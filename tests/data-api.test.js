import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const item = (id, title = id, notes = '') =>
  ({ id, age: 10, sud: 5, title, notes, clusterIds: [] });
const doc = (events = [], clusters = []) => ({ version: 1, events, clusters });
const empty = () => doc();

function harness() {
  const source = readFileSync(new URL('../api/data.js', import.meta.url), 'utf8')
    .replace(/^import .*?;\s*$/gm, '')
    .replace('export default async function handler', 'async function handler');
  const sync = readFileSync(new URL('../sync-core.js', import.meta.url), 'utf8');
  let stored = null;
  let sequence = 0;
  let failNextWrite = false;
  class BlobPreconditionFailedError extends Error {}

  async function get(path, options) {
    assert.equal(path, 'sud/timeline-v2.json');
    assert.equal(options.useCache, false);
    if (!stored) return null;
    if (stored.etag === options.ifNoneMatch) {
      return { statusCode: 304, stream: null, blob: { etag: stored.etag } };
    }
    return { statusCode: 200, stream: new Response(stored.text).body,
      blob: { etag: stored.etag } };
  }
  async function put(path, payload, options) {
    assert.equal(path, 'sud/timeline-v2.json');
    if (failNextWrite) {
      failNextWrite = false;
      throw new BlobPreconditionFailedError('precondition failed');
    }
    if (stored && options.ifMatch !== stored.etag) {
      throw new BlobPreconditionFailedError('precondition failed');
    }
    if (stored && !options.allowOverwrite) {
      throw new BlobPreconditionFailedError('already exists');
    }
    if (!stored && options.ifMatch) {
      throw new BlobPreconditionFailedError('precondition failed');
    }
    stored = { text: payload, etag: '"' + (++sequence).toString(16) + '"' };
    return { etag: stored.etag };
  }
  const context = {
    Buffer, Response, setTimeout, randomBytes, createCipheriv, createDecipheriv,
    get, put, BlobPreconditionFailedError,
    process: { env: {
      BLOB_READ_WRITE_TOKEN: 'test',
      SUD_SESSION_SECRET: 'test-secret',
      SUD_DATA_KEY: Buffer.alloc(32, 7).toString('base64')
    } },
    readPasswordRecord: async () => ({ version: 'test' }),
    validSession: () => true, rejectCrossOrigin: () => false,
    json(res, code, payload) { res.statusCode = code; res.end(JSON.stringify(payload)); }
  };
  runInNewContext(sync, context);
  runInNewContext(source + '\nglobalThis.serverHandler = handler;', context);

  async function request(method, body = null, headers = {}) {
    const req = { method, body, headers: {
      origin: 'https://sud-livid.vercel.app',
      'content-type': 'application/json', ...headers
    } };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      end(value = '') { this.value = value; }
    };
    await context.serverHandler(req, res);
    return { status: res.statusCode, body: res.value ? JSON.parse(res.value) : null,
      headers: res.headers };
  }
  return { request, get writes() { return sequence; },
    collideOnce() { failNextWrite = true; } };
}

test('server merges independently edited events without returning a browser 409', async () => {
  const api = harness();
  const original = doc([item('a'), item('b')]);
  assert.equal((await api.request('PATCH', { base: empty(), data: original })).status, 200);
  const left = doc([item('a', 'from A'), item('b')]);
  const right = doc([item('a'), item('b', 'from B')]);
  const [a, b] = await Promise.all([
    api.request('PATCH', { base: original, data: left }),
    api.request('PATCH', { base: original, data: right })
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const latest = await api.request('GET');
  assert.deepEqual(latest.body.data.events.map(e => e.title), ['from A', 'from B']);
});

test('same event merges independent fields; replay does not create extra revisions', async () => {
  const api = harness();
  const original = doc([item('a')]);
  await api.request('PATCH', { base: empty(), data: original });
  const first = await api.request('PATCH',
    { base: original, data: doc([item('a', 'title')]) });
  const second = await api.request('PATCH',
    { base: original, data: doc([item('a', 'a', 'notes')]) });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const version = api.writes;
  const replay = await api.request('PATCH',
    { base: original, data: doc([item('a', 'a', 'notes')]) });
  assert.equal(replay.status, 200);
  assert.equal(api.writes, version);
  const latest = await api.request('GET');
  assert.equal(latest.body.data.events[0].title, 'title');
  assert.equal(latest.body.data.events[0].notes, 'notes');
});

test('server retries a storage precondition failure internally', async () => {
  const api = harness();
  api.collideOnce();
  const response = await api.request('PATCH',
    { base: empty(), data: doc([item('added')]) });
  assert.equal(response.status, 200);
  assert.equal((await api.request('GET')).body.data.events.length, 1);
});

test('conditional GET returns 304 only for the current ETag', async () => {
  const api = harness();
  const saved = await api.request('PATCH', { base: empty(), data: doc([item('a')]) });
  assert.equal((await api.request('GET', null, { 'if-none-match': saved.body.etag })).status, 304);
  const altered = await api.request('PATCH',
    { base: doc([item('a')]), data: doc([item('a', 'changed')]) });
  assert.equal(altered.status, 200);
  const fresh = await api.request('GET', null, { 'if-none-match': saved.body.etag });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.data.events[0].title, 'changed');
});
