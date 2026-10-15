#!/usr/bin/env node
/*
 * Destructive only inside a private, UUID-named release/state directory. This is
 * intentionally an opt-in integration check; it is not part of `npm test`.
 * Run from the compiler image with:
 *   node scripts/verify-worker.mjs
 *
 * It runs two real workers against a real Pandoc/XeLaTeX compiler. The SQLite
 * concurrency setting is one, so two submitted chapters must never have two
 * XeLaTeX processes at once. Cancellation and lease recovery are covered by
 * the deterministic unit tests; this opt-in check focuses on the real
 * cross-process slot and compiler path.
 */
import { register } from 'tsx/esm/api';
register();
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

if (process.platform !== 'linux') throw new Error('verify-worker.mjs 需要 Linux 容器（flock 与 /proc）。');
const { Queue, queueConfigFromEnv } = await import('../src/queue.ts');
const { runWorker } = await import('../src/worker.ts');

const root = resolve(process.env.STATE_DIR || '.state', 'verify-worker', randomUUID());
const stateDir = join(root, 'state');
const releasesDir = join(root, 'releases');
const revision = 'c'.repeat(64);
const config = {
  ...queueConfigFromEnv(), stateDir, releasesDir,
  currentFile: join(releasesDir, 'current.json'), maxParallel: 1,
  maxQueued: 10, maxActivePerSource: 10, leaseMs: 2_000, maxAttempts: 2,
  timeoutMs: 30_000, bookTimeoutMs: 30_000,
};
const body = (source) => ({
  ast: { 'pandoc-api-version': [1, 22, 2, 1], meta: {}, blocks: [
    { t: 'Para', c: [{ t: 'Str', c: `集成验证 ${source}` }] },
  ] }, html: `<p>${source}</p>`, text: source, headings: [], source: `${source}.md`,
});
const problem = (id, chapterId, number) => ({ id, title: `测试题 ${number}`, tags: ['integration'], sources: [], difficulty: 1,
  chapterId, number, body: body(id), solutions: [], comments: [] });
const course = {
  schemaVersion: 1, engineVersion: 'verify-worker', revision, builtAt: new Date().toISOString(),
  title: 'Worker 集成验证', author: 'lecture-notes-engine', language: 'zh-CN',
  basePath: '/verify-worker/', siteUrl: 'http://localhost/verify-worker/', macros: '', macroConfig: {}, references: {}, assets: [],
  documents: {}, sets: {},
  chapters: [
    { id: 'chapter-one', title: '第一章', number: 1, body: body('chapter-one'), documents: [], problems: ['problem-one'], sets: [] },
    { id: 'chapter-two', title: '第二章', number: 2, body: body('chapter-two'), documents: [], problems: ['problem-two'], sets: [] },
  ],
  problems: {
    'problem-one': problem('problem-one', 'chapter-one', '1.1'),
    'problem-two': problem('problem-two', 'chapter-two', '2.1'),
  },
};
const requests = [
  { revision, chapterId: 'chapter-one', problemIds: ['problem-one'], includeDocuments: false, solutions: 'none', comments: false },
  { revision, chapterId: 'chapter-two', problemIds: ['problem-two'], includeDocuments: false, solutions: 'none', comments: false },
];
const workers = [];
const childPids = new Set();
async function compilerCount() {
  let count = 0;
  for (const name of await import('node:fs/promises').then(fs => fs.readdir('/proc')).catch(() => [])) {
    if (!/^\d+$/.test(name)) continue;
    // `flock ... xelatex ...` itself contains the word xelatex in cmdline;
    // inspect comm so the wrapper is not counted as a second compiler.
    const command = await readFile(`/proc/${name}/comm`).catch(() => Buffer.alloc(0));
    if (command.toString('utf8').trim() === 'xelatex') { count++; childPids.add(Number(name)); }
  }
  return count;
}
async function waitFor(predicate, timeout = 45_000, label = '条件') {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`等待${label}超时`);
}
function launchWorker() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
    cwd: resolve(new URL('..', import.meta.url).pathname), windowsHide: true,
    env: { ...process.env, STATE_DIR: config.stateDir, RELEASES_DIR: config.releasesDir,
      CURRENT_FILE: config.currentFile, PRINT_CONCURRENCY: '1', PRINT_LEASE_MS: String(config.leaseMs),
      PRINT_TIMEOUT_MS: String(config.timeoutMs), BOOK_TIMEOUT_MS: String(config.bookTimeoutMs),
      PRINT_MAX_QUEUED: '10', PRINT_MAX_ACTIVE_PER_SOURCE: '10', PRINT_MAX_ATTEMPTS: String(config.maxAttempts) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => process.stdout.write(`[worker ${child.pid}] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[worker ${child.pid}] ${chunk}`));
  workers.push(child); return child;
}
async function terminate(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); }, 10_000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
}
let queue;
try {
  await mkdir(join(releasesDir, revision, 'content'), { recursive: true });
  await mkdir(join(releasesDir, revision, 'site'), { recursive: true });
  await writeFile(join(releasesDir, revision, 'course.json'), JSON.stringify(course));
  await writeFile(join(releasesDir, revision, 'site', 'index.html'), '<p>verify-worker</p>');
  await writeFile(config.currentFile, JSON.stringify({ revision }));
  queue = new Queue(config);
  const first = queue.enqueue(course, requests[0], 'verify-worker-1').job;
  const second = queue.enqueue(course, requests[1], 'verify-worker-2').job;
  const workerOne = launchWorker();
  await waitFor(async () => (await compilerCount()) > 0, 20_000, '首个 XeLaTeX 进程');
  const workerTwo = launchWorker();
  let peak = 0;
  const sampleUntil = Date.now() + 2_000;
  while (Date.now() < sampleUntil) { peak = Math.max(peak, await compilerCount()); await new Promise(resolve => setTimeout(resolve, 100)); }
  if (peak > 1) throw new Error(`SQLite/flock 并发限制失效：观测到 ${peak} 个 XeLaTeX`);
  await waitFor(() => queue.get(first.id)?.state === 'succeeded' && queue.get(second.id)?.state === 'succeeded', 90_000, '两个 PDF 完成');
  const finalPeak = Math.max(peak, await compilerCount());
  if (finalPeak > 1) throw new Error(`最终观测到 ${finalPeak} 个 XeLaTeX`);
  const firstPdf = queue.get(first.id)?.outputPath; const secondPdf = queue.get(second.id)?.outputPath;
  if (!firstPdf || !secondPdf || !existsSync(firstPdf) || !existsSync(secondPdf)) throw new Error('任务成功但 PDF 缓存不存在');
  console.log(`verify-worker: PASS (peak XeLaTeX=${finalPeak}, jobs=${first.id},${second.id})`);
} finally {
  for (const child of workers) await terminate(child).catch(() => undefined);
  queue?.close();
  await rm(root, { recursive: true, force: true });
}
