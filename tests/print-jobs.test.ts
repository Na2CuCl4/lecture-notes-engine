import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import ts from 'typescript';
import { Window } from 'happy-dom';
import * as printJobs from '../site/src/scripts/print-jobs.js';

const script = ts.transpileModule(readFileSync(new URL('../site/src/scripts/global-ui.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
}).outputText;
const first = { id: 'calculus', title: '微积分', basePath: '/calculus/' };
const second = { id: 'advanced', title: '高等微积分', basePath: '/advanced/' };
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const saved = (id: string, state: printJobs.JobState = 'queued', project = first, savedAt = Date.now() - 1000): printJobs.SavedPrintJob => ({
  id, title: `题单 ${id}`, project, state, createdAt: new Date(savedAt).toISOString(), savedAt, failures: 0,
});
const history = (jobs: printJobs.SavedPrintJob[], clearedAt = 0): printJobs.PrintHistory => ({ version: 1, clearedAt, jobs });
async function until(predicate: () => boolean, description: string) {
  for (let count = 0; count < 100; count++) { if (predicate()) return; await nextTurn(); }
  assert.fail(description);
}

// Run the real controller against a DOM. Its timers use a controllable clock;
// tests never wait for the real polling or retry intervals, or inspect visuals.
function fixture(options: {
  raw?: string; portal?: boolean; project?: printJobs.JobProject; hidden?: boolean;
  legacy?: Record<string, unknown>; fetch?: (url: string) => Promise<Response>;
} = {}) {
  const window = new Window({ url: `https://notes.example${options.portal ? '/' : (options.project || first).basePath}` });
  const app = window as any;
  let now = Date.now();
  let token = 0;
  let hidden = options.hidden || false;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const requests: string[] = [];
  app.exports = {};
  app.require = (name: string) => name === './print-jobs' ? printJobs : assert.fail(`Unexpected module ${name}`);
  // Mock fetch does not use the deadline. Keep those abort timers separate
  // from the application's polling timers inspected by these tests.
  app.AbortSignal = globalThis.AbortSignal;
  app.Date = class extends Date { static now() { return now; } };
  app.setTimeout = (callback: () => void, delay = 0) => { const id = ++token; timers.set(id, { at: now + delay, callback }); return id; };
  app.clearTimeout = (id: number) => { timers.delete(id); };
  Object.defineProperty(window.document, 'hidden', { get: () => hidden });
  const config = { portal: options.portal || false, ...(options.portal ? {} : { project: options.project || first }) };
  window.document.body.innerHTML = `<header><details data-project-picker hidden><summary>项目</summary><nav data-project-links></nav></details><a data-project-fallback>课程</a><button data-print-history-open>打印状态<span data-print-status-count hidden></span></button></header>
    <dialog data-print-history-dialog><button data-print-history-close>关闭</button><div data-print-history-list></div><p data-print-history-error hidden></p><button data-print-history-clear>清空</button></dialog>
    ${options.portal ? '<main><h1 data-portal-title>项目</h1><p data-project-loading></p><p data-project-error hidden><button data-project-retry>重试</button></p><p data-project-empty hidden>暂无项目</p><div data-project-list></div></main>' : ''}
    <script id="global-client-config" type="application/json">${JSON.stringify(config)}</script>`;
  if (options.raw) window.localStorage.setItem(printJobs.PRINT_HISTORY_KEY, options.raw);
  for (const [key, value] of Object.entries(options.legacy || {})) window.sessionStorage.setItem(key, JSON.stringify(value));
  app.fetch = async (input: string) => {
    const url = String(input); requests.push(url);
    if (options.fetch) return options.fetch(url);
    if (url === '/_engine/projects') return jsonResponse({ title: '课程项目', isMultiProject: true, projects: [first, second] });
    return new Response('missing', { status: 404 });
  };
  vm.runInContext(script, vm.createContext(window), { filename: 'global-ui.ts' });
  const $ = (selector: string) => window.document.querySelector(selector)! as any;
  const persisted = () => printJobs.restorePrintHistory(window.localStorage.getItem(printJobs.PRINT_HISTORY_KEY));
  const runTimer = () => {
    const entry = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    assert.ok(entry, 'expected a pending polling timer');
    timers.delete(entry[0]); now = Math.max(now, entry[1].at); entry[1].callback();
  };
  const delay = () => Math.min(...[...timers.values()].map(value => value.at - now));
  const stored = (value: printJobs.PrintHistory) => {
    window.localStorage.setItem(printJobs.PRINT_HISTORY_KEY, JSON.stringify(value));
    window.dispatchEvent(new window.StorageEvent('storage', { key: printJobs.PRINT_HISTORY_KEY }));
  };
  app.exports.startGlobalUI();
  return {
    window, $, requests, persisted, runTimer, delay, stored,
    register: app.exports.registerPrintJob as (result: printJobs.PrintResult, fallback: { title: string; project: printJobs.JobProject }) => boolean,
    hide(value: boolean) { hidden = value; window.document.dispatchEvent(new window.Event('visibilitychange')); },
    close: async () => { timers.clear(); await window.happyDOM.close(); },
  };
}

test('print history rejects malformed entries, bounds cached values, and respects clear tombstones', () => {
  assert.deepEqual(printJobs.restorePrintHistory('{broken'), history([]));
  assert.deepEqual(printJobs.restorePrintHistory(JSON.stringify({ version: 99, jobs: [saved('one')] })), history([]));
  const one = saved('one');
  const parsed = printJobs.restorePrintHistory(JSON.stringify(history([
    { ...one, title: 'a'.repeat(400), failures: 999 }, one,
    { ...saved('unsafe'), id: '../other' },
    { ...saved('external'), project: { ...first, basePath: '//other.example/' } },
    { ...saved('traversal'), project: { ...first, basePath: '/one/../two/' } },
    { ...saved('future'), savedAt: Date.now() + 172800000 },
    { ...saved('invalid-state'), state: 'unknown' as any },
  ])));
  assert.equal(parsed.jobs.length, 1);
  assert.equal(parsed.jobs[0].title.length, 250);
  assert.equal(parsed.jobs[0].failures, 8);
  const cleared = printJobs.mergePrintHistory(history([one]), history([], one.savedAt));
  assert.deepEqual(cleared.jobs, []);
  assert.equal(cleared.clearedAt, one.savedAt);
  const fresh = { ...one, savedAt: one.savedAt + 1, state: 'succeeded' as const };
  assert.deepEqual(printJobs.mergePrintHistory(cleared, history([fresh])).jobs, [fresh]);
  assert.equal(printJobs.printPollDelay(0, false), 3000);
  assert.equal(printJobs.printPollDelay(1, false), 6000);
  assert.equal(printJobs.printPollDelay(0, true), 30000);
  assert.equal(printJobs.printPollDelay(8, false), 60000);
  const fallback = { title: '第一章', project: first };
  for (const error of ['PDF 缓存已过期，请重新提交打印任务。', 'PDF 已缺失，请重新生成。']) {
    assert.equal(printJobs.savedPrintJob({ job: { id: 'old-pdf', state: 'failed', error } }, fallback)?.state, 'expired');
  }
  assert.equal(printJobs.savedPrintJob({ job: { id: 'compiler-error', state: 'failed', error: '排版失败' } }, fallback)?.state, 'failed');
  const many = Array.from({ length: 60 }, (_, index) => saved(`job-${index}`, 'succeeded', first, one.savedAt + index));
  assert.equal(printJobs.restorePrintHistory(JSON.stringify(history(many))).jobs.length, printJobs.MAX_PRINT_HISTORY);
});

test('registered tasks survive navigation across projects and only registered IDs are queried', async () => {
  let state = 'running';
  const app = fixture({ fetch: async url => url === '/_engine/projects' ? jsonResponse({ projects: [] }) : jsonResponse({ job: { id: 'task-one', state }, title: '服务器原始题单', downloadUrl: 'https://evil.example/file.pdf' }) });
  let raw: string;
  try {
    app.register({ job: { id: 'task-one', state: 'queued' }, title: '服务器原始题单' }, { title: '第一章', project: first });
    app.register({ job: { id: 'task-two', state: 'succeeded' } }, { title: '<img src=x onerror=alert(1)>', project: second });
    assert.equal(app.$('[data-print-status-count]').textContent, '1');
    app.runTimer();
    await until(() => app.persisted().jobs.find(job => job.id === 'task-one')?.state === 'running', 'running state must persist');
    assert.equal(app.delay(), 3000);
    state = 'succeeded'; app.runTimer();
    await until(() => app.persisted().jobs.every(job => job.state === 'succeeded'), 'completion must persist');
    assert.equal(app.$('[data-print-status-count]').textContent, '可下载');
    assert.equal(app.persisted().jobs.find(job => job.id === 'task-one')!.title, '第一章', 'polling preserves the chapter-specific title chosen at submission');
    assert.equal(app.window.document.querySelectorAll('img').length, 0, 'task titles are text, not HTML');
    assert.equal(app.$('[data-print-job-id="task-one"] a').getAttribute('href'), '/_engine/jobs/task-one/pdf');
    assert.deepEqual(app.requests.filter(url => url.includes('/jobs')), ['/_engine/jobs/task-one', '/_engine/jobs/task-one']);
    assert.equal(app.delay(), Infinity, 'finished tasks are not continuously polled');
    raw = app.window.localStorage.getItem(printJobs.PRINT_HISTORY_KEY)!;
  } finally { await app.close(); }
  const anotherPage = fixture({ project: second, raw: raw! });
  try {
    assert.deepEqual(anotherPage.persisted().jobs.map(job => job.id).sort(), ['task-one', 'task-two']);
    assert.equal(anotherPage.window.document.querySelectorAll('[data-print-job-id]').length, 2);
    assert.equal(anotherPage.$('[data-print-job-id="task-one"] .print-job-project').textContent, first.title);
    assert.equal(anotherPage.delay(), Infinity);
  } finally { await anotherPage.close(); }
});

test('legacy session tasks migrate once into shared persistent history', async () => {
  const key = 'lecture-notes-jobs:/calculus:revision-a';
  const app = fixture({ raw: JSON.stringify(history([saved('existing', 'succeeded')])), legacy: {
    [key]: [{ job: { id: 'legacy-task', state: 'queued' }, title: '旧题单' }, { job: { id: '../invalid', state: 'queued' } }],
    'lecture-notes-jobs:/advanced:revision-b': [{ job: { id: 'existing', state: 'queued' } }],
  } });
  try {
    assert.deepEqual(app.persisted().jobs.map(job => job.id).sort(), ['existing', 'legacy-task']);
    assert.deepEqual(app.persisted().jobs.find(job => job.id === 'legacy-task')!.project, first);
    assert.equal(app.persisted().jobs.find(job => job.id === 'existing')!.state, 'succeeded');
    assert.equal(app.window.sessionStorage.getItem(key), null);
    assert.equal(app.$('[data-print-status-count]').textContent, '1');
  } finally { await app.close(); }
});

test('failed, missing, and expired jobs become terminal without repeated polling', async () => {
  const app = fixture({ raw: JSON.stringify(history(['failed', 'missing', 'expired'].map(id => saved(id)))), fetch: async url => {
    if (url === '/_engine/projects') return jsonResponse({ projects: [] });
    if (url.endsWith('/failed')) return jsonResponse({ job: { id: 'failed', state: 'failed' } });
    return new Response('', { status: url.endsWith('/missing') ? 404 : 410 });
  } });
  try {
    app.runTimer();
    await until(() => app.persisted().jobs.every(job => !printJobs.pendingPrintJob(job)), 'terminal states should settle');
    assert.deepEqual(Object.fromEntries(app.persisted().jobs.map(job => [job.id, job.state])), { expired: 'expired', failed: 'failed', missing: 'expired' });
    assert.equal(app.delay(), Infinity);
    const count = app.requests.length;
    app.$('[data-print-history-open]').click();
    await nextTurn();
    assert.equal(app.requests.length, count, 'opening history does not retry terminal failures');
    assert.equal(app.$('[data-print-history-dialog]').open, true);
    app.$('[data-print-history-close]').click();
    assert.equal(app.$('[data-print-history-dialog]').open, false);
  } finally { await app.close(); }
});

test('clearing history during a status fetch cannot resurrect the completed task', async () => {
  let release!: (response: Response) => void;
  const app = fixture({ raw: JSON.stringify(history([saved('slow')])), fetch: url => url === '/_engine/projects' ? Promise.resolve(jsonResponse({ projects: [] })) : new Promise(resolve => { release = resolve; }) });
  try {
    app.runTimer();
    assert.ok(release);
    app.$('[data-print-history-clear]').click();
    const clearedAt = app.persisted().clearedAt;
    release(jsonResponse({ job: { id: 'slow', state: 'succeeded' } }));
    await nextTurn(); await nextTurn();
    assert.deepEqual(app.persisted().jobs, []);
    assert.equal(app.persisted().clearedAt, clearedAt);
    assert.equal(app.window.document.querySelectorAll('[data-print-job-id]').length, 0);
    assert.equal(app.delay(), Infinity);
  } finally { await app.close(); }
});

test('cross-tab storage merges terminal submissions back to disk and preserves a remote clear', async () => {
  const own = saved('one', 'succeeded');
  const other = saved('two', 'succeeded', second, own.savedAt + 1);
  const app = fixture({ raw: JSON.stringify(history([own])) });
  try {
    app.stored(history([other]));
    assert.deepEqual(app.persisted().jobs.map(job => job.id).sort(), ['one', 'two'], 'both terminal jobs must reach localStorage even with no pending poll');
    app.stored(history([], other.savedAt + 1));
    assert.deepEqual(app.persisted().jobs, []);
    app.stored(history([own]));
    assert.deepEqual(app.persisted().jobs, [], 'stale storage events cannot undo a clear');
  } finally { await app.close(); }
});

test('network failures back off, suspended queries resume manually, and hidden pages poll more slowly', async () => {
  let fail = true;
  const app = fixture({ raw: JSON.stringify(history([saved('offline')])), fetch: async url => {
    if (url === '/_engine/projects') return jsonResponse({ projects: [] });
    if (fail) throw new Error('offline');
    return jsonResponse({ job: { id: 'offline', state: 'succeeded' } });
  } });
  try {
    app.runTimer();
    await until(() => app.persisted().jobs[0].failures === 1, 'first network error should persist');
    assert.equal(app.delay(), 6000);
    app.hide(true);
    assert.equal(app.delay(), 30000);
    app.hide(false);
    assert.equal(app.delay(), 0);
    const stalled = { ...app.persisted().jobs[0], failures: 8, savedAt: Date.now() + 10 };
    app.stored(history([stalled]));
    assert.equal(app.delay(), Infinity, 'repeated failures stop automatic queries');
    assert.match(app.$('[data-job-state]').textContent, /重试/);
    fail = false;
    app.$('[data-print-job-id="offline"] button').click();
    assert.equal(app.delay(), 0);
    app.runTimer();
    await until(() => app.persisted().jobs[0].state === 'succeeded', 'manual retry resumes the status query');
    assert.equal(app.persisted().jobs[0].failures, 0);
  } finally { await app.close(); }
});

test('download expiry removes the stale link and never follows a server-supplied download URL', async () => {
  const app = fixture({ raw: JSON.stringify(history([saved('ready', 'succeeded')])), fetch: async url => {
    if (url === '/_engine/projects') return jsonResponse({ projects: [] });
    assert.equal(url, '/_engine/jobs/ready/pdf');
    return new Response('', { status: 410 });
  } });
  try {
    app.$('[data-print-job-id="ready"] a').click();
    await until(() => app.persisted().jobs[0].state === 'expired', 'download expiration must update the saved task');
    assert.equal(app.window.document.querySelector('[data-print-job-id="ready"] a'), null);
    assert.equal(app.delay(), Infinity);
  } finally { await app.close(); }
});

test('portal recovers catalog errors, builds safe project links, and keeps print history available at root', async () => {
  let fail = true;
  const app = fixture({ portal: true, raw: JSON.stringify(history([saved('portal-task', 'succeeded', second)])), fetch: async url => {
    assert.equal(url, '/_engine/projects');
    if (fail) return new Response('', { status: 503 });
    return jsonResponse({ title: '我的课程', isMultiProject: true, projects: [first, { ...second, title: '<script>bad()</script>', author: '教师', subtitle: '新课程' }, { ...first, id: 'external', basePath: '//evil.example/' }] });
  } });
  try {
    await until(() => !app.$('[data-project-error]').hidden, 'portal should surface catalog failure');
    assert.equal(app.$('[data-project-loading]').hidden, true);
    assert.equal(app.$('[data-print-job-id="portal-task"] h3').textContent, '题单 portal-task');
    fail = false; app.$('[data-project-retry]').click();
    await until(() => app.window.document.querySelectorAll('.project-card').length === 2, 'retry should populate the project portal');
    assert.equal(app.$('[data-project-error]').hidden, true);
    assert.equal(app.window.document.title, '我的课程');
    assert.equal(app.$('[data-project-picker]').hidden, false);
    const links = Array.from(app.window.document.querySelectorAll('[data-project-links] a')).map(link => [link.getAttribute('href'), link.textContent]);
    assert.deepEqual(links, [['/', '所有项目'], ['/calculus/', first.title], ['/advanced/', '<script>bad()</script>']]);
    assert.equal(app.$('[data-project-links] a[aria-current]').getAttribute('href'), '/');
    assert.equal(app.window.document.querySelectorAll('script').length, 1, 'catalog labels are inserted as text');
    app.$('[data-project-picker]').open = true;
    app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(app.$('[data-project-picker]').open, false);
  } finally { await app.close(); }
});
