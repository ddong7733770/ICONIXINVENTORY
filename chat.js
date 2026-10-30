/**
 * 톡! 해요 — 실시간 채팅 모듈 (Socket.IO)
 *
 * 사용법 (기존 Express 서버에 붙이기):
 *   const attachChat = require('./chat');
 *   const server = http.createServer(app);
 *   attachChat(server, app);           // server.listen(...) 전에 호출
 *
 * - 동시 접속 최대 50명 (MAX_CLIENTS)
 * - 메시지·이미지·파일 공유 (파일 최대 10MB)
 * - 최근 대화 500건을 chat-data/history.json 에 보관
 * - 닉네임 변경(과거 메시지 이름도 함께 변경), 본인 메시지 삭제
 * - 소진계획 메모(팀별)를 chat-data/plans.json 에 저장하고 전체 접속자에게 실시간 공유
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const MAX_CLIENTS = 50;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT = 1000;
const MAX_NICK = 20;
const HISTORY_LIMIT = 500;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp|bmp)$/i;
const PLAN_TEAMS = ['1팀', '2팀', '온라인', '기타'];
const PLAN_MAX = 100;

module.exports = function attachChat(httpServer, app, opts = {}) {
  const dataDir = opts.dataDir || path.join(__dirname, 'chat-data');
  const uploadDir = path.join(dataDir, 'uploads');
  const historyFile = path.join(dataDir, 'history.json');
  const plansFile = path.join(dataDir, 'plans.json');
  fs.mkdirSync(uploadDir, { recursive: true });

  /* ---------- 대화 기록 ---------- */
  let history = [];
  try { history = JSON.parse(fs.readFileSync(historyFile, 'utf8')); if (!Array.isArray(history)) history = []; } catch (e) { history = []; }
  let seq = history.reduce((a, m) => Math.max(a, m.id || 0), 0);
  let saveTimer = null;
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fs.writeFile(historyFile, JSON.stringify(history), err => { if (err) console.error('[chat] history save failed', err.message); });
    }, 800);
  };
  const push = (msg) => {
    history.push(msg);
    if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
    persist();
    io.emit('message', msg);
  };

  /* ---------- 소진계획 메모 ---------- */
  let plans = {};
  try { plans = JSON.parse(fs.readFileSync(plansFile, 'utf8')); if (!plans || typeof plans !== 'object' || Array.isArray(plans)) plans = {}; } catch (e) { plans = {}; }
  let planTimer = null;
  const persistPlans = () => {
    clearTimeout(planTimer);
    planTimer = setTimeout(() => {
      fs.writeFile(plansFile, JSON.stringify(plans), err => { if (err) console.error('[plans] save failed', err.message); });
    }, 500);
  };
  const setPlan = (code, team, text, by) => {
    const ts = Date.now();
    if (text) { if (!plans[code]) plans[code] = {}; plans[code][team] = { text, by, ts }; }
    else if (plans[code]) { delete plans[code][team]; if (!Object.keys(plans[code]).length) delete plans[code]; }
    persistPlans();
    return { code, team, text, by, ts };
  };
  const validCode = c => /^[A-Za-z0-9_-]{2,40}$/.test(c);

  /* ---------- 업로드 파일 제공 (이미지 외 파일은 다운로드로만 제공) ---------- */
  app.use('/uploads', express.static(uploadDir, {
    maxAge: '7d',
    setHeaders(res, filePath) {
      res.set('X-Content-Type-Options', 'nosniff');
      if (!IMAGE_EXT.test(filePath)) res.set('Content-Disposition', 'attachment');
    }
  }));

  /* ---------- Socket.IO ---------- */
  const io = new Server(httpServer, { maxHttpBufferSize: MAX_FILE_BYTES + 512 * 1024 });
  const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
  const broadcastOnline = () => io.emit('online', io.of('/').sockets.size);

  io.on('connection', (socket) => {
    if (io.of('/').sockets.size > MAX_CLIENTS) {
      socket.emit('full', MAX_CLIENTS);
      return setTimeout(() => socket.disconnect(true), 50);
    }
    const clientId = clean(socket.handshake.auth && socket.handshake.auth.clientId, 64) || socket.id;
    let lastSent = 0;
    const tooFast = () => { const now = Date.now(); if (now - lastSent < 300) return true; lastSent = now; return false; };

    socket.emit('history', history);
    broadcastOnline();

    socket.on('message', (p, ack = () => {}) => {
      if (tooFast()) return ack({ ok: false, error: '메시지를 너무 빠르게 보내고 있습니다.' });
      const text = clean(p && p.text, MAX_TEXT);
      const nick = clean(p && p.nick, MAX_NICK);
      if (!text) return ack({ ok: false, error: '내용이 없습니다.' });
      if (!nick) return ack({ ok: false, error: '닉네임을 먼저 설정하세요.' });
      push({ id: ++seq, ts: Date.now(), nick, clientId, text });
      ack({ ok: true });
    });

    socket.on('file', (p, ack = () => {}) => {
      try {
        const nick = clean(p && p.nick, MAX_NICK);
        if (!nick) return ack({ ok: false, error: '닉네임을 먼저 설정하세요.' });
        const buf = p && p.data;
        if (!Buffer.isBuffer(buf) || !buf.length) return ack({ ok: false, error: '파일 데이터가 없습니다.' });
        if (buf.length > MAX_FILE_BYTES) return ack({ ok: false, error: '파일은 최대 10MB까지 올릴 수 있습니다.' });

        const origName = clean(p.name, 120).replace(/[\\/:*?"<>|]/g, '_') || 'file';
        const ext = (path.extname(origName).toLowerCase().match(/^\.[a-z0-9]{1,8}$/) || [''])[0];
        const stored = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
        fs.writeFileSync(path.join(uploadDir, stored), buf);

        const isImage = IMAGE_EXT.test(ext) && IMAGE_MIME.test(String(p.type || ''));
        push({
          id: ++seq, ts: Date.now(), nick, clientId,
          text: clean(p.text, MAX_TEXT),
          file: { url: `/uploads/${stored}`, name: origName, size: buf.length, isImage }
        });
        ack({ ok: true });
      } catch (e) {
        console.error('[chat] upload failed', e);
        ack({ ok: false, error: '파일 저장 중 오류가 발생했습니다.' });
      }
    });

    /* 닉네임 변경: 이 사용자의 과거 메시지 이름도 함께 변경 */
    socket.on('nick', (p, ack = () => {}) => {
      const nick = clean(p && p.nick, MAX_NICK);
      if (!nick) return ack({ ok: false, error: '닉네임을 입력하세요.' });
      let changed = false;
      history.forEach(m => { if (m.clientId === clientId && m.nick !== nick) { m.nick = nick; changed = true; } });
      if (changed) persist();
      io.emit('nick', { clientId, nick });
      ack({ ok: true });
    });

    /* 본인 메시지 삭제 */
    socket.on('delete', (p, ack = () => {}) => {
      const id = Number(p && p.id);
      const idx = history.findIndex(m => m.id === id);
      if (idx < 0) return ack({ ok: false, error: '이미 삭제된 메시지입니다.' });
      if (history[idx].clientId !== clientId) return ack({ ok: false, error: '본인이 작성한 메시지만 삭제할 수 있습니다.' });
      const [removed] = history.splice(idx, 1);
      if (removed.file && removed.file.url) {
        fs.unlink(path.join(uploadDir, path.basename(removed.file.url)), () => {});
      }
      persist();
      io.emit('deleted', id);
      ack({ ok: true });
    });

    /* 소진계획 메모 */
    socket.emit('plans', plans);
    socket.on('plan:set', (p, ack = () => {}) => {
      const code = clean(p && p.code, 40), team = clean(p && p.team, 10);
      if (!validCode(code) || !PLAN_TEAMS.includes(team)) return ack({ ok: false, error: '잘못된 요청입니다.' });
      const entry = setPlan(code, team, clean(p.text, PLAN_MAX), clean(p.by, MAX_NICK) || '익명');
      io.emit('plan', entry);
      ack({ ok: true });
    });
    socket.on('plan:clearTeam', (p, ack = () => {}) => {
      const team = clean(p && p.team, 10);
      if (!PLAN_TEAMS.includes(team)) return ack({ ok: false, error: '잘못된 팀입니다.' });
      let removed = 0;
      Object.keys(plans).forEach(code => {
        if (plans[code] && plans[code][team]) { delete plans[code][team]; removed++; if (!Object.keys(plans[code]).length) delete plans[code]; }
      });
      persistPlans();
      io.emit('plans', plans);
      console.log(`[plans] ${team} 일괄삭제 ${removed}건 by ${clean(p && p.by, MAX_NICK) || '익명'}`);
      ack({ ok: true, removed });
    });
    socket.on('plan:merge', (p, ack = () => {}) => {
      const items = Array.isArray(p && p.items) ? p.items.slice(0, 5000) : [];
      const by = clean(p && p.by, MAX_NICK) || '익명';
      items.forEach(it => {
        const code = clean(it && it.code, 40), team = clean(it && it.team, 10);
        if (!validCode(code) || !PLAN_TEAMS.includes(team)) return;
        io.emit('plan', setPlan(code, team, clean(it.text, PLAN_MAX), by));
      });
      ack({ ok: true });
    });

    socket.on('disconnect', broadcastOnline);
  });

  return io;
};
