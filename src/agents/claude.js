'use strict';
// Claude Code adapter.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isHuman, runs, walk, headTail, excerptFrom } = require('./common');

const CMD = process.env.STM_CLAUDE_CMD || 'claude --chrome --dangerously-skip-permissions';
const ROOT = () => process.env.STM_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const projectDir = (cwd) => path.join(ROOT(), cwd.replace(/[^a-zA-Z0-9]/g, '-'));

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
  return '';
}
const messages = (entries) => entries.filter((e) => (e.type === 'user' || e.type === 'assistant') && !e.isSidechain)
  .map((e) => ({ role: e.type, text: textOf(e.message && e.message.content).trim() }))
  .filter((m) => isHuman(m.text) || (m.role === 'assistant' && m.text));

module.exports = {
  kind: 'claude',
  label: 'Claude',
  // We pick the session id up front, so resume is exact.
  launch(t) {
    t.agent_session_id = t.agent_session_id || crypto.randomUUID();
    return `${CMD} --session-id ${t.agent_session_id}`;
  },
  resume: (id) => `${CMD} --resume ${id}`,
  matches: (args) => runs(args, 'claude'),
  sessionFromArgs: (args) => (args.match(/(?:--resume|--session-id|-r)[ =]([0-9a-f]{8}-[0-9a-f-]{27})/) || [])[1] || null,

  // Find the transcript for a tab: exact by id, else the newest one for that cwd.
  locate({ cwd, sessionId }) {
    if (!cwd) return null;
    const dir = projectDir(cwd);
    if (sessionId) {
      const f = path.join(dir, `${sessionId}.jsonl`);
      return fs.existsSync(f) ? { sessionId, file: f } : null;
    }
    const newest = walk(dir, 0).sort((a, b) => b.mtime - a.mtime)[0];
    return newest ? { sessionId: path.basename(newest.file, '.jsonl'), file: newest.file } : null;
  },

  excerpt(file, budget = 6000) {
    try {
      const { head, tail } = headTail(file);
      return excerptFrom(messages(head), messages(tail), budget);
    } catch { return ''; }
  },

  list: () => walk(ROOT(), 1),

  // Single cheap pass; skips the big irrelevant entries without JSON-parsing them.
  readMeta(file) {
    const meta = { sessionId: path.basename(file, '.jsonl'), interactive: false, cwd: null, title: null, firstAsk: null, humanTurns: 0 };
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
    let entrypoint = null;
    for (const line of raw.split('\n')) {
      if (!line || (!line.includes('"type":"user"') && !line.includes('"type":"ai-title"') && !line.includes('"entrypoint"'))) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (!entrypoint && e.entrypoint) entrypoint = e.entrypoint;
      if (e.cwd && !meta.cwd) meta.cwd = e.cwd;
      if (e.type === 'ai-title' && e.aiTitle) meta.title = e.aiTitle;
      if (e.type === 'user' && !e.isSidechain) {
        const t = textOf(e.message && e.message.content).trim();
        if (isHuman(t)) { meta.humanTurns++; if (!meta.firstAsk) meta.firstAsk = t; }
      }
    }
    meta.interactive = entrypoint === 'cli'; // "sdk-cli" = claude -p / SDK / observers
    return meta;
  },
};
