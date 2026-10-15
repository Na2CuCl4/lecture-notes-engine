import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { Window } from 'happy-dom';
import * as listState from '../site/src/scripts/list-state.js';
import * as readingState from '../site/src/scripts/reading-state.js';

// Exercise the actual application script in a DOM, without starting a browser
// or doing visual inspection. Network responses are controlled by each test.
const script = ts.transpileModule(readFileSync(new URL('../site/src/scripts/app.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
}).outputText;
const revision = 'a'.repeat(64);
const problems = Array.from({ length: 25 }, (_, index) => ({
  id: `p${index + 1}`, chapterId: 'one', tags: [index < 12 ? 'first' : 'second'], sources: [], difficulty: 2,
  hasSolutions: true, text: `exercise ${index + 1}`, anchors: [`problem-p${index + 1}`, `solution-p${index + 1}`, `formula-p${index + 1}`],
}));
const card = (id: string) => `<article class="problem-card problem-card-linked" id="problem-${id}" data-problem-id="${id}"><h3><a class="problem-title-link" href="/course/problems/${id}/">${id}</a></h3><a data-chapter-tag href="/course/chapters/one/">one</a><div data-math><p>exercise ${id}</p></div><div class="problem-notes"><details class="solution-block" id="solution-${id}"><summary>solution</summary><div id="formula-${id}" data-math>answer ${id}</div></details></div></article>`;
const key = 'lecture-notes-reading:https://notes.example:/course';
const json = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');
const delay = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function until(predicate: () => boolean, description: string) {
  for (let count = 0; count < 200; count++) { if (predicate()) return; await delay(); }
  assert.fail(description);
}

function fixture(options: { query?: string; progress?: readingState.ReadingProgress; fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {}) {
  const window = new Window({ url: `https://notes.example/course/chapters/one/${options.query || ''}` });
  const requests: string[] = [];
  const cleared: string[][] = [];
  let shared = '';
  const printRequests: any[] = [];
  const app = window as any;
  app.exports = {};
  app.require = (name: string) => name === './list-state' ? listState : name === './reading-state' ? readingState : assert.fail(`Unexpected module ${name}`);
  app.MathJax = { startup: { promise: Promise.resolve() }, typesetPromise: async () => {}, typesetClear: (elements: Element[]) => cleared.push(elements.map(element => element.id)) };
  app.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(window.document, 'readyState', { value: 'complete' });
  Object.defineProperty(window.document, 'fonts', { value: { ready: Promise.resolve() } });
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (value: string) => { shared = value; } } });
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.getClientRects = function () { return [{ top: 120, bottom: 200, width: 100, height: 80 }] as any; };
  window.HTMLElement.prototype.getBoundingClientRect = function () { return { top: 120, bottom: 200, width: 100, height: 80 } as any; };
  app.fetch = async (input: string, init?: RequestInit) => {
    const url = String(input); requests.push(url);
    if (url.endsWith('/api/print')) {
      const request = JSON.parse(String(init?.body)); printRequests.push(request);
      return new Response(JSON.stringify({ job: { id: 'job1', state: 'succeeded', request }, downloadUrl: '/course/api/jobs/job1/pdf' }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (options.fetch) return options.fetch(url, init);
    const id = url.match(/\/fragments\/problems\/(p\d+)\/index.html$/)?.[1];
    return id ? new Response(card(id)) : new Response('missing', { status: 404 });
  };
  const config = { revision, basePath: '/course/', siteUrl: 'https://notes.example', chapters: [{ id: 'one', title: '第一章' }], readingPages: [
    { path: '/course/chapters/one/', anchors: ['main-content', 'exercises', ...problems.flatMap(problem => problem.anchors)] },
    ...problems.map(problem => ({ path: `/course/problems/${problem.id}/`, anchors: problem.anchors })),
  ] };
  const list = { title: '所有习题', chapterId: 'one', includeDocuments: true, revision, problems, groups: [{ title: '第一组', problems: problems.slice(0, 12).map(problem => problem.id) }, { title: '第二组', problems: problems.slice(12).map(problem => problem.id) }], fragmentBase: `/course/_releases/${revision}/fragments/problems/`, showChapter: false, standalone: false };
  window.document.body.innerHTML = `<button class="menu-toggle" aria-expanded="true"></button><button class="sidebar-scrim"></button><aside id="course-sidebar"><button class="sidebar-close"></button><a href="/course/">overview</a></aside><main id="main-content"><div class="page-container"><section id="exercises" data-exercise-list>
    <div class="version-warning" hidden><button data-use-current>use current</button></div>
    <form class="filter-panel"><input name="search"><select name="tag"><option value=""></option><option>first</option><option>second</option></select><input name="source"><input name="difficulty"><input name="solutions"><button type="button" class="reset-filters">reset</button></form>
    <span data-result-count></span><span data-sample-label></span><button data-clear-sample></button><button data-print-open></button><button data-share></button><button data-random></button><button data-toggle-solutions></button><input id="random-count" type="number" min="1" max="25" value="3">
    <p data-list-message></p><div class="page-load-error" hidden><button data-retry-page>retry</button></div><div class="problem-list">${problems.slice(0,10).map(problem => card(problem.id)).join('')}</div><nav data-pagination></nav><div class="empty-state" hidden></div>
    <dialog class="print-dialog"><p class="print-summary"></p><button data-print-close></button><form class="print-options"><input name="print-solutions" value="none"><button type="submit" data-print-submit></button></form><div class="print-error" hidden></div><div class="print-jobs"></div></dialog>
    <script data-exercise-config type="application/json">${json(list)}</script></section></div></main><script id="course-client-config" type="application/json">${json(config)}</script>`;
  if (options.progress) {
    window.localStorage.setItem(key, JSON.stringify(options.progress));
    window.sessionStorage.setItem(`${key}:resume`, JSON.stringify(options.progress));
  }
  vm.runInContext(script, vm.createContext(window), { filename: 'app.ts' });
  const $ = (selector: string) => window.document.querySelector(selector)! as any;
  const ids = () => Array.from(window.document.querySelectorAll('[data-problem-id]')).map(element => element.getAttribute('data-problem-id'));
  return { window, $, ids, requests, cleared, shared: () => shared, printRequests, close: () => window.happyDOM.close() };
}

test('DOM pagination mounts 10/10/5 cards, retains initial groups, and prints/shares all pages', async () => {
  const app = fixture();
  try {
    await delay();
    assert.equal(app.ids().length, 10);
    assert.equal(app.$('.group-heading').textContent, '第一组');
    app.$('[data-page="2"]').click();
    await until(() => app.ids()[0] === 'p11', 'second page should load');
    assert.deepEqual(app.ids(), problems.slice(10,20).map(problem => problem.id));
    assert.equal(app.window.location.search.includes('page=2'), true);
    assert.equal(app.requests.filter(url => url.includes('/fragments/')).length, 10);
    assert.ok(app.requests.every(url => url.includes(`/_releases/${revision}/`)));
    assert.ok(app.cleared.some(ids => ids.includes('problem-p1')));
    app.$('[data-page="3"]').click();
    await until(() => app.ids()[0] === 'p21', 'third page should load');
    assert.equal(app.ids().length, 5);
    app.$('[data-share]').click();
    await until(() => Boolean(app.shared()), 'share should complete');
    const shared = new URL(app.shared());
    assert.equal(shared.searchParams.get('problems')!.split(',').length, 25);
    assert.equal(shared.searchParams.get('page'), '3');
    app.$('.print-options').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => app.printRequests.length > 0, 'printing should submit');
    assert.deepEqual(app.printRequests[0].problemIds, problems.map(problem => problem.id));
    app.$('[name="tag"]').value = 'first';
    app.$('[name="tag"]').dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await until(() => app.ids()[0] === 'p1', 'filter resets to first page');
    assert.equal(new URL(app.window.location.href).searchParams.has('page'), false);
    assert.equal(app.$('[data-result-count]').textContent, '12');
    app.$('#random-count').value = '11';
    app.$('[data-random]').click();
    await until(() => app.$('[data-result-count]').textContent === '11', 'random sample updates');
    assert.ok(app.ids().length <= 10);
    assert.equal(new URL(app.window.location.href).searchParams.get('problems')!.split(',').length, 11);
  } finally { await app.close(); }
});

test('slow obsolete responses cannot overwrite later pages, and failed pages retry', async () => {
  const delayed: { id: string; resolve: (response: Response) => void }[] = [];
  let fail = false;
  const app = fixture({ fetch: url => {
    const id = url.match(/\/(p\d+)\/index.html$/)![1];
    if (fail) return Promise.resolve(new Response('offline', { status: 503 }));
    if (Number(id.slice(1)) <= 20) return new Promise(resolve => delayed.push({ id, resolve }));
    return Promise.resolve(new Response(card(id)));
  } });
  try {
    app.$('[data-page="2"]').click();
    await until(() => delayed.length === 10, 'page two requests should start');
    app.$('[data-page="3"]').click();
    await until(() => app.ids()[0] === 'p21', 'page three should win');
    delayed.forEach(({ id, resolve }) => resolve(new Response(card(id))));
    await delay(); await delay();
    assert.deepEqual(app.ids(), ['p21', 'p22', 'p23', 'p24', 'p25']);
  } finally { await app.close(); }
  const retry = fixture({ fetch: url => fail ? Promise.resolve(new Response('offline', { status: 503 })) : Promise.resolve(new Response(card(url.match(/\/(p\d+)\/index.html$/)![1]))) });
  try {
    fail = true;
    retry.$('[data-page="2"]').click();
    await until(() => !retry.$('.page-load-error').hidden, 'failure must be visible');
    assert.equal(retry.ids().length, 0);
    fail = false;
    retry.$('[data-retry-page]').click();
    await until(() => retry.ids()[0] === 'p11', 'retry should load requested page');
    assert.equal(retry.$('.page-load-error').hidden, true);
  } finally { await retry.close(); }
});

test('deep solution links and saved reading positions await their asynchronous page', async () => {
  const app = fixture({ query: '?page=1#solution-p25' });
  try {
    await until(() => app.ids()[0] === 'p21', 'hash should locate page three');
    await until(() => app.$('#solution-p25').open, 'deep solution should expand');
    assert.equal(new URL(app.window.location.href).searchParams.get('page'), '3');
    app.$('[name="tag"]').value = 'second';
    app.$('[name="tag"]').dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await until(() => app.ids()[0] === 'p13', 'changing filters should reset to its first page');
    assert.equal(app.window.location.hash, '#exercises', 'the old problem hash must not pull a shared filter back to a later page');
    assert.equal(new URL(app.window.location.href).searchParams.has('page'), false);
  } finally { await app.close(); }
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const progress: readingState.ReadingProgress = { href: `/course/chapters/one/?page=3&revision=${revision}`, revision, timestamp: 10, scrollY: 700, anchor: 'solution-p25', offset: 30, expanded: ['solution-p25'] };
  const resumed = fixture({ query: `?page=3&revision=${revision}`, progress, fetch: async url => { await gate; return new Response(card(url.match(/\/(p\d+)\/index.html$/)![1])); } });
  try {
    assert.deepEqual(JSON.parse(resumed.window.localStorage.getItem(key)!), progress, 'pending resume must not overwrite saved state');
    release();
    await until(() => resumed.ids()[0] === 'p21', 'resume page should load');
    await until(() => resumed.$('#solution-p25').open, 'saved expanded solution should open');
  } finally { release(); await resumed.close(); }
});

test('a failed resume preserves its saved anchor until retry finishes', async () => {
  let fail = true;
  const progress: readingState.ReadingProgress = { href: `/course/chapters/one/?page=3&revision=${revision}`, revision, timestamp: 10, scrollY: 700, anchor: 'solution-p25', offset: 30, expanded: ['solution-p25'] };
  const app = fixture({ query: `?page=3&revision=${revision}`, progress, fetch: async url => fail ? new Response('offline', { status: 503 }) : new Response(card(url.match(/\/(p\d+)\/index.html$/)![1])) });
  try {
    await until(() => !app.$('.page-load-error').hidden, 'resume failure should allow retry');
    app.window.dispatchEvent(new app.window.Event('pagehide'));
    assert.deepEqual(JSON.parse(app.window.localStorage.getItem(key)!), progress, 'failed page must retain the original progress');
    fail = false;
    app.$('[data-retry-page]').click();
    await until(() => app.ids()[0] === 'p21', 'retry should mount saved page');
    await until(() => app.$('#solution-p25').open, 'retry should restore the saved expanded solution');
    await until(() => JSON.parse(app.window.localStorage.getItem(key)!).timestamp !== 10, 'progress is saved only after the successful restore');
    assert.ok(JSON.parse(app.window.localStorage.getItem(key)!).expanded.includes('solution-p25'));
  } finally { await app.close(); }
});
