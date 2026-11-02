import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applyCommand, buildPlayerView, DEFAULT_SETTINGS, mergeSettings } from './game-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, '.data'));
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const BODY_LIMIT = 20 * 1024;
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

let store = { rooms: {} };
let loaded = false;
let mutationQueue = Promise.resolve();
const rateBuckets = new Map();

const sha256 = value => createHash('sha256').update(value).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const newRoomCode = () => Array.from({ length: 6 }, () => CODE_ALPHABET[randomBytes(1)[0] % CODE_ALPHABET.length]).join('');
const newRecoveryCode = () => Array.from({ length: 12 }, () => RECOVERY_ALPHABET[randomBytes(1)[0] % RECOVERY_ALPHABET.length]).join('');

async function loadStore() {
  if (loaded) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.rooms === 'object') store = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await saveStore();
  }
  loaded = true;
}

async function saveStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temporary = `${DATA_FILE}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.rename(temporary, DATA_FILE);
}

function mutate(work) {
  const task = mutationQueue.then(async () => {
    await loadStore();
    const result = await work();
    await saveStore();
    return result;
  });
  mutationQueue = task.catch(() => undefined);
  return task;
}

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(JSON.stringify(data));
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  const allowed = !origin || origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || /^https:\/\/[a-z0-9-]+\.github\.io$/.test(origin) || (process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean).includes(origin);
  if (origin && allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  return allowed;
}

function rateLimit(req, res, key, max = 25, windowMs = 60_000) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const id = `${ip}:${key}`;
  const now = Date.now();
  const bucket = rateBuckets.get(id);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(id, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  if (bucket.count > max) {
    send(res, 429, { error: 'アクセスが多すぎます。少し時間をおいて再度お試しください。' });
    return false;
  }
  return true;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error('リクエストが大きすぎます。');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('JSON形式が不正です。');
  }
}

function getToken(req, body = {}) {
  const authorization = req.headers.authorization || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  return bearer || body.token || '';
}

function findMember(room, token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const hash = sha256(token);
  return room.members.find(member => member.tokenHash === hash) || null;
}

function cleanMember(member) {
  return { id: member.id, name: member.name, seat: member.seat, isHost: member.isHost, ready: member.ready };
}

async function handle(req, res) {
  const corsAllowed = applyCors(req, res);
  if (!corsAllowed) return send(res, 403, { error: 'この接続元は許可されていません。' });
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, { ok: true, service: 'werewolf-gm-api', version: '0.1.0' });
  }

  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    if (!rateLimit(req, res, 'create-room', 10)) return;
    let body;
    try { body = await readJson(req); } catch (error) { return send(res, 400, { error: error.message }); }
    const name = String(body.name || '').trim();
    if (!name || name.length > 16) return send(res, 400, { error: 'プレイヤー名は1〜16文字で入力してください。' });
    try {
      const result = await mutate(() => {
        let code;
        do { code = newRoomCode(); } while (store.rooms[code]);
        const token = newToken();
        const recoveryCode = newRecoveryCode();
        const member = { id: randomUUID(), tokenHash: sha256(token), recoveryHash: sha256(recoveryCode), name, seat: 1, isHost: true, ready: true, joinedAt: new Date().toISOString() };
        const room = {
          id: randomUUID(), code, hostMemberId: member.id, status: 'LOBBY',
          settings: mergeSettings(DEFAULT_SETTINGS), members: [member], game: null,
          createdAt: new Date().toISOString()
        };
        store.rooms[code] = room;
        return { code, token, recoveryCode, member: cleanMember(member) };
      });
      return send(res, 201, result);
    } catch (error) { return send(res, 500, { error: error.message }); }
  }

  const joinMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/join$/);
  if (req.method === 'POST' && joinMatch) {
    if (!rateLimit(req, res, 'join-room', 30)) return;
    const code = joinMatch[1];
    let body;
    try { body = await readJson(req); } catch (error) { return send(res, 400, { error: error.message }); }
    const name = String(body.name || '').trim();
    if (!name || name.length > 16) return send(res, 400, { error: 'プレイヤー名は1〜16文字で入力してください。' });
    try {
      const result = await mutate(() => {
        const room = store.rooms[code];
        if (!room) throw new Error('ルームが見つかりません。ルームコードを確認してください。');
        if (room.status !== 'LOBBY') throw new Error('このルームでは参加受付を終了しています。');
        if (room.members.length >= 20) throw new Error('このルームは満員です（最大20人）。');
        if (room.members.some(member => member.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('同じプレイヤー名が既に使用されています。');
        const token = newToken();
        const recoveryCode = newRecoveryCode();
        const member = { id: randomUUID(), tokenHash: sha256(token), recoveryHash: sha256(recoveryCode), name, seat: room.members.length + 1, isHost: false, ready: false, joinedAt: new Date().toISOString() };
        room.members.push(member);
        return { code, token, recoveryCode, member: cleanMember(member) };
      });
      return send(res, 201, result);
    } catch (error) { return send(res, 400, { error: error.message }); }
  }

  const recoverMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/recover$/);
  if (req.method === 'POST' && recoverMatch) {
    if (!rateLimit(req, res, 'recover-room', 5)) return;
    const code = recoverMatch[1];
    let body;
    try { body = await readJson(req); } catch (error) { return send(res, 400, { error: error.message }); }
    const recoveryCode = String(body.recoveryCode || '').trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{12}$/.test(recoveryCode)) return send(res, 400, { error: '復帰コードの形式が正しくありません。' });
    try {
      const result = await mutate(() => {
        const room = store.rooms[code];
        if (!room) throw new Error('ルームが見つかりません。');
        const member = room.members.find(item => item.recoveryHash && item.recoveryHash === sha256(recoveryCode));
        if (!member) throw new Error('復帰コードが一致しません。');
        const token = newToken();
        const nextRecoveryCode = newRecoveryCode();
        member.tokenHash = sha256(token);
        member.recoveryHash = sha256(nextRecoveryCode);
        return { code, token, recoveryCode: nextRecoveryCode, member: cleanMember(member) };
      });
      return send(res, 200, result);
    } catch (error) { return send(res, 401, { error: error.message }); }
  }

  const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/(view|command)$/);
  if (roomMatch) {
    const code = roomMatch[1];
    if (req.method === 'GET' && roomMatch[2] === 'view') {
      await loadStore();
      const room = store.rooms[code];
      if (!room) return send(res, 404, { error: 'ルームが見つかりません。' });
      const member = findMember(room, getToken(req));
      if (!member) return send(res, 401, { error: '参加認証に失敗しました。再参加または復帰コードを確認してください。' });
      return send(res, 200, buildPlayerView(room, member));
    }
    if (req.method === 'POST' && roomMatch[2] === 'command') {
      let body;
      try { body = await readJson(req); } catch (error) { return send(res, 400, { error: error.message }); }
      const token = getToken(req, body);
      try {
        const view = await mutate(() => {
          const room = store.rooms[code];
          if (!room) throw new Error('ルームが見つかりません。');
          const member = findMember(room, token);
          if (!member) throw new Error('参加認証に失敗しました。');
          if (body.phaseVersion !== undefined && room.game && Number(body.phaseVersion) !== room.game.phaseVersion) throw new Error('画面の情報が古くなっています。最新状態を読み込みました。');
          applyCommand(room, member, String(body.command || ''), body.payload || {});
          return buildPlayerView(room, member);
        });
        return send(res, 200, view);
      } catch (error) {
        const status = /認証/.test(error.message) ? 401 : 400;
        return send(res, status, { error: error.message });
      }
    }
  }

  return send(res, 404, { error: 'エンドポイントが見つかりません。' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    console.error(error);
    if (!res.headersSent) send(res, 500, { error: 'サーバー内部でエラーが発生しました。' });
    else res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`WEREWOLF GM API listening on http://${HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
