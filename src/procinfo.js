'use strict';
// Inspect what a tab is actually doing: cwd, child processes, git branch, and — if it's
// running Claude Code — which session and what the agent was asked to do.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const run = (cmd, args, opts = {}) => new Promise((resolve) =>
  execFile(cmd, args, { timeout: 4000, maxBuffer: 16e6, ...opts }, (err, out) => resolve(err ? '' : out)));

async function cwdOf(pid) {
  const out = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const line = out.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

async function descendants(rootPid) {
  const out = await run('ps', ['-A', '-o', 'pid=,ppid=,args=']);
  const procs = out.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], args: m[3] }));
  const result = [];
  const queue = [rootPid];
  while (queue.length) {
    const p = queue.shift();
    for (const c of procs) if (c.ppid === p) { result.push(c); queue.push(c.pid); }
  }
  return result;
}

const isClaude = (args) => /(^|\/)claude(\s|$)/.test(args.split(/\s+/)[0] || '') || /(^|\s)\S*\/claude(\s|$)/.test(args);
const sessionFromArgs = (args) => (args.match(/(?:--resume|--session-id|-r)[ =]([0-9a-f]{8}-[0-9a-f-]{27})/) || [])[1] || null;

const projectDir = (cwd) => path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));

function transcriptPath(cwd, sessionId) {
  const dir = projectDir(cwd);
  if (sessionId) {
    const f = path.join(dir, `${sessionId}.jsonl`);
    return fs.existsSync(f) ? f : null;
  }
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return files[0] ? files[0].f : null;
  } catch { return null; }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
  return '';
}

// First human ask + the recent back-and-forth: that's what tells you why an agent tab mattered.
function transcriptExcerpt(file, budget = 6000) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const read = (start, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, start); return b.toString('utf8'); };
    const parse = (chunk) => chunk.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const msgs = (entries) => entries.filter((e) => e.type === 'user' || e.type === 'assistant')
      .map((e) => ({ role: e.type, text: textOf(e.message && e.message.content).trim() }))
      .filter((m) => m.text && !m.text.startsWith('<') && !m.text.startsWith('Caveat:'));
    const head = msgs(parse(read(0, Math.min(size, 200_000))));
    const tail = msgs(parse(read(Math.max(0, size - 400_000), Math.min(size, 400_000))));
    const first = head.find((m) => m.role === 'user');
    const recent = [];
    let used = 0;
    for (let i = tail.length - 1; i >= 0 && used < budget * 0.7; i--) {
      const t = `${tail[i].role === 'user' ? 'USER' : 'AGENT'}: ${tail[i].text.slice(0, 600)}`;
      recent.unshift(t);
      used += t.length;
    }
    return [first ? `FIRST ASK: ${first.text.slice(0, budget * 0.3)}` : '', 'RECENT:', ...recent].join('\n');
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

async function gitInfo(cwd) {
  if (!cwd) return null;
  const top = (await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])).trim();
  if (!top) return null;
  const branch = (await run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  return { repo: path.basename(top), branch };
}

async function inspect(shellPid, knownSessionId, fallbackCwd) {
  const info = { cwd: fallbackCwd || null, processes: [], claude: null, git: null };
  if (shellPid) {
    info.cwd = (await cwdOf(shellPid)) || info.cwd;
    const kids = await descendants(shellPid);
    info.processes = kids.map((k) => k.args).slice(0, 6);
    const c = kids.find((k) => isClaude(k.args));
    if (c) {
      const ccwd = (await cwdOf(c.pid)) || info.cwd;
      info.claude = { cwd: ccwd, sessionId: sessionFromArgs(c.args) || knownSessionId || null };
    }
  }
  if (!info.claude && knownSessionId && info.cwd) info.claude = { cwd: info.cwd, sessionId: knownSessionId };
  if (info.claude) {
    const file = transcriptPath(info.claude.cwd, info.claude.sessionId);
    if (file) {
      if (!info.claude.sessionId) info.claude.sessionId = path.basename(file, '.jsonl');
      info.claude.transcript = transcriptExcerpt(file);
    }
  }
  info.git = await gitInfo(info.cwd);
  return info;
}

module.exports = { inspect, cwdOf, transcriptExcerpt, projectDir };
