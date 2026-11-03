'use strict';
// Pull your existing Claude Code sessions (~/.claude/projects/*/*.jsonl) into long-term memory.
// Only interactive sessions (entrypoint "cli") with at least one real human message are imported;
// SDK/background sessions (claude-mem observers, `claude -p`) are skipped.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { transcriptExcerpt } = require('./procinfo');

const ROOT = process.env.STM_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
  return '';
}
// Sessions run in throwaway temp dirs (scratchpads, test fixtures) can't be resumed and just add noise.
const TEMP_CWD = /^(\/private)?\/(tmp|var\/folders)\//;
const isHuman = (t) => t && !t.startsWith('<') && !t.startsWith('Caveat:') && !t.startsWith('[Request interrupted');

// Cheap single pass over one transcript.
function readMeta(file) {
  const meta = { sessionId: path.basename(file, '.jsonl'), entrypoint: null, cwd: null, branch: null, aiTitle: null, firstAsk: null, humanTurns: 0 };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    // Skip the big, irrelevant entry kinds without JSON-parsing them.
    if (!line.includes('"type":"user"') && !line.includes('"type":"ai-title"') && !line.includes('"entrypoint"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!meta.entrypoint && e.entrypoint) meta.entrypoint = e.entrypoint;
    if (e.cwd && !meta.cwd) meta.cwd = e.cwd;
    if (e.gitBranch) meta.branch = e.gitBranch;
    if (e.type === 'ai-title' && e.aiTitle) meta.aiTitle = e.aiTitle;
    if (e.type === 'user' && !e.isSidechain) {
      const t = textOf(e.message && e.message.content).trim();
      if (isHuman(t)) { meta.humanTurns++; if (!meta.firstAsk) meta.firstAsk = t; }
    }
  }
  return meta;
}

function listTranscripts() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT); } catch { return out; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(ROOT, d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(ROOT, d, f);
      try { out.push({ file, mtime: fs.statSync(file).mtimeMs }); } catch {}
    }
  }
  return out;
}

const seenMtime = new Map(); // file -> mtime we last processed (skip unchanged files on rescans)

/**
 * Scan and upsert. `tabs` is the daemon's Map; `hooks.create(fields)` / `hooks.update(t, fields)` persist.
 * Returns the number of new or changed entries.
 */
function scan(tabs, hooks) {
  const bySession = new Map();
  for (const t of tabs.values()) if (t.claude_session_id) bySession.set(t.claude_session_id, t);
  let changed = 0;
  for (const { file, mtime } of listTranscripts()) {
    if (seenMtime.get(file) === mtime) continue;
    seenMtime.set(file, mtime);
    const sid = path.basename(file, '.jsonl');
    const existing = bySession.get(sid);
    // A tab stm-term itself is running owns its own record; don't fight it.
    if (existing && (existing.state === 'stm' || existing.import_source !== 'claude')) continue;
    if (existing && Math.abs((existing.last_active_at || 0) - mtime) < 2000) continue;
    const meta = readMeta(file);
    if (!meta || meta.entrypoint !== 'cli' || meta.humanTurns === 0 || !meta.cwd) continue;
    if (TEMP_CWD.test(meta.cwd) && !process.env.STM_CLAUDE_PROJECTS) continue;
    const fields = {
      title: meta.aiTitle || meta.firstAsk.split('\n')[0].slice(0, 80),
      cwd: meta.cwd,
      last_active_at: mtime,
      scrollback: transcriptExcerpt(file, 8000),
      branch: meta.branch,
    };
    if (existing) hooks.update(existing, fields);
    else hooks.create({ ...fields, claude_session_id: sid, created_at: mtime });
    changed++;
  }
  return changed;
}

module.exports = { scan, ROOT };
