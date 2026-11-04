import { get, put, BlobPreconditionFailedError } from '@vercel/blob';
import { timingSafeEqual } from 'node:crypto';

const PATH = 'sud/private-timeline.json';
const LIMIT = 750_000;
const denyCache = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' };

function send(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [name, val] of Object.entries(denyCache)) res.setHeader(name, val);
  res.end(JSON.stringify(value));
}

function equalSecret(given, expected) {
  if (!given || !expected || given.length > 256 || expected.length > 256) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validEnvelope(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.format !== 'sud-aes-gcm-v1') return false;
  return ['salt', 'iv', 'ciphertext'].every(k => typeof p[k] === 'string' && /^[A-Za-z0-9+/=]+$/.test(p[k])) &&
    p.salt.length >= 20 && p.salt.length <= 32 && p.iv.length >= 16 && p.iv.length <= 24 &&
    p.ciphertext.length < LIMIT;
}

export default async function handler(req, res) {
  if (!['GET', 'PUT'].includes(req.method)) {
    res.setHeader('Allow', 'GET, PUT');
    return send(res, 405, { error: 'Methode nicht erlaubt' });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN || !process.env.SUD_ACCESS_TOKEN) {
    return send(res, 503, { error: 'Cloud-Speicher noch nicht konfiguriert' });
  }
  const authorization = String(req.headers.authorization || '');
  const match = /^Bearer ([A-Za-z0-9_-]{40,256})$/.exec(authorization);
  if (!match || !equalSecret(match[1], process.env.SUD_ACCESS_TOKEN)) {
    return send(res, 401, { error: 'Ungültiger Zugangsschlüssel' });
  }
  try {
    if (req.method === 'GET') {
      const file = await get(PATH, { access: 'private', useCache: false });
      if (!file || file.statusCode === 404) return send(res, 200, { data: null, etag: null });
      if (file.statusCode !== 200 || !file.stream) return send(res, 502, { error: 'Speicher konnte nicht gelesen werden' });
      const raw = await new Response(file.stream).text();
      if (raw.length > LIMIT) return send(res, 502, { error: 'Datensatz zu groß' });
      const data = JSON.parse(raw);
      if (!validEnvelope(data)) return send(res, 502, { error: 'Ungültiges gespeichertes Datenformat' });
      return send(res, 200, { data, etag: file.blob.etag || null });
    }
    if (Number(req.headers['content-length'] || 0) > LIMIT) return send(res, 413, { error: 'Datei zu groß' });
    const input = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!input || !validEnvelope(input.data)) return send(res, 400, { error: 'Ungültiger verschlüsselter Datensatz' });
    const dataString = JSON.stringify(input.data);
    if (Buffer.byteLength(dataString) > LIMIT) return send(res, 413, { error: 'Datei zu groß' });
    const etag = input.etag;
    if (etag !== null && etag !== undefined && (typeof etag !== 'string' || etag.length > 200 || !/^[\w"\/-]+$/.test(etag))) {
      return send(res, 400, { error: 'Ungültige Datenversion' });
    }
    // On the very first write, an existing blob must not be overwritten.
    // For all later writes, ETag preconditions stop silent lost updates.
    const options = { access: 'private', contentType: 'application/json',
      cacheControlMaxAge: 60, allowOverwrite: Boolean(etag) };
    if (etag) options.ifMatch = etag;
    await put(PATH, dataString, options);
    const fresh = await get(PATH, { access: 'private', useCache: false });
    if (fresh?.stream) await fresh.stream.cancel();
    return send(res, 200, { ok: true, etag: fresh?.blob?.etag || null });
  } catch (err) {
    if (err instanceof BlobPreconditionFailedError || /already exists|precondition|condition not met|conflict/i.test(err.message || '')) {
      return send(res, 409, { error: 'Die Cloud-Daten wurden inzwischen geändert. Bitte erst neu laden und Änderungen zusammenführen.' });
    }
    console.error('Cloud-Speicher: Fehlercode', err?.name || 'UnknownError');
    return send(res, 500, { error: 'Cloud-Speicher derzeit nicht verfügbar' });
  }
}
