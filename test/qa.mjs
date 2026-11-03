// Agent-native QA: spins up an isolated daemon (own port, own temp data dir) and drives the UI
// in a headless Chromium. Nothing appears on screen and nothing touches your real ~/.stm-term.
//   node test/qa.mjs            fake tagger (fast, deterministic)
//   STM_QA_REAL=1 node test/qa.mjs   real Haiku tagging via `claude -p`
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4800 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const ART = path.join(ROOT, '.qa-artifacts');
const REAL = !!process.env.STM_QA_REAL;
fs.mkdirSync(ART, { recursive: true });

let data = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-qa-'));
// Fixture Claude Code transcripts: one interactive session (should import), one SDK session (should not).
const FIX_SID = '11111111-2222-4333-8444-555555555555';
const fixDir = path.join(data, 'claude-projects', '-fixture-foxtrot');
fs.mkdirSync(fixDir, { recursive: true });
const line = (o) => JSON.stringify(o) + '\n';
fs.writeFileSync(path.join(fixDir, `${FIX_SID}.jsonl`),
  line({ type: 'user', entrypoint: 'cli', cwd: '/tmp/foxtrot-billing', sessionId: FIX_SID, gitBranch: 'main', message: { role: 'user', content: 'Migrate foxtrot billing webhooks to the new queue' } })
  + line({ type: 'assistant', entrypoint: 'cli', cwd: '/tmp/foxtrot-billing', sessionId: FIX_SID, message: { role: 'assistant', content: [{ type: 'text', text: 'Moved the webhook handler onto the queue; tests pass.' }] } })
  + line({ type: 'ai-title', aiTitle: 'Foxtrot billing webhook queue migration', sessionId: FIX_SID }));
fs.writeFileSync(path.join(fixDir, '99999999-2222-4333-8444-555555555555.jsonl'),
  line({ type: 'user', entrypoint: 'sdk-cli', cwd: '/tmp/observer', message: { role: 'user', content: 'background observer prompt' } }));
let daemon;
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (method, p, body) => fetch(BASE + p, { method, headers: { 'content-type': 'application/json', 'x-stm': '1' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
async function until(fn, ms = 15000, step = 150) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(step); }
  return last;
}

function startDaemon() {
  daemon = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    cwd: ROOT, env: { ...process.env, STM_PORT: String(PORT), STM_DATA_DIR: data, STM_TAGGER: REAL ? 'claude' : 'fake', STM_SHELL: '/bin/zsh', STM_CLAUDE_PROJECTS: path.join(data, 'claude-projects') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stderr.on('data', (d) => process.stderr.write(`[daemon] ${d}`));
  return until(() => fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false), 10000);
}
async function stopDaemon() {
  await api('POST', '/api/shutdown').catch(() => {});
  await new Promise((r) => daemon.once('exit', r));
}

async function main() {
  await startDaemon();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.goto(BASE);
  await page.waitForSelector('#empty:not([hidden])');
  check('empty state shown on fresh data dir', true);

  // 0. Existing Claude Code sessions are imported into long-term memory (interactive only).
  const imported = await until(async () => {
    const m = await api('GET', '/api/memory');
    return m.items.length >= 1 && m.items.every((x) => x.tag_status === 'done') && m.items;
  }, REAL ? 60000 : 8000);
  const fx = imported && imported.find((x) => x.claude_session_id === FIX_SID);
  check('interactive Claude session imported + tagged, SDK session skipped', imported && imported.length === 1 && !!fx && fx.tags.length > 0,
    imported ? `${imported.length} item(s): "${fx && fx.title}" [${fx && fx.tags.join(', ')}]` : 'timeout');
  check('imported session keeps Claude ai-title', fx && fx.title === 'Foxtrot billing webhook queue migration');
  await page.fill('[data-testid=ltm-search]', 'webhook queue');
  await until(async () => (await page.locator('[data-testid=memory-item]').count()) === 1, 3000);
  check('search finds imported session by transcript text', await page.locator(`[data-testid=memory-item][data-id="${fx && fx.id}"]`).count() === 1);
  await page.fill('[data-testid=ltm-search]', '');

  // 1. Open 5 shells through the UI, each in a distinct project dir, tag each with a marker.
  const dirs = ['alpha-api', 'bravo-web', 'charlie-infra', 'delta-docs', 'echo-ml'].map((n) => {
    const d = path.join(data, 'projects', n); fs.mkdirSync(d, { recursive: true }); return d;
  });
  const ids = [];
  for (let i = 0; i < 5; i++) {
    await page.click('[data-testid=new-shell]');
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid=stm-tab]').length === n, i + 1);
    const st = await api('GET', '/api/state');
    const id = st.focusedId;
    ids.push(id);
    // Type through the real xterm (keyboard → websocket → pty), not the API.
    await page.locator(`.term[data-tab-id="${id}"] .xterm-helper-textarea`).focus();
    await page.keyboard.type(`cd ${dirs[i]} && echo MARKER-${i}-$((6*7))\n`);
    const ok = await until(async () => (await api('GET', `/api/tabs/${id}/text`)).text.includes(`MARKER-${i}-42`));
    check(`tab ${i + 1}: typed command ran in pty`, !!ok);
  }
  const st5 = await api('GET', '/api/state');
  check('5 tabs open, slots full', st5.stm.length === 5, `${st5.stm.length}/${st5.max}`);
  check('UI renders xterm output', await page.locator(`.term[data-tab-id="${ids[4]}"]`).innerText().then((t) => t.includes('MARKER-4-42')));

  // 2. Touch tabs so tab[2] is the stalest: focus order 0,1,3,4 (2 untouched since creation... 0 & 1 refreshed after it).
  for (const i of [0, 1, 3, 4]) { await page.click(`[data-testid=stm-tab][data-id="${ids[i]}"]`); await sleep(60); }
  const stTouched = await api('GET', '/api/state');
  check('"next out" marker on the stalest tab', stTouched.nextToEvict === ids[2] && await page.locator(`[data-testid=stm-tab][data-id="${ids[2]}"] [data-testid=next-evict]`).count() === 1);
  await page.screenshot({ path: path.join(ART, '01-five-tabs.png') });

  // Start a long-running process in the soon-to-be-evicted tab to prove it survives eviction.
  await api('POST', `/api/tabs/${ids[2]}/input`, { data: 'for i in $(seq 1 600); do echo tick-$i; sleep 0.2; done\n' });
  await sleep(800);

  // 3. Open a 6th → stalest moves to long-term memory, gets tagged, process keeps running.
  await page.click('[data-testid=new-shell]');
  const st6 = await until(async () => { const s = await api('GET', '/api/state'); return s.stm.length === 5 && !s.stm.find((t) => t.id === ids[2]) && s; });
  check('6th tab evicts the stalest (tab 3) and keeps 5', !!st6);
  await page.waitForSelector(`[data-testid=memory-item][data-id="${ids[2]}"]`);
  check('evicted tab appears in long-term memory sidebar', true);
  const tagged = await until(async () => {
    const m = await api('GET', '/api/memory');
    const it = m.items.find((x) => x.id === ids[2]);
    return it && it.tag_status === 'done' && it;
  }, REAL ? 90000 : 10000);
  check('evicted tab gets tags', tagged && tagged.tag_status === 'done' && tagged.tags.length >= 2, tagged ? `${tagged.tag_status}: [${tagged.tags.join(', ')}] "${tagged.title}" — ${tagged.summary}` : 'timeout');
  check('evicted tab cwd captured', tagged && tagged.cwd && tagged.cwd.endsWith('charlie-infra'), tagged && tagged.cwd);
  const t1 = (await api('GET', `/api/tabs/${ids[2]}/text`)).text.match(/tick-(\d+)/g) || [];
  await sleep(1200);
  const t2 = (await api('GET', `/api/tabs/${ids[2]}/text`)).text.match(/tick-(\d+)/g) || [];
  check('evicted process still running in background', t2.length > t1.length && tagged.process === 'running', `${t1.at(-1)} → ${t2.at(-1)}`);
  await page.waitForSelector(`[data-testid=memory-item][data-id="${ids[2]}"] [data-testid=mem-tag]`);
  await page.screenshot({ path: path.join(ART, '02-evicted-tagged.png') });

  // 4. Search + tag filter.
  await page.fill('[data-testid=ltm-search]', 'charlie');
  await until(async () => (await page.locator('[data-testid=memory-item]').count()) === 1, 3000);
  check('search "charlie" finds the evicted tab', await page.locator(`[data-testid=memory-item][data-id="${ids[2]}"]`).count() === 1);
  await page.fill('[data-testid=ltm-search]', 'zzz-nothing-matches');
  await until(async () => (await page.locator('[data-testid=memory-item]').count()) === 0, 3000);
  check('search with no match shows empty list', await page.locator('[data-testid=memory-item]').count() === 0);
  await page.fill('[data-testid=ltm-search]', '');
  await page.waitForSelector(`[data-testid=memory-item][data-id="${ids[2]}"]`);

  // Evict a second tab so tag filtering has something to exclude.
  await page.click('[data-testid=new-shell]');
  await until(async () => (await api('GET', '/api/memory')).items.filter((x) => x.tag_status === 'done').length === 3, REAL ? 90000 : 10000);
  const mem2 = await api('GET', '/api/memory');
  const target = mem2.items.find((x) => x.id === ids[2]);
  const others = mem2.items.filter((x) => x.id !== ids[2]);
  const uniqueTag = target.tags.find((g) => others.every((o) => !o.tags.includes(g)));
  await page.waitForSelector(`[data-testid=memory-item][data-id="${ids[2]}"] [data-testid=mem-tag]`);
  await page.locator(`[data-testid=memory-item][data-id="${ids[2]}"] [data-testid=mem-tag]`, { hasText: uniqueTag }).first().click();
  await until(async () => (await page.locator('[data-testid=memory-item]').count()) === 1, 3000);
  const filtered = await page.locator('[data-testid=memory-item]').evaluateAll((els) => els.map((e) => e.dataset.id));
  check(`clicking tag "${uniqueTag}" filters memory`, filtered.length === 1 && filtered[0] === ids[2] && await page.locator('#filter:not([hidden])').count() === 1, `${filtered.length} item(s)`);
  await page.screenshot({ path: path.join(ART, '03-tag-filter.png') });
  await page.click('[data-testid=tag-filter]');
  await until(async () => (await page.locator('[data-testid=memory-item]').count()) === 3, 3000);
  check('clearing tag filter shows all', await page.locator('[data-testid=memory-item]').count() === 3);

  // 5. Click a memory → it comes back to short-term, stalest goes out, live process reattaches.
  const before = await api('GET', '/api/state');
  const expectedOut = before.nextToEvict;
  await page.click(`[data-testid=memory-item][data-id="${ids[2]}"]`);
  const after = await until(async () => { const s = await api('GET', '/api/state'); return s.stm.some((t) => t.id === ids[2]) && s; });
  check('clicking memory restores it to short-term (focused)', after && after.focusedId === ids[2]);
  check('restore evicts the then-stalest tab', after && !after.stm.some((t) => t.id === expectedOut) && after.stm.length === 5);
  const restoredText = await until(async () => {
    const txt = await page.locator(`.term[data-tab-id="${ids[2]}"]`).innerText();
    return /tick-\d+/.test(txt) && txt.includes('MARKER-2-42') && txt;
  }, 5000);
  check('restored tab shows live output + earlier history', !!restoredText);
  await page.screenshot({ path: path.join(ART, '04-restored.png') });

  // 6. Close a tab explicitly → archived + process killed.
  const closeId = after.stm.find((t) => t.id !== ids[2]).id;
  await page.click(`[data-testid=stm-tab][data-id="${closeId}"] [data-testid=close-tab]`);
  const closed = await until(async () => (await api('GET', '/api/memory')).items.find((x) => x.id === closeId && x.process === 'snapshot'));
  check('closing a tab archives it with process stopped', !!closed);

  // 7. Daemon restart: short-term tabs come back from snapshot with fresh shells.
  await stopDaemon();
  await startDaemon();
  await page.reload();
  const rst = await until(async () => { const s = await api('GET', '/api/state'); return s.stm.length === 4 && s; });
  check('after daemon restart, 4 short-term tabs restored', !!rst, rst && `${rst.stm.length}`);
  const restoredAfter = await until(async () => {
    const txt = await page.locator(`.term[data-tab-id="${ids[2]}"]`).innerText().catch(() => '');
    return txt.includes('MARKER-2-42') && txt.includes('restored from long-term memory');
  }, 8000);
  check('snapshot replayed after restart', !!restoredAfter);
  const memAfter = await api('GET', '/api/memory');
  check('long-term memory persisted across restart (no duplicate imports)', memAfter.items.length === 4, `${memAfter.items.length} items`);

  // Forgetting an imported session sticks across rescans/restarts.
  await api('DELETE', `/api/memory/${fx.id}`);
  await stopDaemon(); await startDaemon();
  await sleep(1500);
  const memForgot = await api('GET', '/api/memory');
  check('forgotten imported session is not re-imported', !memForgot.items.some((x) => x.claude_session_id === FIX_SID), `${memForgot.items.length} items`);
  await page.reload();

  // 8. Security: cross-site mutation without the header is refused; foreign Host is refused.
  const noHeader = await fetch(`${BASE}/api/tabs`, { method: 'POST', body: '{}' });
  check('mutation without x-stm header refused', noHeader.status === 403);
  const badHost = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', headers: { host: 'evil.example' } },
    (res) => { res.resume(); resolve({ status: res.statusCode }); }).on('error', () => resolve({ status: 0 })));
  check('foreign Host header refused', badHost.status === 403);

  await page.screenshot({ path: path.join(ART, '05-after-restart.png') });
  check('no browser console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  await browser.close();
  await stopDaemon();
}

main().catch((e) => { check('harness crashed', false, e.stack); })
  .finally(() => {
    try { daemon && daemon.kill(); } catch {}
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${ART}`);
    fs.writeFileSync(path.join(ART, 'results.json'), JSON.stringify(results, null, 2));
    process.exit(failed.length ? 1 : 0);
  });
