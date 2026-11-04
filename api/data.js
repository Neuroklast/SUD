import { get, put, BlobPreconditionFailedError } from '@vercel/blob';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { json, readPasswordRecord, validSession, rejectCrossOrigin } from '../lib/auth.js';

const PATH = 'sud/timeline-v2.json';
const LIMIT = 750_000;

function key() {
  const value = Buffer.from(process.env.SUD_DATA_KEY || '', 'base64');
  if (value.length !== 32) throw new Error('Invalid data encryption key');
  return value;
}
function pack(data) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return JSON.stringify({ format: 'sud-storage-v2', iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
}
function unpack(raw) {
  const envelope = JSON.parse(raw);
  if (envelope.format !== 'sud-storage-v2') throw new Error('Unsupported storage format');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
}
function validData(value) {
  return value && typeof value === 'object' &&
    Number(value.version) === 1 && Array.isArray(value.events) && Array.isArray(value.clusters) &&
    value.events.length <= 20_000 && value.clusters.length <= 1500;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'PUT') {
    res.setHeader('Allow', 'GET, PUT');
    return json(res, 405, { error: 'Nicht erlaubt' });
  }
  if (req.method === 'PUT' && (rejectCrossOrigin(req) ||
      !String(req.headers['content-type'] || '').startsWith('application/json'))) {
    return json(res, 403, { error: 'Anfrage nicht erlaubt' });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN || !process.env.SUD_SESSION_SECRET || !process.env.SUD_DATA_KEY) {
    return json(res, 503, { error: 'Speicher nicht bereit' });
  }
  try {
    const record = await readPasswordRecord();
    if (!validSession(req, record)) return json(res, 401, { error: 'Anmeldung erforderlich' });
    if (req.method === 'GET') {
      const file = await get(PATH, { access: 'private', useCache: false });
      if (!file || file.statusCode === 404) return json(res, 200, { data: null, etag: null });
      if (file.statusCode !== 200 || !file.stream) return json(res, 502, { error: 'Daten nicht verfügbar' });
      const raw = await new Response(file.stream).text();
      if (raw.length > LIMIT * 2) return json(res, 502, { error: 'Datensatz zu groß' });
      const data = unpack(raw);
      if (!validData(data)) return json(res, 502, { error: 'Ungültiger Datensatz' });
      return json(res, 200, { data, etag: file.blob.etag });
    }
    if (Number(req.headers['content-length'] || 0) > LIMIT) return json(res, 413, { error: 'Datei zu groß' });
    const input = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!input || !validData(input.data)) return json(res, 400, { error: 'Ungültige Einträge' });
    const serialized = JSON.stringify(input.data);
    if (Buffer.byteLength(serialized, 'utf8') > LIMIT) return json(res, 413, { error: 'Datei zu groß' });
    const etag = input.etag;
    if (etag !== null && etag !== undefined &&
        (typeof etag !== 'string' || etag.length > 200 || !/^[A-Za-z0-9"\/_=-]+$/.test(etag))) {
      return json(res, 400, { error: 'Ungültige Datenversion' });
    }
    const saved = await put(PATH, pack(input.data), {
      access: 'private', contentType: 'application/json', allowOverwrite: Boolean(etag),
      ...(etag ? { ifMatch: etag } : {}), cacheControlMaxAge: 60
    });
    return json(res, 200, { ok: true, etag: saved.etag });
  } catch (error) {
    if (error instanceof BlobPreconditionFailedError ||
        /already exists|precondition|condition not met|conflict/i.test(error.message || '')) {
      return json(res, 409, { error: 'Die Daten wurden inzwischen auf einem anderen Gerät geändert.' });
    }
    console.error('Data operation failed:', error?.name || 'UnknownError');
    return json(res, 500, { error: 'Speichern gerade nicht möglich' });
  }
}
