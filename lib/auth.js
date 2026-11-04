import { get, put, BlobPreconditionFailedError } from '@vercel/blob';
import { createHmac, timingSafeEqual, pbkdf2 as pbkdf2Callback, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2 = promisify(pbkdf2Callback);
const AUTH_FILE = 'sud/auth/password.json';
const ITERATIONS = 310_000;
const COOKIE = 'sud_session';
const WEEK = 7 * 24 * 60 * 60;
export const HEADERS = { 'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' };

export function json(res, code, value) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [key, val] of Object.entries(HEADERS)) res.setHeader(key, val);
  res.end(JSON.stringify(value));
}
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length > 1024 || b.length > 1024) return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function rejectCrossOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || typeof origin !== 'string') return true;
  const host = req.headers.host;
  return origin !== 'https://' + host && origin !== 'http://' + host;
}
export function passwordValid(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 200;
}
export async function passwordRecord(password) {
  const salt = randomBytes(16);
  const digest = await pbkdf2(password, salt, ITERATIONS, 32, 'sha256');
  return {
    format: 'sud-password-v1',
    version: randomBytes(16).toString('hex'),
    salt: salt.toString('base64'),
    hash: digest.toString('base64'),
    iterations: ITERATIONS
  };
}
export async function readPasswordRecord() {
  const result = await get(AUTH_FILE, { access: 'private', useCache: false });
  if (!result || result.statusCode === 404) return null;
  if (result.statusCode !== 200 || !result.stream) throw new Error('Cannot load password configuration');
  const record = JSON.parse(await new Response(result.stream).text());
  if (record.format !== 'sud-password-v1' || typeof record.version !== 'string' ||
      typeof record.salt !== 'string' || typeof record.hash !== 'string' ||
      record.iterations !== ITERATIONS) throw new Error('Invalid password configuration');
  return { ...record, etag: result.blob.etag };
}
export async function checkPassword(password, record) {
  if (!passwordValid(password) || !record) return false;
  const derived = await pbkdf2(password, Buffer.from(record.salt, 'base64'), record.iterations, 32, 'sha256');
  return timingSafeEqual(derived, Buffer.from(record.hash, 'base64'));
}
export async function initialSetup(password, bootstrap) {
  if (!passwordValid(password)) throw Object.assign(new Error('Passwort muss 12 bis 200 Zeichen haben'), { status: 400 });
  const expected = process.env.SUD_BOOTSTRAP_TOKEN;
  if (!expected || !safeEqual(expected, bootstrap)) {
    throw Object.assign(new Error('Der Einrichtungslink ist ungültig'), { status: 403 });
  }
  const previous = await readPasswordRecord();
  if (previous) throw Object.assign(new Error('Passwort wurde bereits eingerichtet'), { status: 409 });
  try {
    return await put(AUTH_FILE, JSON.stringify(await passwordRecord(password)), {
      access: 'private', contentType: 'application/json', allowOverwrite: false
    });
  } catch (error) {
    if (error instanceof BlobPreconditionFailedError || /already exists|precondition/i.test(String(error.message))) {
      throw Object.assign(new Error('Passwort wurde bereits eingerichtet'), { status: 409 });
    }
    throw error;
  }
}
export async function updatePassword(password, record) {
  if (!passwordValid(password)) throw Object.assign(new Error('Passwort muss 12 bis 200 Zeichen haben'), { status: 400 });
  await put(AUTH_FILE, JSON.stringify(await passwordRecord(password)), {
    access: 'private', contentType: 'application/json', allowOverwrite: true, ifMatch: record.etag
  });
}
function sessionKey() {
  const secret = process.env.SUD_SESSION_SECRET;
  if (!secret || secret.length < 40) throw new Error('Session secret is missing');
  return secret;
}
export function createSession(res, record) {
  const payload = Buffer.from(JSON.stringify({ version: record.version, expires: Date.now() + WEEK * 1000 })).toString('base64url');
  const signature = createHmac('sha256', sessionKey()).update(payload).digest('base64url');
  res.setHeader('Set-Cookie', COOKIE + '=' + payload + '.' + signature + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + WEEK);
}
export function clearSession(res) {
  res.setHeader('Set-Cookie', COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
}
export function validSession(req, record) {
  if (!record) return false;
  const cookies = String(req.headers.cookie || '').split(';').map(x => x.trim());
  const raw = cookies.find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (!raw || raw.length > 2048) return false;
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(raw);
  if (!match) return false;
  const sign = createHmac('sha256', sessionKey()).update(match[1]).digest('base64url');
  if (!safeEqual(sign, match[2])) return false;
  try {
    const decoded = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    return decoded.version === record.version && typeof decoded.expires === 'number' && decoded.expires > Date.now();
  } catch { return false; }
}
