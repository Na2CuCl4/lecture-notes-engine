import { filterProblems, restoreSelection, groupByChapter, randomSample, paginateProblems, pageForAnchor, paginationNumbers, PAGE_SIZE, type SearchProblem, type Filters } from './list-state';
import { readingHref, restoreReadingProgress, type ReadingPage, type ReadingProgress } from './reading-state';
import type { PrintRequest } from '../../../src/types';
import { registerPrintJob } from './global-ui';

declare global { interface Window { MathJax?: { startup?: { promise?: Promise<void> }; typesetPromise?: (elements: Element[]) => Promise<void>; typesetClear?: (elements: Element[]) => void } } }
interface ClientConfig { projectId?: string; title?: string; revision: string; basePath: string; siteUrl: string; readingPages: ReadingPage[]; chapters: { id: string; title: string }[] }
interface ListConfig { title: string; problems: SearchProblem[]; groups: { title: string; problems: string[] }[]; fragmentBase: string; showChapter: boolean }
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
  if (restoringProgress || pendingResume || navigatingToReadingPage) return;
  if ($$('[data-exercise-list]').some(section => $('.problem-list', section).getAttribute('aria-busy') === 'true' || !$('.page-load-error', section).hidden)) return;
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

window.addEventListener('hashchange', () => { navigatingToReadingPage = false; });

// The title is a native link; clicking noninteractive card space has the same
// destination without placing an overlay over selectable text or formulas.
document.addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = event.target as Element;
  if (target.closest('a, button, input, select, textarea, summary, details, [role="button"], [contenteditable], mjx-container')) return;
  const card = target.closest('.problem-card-linked');
  if (!card || window.getSelection()?.toString()) return;
  card.querySelector<HTMLAnchorElement>('.problem-title-link')?.click();
});

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
function shown(element: Element) { return element.isConnected && !element.closest('[hidden], details:not([open])') && element.getClientRects().length > 0; }
function renderMath(element: Element) {
  if (complete.has(element) || queued.has(element) || !shown(element)) return;
  queued.add(element);
  mathQueue = mathQueue.then(async () => {
    if (!shown(element)) return;
    await readyMath();
    if (!shown(element)) return;
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
document.addEventListener('toggle', event => {
  const details = event.target;
  if (details instanceof HTMLDetailsElement && details.open && details.closest('.problem-notes')) refreshMath(details);
}, true);

const lists = $$('[data-exercise-list]').map(setupList);
function hashId() { try { return decodeURIComponent(location.hash.slice(1)); } catch { return ''; } }
async function revealHash() {
  let id: string;
  try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
  if (!id) return;
  if ((await Promise.all(lists.map(list => list.ensureAnchor(id)))).some(loaded => !loaded)) return;
  if (id !== hashId()) return;
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
window.addEventListener('hashchange', () => { void revealHash().then(captureReadingProgress); });
if (!pendingResume) { void Promise.all(lists.map(list => list.ready())).then(async () => { await revealHash(); captureReadingProgress(); }); }
else void restoreReadingPosition(pendingResume);
async function restoreReadingPosition(progress: ReadingProgress) {
  let restored = false;
  const cancel = () => { restoringProgress = false; pendingResume = null; };
  window.addEventListener('wheel', cancel, { once: true, passive: true });
  window.addEventListener('touchstart', cancel, { once: true, passive: true });
  try {
    if ((await Promise.all(lists.map(list => list.ensureAnchor(progress.anchor || hashId())))).some(loaded => !loaded)) return;
    if (!restoringProgress) return;
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
    restored = true;
  } finally {
    window.removeEventListener('wheel', cancel);
    window.removeEventListener('touchstart', cancel);
    restoringProgress = false;
    if (restored) pendingResume = null;
    captureReadingProgress();
  }
}
function setupList(section: HTMLElement) {
  const config: ListConfig = JSON.parse($('[data-exercise-config]', section).textContent!);
  const form = $<HTMLFormElement>('.filter-panel', section);
  const list = $('.problem-list', section);
  const pagination = $('[data-pagination]', section);
  const message = $('[data-list-message]', section);
  const loadError = $('.page-load-error', section);
  // Cache raw HTML only, never retain detached, typeset DOM trees. The cache is
  // bounded to three pages even when readers browse hundreds of exercises.
  const fragments = new Map($$<HTMLElement>('[data-problem-id]', list).map(card => [card.dataset.problemId!, card.outerHTML]));
  let selected: string[] | null = null;
  let visible: string[] = [];
  let mismatch = false;
  let filtered: SearchProblem[] = [];
  let currentPage = 1;
  let expandedSolutions = false;
  let mountVersion = 0;
  let controller: AbortController | undefined;
  let ready = Promise.resolve(true);
  let initial = true;
  function filterValues(): Filters {
    const data = new FormData(form);
    return Object.fromEntries(['search', 'tag', 'source', 'difficulty', 'solutions'].map(key => [key, String(data.get(key) || '')])) as unknown as Filters;
  }
  function updateUrl(push = false) {
    const url = new URL(location.href);
    for (const [key, value] of Object.entries(filterValues())) value ? url.searchParams.set(key, value) : url.searchParams.delete(key);
    if (selected !== null) url.searchParams.set('problems', selected.join(',')); else url.searchParams.delete('problems');
    if (!mismatch) url.searchParams.set('revision', client.revision);
    currentPage > 1 ? url.searchParams.set('page', String(currentPage)) : url.searchParams.delete('page');
    if (push && url.href !== location.href) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
  }
  function discardCards() {
    const old = $$('[data-problem-id]', list);
    old.forEach(card => $$('[data-math]', card).forEach(element => mathObserver.unobserve(element)));
    window.MathJax?.typesetClear?.(old);
    list.replaceChildren();
    // A typeset already in flight may finish after detachment. Clear its record
    // again once the queue has drained, before rendering any new page.
    if (old.length) mathQueue = mathQueue.then(() => { window.MathJax?.typesetClear?.(old); });
  }
  function cache(id: string, html: string) {
    fragments.delete(id); fragments.set(id, html);
    while (fragments.size > PAGE_SIZE * 3) fragments.delete(fragments.keys().next().value!);
  }
  async function fragment(id: string, signal: AbortSignal) {
    const cached = fragments.get(id);
    if (cached) { cache(id, cached); return cached; }
    const response = await fetch(`${config.fragmentBase}${encodeURIComponent(id)}/index.html`, { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), headers: { Accept: 'text/html' } });
    if (!response.ok) throw new Error('习题加载失败');
    const html = await response.text();
    const document = new DOMParser().parseFromString(html, 'text/html');
    const card = document.querySelector<HTMLElement>('article[data-problem-id]');
    if (!card || card.dataset.problemId !== id) throw new Error('习题内容不匹配');
    cache(id, card.outerHTML);
    return card.outerHTML;
  }
  function renderPagination() {
    const state = paginateProblems(visible, currentPage);
    pagination.replaceChildren();
    pagination.hidden = state.pages <= 1;
    const button = (label: string, page: number, disabled = false) => {
      const element = document.createElement('button'); element.type = 'button'; element.className = 'pagination-button';
      element.textContent = label; element.disabled = disabled; element.dataset.page = String(page);
      element.setAttribute('aria-label', label === String(page) ? `第 ${page} 页` : label);
      if (label === String(page) && page === state.page) element.setAttribute('aria-current', 'page');
      return element;
    };
    pagination.append(button('上一页', state.page - 1, state.page === 1));
    for (const number of paginationNumbers(state.page, state.pages)) {
      if (number === 'gap') { const gap = document.createElement('span'); gap.textContent = '…'; gap.setAttribute('aria-hidden', 'true'); pagination.append(gap); }
      else pagination.append(button(String(number), number));
    }
    pagination.append(button('下一页', state.page + 1, state.page === state.pages));
    const status = document.createElement('span'); status.className = 'pagination-status';
    status.textContent = `第 ${state.page} / ${state.pages} 页，每页 ${PAGE_SIZE} 题`; pagination.append(status);
  }
  async function mountPage(scroll = false) {
    const version = ++mountVersion;
    controller?.abort(); controller = new AbortController();
    const ids = paginateProblems(visible, currentPage).ids;
    loadError.hidden = true;
    const current = $$<HTMLElement>('[data-problem-id]', list).map(card => card.dataset.problemId);
    const unchanged = ids.length === current.length && ids.every((id, index) => id === current[index]);
    if (!unchanged) {
      discardCards();
      list.setAttribute('aria-busy', 'true');
      try {
        const html = await Promise.all(ids.map(id => fragment(id, controller!.signal)));
        if (version !== mountVersion) return false;
        const nodes = document.createDocumentFragment();
        let lastGroup = '';
        for (let index = 0; index < ids.length; index++) {
          const group = selected === null ? config.groups.find(group => group.problems.includes(ids[index]))?.title || '' : '';
          if (group && group !== lastGroup) { const heading = document.createElement('h3'); heading.className = 'group-heading'; heading.textContent = group; nodes.append(heading); }
          lastGroup = group;
          const template = document.createElement('template'); template.innerHTML = html[index];
          const card = template.content.querySelector<HTMLElement>('[data-problem-id]')!;
          $$<HTMLElement>('[data-chapter-tag]', card).forEach(tag => { tag.hidden = !config.showChapter; });
          $$<HTMLDetailsElement>('.solution-block', card).forEach(details => { details.open = expandedSolutions; });
          nodes.append(card);
        }
        list.replaceChildren(nodes);
      } catch (error) {
        if (version !== mountVersion) return false;
        loadError.hidden = false;
        return false;
      } finally { if (version === mountVersion) list.removeAttribute('aria-busy'); }
    }
    if (version !== mountVersion) return false;
    // Initial server-rendered cards are already present. Add the same group
    // labels as dynamically loaded pages without replacing those card nodes.
    if (unchanged) {
      $$('.group-heading', list).forEach(heading => heading.remove());
      let lastGroup = '';
      for (const card of $$<HTMLElement>('[data-problem-id]', list)) {
        const group = selected === null ? config.groups.find(group => group.problems.includes(card.dataset.problemId!))?.title || '' : '';
        if (group && group !== lastGroup) { const heading = document.createElement('h3'); heading.className = 'group-heading'; heading.textContent = group; list.insertBefore(heading, card); }
        lastGroup = group;
      }
    }
    $$('[data-math]', list).forEach(element => mathObserver.observe(element));
    refreshMath(list);
    if (scroll) list.scrollIntoView({ block: 'start', behavior: 'instant' });
    return true;
  }
  function update(options: { writeUrl?: boolean; push?: boolean; scroll?: boolean; anchor?: string } = {}) {
    filtered = filterProblems(config.problems, filterValues());
    const allowed = new Set(filtered.map(problem => problem.id));
    visible = selected !== null ? selected.filter(id => allowed.has(id)) : filtered.map(problem => problem.id);
    currentPage = pageForAnchor(visible, config.problems, options.anchor) || paginateProblems(visible, currentPage).page;
    const state = paginateProblems(visible, currentPage);
    $('[data-result-count]', section).textContent = String(visible.length);
    $('[data-sample-label]', section).textContent = `${selected !== null ? ' · 已选题单' : ''}${state.pages > 1 ? ` · 显示第 ${(state.page - 1) * PAGE_SIZE + 1}–${(state.page - 1) * PAGE_SIZE + state.ids.length} 题` : ''}`;
    $('[data-clear-sample]', section).hidden = selected === null;
    $('.empty-state', section).hidden = visible.length > 0;
    $<HTMLButtonElement>('[data-print-open]', section).disabled = mismatch || visible.length === 0;
    $<HTMLButtonElement>('[data-share]', section).disabled = visible.length === 0;
    $<HTMLButtonElement>('[data-random]', section).disabled = filtered.length === 0;
    $<HTMLInputElement>('#random-count', section).max = String(Math.max(1, filtered.length));
    renderPagination();
    if (options.writeUrl !== false) updateUrl(options.push);
    ready = mountPage(options.scroll).then(loaded => { if (loaded && options.writeUrl !== false) captureReadingProgress(); return loaded; });
    return ready;
  }
  function hydrate() {
    const params = new URL(location.href).searchParams;
    for (const name of ['search', 'tag', 'source', 'difficulty', 'solutions']) {
      const input = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
      input.value = params.get(name) || '';
    }
    const ids = params.has('problems') ? (params.get('problems') || '').split(',').filter(Boolean) : null;
    selected = ids ? restoreSelection(ids, config.problems) : null;
    message.textContent = ids && ids.length !== selected!.length ? '链接中的部分题目不属于当前题单或已不可用，已显示能够找到的题目。' : '';
    mismatch = Boolean(params.get('revision') && params.get('revision') !== client.revision);
    $('.version-warning', section).hidden = !mismatch;
    currentPage = Number(params.get('page')) || 1;
    const anchor = initial ? pendingResume?.anchor || hashId() : hashId();
    initial = false;
    void update({ writeUrl: false, anchor }).then(() => {
      // Clamp obsolete/out-of-range page numbers without losing selection state.
      if (params.has('page') || anchor) updateUrl();
    });
  }
  function resetPage() {
    currentPage = 1;
    pendingResume = null; restoringProgress = false;
    if (pageForAnchor(config.problems.map(problem => problem.id), config.problems, hashId()) !== null) {
      const url = new URL(location.href); url.hash = 'exercises'; history.replaceState(null, '', url);
    }
  }
  function reset() { form.reset(); selected = null; resetPage(); message.textContent = ''; void update(); }
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('input', () => { selected = null; resetPage(); message.textContent = ''; void update(); });
  $$('.reset-filters', section).forEach(button => button.addEventListener('click', reset));
  $('[data-clear-sample]', section).addEventListener('click', () => { selected = null; resetPage(); message.textContent = ''; void update(); });
  $('[data-use-current]', section).addEventListener('click', () => { mismatch = false; $('.version-warning', section).hidden = true; void update(); });
  $('[data-retry-page]', section).addEventListener('click', () => {
    ready = mountPage();
    void ready.then(loaded => {
      if (!loaded) return;
      if (pendingResume) { restoringProgress = true; void restoreReadingPosition(pendingResume); }
      else void revealHash().then(captureReadingProgress);
    });
  });
  pagination.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-page]');
    if (!button || button.disabled) return;
    pendingResume = null; restoringProgress = false;
    currentPage = Number(button.dataset.page);
    // A previous deep link must not pull the next page back to its old card.
    const url = new URL(location.href); url.hash = 'exercises'; history.replaceState(null, '', url);
    void update({ push: true, scroll: true });
  });
  $('[data-random]', section).addEventListener('click', () => {
    const input = $<HTMLInputElement>('#random-count', section);
    if (!input.reportValidity()) return;
    selected = randomSample(filtered.map(problem => problem.id), Number(input.value), max => {
      const range = 0x100000000; const limit = range - range % max; const bytes = new Uint32Array(1);
      do { crypto.getRandomValues(bytes); } while (bytes[0] >= limit);
      return bytes[0] % max;
    });
    resetPage();
    message.textContent = `已从 ${filtered.length} 道符合条件的习题中抽取 ${selected.length} 道，题目不会重复。`;
    void update();
  });
  $('[data-toggle-solutions]', section).addEventListener('click', event => {
    const details = $$<HTMLDetailsElement>('.solution-block', list);
    expandedSolutions = details.length ? details.some(detail => !detail.open) : !expandedSolutions;
    details.forEach(detail => { detail.open = expandedSolutions; });
    (event.currentTarget as HTMLButtonElement).textContent = expandedSolutions ? '收起解答' : '展开解答';
    refreshMath(list);
  });
  $('[data-share]', section).addEventListener('click', async () => {
    const url = new URL(location.href); url.searchParams.set('problems', visible.join(','));
    if (!mismatch) url.searchParams.set('revision', client.revision);
    try { await navigator.clipboard.writeText(url.href); message.textContent = '题单链接已复制，包含所有页的题目及其顺序。'; }
    catch {
      const input = document.createElement('input'); input.value = url.href; input.readOnly = true; input.setAttribute('aria-label', '题单分享链接'); input.className = 'share-url';
      message.replaceChildren(document.createTextNode('请复制题单链接：'), input); input.focus(); input.select();
    }
  });
  window.addEventListener('popstate', () => { hydrate(); void ready.then(revealHash); });
  hydrate();
  // Pagination limits rendering only. Printing retains the entire filtered or
  // randomly selected list, including every page in the displayed order.
  setupPrinting(section, config, () => visible, () => mismatch);
  return {
    ready: () => ready,
    async ensureAnchor(anchor: string) {
      const page = pageForAnchor(visible, config.problems, anchor);
      if (page !== null && page !== currentPage) { currentPage = page; return update(); }
      return ready;
    },
  };
}
function setupPrinting(section: HTMLElement, config: ListConfig, getIds: () => string[], isMismatch: () => boolean) {
  const dialog = $<HTMLDialogElement>('.print-dialog', section);
  const form = $<HTMLFormElement>('.print-options', dialog);
  const submit = $<HTMLButtonElement>('[data-print-submit]', dialog);
  const errors = $('.print-error', dialog);
  const submitted = $('.print-submitted', dialog);
  let submitting = false;
  const chapterTitle = (id: string) => client.chapters.find(chapter => chapter.id === id)?.title || '章节';
  function error(text: string) { errors.hidden = false; errors.textContent = text; }
  async function responseJson(response: Response) {
    if (!response.ok) {
      let body: { message?: string; error?: string } = {}; try { body = await response.json(); } catch { /* Keep a readable fallback. */ }
      if (response.status === 429) throw new Error('当前提交较多，请稍后再试。');
      if (response.status === 404) throw new Error('打印服务暂不可用。你可以先下载全文 PDF，或稍后再试。');
      if (response.status === 409) throw new Error('内容版本已更新，请刷新页面后重新生成。');
      throw new Error(body.message || body.error || 'PDF 生成请求未能完成，请稍后重试。');
    }
    return response.json();
  }
  $('[data-print-open]', section).addEventListener('click', () => {
    const groups = groupByChapter(getIds(), config.problems);
    $('.print-summary', dialog).textContent = `当前题单包含全部页面的 ${getIds().length} 道习题${groups.size > 1 ? `，分属 ${groups.size} 个章节` : ''}，按照题单中的题目顺序排版。`;
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
    errors.hidden = true; if (submitted) submitted.hidden = true; submitting = true; submit.disabled = true; submit.textContent = '正在提交…';
    let submittedCount = 0;
    try {
      for (const [chapterId, problemIds] of groups) {
        const request: PrintRequest = { revision: client.revision, chapterId, problemIds, includeDocuments: data.has('print-documents'), solutions, comments: data.has('print-comments'), title: config.title === '所有习题' ? chapterTitle(chapterId) : config.title };
        const response = await fetch(api('print'), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(20000) });
        const result = await responseJson(response);
        const title = groups.size > 1 ? `${request.title} · ${chapterTitle(chapterId)}` : request.title || chapterTitle(chapterId);
        const registered = registerPrintJob(result, { title, project: { id: client.projectId!, title: client.title || '课程', basePath: client.basePath || '/' } });
        if (!registered) throw new Error('打印服务返回的任务状态无效，请稍后重试。');
        submittedCount++;
      }
      if (submitted) { submitted.hidden = false; submitted.textContent = '任务已提交，可关闭此面板继续阅读。右上角“打印状态”可查看进度和下载 PDF。'; }
    } catch (cause) { error(cause instanceof Error && cause.name === 'TimeoutError' ? '提交耗时较长，请稍后重试；相同题单会复用已提交的任务。' : cause instanceof TypeError ? '暂时无法连接打印服务，请检查网络后重试。' : cause instanceof Error ? cause.message : '打印任务提交失败，请稍后重试。'); }
    finally {
      if (submitted && submittedCount > 0 && !errors.hidden) { submitted.hidden = false; submitted.textContent = `已有 ${submittedCount} 个任务成功提交，可在右上角“打印状态”查看。重新提交会复用相同任务。`; }
      submitting = false; submit.disabled = false; submit.textContent = '生成 PDF';
    }
  });
}
