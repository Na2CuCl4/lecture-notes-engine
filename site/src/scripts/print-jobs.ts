export const PRINT_HISTORY_KEY = 'lecture-notes-print-history:v1';
export const MAX_PRINT_HISTORY = 50;
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'expired';
export interface JobProject { id: string; title: string; basePath: string }
export interface SavedPrintJob {
  id: string; title: string; project: JobProject; state: JobState;
  createdAt: string; savedAt: number; failures: number; position?: number;
}
export interface PrintHistory { version: 1; clearedAt: number; jobs: SavedPrintJob[] }
export interface PrintResult {
  job: { id: string; state: string; createdAt?: string; position?: number; error?: string; request?: { title?: string } };
  project?: JobProject; title?: string;
}
const states: JobState[] = ['queued', 'running', 'succeeded', 'failed', 'expired'];
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const shortText = (value: unknown, fallback = '') => typeof value === 'string' ? value.slice(0, 250) : fallback;
export function validProject(value: unknown): value is JobProject {
  const project = value as JobProject | null;
  return Boolean(project && validId(project.id) && typeof project.title === 'string' && typeof project.basePath === 'string'
    && /^\/(?!\/)[^?#\\\s]*$/.test(project.basePath) && !project.basePath.split('/').some(part => part === '.' || part === '..'));
}
export function restorePrintHistory(raw: string | null): PrintHistory {
  const empty: PrintHistory = { version: 1, clearedAt: 0, jobs: [] };
  try {
    const data = JSON.parse(raw || 'null');
    if (!data || data.version !== 1 || !Array.isArray(data.jobs)) return empty;
    const clearedAt = Number.isFinite(data.clearedAt) && data.clearedAt >= 0 ? data.clearedAt : 0;
    const jobs: SavedPrintJob[] = [];
    const seen = new Set<string>();
    for (const value of data.jobs) {
      if (!value || !validId(value.id) || seen.has(value.id) || !validProject(value.project) || !states.includes(value.state)
        || !Number.isFinite(value.savedAt) || value.savedAt <= clearedAt || value.savedAt > Date.now() + 86400000) continue;
      seen.add(value.id);
      jobs.push({ id: value.id, title: shortText(value.title, '打印题单'),
        project: { id: value.project.id, title: shortText(value.project.title), basePath: value.project.basePath },
        state: value.state, createdAt: typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) ? value.createdAt : new Date(value.savedAt).toISOString(),
        savedAt: value.savedAt, failures: Number.isSafeInteger(value.failures) && value.failures >= 0 ? Math.min(value.failures, 8) : 0,
        ...(Number.isSafeInteger(value.position) && value.position > 0 ? { position: value.position } : {}),
      });
    }
    return { version: 1, clearedAt, jobs: jobs.sort((a, b) => b.savedAt - a.savedAt || a.id.localeCompare(b.id)).slice(0, MAX_PRINT_HISTORY) };
  } catch { return empty; }
}
export function mergePrintHistory(left: PrintHistory, right: PrintHistory): PrintHistory {
  const clearedAt = Math.max(left.clearedAt, right.clearedAt);
  const jobs = new Map<string, SavedPrintJob>();
  for (const job of [...left.jobs, ...right.jobs]) {
    if (job.savedAt <= clearedAt) continue;
    if (!jobs.has(job.id) || jobs.get(job.id)!.savedAt <= job.savedAt) jobs.set(job.id, job);
  }
  return { version: 1, clearedAt, jobs: [...jobs.values()].sort((a, b) => b.savedAt - a.savedAt || a.id.localeCompare(b.id)).slice(0, MAX_PRINT_HISTORY) };
}
export function savedPrintJob(result: PrintResult, fallback: { title: string; project: JobProject }, now = Date.now()): SavedPrintJob | null {
  if (!result?.job || !validId(result.job.id) || !states.includes(result.job.state as JobState)) return null;
  const project = validProject(result.project) ? result.project : fallback.project;
  if (!validProject(project)) return null;
  const state = result.job.state === 'failed' && typeof result.job.error === 'string' && /PDF.*(?:已过期|已缺失)/.test(result.job.error)
    ? 'expired' : result.job.state as JobState;
  return {
    id: result.job.id, title: shortText(result.title || result.job.request?.title || fallback.title, '打印题单'),
    project: { id: project.id, title: shortText(project.title), basePath: project.basePath }, state,
    createdAt: result.job.createdAt && Number.isFinite(Date.parse(result.job.createdAt)) ? result.job.createdAt : new Date(now).toISOString(),
    savedAt: now, failures: 0,
    ...(Number.isSafeInteger(result.job.position) && result.job.position! > 0 ? { position: result.job.position } : {}),
  };
}
export const pendingPrintJob = (job: SavedPrintJob) => job.state === 'queued' || job.state === 'running';
export const printPollDelay = (failures: number, hidden: boolean) => Math.max(hidden ? 30000 : 3000, Math.min(60000, 3000 * 2 ** Math.min(5, failures)));
export function printStatusText(job: SavedPrintJob): string {
  if (job.state === 'expired') return '任务或 PDF 已过期，请重新生成。';
  if (job.state === 'succeeded') return 'PDF 已准备好';
  if (job.state === 'failed') return '生成失败，请重新提交或联系课程维护者。';
  if (job.failures >= 8) return '暂时无法获取状态，点击“重试”恢复查询。';
  if (job.failures > 0) return '连接暂时中断，正在重试查询';
  if (job.state === 'running') return '正在排版，你可以继续阅读';
  return job.position && job.position > 1 ? `正在排队，前方还有 ${job.position - 1} 个任务` : '正在排队，稍后开始生成';
}
