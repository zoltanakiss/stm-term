'use strict';
// OpenAI Codex CLI adapter.
// Codex has no --session-id flag, but it runs Claude-style SessionStart hooks that receive the
// session id. stm-term installs a hook (bin/agent-session-hook.sh) that is a no-op unless
// $STM_TAB_ID is set; inside a tab it records the session for that tab, so resume is exact.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isHuman, runs, walk, headTail, excerptFrom } = require('./common');

const FLAGS = '--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust';
const BIN = process.env.STM_CODEX_BIN || 'codex';
const CMD = process.env.STM_CODEX_CMD || `${BIN} ${FLAGS}`;
const HOME = () => process.env.STM_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const HOOK = path.join(__dirname, '..', '..', 'bin', 'agent-session-hook.sh');

const messages = (entries) => {
  const out = [];
  for (const e of entries) {
    const p = e.payload || {};
    if (e.type === 'event_msg' && p.type === 'user_message' && isHuman(String(p.message || '').trim())) out.push({ role: 'user', text: String(p.message).trim() });
    else if (e.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      const text = (p.content || []).map((c) => c.text || '').join('\n').trim();
      if (text) out.push({ role: 'assistant', text });
    }
  }
  return out;
};

function titles() {
  const map = new Map();
  try {
    for (const line of fs.readFileSync(path.join(HOME(), 'session_index.jsonl'), 'utf8').split('\n')) {
      try { const e = JSON.parse(line); if (e.id && e.thread_name) map.set(e.id, e.thread_name); } catch {}
    }
  } catch {}
  return map;
}

function findById(id) {
  const hit = walk(path.join(HOME(), 'sessions'), 3).find((f) => f.file.endsWith(`-${id}.jsonl`));
  return hit ? hit.file : null;
}

module.exports = {
  kind: 'codex',
  label: 'Codex',
  launch: () => CMD,
  resume: (id) => `${BIN} resume ${id} ${FLAGS}`,
  matches: (args) => runs(args, 'codex') && !/\scodex\s+(exec|e|review|login|mcp)\b/.test(` ${args}`),
  sessionFromArgs: (args) => (args.match(/codex\s+(?:resume|fork)\s+([0-9a-f]{8}-[0-9a-f-]{27})/) || [])[1] || null,

  // Exact via the hook record for this tab (newest wins: resume/fork fire it again), else by id.
  locate({ tabId, sessionsDir, sessionId }) {
    if (tabId && sessionsDir) {
      const f = path.join(sessionsDir, `${tabId}.codex.json`);
      try {
        const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (rec.session_id) return { sessionId: rec.session_id, file: rec.transcript_path || findById(rec.session_id) };
      } catch {}
    }
    if (sessionId) { const file = findById(sessionId); return file ? { sessionId, file } : null; }
    return null;
  },

  excerpt(file, budget = 6000) {
    try {
      const { head, tail } = headTail(file);
      return excerptFrom(messages(head), messages(tail), budget);
    } catch { return ''; }
  },

  list() {
    this._titles = titles(); // refreshed once per scan
    return walk(path.join(HOME(), 'sessions'), 3);
  },

  readMeta(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
    const meta = { sessionId: null, interactive: false, cwd: null, title: null, firstAsk: null, humanTurns: 0 };
    for (const line of raw.split('\n')) {
      if (!line || (!line.includes('"session_meta"') && !line.includes('"user_message"') && !line.includes('"turn_context"'))) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const p = e.payload || {};
      if (e.type === 'session_meta') {
        meta.sessionId = p.id || p.session_id;
        meta.cwd = meta.cwd || p.cwd;
        // codex-tui from the terminal or the VS Code extension = a human session; exec/subagents aren't.
        meta.interactive = /tui/.test(p.originator || '') && (p.source === 'cli' || p.source === 'vscode');
      } else if (e.type === 'turn_context' && !meta.cwd) meta.cwd = p.cwd;
      else if (e.type === 'event_msg' && p.type === 'user_message') {
        const t = String(p.message || '').trim();
        if (isHuman(t)) { meta.humanTurns++; if (!meta.firstAsk) meta.firstAsk = t; }
      }
    }
    if (!meta.sessionId) return null;
    meta.title = (this._titles || titles()).get(meta.sessionId) || null;
    return meta;
  },

  // Idempotently add our SessionStart hook to $CODEX_HOME/hooks.json, preserving anything already there.
  ensureHook() {
    const home = HOME();
    if (!fs.existsSync(home)) return 'no codex home';
    const file = path.join(home, 'hooks.json');
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (fs.existsSync(file)) return `unreadable ${file}; not touching it`; }
    cfg.hooks = cfg.hooks || {};
    const groups = cfg.hooks.SessionStart = cfg.hooks.SessionStart || [];
    if (JSON.stringify(groups).includes('agent-session-hook.sh')) return 'present';
    groups.push({ hooks: [{ type: 'command', command: `${HOOK} codex`, timeout: 5 }] });
    fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
    return 'installed';
  },
};
