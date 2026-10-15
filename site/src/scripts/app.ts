import { filterProblems, restoreSelection, groupByChapter, randomSample, type SearchProblem, type Filters } from './list-state';
import { readingHref, restoreReadingProgress, type ReadingPage, type ReadingProgress } from './reading-state';
import type { PrintJob, PrintRequest } from '../../../src/types';

declare global { interface Window { MathJax?: { startup?: { promise?: Promise<void> }; typesetPromise?: (elements: Element[]) => Promise<void> } } }
interface ClientConfig { revision: string; basePath: string; siteUrl: string; readingPages: ReadingPage[]; chapters: { id: string; title: string }[] }
interface ListConfig { title: string; chapterId?: string; includeDocuments: boolean; revision: string; problems: SearchProblem[]; groups: { title: string; problems: string[] }[] }
const client: ClientConfig = JSON.parse(document.querySelector('#course-client-config')!.textContent!);
const base = client.basePath.replace(/\/+$/, '');
const api = (path: string) => `${base}/api/${path}`;
const $ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document) => root.querySelector<T>(selector)!;
const $$ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document) => Array.from(root.querySelectorAll<T>(selector));

const progressKey = `lecture-notes-reading:${client.siteUrl || location.origin}:${base}`;
const resumeKey = `${progressKey}:resume`;
const currentReadingHref = () => readingHref(location.href, location.origin, client.readingPages);
function readProgress(storage: Storage, key: string) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const progress = restoreReadingProgress(JSON.parse(raw), location.origin, client.readingPages, client.revision);
    if (!progress) storage.removeItem(key);
    return progress;
  } catch {
    try { storage.removeItem(key); } catch { /* Storage may be disabled. */ }
    return null;
  }
}
function writeProgress(progress: ReadingProgress) {
  try { localStorage.setItem(progressKey, JSON.stringify(progress)); } catch { /* Reading works when storage is unavailable. */ }
}
let pendingResume: ReadingProgress | null = null;
try {
  pendingResume = readProgress(sessionStorage, resumeKey);
  sessionStorage.removeItem(resumeKey);
  if (pendingResume?.href !== currentReadingHref()) pendingResume = null;
} catch { /* Private browsing may disable storage. */ }
let restoringProgress = pendingResume !== null;
let navigatingToReadingPage = false;
let progressTimer: ReturnType<typeof setTimeout> | undefined;
function captureReadingProgress() {
  if (restoringProgress || navigatingToReadingPage) return;
  const href = currentReadingHref();
  if (!href) return; // Returning to the course overview must retain the last passage.
  const anchors = $$<HTMLElement>('#main-content [id]').filter(element => !element.closest('[hidden], details:not([open])') && element.getClientRects().length > 0);
  let nearest: HTMLElement | undefined;
  let nearestTop = -Infinity;
  for (const element of anchors) {
    const top = element.getBoundingClientRect().top;
    if (top <= 100 && top > nearestTop) { nearest = element; nearestTop = top; }
  }
  writeProgress({ href, revision: client.revision, timestamp: Date.now(), scrollY: window.scrollY,
    ...(nearest ? { anchor: nearest.id, offset: -nearestTop } : {}),
    expanded: $$<HTMLDetailsElement>('#main-content details[open][id]').map(details => details.id),
  });
}
const readingLink = $<HTMLAnchorElement>('[data-reading-link]');
if (readingLink) {
  const firstChapterHref = readingLink.href;
  let progress: ReadingProgress | null;
  function refreshReadingLink() {
    progress = null;
    try { progress = readProgress(localStorage, progressKey); } catch { /* Use the first chapter. */ }
    readingLink.href = progress?.href || firstChapterHref;
    $('[data-reading-label]', readingLink).textContent = progress ? '继续阅读' : '开始阅读';
  }
  refreshReadingLink();
  window.addEventListener('pageshow', refreshReadingLink);
  window.addEventListener('storage', event => { if (event.key === progressKey) refreshReadingLink(); });
  readingLink.addEventListener('click', () => {
    if (progress) try { sessionStorage.setItem(resumeKey, JSON.stringify(progress)); } catch { /* The saved page remains a valid destination. */ }
  });
}
document.addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
  if (!link || link.hasAttribute('download') || link.target === '_blank') return;
  const target = readingHref(link.href, location.origin, client.readingPages);
  if (!target) { captureReadingProgress(); return; }
  if (!link.hasAttribute('data-reading-link')) writeProgress({ href: target, revision: client.revision, timestamp: Date.now(), scrollY: 0 });
  navigatingToReadingPage = new URL(target, location.origin).pathname !== location.pathname || new URL(target, location.origin).search !== location.search;
});
window.addEventListener('scroll', () => {
  if (progressTimer) clearTimeout(progressTimer);
  progressTimer = setTimeout(captureReadingProgress, 350);
}, { passive: true });
window.addEventListener('pagehide', captureReadingProgress);
window.addEventListener('pageshow', event => { if (event.persisted) { navigatingToReadingPage = false; captureReadingProgress(); } });
document.addEventListener('visibilitychange', () => { if (document.hidden) captureReadingProgress(); });

function updateChapterNavigation() {
  const chapterId = $('.page-container[data-chapter-page]')?.dataset.chapterPage;
  if (!chapterId) return;
  let hash = ''; try { hash = decodeURIComponent(location.hash.slice(1)); } catch { /* Ignore malformed anchors. */ }
  const target = hash ? document.getElementById(hash) : null;
  const exercises = hash === 'exercises' || Boolean(target?.closest('[data-exercise-list]'));
  for (const [selector, active] of [['[data-chapter-overview]', !exercises], ['[data-chapter-exercises]', exercises]] as const) {
    const item = $$<HTMLAnchorElement>(selector).find(item => (item.dataset.chapterOverview || item.dataset.chapterExercises) === chapterId);
    if (!item) continue;
    item.classList.toggle('active', active);
    active ? item.setAttribute('aria-current', 'page') : item.removeAttribute('aria-current');
  }
}
updateChapterNavigation();
window.addEventListener('hashchange', () => { updateChapterNavigation(); navigatingToReadingPage = false; });

// Native details remain useful without JavaScript; the drawer adds keyboard support.
const menu = $<HTMLButtonElement>('.menu-toggle');
const mobile = matchMedia('(max-width: 760px)');
function setSidebar(open: boolean) {
  document.body.classList.toggle(mobile.matches ? 'sidebar-open' : 'sidebar-collapsed', mobile.matches ? open : !open);
  menu.setAttribute('aria-expanded', String(open));
  $('#course-sidebar').toggleAttribute('inert', !open);
  if (mobile.matches && open) $<HTMLButtonElement>('.sidebar-close').focus();
}
setSidebar(!mobile.matches);
menu.addEventListener('click', () => setSidebar(menu.getAttribute('aria-expanded') !== 'true'));
$('.sidebar-scrim').addEventListener('click', () => setSidebar(false));
$<HTMLButtonElement>('.sidebar-close').addEventListener('click', () => { setSidebar(false); menu.focus(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && mobile.matches && document.body.classList.contains('sidebar-open')) { setSidebar(false); menu.focus(); } });
document.addEventListener('keydown', event => {
  if (event.key !== 'Tab' || !mobile.matches || !document.body.classList.contains('sidebar-open')) return;
  const targets = $$<HTMLElement>('a, button, summary', $('#course-sidebar')).filter(element => element.getClientRects().length > 0);
  const first = targets[0], last = targets[targets.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
mobile.addEventListener('change', () => { document.body.classList.remove('sidebar-open', 'sidebar-collapsed'); setSidebar(!mobile.matches); });
$$('a', $('#course-sidebar')).forEach(link => link.addEventListener('click', () => { if (mobile.matches) setSidebar(false); }));

// Typeset only visible passages. Formula state never depends on reading order.
let mathQueue = Promise.resolve();
const queued = new WeakSet<Element>();
const complete = new WeakSet<Element>();
let mathReady: Promise<void> | undefined;
function readyMath() {
  if (!mathReady) mathReady = new Promise<void>((resolve, reject) => {
    const started = Date.now();
    function check() {
      if (window.MathJax?.typesetPromise) {
        Promise.resolve(window.MathJax.startup?.promise).then(() => resolve(), reject);
      } else if (Date.now() - started > 20000) reject(new Error('数学公式资源加载失败，请刷新页面。'));
      else setTimeout(check, 100);
    }
    check();
  });
  return mathReady;
}
function shown(element: Element) { return !element.closest('[hidden], details:not([open])') && element.getClientRects().length > 0; }
function renderMath(element: Element) {
  if (complete.has(element) || queued.has(element) || !shown(element)) return;
  queued.add(element);
  mathQueue = mathQueue.then(async () => {
    if (!shown(element)) return;
    await readyMath();
    await window.MathJax!.typesetPromise!([element]);
    complete.add(element);
  }).catch(() => {
    if (!document.querySelector('[data-math-error]')) {
      const note = document.createElement('p'); note.dataset.mathError = ''; note.className = 'version-warning'; note.setAttribute('role', 'status');
      note.textContent = '数学公式暂未完成显示，请检查网络后刷新页面。';
      $('.page-container').prepend(note);
    }
  }).finally(() => queued.delete(element));
}
const mathObserver = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) renderMath(entry.target); }), { rootMargin: '300px' });
$$('[data-math]').forEach(element => mathObserver.observe(element));
function refreshMath(root: ParentNode = document) {
  $$('[data-math]', root).forEach(element => {
    const rect = element.getBoundingClientRect();
    if (rect.bottom > -300 && rect.top < innerHeight + 300) renderMath(element);
  });
}
$$<HTMLDetailsElement>('.problem-notes details').forEach(details => details.addEventListener('toggle', () => { if (details.open) refreshMath(details); }));

for (const section of $$('[data-exercise-list]')) setupList(section);
function revealHash() {
  let id: string;
  try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
  if (!id) return;
  const target = document.getElementById(id);
  if (!target) return;
  let ancestor: HTMLElement | null = target;
  while (ancestor) { if (ancestor instanceof HTMLDetailsElement) ancestor.open = true; ancestor = ancestor.parentElement; }
  target.scrollIntoView({ block: 'start' });
  const passage = target.closest('[data-math]');
  if (passage) renderMath(passage);
  refreshMath(target);
  void mathQueue.then(() => target.scrollIntoView({ block: 'start' }));
}
window.addEventListener('hashchange', () => { revealHash(); captureReadingProgress(); });
if (!pendingResume) { revealHash(); captureReadingProgress(); }
else void restoreReadingPosition(pendingResume);
async function restoreReadingPosition(progress: ReadingProgress) {
  const cancel = () => { restoringProgress = false; };
  window.addEventListener('wheel', cancel, { once: true, passive: true });
  window.addEventListener('touchstart', cancel, { once: true, passive: true });
  try {
    for (const id of progress.expanded || []) {
      const details = document.getElementById(id);
      if (details instanceof HTMLDetailsElement) details.open = true;
    }
    const target = progress.anchor ? document.getElementById(progress.anchor) : null;
    let ancestor = target;
    while (ancestor) { if (ancestor instanceof HTMLDetailsElement) ancestor.open = true; ancestor = ancestor.parentElement; }
    const move = () => {
      if (!restoringProgress) return;
      const top = target ? window.scrollY + target.getBoundingClientRect().top + (progress.offset || 0) : progress.scrollY;
      window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    };
    move();
    refreshMath();
    if (document.readyState !== 'complete') await new Promise<void>(resolve => window.addEventListener('load', () => resolve(), { once: true }));
    await document.fonts.ready;
    await mathQueue;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    move();
  } finally {
    window.removeEventListener('wheel', cancel);
    window.removeEventListener('touchstart', cancel);
    restoringProgress = false;
    pendingResume = null;
    captureReadingProgress();
  }
}
function setupList(section: HTMLElement) {
  const config: ListConfig = JSON.parse($('[data-exercise-config]', section).textContent!);
  const form = $<HTMLFormElement>('.filter-panel', section);
  const list = $('.problem-list', section);
  const byId = new Map(config.problems.map(problem => [problem.id, problem]));
  const cards = new Map($$<HTMLElement>('[data-problem-id]', list).map(card => [card.dataset.problemId!, card]));
  const message = $('[data-list-message]', section);
  let selected: string[] | null = null;
  let visible: string[] = [];
  let mismatch = false;
  let filtered: SearchProblem[] = [];
  function filterValues(): Filters {
    const data = new FormData(form);
    return Object.fromEntries(['search', 'tag', 'source', 'difficulty', 'solutions'].map(key => [key, String(data.get(key) || '')])) as unknown as Filters;
  }
  function hydrate() {
    const params = new URL(location.href).searchParams;
    for (const name of ['search', 'tag', 'source', 'difficulty', 'solutions']) {
      const input = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
      input.value = params.get(name) || '';
    }
    const ids = params.has('problems') ? (params.get('problems') || '').split(',').filter(Boolean) : null;
    selected = ids ? restoreSelection(ids, config.problems) : null;
    if (ids && ids.length !== selected!.length) message.textContent = '链接中的部分题目不属于当前题单或已不可用，已显示能够找到的题目。';
    mismatch = Boolean(params.get('revision') && params.get('revision') !== client.revision);
    $('.version-warning', section).hidden = !mismatch;
    update(false);
  }
  function updateUrl() {
    const url = new URL(location.href);
    const filters = filterValues();
    for (const [key, value] of Object.entries(filters)) value ? url.searchParams.set(key, value) : url.searchParams.delete(key);
    if (selected !== null) url.searchParams.set('problems', selected.join(',')); else url.searchParams.delete('problems');
    if (!mismatch) url.searchParams.set('revision', client.revision);
    history.replaceState(null, '', url);
  }
  function update(writeUrl = true) {
    filtered = filterProblems(config.problems, filterValues());
    const allowed = new Set(filtered.map(problem => problem.id));
    visible = selected !== null ? selected.filter(id => allowed.has(id)) : filtered.map(problem => problem.id);
    cards.forEach(card => { card.hidden = true; });
    $$('.group-heading', list).forEach(heading => heading.remove());
    let lastGroup = '';
    for (const id of visible) {
      const group = !selected ? config.groups.find(group => group.problems.includes(id))?.title || '' : '';
      if (group && group !== lastGroup) { const heading = document.createElement('h3'); heading.className = 'group-heading'; heading.textContent = group; list.append(heading); }
      lastGroup = group;
      const card = cards.get(id)!; card.hidden = false; list.append(card);
    }
    $('[data-result-count]', section).textContent = String(visible.length);
    $('[data-sample-label]', section).textContent = selected !== null ? ' · 已选题单' : '';
    $('[data-clear-sample]', section).hidden = selected === null;
    $('.empty-state', section).hidden = visible.length > 0;
    $<HTMLButtonElement>('[data-print-open]', section).disabled = mismatch || visible.length === 0;
    $<HTMLButtonElement>('[data-share]', section).disabled = visible.length === 0;
    $<HTMLButtonElement>('[data-random]', section).disabled = filtered.length === 0;
    $<HTMLInputElement>('#random-count', section).max = String(Math.max(1, filtered.length));
    if (writeUrl) { updateUrl(); captureReadingProgress(); }
    refreshMath(list);
  }
  function reset() { form.reset(); selected = null; message.textContent = ''; update(); }
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('input', () => { selected = null; message.textContent = ''; update(); });
  $$('.reset-filters', section).forEach(button => button.addEventListener('click', reset));
  $('[data-clear-sample]', section).addEventListener('click', () => { selected = null; message.textContent = ''; update(); });
  $('[data-use-current]', section).addEventListener('click', () => { mismatch = false; $('.version-warning', section).hidden = true; update(); });
  $('[data-random]', section).addEventListener('click', () => {
    const input = $<HTMLInputElement>('#random-count', section);
    if (!input.reportValidity()) return;
    selected = randomSample(filtered.map(problem => problem.id), Number(input.value), max => {
      const range = 0x100000000; const limit = range - range % max; const bytes = new Uint32Array(1);
      do { crypto.getRandomValues(bytes); } while (bytes[0] >= limit);
      return bytes[0] % max;
    });
    message.textContent = `已从 ${filtered.length} 道符合条件的习题中抽取 ${selected.length} 道，题目不会重复。`;
    update();
  });
  $('[data-toggle-solutions]', section).addEventListener('click', event => {
    const details = visible.flatMap(id => $$<HTMLDetailsElement>('.solution-block', cards.get(id)!));
    const open = details.some(detail => !detail.open);
    details.forEach(detail => { detail.open = open; });
    (event.currentTarget as HTMLButtonElement).textContent = open ? '收起解答' : '展开解答';
    refreshMath(list);
  });
  $('[data-share]', section).addEventListener('click', async () => {
    const url = new URL(location.href); url.searchParams.set('problems', visible.join(','));
    if (!mismatch) url.searchParams.set('revision', client.revision);
    try { await navigator.clipboard.writeText(url.href); message.textContent = '题单链接已复制，包含当前题目及其顺序。'; }
    catch {
      const input = document.createElement('input'); input.value = url.href; input.readOnly = true; input.setAttribute('aria-label', '题单分享链接'); input.className = 'share-url';
      message.replaceChildren(document.createTextNode('请复制题单链接：'), input); input.focus(); input.select();
    }
  });
  window.addEventListener('popstate', hydrate);
  hydrate();
  setupPrinting(section, config, () => visible, () => mismatch);
}

function setupPrinting(section: HTMLElement, config: ListConfig, getIds: () => string[], isMismatch: () => boolean) {
  const dialog = $<HTMLDialogElement>('.print-dialog', section);
  const form = $<HTMLFormElement>('.print-options', dialog);
  const submit = $<HTMLButtonElement>('[data-print-submit]', dialog);
  const errors = $('.print-error', dialog);
  const jobsElement = $('.print-jobs', dialog);
  const jobs = new Map<string, { job: PrintJob; title: string; downloadUrl?: string; failures: number }>();
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let submitting = false;
  const chapterTitle = (id: string) => client.chapters.find(chapter => chapter.id === id)?.title || '章节';
  const storageKey = `lecture-notes-jobs:${base}:${client.revision}`;
  function persist() { try { sessionStorage.setItem(storageKey, JSON.stringify([...jobs.values()].slice(-20))); } catch { /* Private browsing or quota exhaustion should not prevent printing. */ } }
  function error(text: string) { errors.hidden = false; errors.textContent = text; }
  async function responseJson(response: Response) {
    if (!response.ok) {
      let body: { message?: string; error?: string } = {}; try { body = await response.json(); } catch { /* Keep a readable fallback. */ }
      if (response.status === 429) throw new Error('当前提交较多，请稍后再试。');
      if (response.status === 404) throw new Error('打印服务暂不可用。你可以先下载全文 PDF，或稍后再试。');
      if (response.status === 409) throw new Error('内容版本已更新，请刷新页面后重新生成。');
      throw new Error(body.message || 'PDF 生成请求未能完成，请稍后重试。');
    }
    return response.json();
  }
  function renderJobs() {
    jobsElement.replaceChildren();
    for (const entry of jobs.values()) {
      const row = document.createElement('div'); row.className = 'print-job';
      const text = document.createElement('div'); const heading = document.createElement('h3'); heading.textContent = entry.title; const state = document.createElement('p');
      if (entry.job.state === 'queued') state.textContent = entry.job.position && entry.job.position > 1 ? `正在排队，前方还有 ${entry.job.position - 1} 个任务` : '正在排队，稍后开始生成';
      else if (entry.job.state === 'running') state.textContent = '正在排版，请稍候';
      else if (entry.job.state === 'succeeded') state.textContent = 'PDF 已准备好';
      else state.textContent = '生成失败，请稍后重试或联系课程维护者。';
      if (entry.failures >= 3 && !['succeeded', 'failed'].includes(entry.job.state)) state.textContent = '连接暂时中断，正在尝试恢复任务状态';
      text.append(heading, state); row.append(text);
      if (entry.job.state === 'succeeded') {
        const link = document.createElement('a'); link.className = 'button button-subtle'; link.textContent = '下载 PDF';
        const expected = api(`jobs/${encodeURIComponent(entry.job.id)}/pdf`);
        // API-provided URLs are constrained to this site's own download endpoint.
        const provided = entry.downloadUrl ? new URL(entry.downloadUrl, location.origin) : null;
        link.href = provided?.origin === location.origin && provided.pathname.startsWith(`${base}/api/jobs/`) ? provided.href : expected;
        link.setAttribute('download', ''); row.append(link);
      }
      jobsElement.append(row);
    }
  }
  function schedulePoll() { if (pollTimer) return; if ([...jobs.values()].some(entry => !['succeeded', 'failed'].includes(entry.job.state))) pollTimer = setTimeout(poll, 2500); }
  async function poll() {
    pollTimer = undefined;
    const pending = [...jobs.values()].filter(entry => !['succeeded', 'failed'].includes(entry.job.state));
    await Promise.allSettled(pending.map(async entry => {
      try {
        const response = await fetch(api(`jobs/${encodeURIComponent(entry.job.id)}`), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
        if (response.status === 404) { entry.job.state = 'failed'; return; }
        const data = await responseJson(response);
        entry.job = data.job; entry.downloadUrl = data.downloadUrl; entry.failures = 0;
      } catch { entry.failures++; }
    }));
    renderJobs(); persist();
    if ([...jobs.values()].some(entry => !['succeeded', 'failed'].includes(entry.job.state))) pollTimer = setTimeout(poll, pending.some(entry => entry.failures >= 3) ? 15000 : 3000);
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || '[]');
    for (const entry of saved) if (entry?.job?.id && entry?.job?.request?.revision === client.revision) jobs.set(entry.job.id, { ...entry, failures: 0 });
    renderJobs(); schedulePoll();
  } catch { /* A missing or malformed cache does not affect the print queue. */ }
  $('[data-print-open]', section).addEventListener('click', () => {
    const groups = groupByChapter(getIds(), config.problems);
    $('.print-summary', dialog).textContent = `当前题单包含 ${getIds().length} 道习题${groups.size > 1 ? `，分属 ${groups.size} 个章节` : ''}，按照页面中的题目顺序排版。`;
    if (!dialog.open) dialog.showModal();
  });
  $('[data-print-close]', dialog).addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting || isMismatch() || !getIds().length) return;
    const groups = groupByChapter(getIds(), config.problems);
    const data = new FormData(form);
    const solutions = String(data.get('print-solutions') || 'none') as PrintRequest['solutions'];
    errors.hidden = true; submitting = true; submit.disabled = true; submit.textContent = '正在提交…';
    try {
      for (const [chapterId, problemIds] of groups) {
        const request: PrintRequest = { revision: client.revision, chapterId, problemIds, includeDocuments: data.has('print-documents'), solutions, comments: data.has('print-comments'), title: config.title === '所有习题' ? chapterTitle(chapterId) : config.title };
        const response = await fetch(api('print'), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(20000) });
        const result = await responseJson(response);
        jobs.set(result.job.id, { job: result.job, title: chapterTitle(chapterId), downloadUrl: result.downloadUrl, failures: 0 });
        renderJobs(); persist(); schedulePoll();
      }
    } catch (cause) { error(cause instanceof Error && cause.name === 'TimeoutError' ? '提交耗时较长，请稍后重试；相同题单会复用已提交的任务。' : cause instanceof TypeError ? '暂时无法连接打印服务，请检查网络后重试。' : cause instanceof Error ? cause.message : '打印任务提交失败，请稍后重试。'); }
    finally { submitting = false; submit.disabled = false; submit.textContent = '生成 PDF'; }
  });
}
