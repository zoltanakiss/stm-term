'use strict';
// Pull your existing agent sessions (Claude Code, Codex, …) into long-term memory. Only interactive
// sessions with at least one real human message are imported; SDK/exec/background/subagent sessions
// and sessions in temp dirs are skipped.
const path = require('path');
const { agents } = require('./agents');
const { TEMP_CWD } = require('./agents/common');

const seenMtime = new Map(); // file -> mtime last processed (skip unchanged files on rescans)
const sessionIdOf = (file) => path.basename(file, '.jsonl').slice(-36); // both formats end in the uuid

/** Scan every agent and upsert. hooks.create(fields) / hooks.update(t, fields) persist. Returns # changed. */
function scan(tabs, hooks) {
  const bySession = new Map();
  for (const t of tabs.values()) if (t.agent_session_id) bySession.set(t.agent_session_id, t);
  let changed = 0;
  for (const a of Object.values(agents)) {
    for (const { file, mtime } of a.list()) {
      if (seenMtime.get(file) === mtime) continue;
      seenMtime.set(file, mtime);
      const existing = bySession.get(sessionIdOf(file));
      // A tab stm-term itself is running owns its own record; don't fight it.
      if (existing && (existing.state === 'stm' || !existing.import_source)) continue;
      if (existing && Math.abs((existing.last_active_at || 0) - mtime) < 2000) continue;
      const meta = a.readMeta(file);
      if (!meta || !meta.interactive || meta.humanTurns === 0 || !meta.cwd) continue;
      if (TEMP_CWD.test(meta.cwd) && process.env.STM_ALLOW_TEMP_CWD !== '1') continue;
      const fields = {
        title: meta.title || meta.firstAsk.split('\n')[0].slice(0, 80),
        native_title: meta.title || null, // the agent's own title beats ours
        cwd: meta.cwd,
        last_active_at: mtime,
        scrollback: a.excerpt(file, 8000),
      };
      if (existing) hooks.update(existing, fields);
      else hooks.create({ ...fields, kind: a.kind, import_source: a.kind, agent_session_id: meta.sessionId || sessionIdOf(file), created_at: mtime });
      changed++;
    }
  }
  return changed;
}

module.exports = { scan };
