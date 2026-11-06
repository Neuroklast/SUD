import { get, put, head, BlobPreconditionFailedError } from '@vercel/blob';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import '../sync-core.js';
import { json, readPasswordRecord, validSession, rejectCrossOrigin } from '../lib/auth.js';

const { mergeData, equal } = globalThis.SUDSync;
const PATH = 'sud/timeline-v2.json';
const LIMIT = 750_000;
const REQUEST_LIMIT = LIMIT * 2 + 80_000;
const MAX_RETRIES = 7;
const EMPTY = () => ({ version: 1, events: [], clusters: [] });

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
  return value && typeof value === 'object' && Number(value.version) === 1 &&
    Array.isArray(value.events) && Array.isArray(value.clusters) &&
    value.events.length <= 20_000 && value.clusters.length <= 1500;
}
function etagValid(etag) {
  return etag === null || (typeof etag === 'string' &&
    etag.length > 0 && etag.length <= 200 && /^[A-Za-z0-9"\\/_=-]+$/.test(etag));
}
function isConflict(error) {
  return error instanceof BlobPreconditionFailedError ||
    /already exists|precondition|condition not met|conflict/i.test(String(error?.message || ''));
}
function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// All reads bypass Vercel Blob's 60-second overwritten-object CDN cache.
// Otherwise even freshly merged conditional writes can loop on an old ETag.
async function readDocument(ifNoneMatch) {
  const file = await get(PATH, { access: 'private', useCache: false,
    ...(ifNoneMatch ? { ifNoneMatch } : {}) });
  if (!file || file.statusCode === 404) return { data: null, etag: null };
  if (file.statusCode === 304) return { unchanged: true, etag: file.blob.etag };
  if (file.statusCode !== 200 || !file.stream) {
    throw Object.assign(new Error('Data unavailable'), { status: 502 });
  }
  const raw = await new Response(file.stream).text();
  if (raw.length > LIMIT * 2) throw Object.assign(new Error('Data too large'), { status: 502 });
  const data = unpack(raw);
  if (!validData(data)) throw Object.assign(new Error('Invalid stored data'), { status: 502 });
  return { data, etag: file.blob.etag };
}
async function writeDocument(value, etag) {
  return put(PATH, pack(value), {
    access: 'private', contentType: 'application/json', allowOverwrite: Boolean(etag),
    ...(etag ? { ifMatch: etag } : {}), cacheControlMaxAge: 60
  });
}

// Conditional writes are safe only when the ETag we read matches Blob's
// current metadata. A precondition failure against the same current ETag is
// not evidence of a competing editor and must not trigger endless retries.
async function mergeAndWrite(base, incoming) {
  let unchangedEtagFailures = 0;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const cloud = await readDocument();
    const merged = mergeData(base, incoming, cloud.data || EMPTY());
    if (!validData(merged.data) || Buffer.byteLength(JSON.stringify(merged.data), 'utf8') > LIMIT) {
      throw Object.assign(new Error('Merged document too large'), { status: 413 });
    }
    if (equal(merged.data, cloud.data || EMPTY())) {
      return { data: cloud.data || EMPTY(), etag: cloud.etag,
        conflictCount: merged.conflicts.length };
    }

    try {
      const stored = await writeDocument(merged.data, cloud.etag);
      return { data: merged.data, etag: stored.etag,
        conflictCount: merged.conflicts.length };
    } catch (error) {
      if (!isConflict(error)) throw error;
      let latest;
      try {
        // head() reads the current metadata without any document content.
        latest = await head(PATH);
      } catch (metadataError) {
        // A first upload has no metadata yet; a failed create with no object
        // is not a competing editor and should not loop indefinitely.
        if (metadataError?.name === 'BlobNotFoundError') latest = null;
        else {
          console.warn('SUD storage metadata check failed', metadataError?.name || 'Unknown');
          throw Object.assign(new Error('Storage metadata unavailable'), { status: 502 });
        }
      }
      const sameEtag = latest?.etag === cloud.etag ||
        (cloud.etag === null && latest === null);
      if (sameEtag) unchangedEtagFailures++;
      else unchangedEtagFailures = 0;
      if (unchangedEtagFailures >= 2) {
        console.error('SUD conditional write rejected matching current ETag', {
          code: 'BLOB_CAS_INCONSISTENT',
          attempts: attempt + 1,
          reason: error?.name || 'PreconditionFailed'
        });
        throw Object.assign(new Error('Storage precondition inconsistent'), {
          status: 502,
          code: 'BLOB_CAS_INCONSISTENT'
        });
      }
      if (attempt + 1 === MAX_RETRIES) {
        console.warn('SUD concurrent writes exhausted retry budget', {
          code: 'BLOB_WRITE_CONTENTION',
          attempts: MAX_RETRIES,
          latestDiffers: Boolean(cloud.etag !== latest?.etag)
        });
        break;
      }
      await pause(Math.min(1500, 120 * (2 ** attempt)) + Math.round(Math.random() * 250));
    }
  }
  throw Object.assign(new Error('Concurrent writes still in progress'), {
    status: 503,
    code: 'BLOB_WRITE_CONTENTION'
  });
}

export default async function handler(req, res) {
  if (!['GET', 'PUT', 'PATCH'].includes(req.method)) {
    res.setHeader('Allow', 'GET, PUT, PATCH');
    return json(res, 405, { error: 'Nicht erlaubt' });
  }
  if (req.method !== 'GET' &&
      (rejectCrossOrigin(req) || !String(req.headers['content-type'] || '').startsWith('application/json'))) {
    return json(res, 403, { error: 'Anfrage nicht erlaubt' });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN || !process.env.SUD_SESSION_SECRET || !process.env.SUD_DATA_KEY) {
    return json(res, 503, { error: 'Speicher nicht bereit' });
  }
  try {
    const record = await readPasswordRecord();
    if (!validSession(req, record)) return json(res, 401, { error: 'Anmeldung erforderlich' });
    if (req.method === 'GET') {
      const known = req.headers['if-none-match'];
      const remote = await readDocument(typeof known === 'string' && etagValid(known) ? known : null);
      if (remote.unchanged) {
        res.statusCode = 304;
        res.setHeader('Cache-Control', 'private, no-store, max-age=0');
        res.setHeader('ETag', remote.etag);
        return res.end();
      }
      if (remote.etag) res.setHeader('ETag', remote.etag);
      return json(res, 200, remote);
    }

    const limit = req.method === 'PATCH' ? REQUEST_LIMIT : LIMIT;
    if (Number(req.headers['content-length'] || 0) > limit) {
      return json(res, 413, { error: 'Datei zu groß' });
    }
    let input;
    try { input = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
    catch { return json(res, 400, { error: 'Ungültiges JSON' }); }
    if (!input || !validData(input.data) ||
        Buffer.byteLength(JSON.stringify(input), 'utf8') > limit) {
      return json(res, 400, { error: 'Ungültige oder zu große Einträge' });
    }
    if (req.method === 'PATCH') {
      if (!validData(input.base)) return json(res, 400, { error: 'Gemeinsame Ausgangsversion fehlt' });
      const merged = await mergeAndWrite(input.base, input.data);
      return json(res, 200, { ok: true, ...merged });
    }

    // Compatibility for already opened legacy tabs. ETags remain mandatory
    // on overwrites, so an outdated tab cannot silently discard cloud changes.
    if (!etagValid(input.etag ?? null)) return json(res, 400, { error: 'Ungültige Datenversion' });
    try {
      const saved = await writeDocument(input.data, input.etag ?? null);
      return json(res, 200, { ok: true, etag: saved.etag });
    } catch (error) {
      if (isConflict(error)) return json(res, 409, { error: 'Die Daten wurden inzwischen geändert. Seite neu laden.' });
      throw error;
    }
  } catch (error) {
    if (typeof error.status === 'number') {
      if (error.status === 503 || error.status === 502) res.setHeader('Retry-After', '15');
      return json(res, error.status, {
        code: error.code || (error.status === 503 ? 'STORAGE_UNAVAILABLE' : 'STORAGE_ERROR'),
        error: error.status === 503
          ? 'Gleichzeitige Änderungen blockieren derzeit die Speicherung. Lokale Änderungen bleiben erhalten.'
          : error.status === 502
            ? 'Vercel Blob hat die aktuelle Datenversion abgelehnt. Lokale Änderungen bleiben erhalten.'
            : error.status === 413 ? 'Datensatz zu groß' : 'Daten nicht verfügbar'
      });
    }
    console.error('Data operation failed:', error?.name || 'UnknownError');
    return json(res, 500, { error: 'Speichern gerade nicht möglich' });
  }
}
