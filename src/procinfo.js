'use strict';
// Inspect what a tab is actually doing: cwd, child processes, git branch, and — if it's running an
// agent (Claude Code, Codex, …) — which session and what the agent was asked to do.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { agents, forProcess } = require('./agents');

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

async function gitInfo(cwd) {
  if (!cwd) return null;
  const top = (await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])).trim();
  if (!top) return null;
  const branch = (await run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  return { repo: path.basename(top), branch };
}

// A Codex started by hand in a plain shell tab still leaves a SessionStart hook record.
const hookRecordKind = (t, sessionsDir) => (sessionsDir && fs.existsSync(path.join(sessionsDir, `${t.id}.codex.json`)) ? 'codex' : null);

async function inspect(shellPid, t, sessionsDir) {
  const info = { cwd: t.cwd || null, processes: [], agent: null, git: null };
  let kind = agents[t.kind] ? t.kind : null;
  let sessionId = t.agent_session_id || null;
  let agentCwd = null;
  if (shellPid) {
    info.cwd = (await cwdOf(shellPid)) || info.cwd;
    const kids = await descendants(shellPid);
    info.processes = kids.map((k) => k.args).slice(0, 6);
    for (const k of kids) {
      const a = forProcess(k.args);
      if (!a) continue;
      if (a.kind !== kind) sessionId = null;
      kind = a.kind;
      sessionId = a.sessionFromArgs(k.args) || sessionId;
      agentCwd = await cwdOf(k.pid);
      break;
    }
  }
  kind = kind || hookRecordKind(t, sessionsDir);
  if (kind) {
    const a = agents[kind];
    const loc = a.locate({ tabId: t.id, sessionsDir, cwd: agentCwd || info.cwd, sessionId });
    info.agent = { kind, label: a.label, sessionId: (loc && loc.sessionId) || sessionId, transcript: loc && loc.file ? a.excerpt(loc.file) : '' };
  }
  info.git = await gitInfo(info.cwd);
  return info;
}

module.exports = { inspect, cwdOf };
