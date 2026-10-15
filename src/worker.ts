import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compilePdf } from './pdf.js';
import { loadCourse, Queue, queueConfigFromEnv } from './queue.js';
import type { Claim, QueueConfig } from './queue.js';

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const artifactName = new RegExp(`^(${uuid})-(${uuid})(?:\\.(pdf|log))?$`);
function childPath(root: string, name: string): string {
  const parent = resolve(root); const child = resolve(parent, name);
  if (!child.startsWith(parent + sep) || child.slice(parent.length + 1).includes(sep)) throw new Error('缓存路径超出指定目录');
  return child;
}
/** Only engine-owned UUID artifacts are eligible; active tasks and symlinks are skipped. */
export async function pruneCache(queue: Queue, now = Date.now()): Promise<void> {
  const config = queue.config; const active = queue.activeIds();
  const pdfDir = join(config.stateDir, 'pdf');
  const pdfs: { path: string; id: string; size: number; mtime: number }[] = [];
  for (const name of await readdir(pdfDir).catch(() => [] as string[])) {
    const match = artifactName.exec(name); if (!match || match[3] !== 'pdf' || active.has(match[1])) continue;
    const file = childPath(pdfDir, name); const info = await lstat(file).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    pdfs.push({ path: file, id: match[1], size: info.size, mtime: info.mtimeMs });
  }
  pdfs.sort((a, b) => a.mtime - b.mtime);
  let total = pdfs.reduce((sum, file) => sum + file.size, 0);
  for (const file of pdfs) {
    if (now - file.mtime < config.cacheTtlMs && total <= config.cacheMaxBytes) continue;
    if (queue.activeIds().has(file.id)) continue;
    try { await rm(file.path); total -= file.size; queue.expireOutput(file.id, file.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[worker] cache cleanup:', error); }
  }
  for (const kind of ['logs', 'work'] as const) {
    const root = join(config.stateDir, kind);
    for (const name of await readdir(root).catch(() => [] as string[])) {
      const match = artifactName.exec(name);
      if (!match || (kind === 'logs' ? match[3] !== 'log' : !!match[3]) || active.has(match[1])) continue;
      const path = childPath(root, name); const info = await lstat(path).catch(() => undefined);
      if (!info || info.isSymbolicLink() || now - info.mtimeMs < config.logTtlMs) continue;
      if (queue.activeIds().has(match[1])) continue;
      if (kind === 'logs' ? info.isFile() : info.isDirectory()) await rm(path, { recursive: kind === 'work', force: true });
    }
  }
}

async function execute(queue: Queue, claim: Claim, shutdown?: AbortSignal): Promise<void> {
  const { job, token } = claim; const config = queue.config;
  const workDir = childPath(join(config.stateDir, 'work'), `${job.id}-${token}`);
  const outputPath = join(config.stateDir, 'pdf', `${job.id}-${token}.pdf`);
  const controller = new AbortController();
  const cancelFromShutdown = () => controller.abort();
  shutdown?.addEventListener('abort', cancelFromShutdown, { once: true });
  let lostLease = false;
  const heartbeat = setInterval(() => {
    try { if (!queue.heartbeat(job.id, token)) { lostLease = true; controller.abort(); } }
    catch (error) {
      // If ownership cannot be confirmed, fail closed and terminate compilation.
      lostLease = true; controller.abort(); console.error(`[worker] ${job.id} heartbeat failed:`, error);
    }
  }, Math.max(25, Math.floor(config.leaseMs / 3)));
  heartbeat.unref();
  console.log(`[worker] ${job.id} started (${job.attempts})`);
  try {
    const course = loadCourse(job.request.revision, config);
    await mkdir(workDir, { recursive: true });
    await mkdir(join(config.stateDir, 'locks'), { recursive: true });
    await compilePdf(course, job.request, {
      contentDir: join(config.releasesDir, job.request.revision, 'content'), workDir, outputPath,
      timeoutMs: 'kind' in job.request ? config.bookTimeoutMs : config.timeoutMs,
      signal: controller.signal, lockPath: join(config.stateDir, 'locks', `slot-${claim.slot}.lock`),
    });
    if (lostLease || !queue.complete(job.id, token, outputPath)) {
      await rm(outputPath, { force: true });
      console.error(`[worker] ${job.id} result discarded after lease loss`);
    } else console.log(`[worker] ${job.id} succeeded`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[worker] ${job.id} failed: ${detail}`);
    // Compiler logs stay local; avoid exposing host paths through the public API.
    const message = /超时|timed?\s*out|timeout/i.test(detail) ? 'PDF 编译超时，请减少题目数量后重试。' : 'PDF 编译失败，请联系维护者检查该任务的本地编译日志。';
    const logDir = join(config.stateDir, 'logs');
    await mkdir(logDir, { recursive: true });
    const compilerLog = await readFile(join(workDir, 'compile.log')).catch(() => Buffer.from(detail));
    await writeFile(childPath(logDir, `${job.id}-${token}.log`), compilerLog.subarray(Math.max(0, compilerLog.length - 128 * 1024)));
    queue.fail(job.id, token, message);
    await rm(outputPath, { force: true });
  } finally {
    clearInterval(heartbeat);
    shutdown?.removeEventListener('abort', cancelFromShutdown);
    await rm(workDir, { recursive: true, force: true });
  }
}
export async function runWorker(options: { config?: QueueConfig; signal?: AbortSignal; once?: boolean } = {}): Promise<void> {
  const queue = new Queue(options.config ?? queueConfigFromEnv());
  const active = new Set<Promise<void>>();
  let nextCleanup = 0;
  const poll = () => new Promise<void>(resolve => {
    if (options.signal?.aborted) return resolve();
    const wake = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', wake); resolve(); };
    const timer = setTimeout(wake, 500);
    options.signal?.addEventListener('abort', wake, { once: true });
  });
  try {
    while (!options.signal?.aborted) {
      if (Date.now() >= nextCleanup) {
        await pruneCache(queue).catch(error => console.error('[worker] cache cleanup failed:', error));
        nextCleanup = Date.now() + 10 * 60_000;
      }
      while (active.size < queue.config.maxParallel && !options.signal?.aborted) {
        const claim = queue.claim();
        if (!claim) break;
        const promise = execute(queue, claim, options.signal).catch(error => console.error('[worker] task cleanup failed:', error)).finally(() => active.delete(promise));
        active.add(promise);
      }
      if (options.once) { await Promise.all(active); break; }
      await poll();
    }
  } finally {
    // SIGTERM stops claims first, then lets active work finish under its compile timeout.
    await Promise.all(active); queue.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort()); process.once('SIGINT', () => controller.abort());
  await runWorker({ signal: controller.signal });
}
