// Real end-to-end check of the agent path: + Claude tab → give it a task → evict → Haiku tags
// derived from the Claude transcript → restore relaunches with --resume. Uses your Claude login.
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const PORT = 4799, BASE = `http://127.0.0.1:${PORT}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-claude-'));
const proj = path.join(data, 'weather-cli'); fs.mkdirSync(proj);
fs.writeFileSync(path.join(proj, 'README.md'), '# weather-cli\nA tiny CLI that prints the forecast for a city.\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (m, p, b) => fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', 'x-stm': '1' }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
const text = async (id) => (await api('GET', `/api/tabs/${id}/text?lines=400`)).text;
const d = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], { env: { ...process.env, STM_PORT: PORT, STM_DATA_DIR: data, STM_MAX: '2' }, stdio: 'inherit' });
try {
  await sleep(800);
  const tab = await api('POST', '/api/tabs', { claude: true, cwd: proj });
  console.log('claude tab', tab.id, 'session', tab.claude_session_id);
  // Answer first-run prompts (folder trust, bypass-permissions acknowledgement) until the input box is ready.
  for (let i = 0; i < 60; i++) {
    const t = await text(tab.id);
    if (/Bypass Permissions mode/i.test(t) && /Yes, I accept/.test(t)) { await api('POST', `/api/tabs/${tab.id}/input`, { data: '2' }); await sleep(300); await api('POST', `/api/tabs/${tab.id}/input`, { data: '\r' }); }
    else if (/Yes, I trust this folder/.test(t) && /Enter to confirm/.test(t)) { await api('POST', `/api/tabs/${tab.id}/input`, { data: '\x1b[B' }); await sleep(300); await api('POST', `/api/tabs/${tab.id}/input`, { data: '\r' }); }
    else if (/\? for shortcuts|bypass permissions on/i.test(t)) break;
    await sleep(1500);
  }
  console.log('--- screen before task ---\n' + (await text(tab.id)).split('\n').slice(-8).join('\n'));
  await api('POST', `/api/tabs/${tab.id}/input`, { data: 'Read README.md and add a "## Usage" section showing `weather-cli forecast Budapest`. Keep it short.' });
  await sleep(500); await api('POST', `/api/tabs/${tab.id}/input`, { data: '\r' });
  for (let i = 0; i < 120 && !fs.readFileSync(path.join(proj, 'README.md'), 'utf8').includes('Usage'); i++) await sleep(1000);
  console.log('README edited by agent:', fs.readFileSync(path.join(proj, 'README.md'), 'utf8').includes('Usage'));
  await sleep(3000);
  await api('POST', '/api/tabs', { cwd: data }); await api('POST', '/api/tabs', { cwd: data }); // evict claude tab (max=2)
  let item;
  for (let i = 0; i < 90; i++) { item = (await api('GET', '/api/memory')).items.find((x) => x.id === tab.id); if (item && item.tag_status !== 'pending') break; await sleep(1000); }
  console.log(JSON.stringify({ kind: item.kind, title: item.title, tags: item.tags, summary: item.summary, status: item.tag_status, process: item.process }, null, 2));
  // Explicit close kills the process; restoring must relaunch Claude with --resume <session>.
  await api('POST', `/api/memory/${tab.id}/restore`);
  await api('POST', `/api/tabs/${tab.id}/close`);
  await sleep(1500);
  const r = await api('POST', `/api/memory/${tab.id}/restore`);
  console.log('restored; evicted', r.evicted.length);
  const { execSync } = await import('node:child_process');
  let resumed = false;
  for (let i = 0; i < 20 && !resumed; i++) { await sleep(1000); resumed = execSync('ps -A -o args=').toString().includes(`--resume ${tab.claude_session_id}`); }
  console.log('claude relaunched with --resume <same session> after close+restore:', resumed);
  await sleep(6000);
  console.log('screen shows prior conversation:', (await text(tab.id)).includes('Usage'));
} finally {
  await api('POST', '/api/shutdown').catch(() => {}); await sleep(500); d.kill();
  // Don't leave test sessions behind in your real ~/.claude/projects.
  for (const dir of [proj, data]) fs.rmSync(path.join(os.homedir(), '.claude', 'projects', fs.realpathSync(dir).replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true, force: true });
}
