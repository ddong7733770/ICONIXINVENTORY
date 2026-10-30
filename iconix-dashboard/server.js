/**
 * 아이코닉스 재고 대시보드 서버 (Render Web Service용)
 *  - public/ 폴더의 index.html, data.xlsx 를 제공
 *  - /socket.io 실시간 채팅 (chat.js)
 *
 * 실행: npm install && npm start  →  http://localhost:3000
 */
const path = require('path');
const http = require('http');
const express = require('express');
const attachChat = require('./chat');

const app = express();
const server = http.createServer(app);

// 데이터 파일은 항상 최신본을 받도록 캐시 금지
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(xlsx|xlsb|xls|html)$/i.test(filePath)) res.set('Cache-Control', 'no-store');
  }
}));

attachChat(server, app, { dataDir: process.env.CHAT_DATA_DIR || path.join(__dirname, 'chat-data') });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Dashboard running on http://localhost:${PORT}`));
