/* Pure three-way merge for concurrent SUD timeline changes.
   No personal data is sent anywhere by this module. */
(function (root) {
  'use strict';
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  function mergeCollection(base, local, remote, fields, type, conflicts) {
    const baseMap = new Map(base.map(item => [item.id, item]));
    const localMap = new Map(local.map(item => [item.id, item]));
    const remoteMap = new Map(remote.map(item => [item.id, item]));
    const ids = new Set([...remoteMap.keys(), ...localMap.keys()]);
    const merged = [];

    for (const id of ids) {
      const before = baseMap.get(id);
      const mine = localMap.get(id);
      const theirs = remoteMap.get(id);
      if (before) {
        // Missing IDs in a whole-document snapshot are NOT deletions.
        // Only explicit deletion operations may remove records.
        // Without this safeguard, an incomplete/stale tab permanently
        // erased records from the shared timeline.
        if (!mine && !theirs) {
          merged.push(before);
          continue;
        }
        if (!mine) {
          merged.push(theirs);
          continue;
        }
        if (!theirs) {
          merged.push(mine);
          continue;
        }
        const next = { id };
        for (const field of fields) {
          const localChanged = !equal(mine[field], before[field]);
          const remoteChanged = !equal(theirs[field], before[field]);
          if (localChanged && remoteChanged && !equal(mine[field], theirs[field])) {
            conflicts.push({ type, id, field });
          }
          next[field] = localChanged ? mine[field] : theirs[field];
        }
        merged.push(next);
      } else if (mine && theirs) {
        // Newly created IDs are UUIDs, so this branch is only a defensive fallback.
        merged.push(mine);
      } else {
        merged.push(mine || theirs);
      }
    }
    return merged;
  }

  function mergeData(base, local, remote) {
    const empty = () => ({ version: 1, events: [], clusters: [] });
    const b = base || empty(), l = local || empty(), r = remote || empty();
    const conflicts = [];
    const clusters = mergeCollection(b.clusters, l.clusters, r.clusters,
      ['name', 'notes', 'color'], 'cluster', conflicts);
    const events = mergeCollection(b.events, l.events, r.events,
      ['age', 'sud', 'title', 'notes', 'clusterIds'], 'event', conflicts);
    const allowed = new Set(clusters.map(c => c.id));
    return {
      data: {
        version: 1,
        events: events.map(ev => ({
          ...ev,
          clusterIds: ev.clusterIds.filter(id => allowed.has(id))
        })),
        clusters
      },
      conflicts
    };
  }

  root.SUDSync = { mergeData, equal };
})(typeof window !== 'undefined' ? window : globalThis);
