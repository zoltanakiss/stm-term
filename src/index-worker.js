'use strict';
// Background indexer for search.sqlite. Runs in a worker thread: the first pass reads every
// transcript (gigabytes), which on the main thread would freeze every terminal while it ran.
// The main thread posts { type: 'scan', sessions: [{ sessionId, kind }] } for the sessions memory
// knows about; we index the newest first and post progress back.
const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const { agents } = require('./agents');
const search = require('./search');

const db = search.open(workerData.file);
const sessionIdOf = (file) => path.basename(file, '.jsonl').slice(-36);
let pending = null;
let running = false;

function filesByKind() {
  const map = new Map(); // sessionId -> { file, mtime, kind }
  for (const a of Object.values(agents)) {
    for (const { file, mtime } of a.list()) {
      const id = sessionIdOf(file);
      const prev = map.get(id);
      if (!prev || prev.mtime < mtime) map.set(id, { file, mtime, kind: a.kind });
    }
  }
  return map;
}

async function scan(sessions) {
  running = true;
  const t0 = Date.now();
  const files = filesByKind();
  const work = sessions.map((s) => ({ ...s, ...(files.get(s.sessionId) || {}) })).filter((s) => s.file)
    .sort((a, b) => b.mtime - a.mtime);
  let done = 0;
  let bytes = 0;
  for (const s of work) {
    try { bytes += search.indexFile(db, s); } catch (e) { parentPort.postMessage({ type: 'error', sessionId: s.sessionId, error: String(e.message || e) }); }
    done++;
    if (done % 25 === 0) parentPort.postMessage({ type: 'progress', done, total: work.length });
    if (pending) break; // a newer scan request supersedes this one; it covers the same sessions
    await new Promise((r) => setImmediate(r));
  }
  parentPort.postMessage({ type: 'scanned', done, total: work.length, bytes, ms: Date.now() - t0, ...search.stats(db) });
  running = false;
  if (pending) { const next = pending; pending = null; scan(next); }
}

parentPort.on('message', (m) => {
  if (m.type === 'scan') {
    if (running) pending = m.sessions;
    else scan(m.sessions);
  } else if (m.type === 'forget') {
    search.removeSession(db, m.sessionId);
  }
});
