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

module.exports = function attachChat(httpServer, app, opts = {}) {
  const dataDir = opts.dataDir || path.join(__dirname, 'chat-data');
  const uploadDir = path.join(dataDir, 'uploads');
  const historyFile = path.join(dataDir, 'history.json');
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

    socket.on('disconnect', broadcastOnline);
  });

  return io;
};
