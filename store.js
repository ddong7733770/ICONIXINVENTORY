/**
 * 저장소 계층
 *  - MONGODB_URI 환경변수가 있으면 MongoDB Atlas에 영구 저장
 *  - 없으면 chat-data/ 폴더의 JSON 파일에 저장 (Render 무료 플랜에서는 재시작 시 사라짐)
 *
 * 공통 API (모두 async)
 *   init()                                   → { history, plans }  (서버 시작 시 1회)
 *   addMessage(msg)                          메시지 1건 저장
 *   renameNick(clientId, nick)               이 사용자의 과거 메시지 이름 변경
 *   deleteMessage(id)                        메시지 삭제
 *   setPlan(code, team, entry|null)          소진계획 저장/삭제
 *   clearTeam(team)                          팀 메모 일괄삭제 → 삭제 건수
 *   saveImage(buffer, contentType)           이미지 저장 → url
 *   getImage(id)                             → { data, contentType } | null
 *   deleteImage(url)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEEP_MESSAGES = 2000;   // DB에 보관할 최대 메시지 수 (화면에는 최근 500건)

/* ======================================================================
   MongoDB Atlas
   ====================================================================== */
class MongoStore {
  constructor(uri, dbName) { this.uri = uri; this.dbName = dbName || 'iconix_dashboard'; this.kind = 'mongodb'; }

  async init(historyLimit) {
    const { MongoClient } = require('mongodb');
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 15000, maxPoolSize: 10 });
    await this.client.connect();
    const db = this.client.db(this.dbName);
    this.messages = db.collection('messages');
    this.plans = db.collection('plans');
    this.images = db.collection('images');
    await this.messages.createIndex({ id: 1 }, { unique: true });
    await this.plans.createIndex({ team: 1 });

    const history = (await this.messages.find({}, { projection: { _id: 0 } })
      .sort({ id: -1 }).limit(historyLimit).toArray()).reverse();
    const plans = {};
    for (const p of await this.plans.find({}).toArray()) {
      if (!plans[p.code]) plans[p.code] = {};
      plans[p.code][p.team] = { text: p.text, by: p.by, ts: p.ts };
    }
    return { history, plans };
  }

  async addMessage(msg) {
    await this.messages.insertOne({ ...msg });
    // 오래된 메시지 정리 (용량 0.5GB 보호)
    if (msg.id % 50 === 0) {
      const old = await this.messages.find({}, { projection: { id: 1, file: 1 } }).sort({ id: -1 }).skip(KEEP_MESSAGES).toArray();
      for (const m of old) { if (m.file && m.file.url) await this.deleteImage(m.file.url); }
      if (old.length) await this.messages.deleteMany({ id: { $in: old.map(m => m.id) } });
    }
  }
  async renameNick(clientId, nick) { await this.messages.updateMany({ clientId }, { $set: { nick } }); }
  async deleteMessage(id) { await this.messages.deleteOne({ id }); }

  async setPlan(code, team, entry) {
    const _id = `${code}|${team}`;
    if (entry) await this.plans.replaceOne({ _id }, { _id, code, team, ...entry }, { upsert: true });
    else await this.plans.deleteOne({ _id });
  }
  async clearTeam(team) { const r = await this.plans.deleteMany({ team }); return r.deletedCount || 0; }

  async saveImage(buffer, contentType) {
    const id = crypto.randomBytes(12).toString('hex');
    await this.images.insertOne({ _id: id, data: buffer, contentType, size: buffer.length, ts: Date.now() });
    return `/files/${id}`;
  }
  async getImage(id) {
    const doc = await this.images.findOne({ _id: String(id) });
    return doc ? { data: doc.data.buffer ? Buffer.from(doc.data.buffer) : doc.data, contentType: doc.contentType } : null;
  }
  async deleteImage(url) {
    const m = /^\/files\/([a-f0-9]{24})$/.exec(String(url || ''));
    if (m) await this.images.deleteOne({ _id: m[1] });
  }
}

/* ======================================================================
   로컬 파일 (DB 미설정 시)
   ====================================================================== */
class FileStore {
  constructor(dir) { this.dir = dir; this.kind = 'file'; }

  async init(historyLimit) {
    this.imgDir = path.join(this.dir, 'images');
    fs.mkdirSync(this.imgDir, { recursive: true });
    this.historyFile = path.join(this.dir, 'history.json');
    this.plansFile = path.join(this.dir, 'plans.json');
    this.history = this._read(this.historyFile, []);
    this.plansObj = this._read(this.plansFile, {});
    if (!Array.isArray(this.history)) this.history = [];
    return { history: this.history.slice(-historyLimit), plans: JSON.parse(JSON.stringify(this.plansObj)) };
  }
  _read(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; } }
  _save(kind) {
    clearTimeout(this['_t' + kind]);
    this['_t' + kind] = setTimeout(() => {
      const [file, data] = kind === 'h' ? [this.historyFile, this.history] : [this.plansFile, this.plansObj];
      fs.writeFile(file, JSON.stringify(data), err => { if (err) console.error('[store] save failed', err.message); });
    }, 500);
  }

  async addMessage(msg) { this.history.push({ ...msg }); if (this.history.length > KEEP_MESSAGES) this.history = this.history.slice(-KEEP_MESSAGES); this._save('h'); }
  async renameNick(clientId, nick) { this.history.forEach(m => { if (m.clientId === clientId) m.nick = nick; }); this._save('h'); }
  async deleteMessage(id) { this.history = this.history.filter(m => m.id !== id); this._save('h'); }

  async setPlan(code, team, entry) {
    if (entry) { if (!this.plansObj[code]) this.plansObj[code] = {}; this.plansObj[code][team] = entry; }
    else if (this.plansObj[code]) { delete this.plansObj[code][team]; if (!Object.keys(this.plansObj[code]).length) delete this.plansObj[code]; }
    this._save('p');
  }
  async clearTeam(team) {
    let n = 0;
    Object.keys(this.plansObj).forEach(code => { if (this.plansObj[code][team]) { delete this.plansObj[code][team]; n++; if (!Object.keys(this.plansObj[code]).length) delete this.plansObj[code]; } });
    this._save('p'); return n;
  }

  async saveImage(buffer, contentType) {
    const id = crypto.randomBytes(12).toString('hex');
    fs.writeFileSync(path.join(this.imgDir, id), buffer);
    fs.writeFileSync(path.join(this.imgDir, id + '.type'), String(contentType));
    return `/files/${id}`;
  }
  async getImage(id) {
    if (!/^[a-f0-9]{24}$/.test(String(id))) return null;
    try { return { data: fs.readFileSync(path.join(this.imgDir, id)), contentType: fs.readFileSync(path.join(this.imgDir, id + '.type'), 'utf8') }; }
    catch (e) { return null; }
  }
  async deleteImage(url) {
    const m = /^\/files\/([a-f0-9]{24})$/.exec(String(url || ''));
    if (m) { fs.unlink(path.join(this.imgDir, m[1]), () => {}); fs.unlink(path.join(this.imgDir, m[1] + '.type'), () => {}); }
  }
}

module.exports = function createStore(opts = {}) {
  const uri = process.env.MONGODB_URI;
  if (uri) return new MongoStore(uri, process.env.MONGODB_DB);
  return new FileStore(opts.dataDir);
};
module.exports.FileStore = FileStore;
module.exports.MongoStore = MongoStore;
