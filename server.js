/**
 * 아이코닉스 재고 대시보드 서버 (Render Web Service용)
 *
 * 환경변수 (Render → Environment)
 *   MONGODB_URI     MongoDB Atlas 연결 주소 (설정 시 메모·채팅·이미지 영구 저장)
 *   APP_PASSWORD    접속 비밀번호 (설정 시 로그인 화면 표시)
 *   SESSION_SECRET  (선택) 로그인 쿠키 서명용 임의 문자열 — 바꾸면 모두 다시 로그인
 *   MONGODB_DB      (선택) DB 이름, 기본값 iconix_dashboard
 *
 * 실행: npm install && npm start  →  http://localhost:3000
 */
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const createStore = require('./store');
const attachChat = require('./chat');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.CHAT_DATA_DIR || path.join(__dirname, 'chat-data');
const PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('iconix:' + PASSWORD).digest('hex');
const COOKIE = 'iconix_auth';
const SESSION_DAYS = 30;

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

/* ======================================================================
   접속 비밀번호 (APP_PASSWORD 미설정 시 로그인 없이 공개)
   ====================================================================== */
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
}
function isAuthed(req) {
  if (!PASSWORD) return true;
  const [exp, sig] = readCookie(req, COOKIE).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function sameText(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest(), hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const attempts = new Map(); // ip → { n, until }
function tooManyAttempts(ip) {
  const a = attempts.get(ip); if (!a) return false;
  if (a.until < Date.now()) { attempts.delete(ip); return false; }
  return a.n >= 10;
}
function noteFailure(ip) {
  const a = attempts.get(ip) || { n: 0, until: Date.now() + 10 * 60 * 1000 };
  a.n++; attempts.set(ip, a);
}

const loginPage = (msg = '') => `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ICONIX INVENTORY · 로그인</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;color:#000;font-family:"Pretendard Variable",Pretendard,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;padding:16px}
.box{width:100%;max-width:360px;border-top:5px solid #000;background:#F5F5F5;padding:32px 28px}
.brand{display:flex;align-items:center;gap:9px;font-weight:800;font-size:17px;letter-spacing:-.05em}
.mark{width:33px;height:21px;background:#000;display:flex;flex-direction:column;justify-content:center;gap:3px;padding:0 7px}.mark i{display:block;height:2px;background:#fff}
h1{margin:28px 0 6px;font-size:26px;font-weight:200;letter-spacing:-.04em}p{margin:0 0 24px;font-size:12px;color:#888}
input{width:100%;height:44px;border:0;border-bottom:1px solid #C7C7C7;background:transparent;font:inherit;font-size:15px;outline:none}input:focus{border-bottom-color:#000}
button{width:100%;height:48px;margin-top:20px;border:0;background:#000;color:#fff;font:inherit;font-size:14px;font-weight:600;cursor:pointer}button:hover{background:#262626}
.err{min-height:18px;margin-top:10px;font-size:12px;color:#DA0011}
</style></head><body>
<form class="box" method="post" action="/login">
  <div class="brand"><span class="mark"><i></i><i></i></span>ICONIX</div>
  <h1>재고자산 현황</h1><p>사내 공유용 페이지입니다. 접속 비밀번호를 입력하세요.</p>
  <input type="password" name="password" placeholder="접속 비밀번호" autofocus autocomplete="current-password" required>
  <div class="err">${msg}</div>
  <button type="submit">들어가기</button>
</form></body></html>`;

app.get('/login', (req, res) => {
  if (!PASSWORD || isAuthed(req)) return res.redirect('/');
  res.set('Cache-Control', 'no-store').send(loginPage());
});
app.post('/login', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  if (!PASSWORD) return res.redirect('/');
  const ip = req.ip;
  if (tooManyAttempts(ip)) return res.status(429).send(loginPage('시도가 너무 많습니다. 10분 뒤 다시 시도하세요.'));
  if (!sameText((req.body && req.body.password) || '', PASSWORD)) { noteFailure(ip); return res.status(401).send(loginPage('비밀번호가 맞지 않습니다.')); }
  attempts.delete(ip);
  const exp = String(Date.now() + SESSION_DAYS * 86400000);
  res.cookie(COOKIE, `${exp}.${sign(exp)}`, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 86400000, path: '/' });
  res.redirect('/');
});
app.get('/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.redirect(PASSWORD ? '/login' : '/'); });
app.get('/healthz', (req, res) => res.send('ok'));
app.get('/api/session', (req, res) => res.set('Cache-Control', 'no-store').json({ passwordEnabled: !!PASSWORD, authed: isAuthed(req) }));

// 이 아래는 모두 로그인 필요
app.use((req, res, next) => {
  if (isAuthed(req)) return next();
  if (req.method === 'GET' && req.accepts('html') && !/\.(xlsx|xlsb|xls)$/i.test(req.path)) return res.redirect('/login');
  res.status(401).send('Unauthorized');
});

/* ======================================================================
   시작
   ====================================================================== */
(async () => {
  let store = createStore({ dataDir: DATA_DIR });
  let initial;
  try {
    initial = await store.init(attachChat.HISTORY_LIMIT);
    console.log(`[store] ${store.kind === 'mongodb' ? 'MongoDB Atlas 연결됨 — 메모·채팅 영구 저장' : '로컬 파일 저장 (MONGODB_URI 미설정 — 재시작 시 삭제될 수 있음)'}`);
  } catch (e) {
    console.error('[store] MongoDB 연결 실패 — 로컬 파일 저장으로 임시 전환합니다:', e.message);
    store = new createStore.FileStore(DATA_DIR);
    initial = await store.init(attachChat.HISTORY_LIMIT);
  }

  attachChat(server, app, { store, initial, dataDir: DATA_DIR, authorize: isAuthed });

  // 대시보드 파일 (데이터 파일은 항상 최신본)
  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      if (/\.(xlsx|xlsb|xls|html)$/i.test(filePath)) res.set('Cache-Control', 'no-store');
    }
  }));

  server.listen(PORT, () => console.log(`Dashboard running on http://localhost:${PORT}${PASSWORD ? ' (접속 비밀번호 사용)' : ' (비밀번호 없음 — 누구나 접속 가능)'}`));
})();
