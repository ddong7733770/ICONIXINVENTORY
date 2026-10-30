/**
 * 톡! 해요 — 실시간 채팅 + 소진계획 공유 (Socket.IO)
 *
 *   const store = require('./store')({ dataDir });
 *   const initial = await store.init(HISTORY_LIMIT);
 *   attachChat(server, app, { store, initial, dataDir, authorize });
 *
 * - 동시 접속 최대 50명
 * - 텍스트·닉네임·소진계획 메모·이미지는 store(MongoDB Atlas)에 영구 저장
 * - 이미지 외 파일(엑셀·PDF 등)은 서버 디스크에 임시 보관 (Render 무료 플랜은 재시작 시 삭제)
 * - 닉네임 변경(과거 메시지 이름도 함께 변경), 본인 메시지 삭제, 팀별 소진계획 일괄삭제
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const MAX_CLIENTS = 50;
const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 일반 파일
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;   // 이미지 (브라우저에서 자동 축소 후 업로드)
const MAX_TEXT = 1000;
const MAX_NICK = 20;
const HISTORY_LIMIT = 500;
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/i;
const PLAN_TEAMS = ['1팀', '2팀', '온라인', '기타'];
const PLAN_MAX = 100;

module.exports = function attachChat(httpServer, app, opts) {
  const { store, initial } = opts;
  const authorize = opts.authorize || (() => true);
  const uploadDir = path.join(opts.dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  let history = initial.history || [];
  let plans = initial.plans || {};
  let seq = history.reduce((a, m) => Math.max(a, m.id || 0), 0);

  const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
  const validCode = c => /^[A-Za-z0-9_-]{2,40}$/.test(c);
  const fail = (ack, e, msg) => { console.error('[chat]', msg, e && e.message); ack({ ok: false, error: msg }); };

  /* ---------- 파일 제공 ---------- */
  // 이미지 (DB 저장분)
  app.get('/files/:id', async (req, res) => {
    try {
      const img = await store.getImage(req.params.id);
      if (!img || !IMAGE_MIME.test(img.contentType)) return res.status(404).end();
      res.set({ 'Content-Type': img.contentType, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      res.end(img.data);
    } catch (e) { res.status(500).end(); }
  });
  // 일반 파일 (임시, 다운로드 전용)
  app.use('/uploads', express.static(uploadDir, {
    maxAge: '1d',
    setHeaders(res) { res.set('X-Content-Type-Options', 'nosniff'); res.set('Content-Disposition', 'attachment'); }
  }));

  /* ---------- Socket.IO ---------- */
  const io = new Server(httpServer, { maxHttpBufferSize: MAX_FILE_BYTES + 512 * 1024 });
  io.use((socket, next) => (authorize(socket.request) ? next() : next(new Error('unauthorized'))));
  const broadcastOnline = () => io.emit('online', io.of('/').sockets.size);

  const pushMessage = async (msg) => {
    await store.addMessage(msg);
    history.push(msg);
    if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
    io.emit('message', msg);
  };
  const applyPlan = (code, team, entry) => {
    if (entry) { if (!plans[code]) plans[code] = {}; plans[code][team] = entry; }
    else if (plans[code]) { delete plans[code][team]; if (!Object.keys(plans[code]).length) delete plans[code]; }
  };

  io.on('connection', (socket) => {
    if (io.of('/').sockets.size > MAX_CLIENTS) {
      socket.emit('full', MAX_CLIENTS);
      return setTimeout(() => socket.disconnect(true), 50);
    }
    const clientId = clean(socket.handshake.auth && socket.handshake.auth.clientId, 64) || socket.id;
    let lastSent = 0;
    const tooFast = () => { const now = Date.now(); if (now - lastSent < 300) return true; lastSent = now; return false; };

    socket.emit('history', history);
    socket.emit('plans', plans);
    broadcastOnline();

    /* 텍스트 메시지 */
    socket.on('message', async (p, ack = () => {}) => {
      if (tooFast()) return ack({ ok: false, error: '메시지를 너무 빠르게 보내고 있습니다.' });
      const text = clean(p && p.text, MAX_TEXT);
      const nick = clean(p && p.nick, MAX_NICK);
      if (!text) return ack({ ok: false, error: '내용이 없습니다.' });
      if (!nick) return ack({ ok: false, error: '닉네임을 먼저 설정하세요.' });
      try { await pushMessage({ id: ++seq, ts: Date.now(), nick, clientId, text }); ack({ ok: true }); }
      catch (e) { fail(ack, e, '메시지를 저장하지 못했습니다.'); }
    });

    /* 이미지 · 파일 */
    socket.on('file', async (p, ack = () => {}) => {
      try {
        const nick = clean(p && p.nick, MAX_NICK);
        if (!nick) return ack({ ok: false, error: '닉네임을 먼저 설정하세요.' });
        const buf = p && p.data;
        if (!Buffer.isBuffer(buf) || !buf.length) return ack({ ok: false, error: '파일 데이터가 없습니다.' });
        const origName = clean(p.name, 120).replace(/[\\/:*?"<>|]/g, '_') || 'file';
        const type = String(p.type || '');
        let file;

        if (IMAGE_MIME.test(type)) {
          if (buf.length > MAX_IMAGE_BYTES) return ack({ ok: false, error: '이미지가 너무 큽니다. (최대 3MB)' });
          const url = await store.saveImage(buf, type.toLowerCase());
          file = { url, name: origName, size: buf.length, isImage: true };
        } else {
          if (buf.length > MAX_FILE_BYTES) return ack({ ok: false, error: '파일은 최대 10MB까지 올릴 수 있습니다.' });
          const ext = (path.extname(origName).toLowerCase().match(/^\.[a-z0-9]{1,8}$/) || [''])[0];
          const stored = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
          fs.writeFileSync(path.join(uploadDir, stored), buf);
          file = { url: `/uploads/${stored}`, name: origName, size: buf.length, isImage: false, temp: true };
        }
        await pushMessage({ id: ++seq, ts: Date.now(), nick, clientId, text: clean(p.text, MAX_TEXT), file });
        ack({ ok: true });
      } catch (e) { fail(ack, e, '파일 저장 중 오류가 발생했습니다.'); }
    });

    /* 닉네임 변경 */
    socket.on('nick', async (p, ack = () => {}) => {
      const nick = clean(p && p.nick, MAX_NICK);
      if (!nick) return ack({ ok: false, error: '닉네임을 입력하세요.' });
      try {
        await store.renameNick(clientId, nick);
        history.forEach(m => { if (m.clientId === clientId) m.nick = nick; });
        io.emit('nick', { clientId, nick });
        ack({ ok: true });
      } catch (e) { fail(ack, e, '닉네임을 바꾸지 못했습니다.'); }
    });

    /* 본인 메시지 삭제 */
    socket.on('delete', async (p, ack = () => {}) => {
      const id = Number(p && p.id);
      const msg = history.find(m => m.id === id);
      if (!msg) return ack({ ok: false, error: '이미 삭제된 메시지입니다.' });
      if (msg.clientId !== clientId) return ack({ ok: false, error: '본인이 작성한 메시지만 삭제할 수 있습니다.' });
      try {
        await store.deleteMessage(id);
        if (msg.file && msg.file.url) {
          if (msg.file.url.startsWith('/files/')) await store.deleteImage(msg.file.url);
          else fs.unlink(path.join(uploadDir, path.basename(msg.file.url)), () => {});
        }
        history = history.filter(m => m.id !== id);
        io.emit('deleted', id);
        ack({ ok: true });
      } catch (e) { fail(ack, e, '삭제하지 못했습니다.'); }
    });

    /* 소진계획 메모 */
    socket.on('plan:set', async (p, ack = () => {}) => {
      const code = clean(p && p.code, 40), team = clean(p && p.team, 10);
      if (!validCode(code) || !PLAN_TEAMS.includes(team)) return ack({ ok: false, error: '잘못된 요청입니다.' });
      const text = clean(p.text, PLAN_MAX), by = clean(p.by, MAX_NICK) || '익명', ts = Date.now();
      const entry = text ? { text, by, ts } : null;
      try {
        await store.setPlan(code, team, entry);
        applyPlan(code, team, entry);
        io.emit('plan', { code, team, text, by, ts });
        ack({ ok: true });
      } catch (e) { fail(ack, e, '소진계획을 저장하지 못했습니다.'); }
    });
    socket.on('plan:clearTeam', async (p, ack = () => {}) => {
      const team = clean(p && p.team, 10);
      if (!PLAN_TEAMS.includes(team)) return ack({ ok: false, error: '잘못된 팀입니다.' });
      try {
        const removed = await store.clearTeam(team);
        Object.keys(plans).forEach(code => applyPlan(code, team, null));
        io.emit('plans', plans);
        console.log(`[plans] ${team} 일괄삭제 ${removed}건 by ${clean(p && p.by, MAX_NICK) || '익명'}`);
        ack({ ok: true, removed });
      } catch (e) { fail(ack, e, '일괄삭제하지 못했습니다.'); }
    });
    socket.on('plan:merge', async (p, ack = () => {}) => {
      const items = Array.isArray(p && p.items) ? p.items.slice(0, 5000) : [];
      const by = clean(p && p.by, MAX_NICK) || '익명';
      try {
        for (const it of items) {
          const code = clean(it && it.code, 40), team = clean(it && it.team, 10);
          if (!validCode(code) || !PLAN_TEAMS.includes(team)) continue;
          const text = clean(it.text, PLAN_MAX), ts = Date.now();
          const entry = text ? { text, by, ts } : null;
          await store.setPlan(code, team, entry);
          applyPlan(code, team, entry);
          io.emit('plan', { code, team, text, by, ts });
        }
        ack({ ok: true });
      } catch (e) { fail(ack, e, '소진계획을 저장하지 못했습니다.'); }
    });

    socket.on('disconnect', broadcastOnline);
  });

  return io;
};
module.exports.HISTORY_LIMIT = HISTORY_LIMIT;
