import { PRINT_HISTORY_KEY, restorePrintHistory, mergePrintHistory, savedPrintJob, pendingPrintJob, printPollDelay, printStatusText, validProject, type PrintHistory, type PrintResult, type JobProject, type SavedPrintJob } from './print-jobs';

interface GlobalConfig { portal?: boolean; project?: JobProject }
interface ProjectInfo extends JobProject { subtitle?: string; author?: string; revision: string }
interface ProjectCatalog { title: string; projects: ProjectInfo[]; isMultiProject: boolean }
let started = false;
let history: PrintHistory = { version: 1, clearedAt: 0, jobs: [] };
let config: GlobalConfig = {};
let timer: ReturnType<typeof setTimeout> | undefined;
const nextPoll = new Map<string, number>();
const checking = new Set<string>();
const downloading = new Set<string>();
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const endpoint = (id: string) => `/_engine/jobs/${encodeURIComponent(id)}`;
function loadHistory() {
  try { return restorePrintHistory(localStorage.getItem(PRINT_HISTORY_KEY)); }
  catch { return { version: 1, clearedAt: 0, jobs: [] } as PrintHistory; }
}
function persist() {
  history = mergePrintHistory(history, loadHistory());
  try { localStorage.setItem(PRINT_HISTORY_KEY, JSON.stringify(history)); return true; }
  catch { return false; }
}
function currentJob(id: string) { return history.jobs.find(job => job.id === id); }
function commit(original: SavedPrintJob, patch: Partial<SavedPrintJob>) {
  // A clear in another tab or while a fetch is running must not resurrect jobs.
  history = mergePrintHistory(history, loadHistory());
  const current = currentJob(original.id);
  if (!current || current.savedAt !== original.savedAt) return;
  Object.assign(current, patch, { savedAt: Math.max(Date.now(), history.clearedAt + 1, current.savedAt + 1) });
  persist(); renderHistory();
}
function migrateLegacyHistory() {
  try {
    const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)!).filter(key => key?.startsWith('lecture-notes-jobs:'));
    for (const key of keys) {
      let values: unknown;
      try { values = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { continue; }
      if (!Array.isArray(values)) continue;
      const basePath = key.slice('lecture-notes-jobs:'.length).replace(/:[^:]*$/, '') || '/';
      const project = config.project && config.project.basePath.replace(/\/$/, '') === basePath.replace(/\/$/, '') ? config.project
        : { id: 'legacy', title: basePath === '/' ? '课程' : basePath.replace(/^\/|\/$/g, ''), basePath };
      for (const value of values) {
        const saved = savedPrintJob(value, { title: value?.title || '打印题单', project });
        if (saved && !currentJob(saved.id)) history.jobs.push(saved);
      }
      if (persist()) sessionStorage.removeItem(key);
    }
  } catch { /* A disabled session cache must not affect the new task history. */ }
}
export function registerPrintJob(result: PrintResult, fallback: { title: string; project: JobProject }): boolean {
  startGlobalUI();
  history = mergePrintHistory(history, loadHistory());
  const saved = savedPrintJob(result, fallback, Math.max(Date.now(), history.clearedAt + 1, (currentJob(result?.job?.id)?.savedAt || 0) + 1));
  if (!saved) return false;
  // A cross-chapter submission includes the chapter in its local title so
  // users can distinguish its separate downloads throughout later polling.
  saved.title = fallback.title.slice(0, 250) || saved.title;
  history.jobs = history.jobs.filter(job => job.id !== saved.id);
  history.jobs.unshift(saved);
  nextPoll.set(saved.id, 0);
  persist(); renderHistory(); schedulePoll();
  return true;
}
function showHistory() {
  const dialog = $<HTMLDialogElement>('[data-print-history-dialog]');
  if (!dialog) return;
  history = mergePrintHistory(history, loadHistory());
  renderHistory();
  if (!dialog.open) dialog.showModal();
  // Finished jobs need no background polling. Recheck them when opened.
  for (const job of history.jobs) if (job.state === 'succeeded') void checkJob(job);
  schedulePoll();
}
function renderHistory() {
  const list = $('[data-print-history-list]');
  const active = history.jobs.filter(pendingPrintJob).length;
  const ready = history.jobs.filter(job => job.state === 'succeeded').length;
  const count = $('[data-print-status-count]');
  if (count) { count.textContent = active ? String(active) : ready ? '可下载' : ''; count.hidden = !active && !ready; }
  const opener = $('[data-print-history-open]');
  opener?.setAttribute('aria-label', `打印状态${active ? `，${active} 个任务进行中` : ready ? `，${ready} 份 PDF 可下载` : ''}`);
  const clear = $<HTMLButtonElement>('[data-print-history-clear]');
  if (clear) clear.disabled = !history.jobs.length;
  if (!list) return;
  list.replaceChildren();
  if (!history.jobs.length) { const empty = document.createElement('p'); empty.className = 'print-history-empty'; empty.textContent = '暂无打印任务。在题单中选择“打印题单”即可生成 PDF。'; list.append(empty); return; }
  for (const job of history.jobs) {
    const row = document.createElement('article'); row.className = 'print-job'; row.dataset.printJobId = job.id;
    const text = document.createElement('div'); text.className = 'print-job-text';
    const project = document.createElement('p'); project.className = 'print-job-project'; project.textContent = job.project.title;
    const heading = document.createElement('h3'); heading.textContent = job.title;
    const state = document.createElement('p'); state.textContent = printStatusText(job); state.dataset.jobState = job.state;
    text.append(project, heading, state); row.append(text);
    if (job.state === 'succeeded') {
      const link = document.createElement('a'); link.className = 'button button-subtle'; link.textContent = '下载 PDF'; link.href = `${endpoint(job.id)}/pdf`; link.download = '';
      if (downloading.has(job.id)) { link.textContent = '正在下载…'; link.setAttribute('aria-disabled', 'true'); }
      link.addEventListener('click', event => { event.preventDefault(); void downloadPdf(job.id, link); }); row.append(link);
    } else if (pendingPrintJob(job) && job.failures > 0) {
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button button-subtle'; retry.textContent = '重试';
      retry.addEventListener('click', () => { const current = currentJob(job.id); if (!current) return; commit(current, { failures: 0 }); nextPoll.set(job.id, 0); schedulePoll(); }); row.append(retry);
    }
    list.append(row);
  }
}
async function downloadPdf(id: string, link: HTMLAnchorElement) {
  if (downloading.has(id)) return;
  downloading.add(id);
  link.setAttribute('aria-disabled', 'true'); link.textContent = '正在下载…';
  const notice = $('[data-print-history-error]');
  if (notice) notice.hidden = true;
  try {
    const response = await fetch(`${endpoint(id)}/pdf`, { signal: AbortSignal.timeout(60000) });
    if (response.status === 404 || response.status === 410) {
      const job = currentJob(id); if (job) commit(job, { state: 'expired', failures: 0 }); return;
    }
    if (!response.ok) throw new Error('下载暂时失败，请稍后再试。');
    const url = URL.createObjectURL(await response.blob());
    const save = document.createElement('a'); save.href = url; save.download = `lecture-${id}.pdf`; document.body.append(save); save.click(); save.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch { if (notice) { notice.textContent = '下载暂时失败，请检查网络后重试。'; notice.hidden = false; } }
  finally { downloading.delete(id); renderHistory(); }
}
async function checkJob(original: SavedPrintJob) {
  if (checking.has(original.id)) return;
  checking.add(original.id);
  try {
    const response = await fetch(endpoint(original.id), { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (response.status === 404 || response.status === 410) { commit(original, { state: 'expired', failures: 0 }); return; }
    if (!response.ok) throw new Error('暂时无法获取打印状态');
    const result = await response.json() as PrintResult;
    const saved = savedPrintJob(result, original);
    if (!saved || saved.id !== original.id) throw new Error('打印状态无效');
    commit(original, { state: saved.state, project: saved.project, position: saved.position, failures: 0 });
  } catch { commit(original, { failures: Math.min(8, original.failures + 1) }); }
  finally {
    checking.delete(original.id);
    const job = currentJob(original.id);
    if (job) nextPoll.set(job.id, Date.now() + printPollDelay(job.failures, document.hidden));
    schedulePoll();
  }
}
function schedulePoll() {
  if (timer) { clearTimeout(timer); timer = undefined; }
  const pending = history.jobs.filter(job => pendingPrintJob(job) && job.failures < 8 && !checking.has(job.id));
  if (!pending.length) return;
  const now = Date.now();
  const next = Math.min(...pending.map(job => nextPoll.get(job.id) ?? now));
  timer = setTimeout(() => {
    timer = undefined;
    for (const job of history.jobs) if (pendingPrintJob(job) && job.failures < 8 && !checking.has(job.id) && (nextPoll.get(job.id) ?? 0) <= Date.now()) void checkJob(job);
  }, Math.max(document.hidden ? 30000 : 0, next - now));
}
function projectLink(project: ProjectInfo, className?: string) {
  const link = document.createElement('a'); link.href = project.basePath; if (className) link.className = className;
  link.textContent = project.title;
  if (config.project?.id === project.id) link.setAttribute('aria-current', 'page');
  return link;
}
async function loadProjects() {
  const grid = $('[data-project-list]'), error = $('[data-project-error]'), status = $('[data-project-loading]');
  if (error) error.hidden = true;
  if (status) status.hidden = false;
  try {
    const response = await fetch('/_engine/projects', { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('项目列表暂不可用');
    const catalog = await response.json() as ProjectCatalog;
    if (!Array.isArray(catalog.projects)) throw new Error('项目列表无效');
    const projects = catalog.projects.filter(validProject);
    const title = typeof catalog.title === 'string' ? catalog.title : '课程项目';
    const heading = $('[data-portal-title]'); if (heading) { heading.textContent = title; document.title = title; }
    const picker = $<HTMLDetailsElement>('[data-project-picker]');
    const fallback = $('[data-project-fallback]');
    if (picker && catalog.isMultiProject) {
      picker.hidden = false; if (fallback) fallback.hidden = true;
      const links = $('[data-project-links]')!; links.replaceChildren();
      const all = document.createElement('a'); all.href = '/'; all.textContent = '所有项目'; if (config.portal) all.setAttribute('aria-current', 'page'); links.append(all);
      for (const project of projects) links.append(projectLink(project));
    }
    if (grid) {
      grid.replaceChildren();
      for (const project of projects) {
        const card = document.createElement('article'); card.className = 'project-card';
        const heading = document.createElement('h2'); heading.append(projectLink(project)); card.append(heading);
        if (project.subtitle) { const subtitle = document.createElement('p'); subtitle.textContent = project.subtitle; card.append(subtitle); }
        if (project.author) { const author = document.createElement('p'); author.className = 'project-author'; author.textContent = project.author; card.append(author); }
        grid.append(card);
      }
      const empty = $('[data-project-empty]'); if (empty) empty.hidden = projects.length !== 0;
    }
  } catch { if (error) error.hidden = false; }
  finally { if (status) status.hidden = true; }
}
export function startGlobalUI() {
  if (started) return;
  started = true;
  try { config = JSON.parse($('#global-client-config')?.textContent || '{}'); } catch { config = {}; }
  history = loadHistory(); migrateLegacyHistory(); renderHistory(); schedulePoll();
  $('[data-print-history-open]')?.addEventListener('click', showHistory);
  const dialog = $<HTMLDialogElement>('[data-print-history-dialog]');
  $('[data-print-history-close]')?.addEventListener('click', () => dialog?.close());
  dialog?.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  $('[data-print-history-clear]')?.addEventListener('click', () => {
    history = { version: 1, clearedAt: Math.max(Date.now(), ...history.jobs.map(job => job.savedAt), history.clearedAt) + 1, jobs: [] };
    persist(); nextPoll.clear(); renderHistory(); schedulePoll();
  });
  window.addEventListener('storage', event => {
    if (event.key !== PRINT_HISTORY_KEY && event.key !== null) return;
    const stored = loadHistory();
    history = event.key === null ? stored : mergePrintHistory(history, stored);
    // Concurrent terminal submissions otherwise stop polling before their
    // merged records reach disk. Write only on a real difference to converge.
    if (JSON.stringify(history) !== JSON.stringify(stored)) persist();
    renderHistory(); schedulePoll();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) for (const job of history.jobs) if (pendingPrintJob(job)) nextPoll.set(job.id, 0);
    schedulePoll();
  });
  window.addEventListener('pageshow', () => { history = mergePrintHistory(history, loadHistory()); renderHistory(); schedulePoll(); });
  window.addEventListener('pagehide', () => { if (timer) clearTimeout(timer); timer = undefined; });
  const picker = $<HTMLDetailsElement>('[data-project-picker]');
  document.addEventListener('click', event => { if (picker?.open && !picker.contains(event.target as Node)) picker.open = false; });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && picker?.open) { picker.open = false; picker.querySelector('summary')?.focus(); } });
  $('[data-project-retry]')?.addEventListener('click', () => { void loadProjects(); });
  if (picker || $('[data-project-list]')) void loadProjects();
}
