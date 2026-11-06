import test from 'node:test';
import assert from 'node:assert/strict';
import '../sync-core.js';

const { mergeData } = globalThis.SUDSync;
const event = (id, title = id, notes = '') => ({
  id, age: 10, sud: 5, title, notes, clusterIds: []
});
const doc = (events = [], clusters = []) => ({ version: 1, events, clusters });

test('edits to different events survive concurrent writes', () => {
  const base = doc([event('a'), event('b')]);
  const local = doc([event('a', 'edited locally'), event('b')]);
  const remote = doc([event('a'), event('b', 'edited remotely')]);
  const merged = mergeData(base, local, remote);
  assert.deepEqual(merged.data.events.map(e => e.title), ['edited locally', 'edited remotely']);
  assert.equal(merged.conflicts.length, 0);
});

test('different fields on the same event are merged', () => {
  const base = doc([event('a')]);
  const local = doc([event('a', 'new title')]);
  const remote = doc([event('a', 'a', 'remote note')]);
  const merged = mergeData(base, local, remote);
  assert.equal(merged.data.events[0].title, 'new title');
  assert.equal(merged.data.events[0].notes, 'remote note');
  assert.deepEqual(merged.conflicts, []);
});

test('same field collision is detected and the latest local save wins', () => {
  const base = doc([event('a')]);
  const result = mergeData(base, doc([event('a', 'local')]), doc([event('a', 'remote')]));
  assert.equal(result.data.events[0].title, 'local');
  assert.deepEqual(result.conflicts, [{ type: 'event', id: 'a', field: 'title' }]);
});

test('remote deletion is not undone by a stale local change', () => {
  const base = doc([event('a')]);
  assert.deepEqual(mergeData(base, doc([event('a', 'stale change')]), doc()).data.events, []);
});

test('local deletion wins even if another user modified the event', () => {
  const base = doc([event('a')]);
  assert.deepEqual(mergeData(base, doc(), doc([event('a', 'changed')])).data.events, []);
});

test('simultaneous additions keep both UUIDs', () => {
  const base = doc();
  const merged = mergeData(base, doc([event('local')]), doc([event('remote')]));
  assert.deepEqual(merged.data.events.map(e => e.id), ['remote', 'local']);
});

test('removed clusters are stripped from event relationships', () => {
  const cluster = { id: 'group', name: 'Group', notes: '', color: '#ef8682' };
  const ev = { ...event('a'), clusterIds: ['group'] };
  const base = doc([ev], [cluster]);
  const merged = mergeData(base, base, doc([ev]));
  assert.equal(merged.data.clusters.length, 0);
  assert.deepEqual(merged.data.events[0].clusterIds, []);
});

test('unchanged merged document is byte-for-byte equivalent to canonical input', () => {
  const base = doc([event('a')]);
  const next = mergeData(base, base, base).data;
  assert.equal(JSON.stringify(next), JSON.stringify(base));
});
