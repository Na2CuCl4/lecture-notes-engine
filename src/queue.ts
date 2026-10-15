import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BookRequest, CompileRequest, Course, PrintJob, PrintRequest, SolutionMode } from './types.js';

/** Bump whenever PDF template/rendering semantics change. */
export const PRINT_TEMPLATE_VERSION = '3';
export interface QueueConfig {
  stateDir: string; releasesDir: string; currentFile: string;
  maxParallel: number; maxQueued: number; maxActivePerSource: number;
  maxProblems: number; leaseMs: number; maxAttempts: number;
  timeoutMs: number; bookTimeoutMs: number;
  cacheTtlMs: number; cacheMaxBytes: number; logTtlMs: number;
}
function positive(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} 必须为正整数`);
  return number;
}
export function queueConfigFromEnv(): QueueConfig {
  const releasesDir = resolve(process.env.RELEASES_DIR ?? 'dist/releases');
  return {
    stateDir: resolve(process.env.STATE_DIR ?? '.state'),
    releasesDir,
    currentFile: resolve(process.env.CURRENT_FILE ?? join(releasesDir, 'current.json')),
    maxParallel: positive(process.env.PRINT_CONCURRENCY, 1, 'PRINT_CONCURRENCY'),
    maxQueued: positive(process.env.PRINT_MAX_QUEUED, 30, 'PRINT_MAX_QUEUED'),
    maxActivePerSource: positive(process.env.PRINT_MAX_ACTIVE_PER_SOURCE, 3, 'PRINT_MAX_ACTIVE_PER_SOURCE'),
    maxProblems: positive(process.env.PRINT_MAX_PROBLEMS, 500, 'PRINT_MAX_PROBLEMS'),
    leaseMs: positive(process.env.PRINT_LEASE_MS, 60_000, 'PRINT_LEASE_MS'),
    maxAttempts: positive(process.env.PRINT_MAX_ATTEMPTS, 2, 'PRINT_MAX_ATTEMPTS'),
    timeoutMs: positive(process.env.PRINT_TIMEOUT_MS, 180_000, 'PRINT_TIMEOUT_MS'),
    bookTimeoutMs: positive(process.env.BOOK_TIMEOUT_MS, 900_000, 'BOOK_TIMEOUT_MS'),
    cacheTtlMs: positive(process.env.PRINT_CACHE_TTL_HOURS, 168, 'PRINT_CACHE_TTL_HOURS') * 3_600_000,
    cacheMaxBytes: positive(process.env.PRINT_CACHE_MAX_MB, 1024, 'PRINT_CACHE_MAX_MB') * 1024 * 1024,
    logTtlMs: positive(process.env.PRINT_LOG_TTL_HOURS, 168, 'PRINT_LOG_TTL_HOURS') * 3_600_000,
  };
}

export class QueueError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}
export function validRevision(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(value);
}
// Snapshots are immutable. Keep two revisions to cover a publish transition without
// synchronously reparsing the complete book for every CSS/font/health request.
const courseCache = new Map<string, Course>();
export function loadCourse(revision: string | undefined, config: QueueConfig = queueConfigFromEnv()): Course {
  let requested = revision;
  if (requested === undefined) {
    try { requested = JSON.parse(readFileSync(config.currentFile, 'utf8')).revision; }
    catch { throw new QueueError('尚无已发布的课程版本，请先运行内容构建。', 503); }
  }
  if (!validRevision(requested)) throw new QueueError('无效的课程版本。');
  const snapshot = join(config.releasesDir, requested, 'course.json');
  const cached = courseCache.get(snapshot);
  if (cached && existsSync(snapshot)) {
    courseCache.delete(snapshot); courseCache.set(snapshot, cached);
    return cached;
  }
  let course: Course;
  try { course = JSON.parse(readFileSync(snapshot, 'utf8')); }
  catch { throw new QueueError('课程版本不存在或已清理，请刷新页面后重试。', 404); }
  if (course.schemaVersion !== 1 || course.revision !== requested || !Array.isArray(course.chapters) || !course.problems || !course.engineVersion) {
    throw new QueueError('课程快照无效，请联系维护者重新构建。', 503);
  }
  courseCache.set(snapshot, course);
  while (courseCache.size > 2) courseCache.delete(courseCache.keys().next().value!);
  return course;
}
export function basePrefix(basePath: string): string {
  const base = '/' + basePath.replace(/^\/+|\/+$/g, '');
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(base)) throw new Error('basePath 只能包含字母、数字、下划线、连字符及斜杠');
  return base === '/' ? '' : base;
}
export function validatePrintRequest(input: unknown, course: Course, maxProblems = 500): PrintRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new QueueError('打印请求必须为对象。');
  const value = input as Record<string, unknown>;
  const allowed = new Set(['revision', 'chapterId', 'problemIds', 'includeDocuments', 'solutions', 'comments', 'title']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new QueueError('打印请求包含不支持的字段。');
  if (value.revision !== course.revision) throw new QueueError('课程版本不匹配。');
  if (typeof value.chapterId !== 'string') throw new QueueError('必须选择一个章节。');
  const chapter = course.chapters.find(ch => ch.id === value.chapterId);
  if (!chapter) throw new QueueError('章节不存在。');
  if (!Array.isArray(value.problemIds) || value.problemIds.length > maxProblems || value.problemIds.some(id => typeof id !== 'string')) {
    throw new QueueError(`题目清单格式错误，单次最多 ${maxProblems} 题。`);
  }
  const problemIds = value.problemIds as string[];
  if (new Set(problemIds).size !== problemIds.length) throw new QueueError('题目清单不能重复。');
  if (problemIds.some(id => !chapter.problems.includes(id) || course.problems[id]?.chapterId !== chapter.id)) {
    throw new QueueError('打印只能包含当前章节主归属的题目；跨章题单请按章节分别打印。');
  }
  if (typeof value.includeDocuments !== 'boolean' || typeof value.comments !== 'boolean') throw new QueueError('必须明确是否包含文档及评语。');
  if (!['none', 'inline', 'end'].includes(value.solutions as string)) throw new QueueError('必须选择有效的解答排版方式。');
  if (!problemIds.length && !(value.includeDocuments && chapter.documents.length)) throw new QueueError('打印内容不能为空。');
  if (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 120 || /[\x00-\x1f\x7f]/.test(value.title))) {
    throw new QueueError('标题须为不超过 120 字的单行文字。');
  }
  return {
    revision: course.revision, chapterId: chapter.id, problemIds: [...problemIds],
    includeDocuments: value.includeDocuments, solutions: value.solutions as SolutionMode, comments: value.comments,
    ...(typeof value.title === 'string' && value.title.trim() ? { title: value.title.trim() } : {}),
  };
}
function stableRequest(request: CompileRequest): CompileRequest {
  if ('kind' in request) return { revision: request.revision, kind: 'book', solutions: request.solutions, comments: request.comments };
  return {
    revision: request.revision, chapterId: request.chapterId, problemIds: request.problemIds,
    includeDocuments: request.includeDocuments, solutions: request.solutions, comments: request.comments,
    ...(request.title ? { title: request.title } : {}),
  };
}
export function printCacheKey(course: Course, request: CompileRequest): string {
  return createHash('sha256').update(JSON.stringify({ engine: course.engineVersion, template: PRINT_TEMPLATE_VERSION, request: stableRequest(request) })).digest('hex');
}
type Row = Record<string, any>;
function asJob(row: Row): PrintJob {
  return {
    id: row.id, key: row.cache_key, request: JSON.parse(row.request_json), state: row.state,
    createdAt: row.created_at, updatedAt: row.updated_at, attempts: row.attempts,
    ...(row.error ? { error: row.error } : {}), ...(row.output_path ? { outputPath: row.output_path } : {}),
  };
}
export interface Claim { job: PrintJob; token: string; slot: number }

/** All capacity checks and claims are transactional across web, worker and CI processes. */
export class Queue {
  readonly db: DatabaseSync;
  constructor(readonly config: QueueConfig = queueConfigFromEnv()) {
    mkdirSync(config.stateDir, { recursive: true });
    mkdirSync(join(config.stateDir, 'pdf'), { recursive: true });
    this.db = new DatabaseSync(join(config.stateDir, 'jobs.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, cache_key TEXT NOT NULL UNIQUE, request_json TEXT NOT NULL,
        state TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER, lease_token TEXT, slot INTEGER, error TEXT, output_path TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(state, priority, created_at);
      CREATE INDEX IF NOT EXISTS jobs_source ON jobs(source, state);
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(jobs)').all() as Row[];
      if (!columns.some(column => column.name === 'slot')) this.db.exec('ALTER TABLE jobs ADD COLUMN slot INTEGER');
    });
    // One persistent limit is shared even if processes accidentally receive different environment values.
    this.db.prepare('INSERT OR IGNORE INTO settings(name,value) VALUES (?,?)').run('max_parallel', config.maxParallel);
    const stored = this.db.prepare('SELECT value FROM settings WHERE name=?').get('max_parallel') as Row;
    if (stored.value !== config.maxParallel) {
      this.db.close();
      throw new Error(`打印并发设置与持久队列不一致（队列 ${stored.value}，配置 ${config.maxParallel}）。停止全部 worker 后使用队列 setConcurrency() 更新。`);
    }
  }
  close(): void { this.db.close(); }
  private transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = callback(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setConcurrency(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('并发数必须为正整数');
    this.transaction(() => {
      if (Number((this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='running'").get() as Row).n)) throw new Error('存在运行中的任务，不能修改并发限制');
      this.db.prepare('UPDATE settings SET value=? WHERE name=?').run(limit, 'max_parallel');
      this.config.maxParallel = limit;
    });
  }
  enqueue(course: Course, request: CompileRequest, source = 'cli'): { job: PrintJob; reused: boolean } {
    if (request.revision !== course.revision) throw new QueueError('课程版本不匹配。');
    const key = printCacheKey(course, request);
    return this.transaction(() => {
      this.recoverExpiredUnsafe(Date.now());
      const existing = this.db.prepare('SELECT * FROM jobs WHERE cache_key=?').get(key) as Row | undefined;
      if (existing && (existing.state === 'queued' || existing.state === 'running' ||
        (existing.state === 'succeeded' && existing.output_path && existsSync(existing.output_path)))) {
        return { job: asJob(existing), reused: true };
      }
      const queued = Number((this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='queued'").get() as Row).n);
      if (queued >= this.config.maxQueued) throw new QueueError('打印队列已满，请稍后重试。', 429);
      const sourceKey = createHash('sha256').update(source).digest('hex');
      const active = Number((this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE source=? AND state IN ('queued','running')").get(sourceKey) as Row).n);
      if (!('kind' in request) && active >= this.config.maxActivePerSource) throw new QueueError('你提交的打印任务仍在处理，请等候完成后再提交。', 429);
      const now = new Date().toISOString();
      // An explicit resubmission can retry a failed task or rebuild an evicted PDF,
      // with the same source/capacity/rate limits as a fresh request.
      if (existing) {
        this.db.prepare("UPDATE jobs SET state='queued',source=?,created_at=?,updated_at=?,attempts=0,lease_until=NULL,lease_token=NULL,slot=NULL,error=NULL,output_path=NULL WHERE id=?")
          .run(sourceKey, now, now, existing.id);
        return { job: this.get(existing.id)!, reused: false };
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO jobs(id,cache_key,request_json,state,priority,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, key, JSON.stringify(stableRequest(request)), 'queued', 'kind' in request ? 10 : 0, sourceKey, now, now);
      return { job: this.get(id)!, reused: false };
    });
  }
  get(id: string): PrintJob | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Row | undefined;
    if (!row) return undefined;
    const job = asJob(row);
    if (job.state === 'succeeded' && (!job.outputPath || !existsSync(job.outputPath))) {
      this.expireOutput(id);
      job.state = 'failed'; job.error = 'PDF 缓存已过期，请重新提交打印任务。'; delete job.outputPath;
    }
    if (job.state === 'queued') {
      job.position = Number((this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='queued' AND (priority<? OR (priority=? AND (created_at<? OR (created_at=? AND rowid<=?))))")
        .get(row.priority, row.priority, row.created_at, row.created_at, (this.db.prepare('SELECT rowid FROM jobs WHERE id=?').get(id) as Row).rowid) as Row).n);
    }
    return job;
  }
  counts(): Record<PrintJob['state'], number> {
    const result = { queued: 0, running: 0, succeeded: 0, failed: 0 };
    for (const row of this.db.prepare('SELECT state,COUNT(*) AS n FROM jobs GROUP BY state').all() as Row[]) result[row.state as PrintJob['state']] = Number(row.n);
    return result;
  }
  activeIds(): Set<string> {
    return new Set((this.db.prepare("SELECT id FROM jobs WHERE state IN ('queued','running')").all() as Row[]).map(row => row.id as string));
  }
  expireOutput(id: string, expectedOutputPath?: string): void {
    const suffix = expectedOutputPath === undefined ? '' : ' AND output_path=?';
    this.db.prepare("UPDATE jobs SET state='failed',output_path=NULL,error=?,updated_at=? WHERE id=? AND state='succeeded'" + suffix)
      .run('PDF 缓存已过期，请重新提交打印任务。', new Date().toISOString(), id, ...(expectedOutputPath === undefined ? [] : [expectedOutputPath]));
  }
  private recoverExpiredUnsafe(now: number): number {
    const stamp = new Date(now).toISOString();
    const rows = this.db.prepare("SELECT id,attempts FROM jobs WHERE state='running' AND lease_until<=?").all(now) as Row[];
    for (const row of rows) this.db.prepare('UPDATE jobs SET state=?,updated_at=?,lease_until=NULL,lease_token=NULL,slot=NULL,error=? WHERE id=?')
      .run(row.attempts >= this.config.maxAttempts ? 'failed' : 'queued', stamp, row.attempts >= this.config.maxAttempts ? '编译进程中断，已达到自动重试次数。' : '编译进程中断，任务已重新排队。', row.id);
    return rows.length;
  }
  recoverExpired(now = Date.now()): number { return this.transaction(() => this.recoverExpiredUnsafe(now)); }
  claim(now = Date.now()): Claim | undefined {
    return this.transaction(() => {
      this.recoverExpiredUnsafe(now);
      const running = Number((this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='running'").get() as Row).n);
      const capacity = Number((this.db.prepare('SELECT value FROM settings WHERE name=?').get('max_parallel') as Row).value);
      if (running >= capacity) return undefined;
      const row = this.db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY priority,created_at,rowid LIMIT 1").get() as Row | undefined;
      if (!row) return undefined;
      const occupied = new Set((this.db.prepare("SELECT slot FROM jobs WHERE state='running'").all() as Row[]).map(job => Number(job.slot ?? 0)));
      let slot = 0; while (occupied.has(slot)) slot++;
      if (slot >= capacity) return undefined;
      const token = randomUUID();
      this.db.prepare("UPDATE jobs SET state='running',attempts=attempts+1,updated_at=?,lease_until=?,lease_token=?,slot=?,error=NULL WHERE id=?")
        .run(new Date(now).toISOString(), now + this.config.leaseMs, token, slot, row.id);
      return { job: this.get(row.id)!, token, slot };
    });
  }
  heartbeat(id: string, token: string, now = Date.now()): boolean {
    return Number(this.db.prepare("UPDATE jobs SET lease_until=?,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND lease_until>?")
      .run(now + this.config.leaseMs, new Date(now).toISOString(), id, token, now).changes) === 1;
  }
  complete(id: string, token: string, outputPath: string): boolean {
    return Number(this.db.prepare("UPDATE jobs SET state='succeeded',output_path=?,updated_at=?,lease_until=NULL,lease_token=NULL,slot=NULL,error=NULL WHERE id=? AND state='running' AND lease_token=? AND lease_until>?")
      .run(outputPath, new Date().toISOString(), id, token, Date.now()).changes) === 1;
  }
  fail(id: string, token: string, error: string): boolean {
    return Number(this.db.prepare("UPDATE jobs SET state='failed',error=?,updated_at=?,lease_until=NULL,lease_token=NULL,slot=NULL WHERE id=? AND state='running' AND lease_token=?")
      .run(error.slice(0, 1000), new Date().toISOString(), id, token).changes) === 1;
  }
}

/** Privileged local entry point: intentionally not exposed by the HTTP API. */
export function enqueueBook(course: Course, options: Partial<Pick<BookRequest, 'solutions' | 'comments'>> = {}, config = queueConfigFromEnv()): PrintJob {
  const request: BookRequest = { revision: course.revision, kind: 'book', solutions: options.solutions ?? 'inline', comments: options.comments ?? true };
  if (!['none', 'inline', 'end'].includes(request.solutions) || typeof request.comments !== 'boolean') throw new QueueError('全文排版选项无效。');
  const queue = new Queue(config);
  try { return queue.enqueue(course, request, 'ci-book').job; } finally { queue.close(); }
}
export async function waitForJob(id: string, config = queueConfigFromEnv(), timeoutMs = config.bookTimeoutMs + 600_000): Promise<PrintJob> {
  const queue = new Queue(config); const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const job = queue.get(id);
      if (!job) throw new Error('打印任务不存在。');
      if (job.state === 'succeeded') return job;
      if (job.state === 'failed') throw new Error(job.error ?? '打印任务失败。');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('等待打印任务超时；任务仍由队列管理。');
  } finally { queue.close(); }
}
