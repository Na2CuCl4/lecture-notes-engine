import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, loadCourse, printCacheKey, queueConfigFromEnv, validatePrintRequest } from '../src/queue.js';
import { createServer } from '../src/server.js';
import { pruneCache } from '../src/worker.js';
import type { Body, Course, PrintRequest } from '../src/types.js';

const body: Body = { ast: { 'pandoc-api-version': [1, 23], meta: {}, blocks: [] }, html: '', text: '', headings: [], source: 'test.md' };
function course(): Course {
  return {
    schemaVersion: 1, engineVersion: 'test-1', revision: 'a'.repeat(32), builtAt: new Date().toISOString(), title: '测试课程', author: '测试',
    language: 'zh-CN', basePath: '/notes/', siteUrl: 'https://example.test/notes/', macros: '', macroConfig: {}, references: {}, assets: [],
    documents: { doc: { id: 'doc', title: '复习', tags: [], body } }, sets: {},
    chapters: [
      { id: 'one', title: '第一章', number: 1, body, documents: ['doc'], problems: ['p1', 'p2'], sets: [] },
      { id: 'two', title: '第二章', number: 2, body, documents: [], problems: ['p3'], sets: [] },
    ],
    problems: Object.fromEntries(['p1', 'p2', 'p3'].map((id, i) => [id, { id, title: id, tags: [], sources: [], difficulty: 1, chapterId: i < 2 ? 'one' : 'two', number: `1.${i + 1}`, body, solutions: [], comments: [] }])),
  };
}
function request(c = course()): PrintRequest {
  return { revision: c.revision, chapterId: 'one', problemIds: ['p1', 'p2'], includeDocuments: true, solutions: 'inline', comments: true };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lecture-queue-'));
  const config = { ...queueConfigFromEnv(), stateDir: join(root, 'state'), releasesDir: join(root, 'releases'), currentFile: join(root, 'releases', 'current.json'), leaseMs: 1000 };
  const c = course();
  const release = join(config.releasesDir, c.revision);
  mkdirSync(join(release, 'site'), { recursive: true });
  writeFileSync(join(release, 'course.json'), JSON.stringify(c));
  writeFileSync(config.currentFile, JSON.stringify({ revision: c.revision }));
  writeFileSync(join(release, 'site', 'index.html'), '<p>课程页面</p>');
  return { config, course: c, root, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test('cache keys retain question order, options, content revision and engine version', () => {
  const c = course(); const r = request(c); const original = printCacheKey(c, r);
  assert.notEqual(original, printCacheKey(c, { ...r, problemIds: [...r.problemIds].reverse() }));
  assert.notEqual(original, printCacheKey(c, { ...r, comments: false }));
  assert.notEqual(original, printCacheKey(c, { ...r, revision: 'b'.repeat(32) }));
  assert.notEqual(original, printCacheKey({ ...c, engineVersion: 'test-2' }, r));
  assert.equal(original, printCacheKey(c, { solutions: r.solutions, comments: r.comments, chapterId: r.chapterId, includeDocuments: r.includeDocuments, revision: r.revision, problemIds: r.problemIds }));
});

test('public requests reject cross-chapter, duplicate and arbitrary compiler fields', () => {
  const c = course(); const r = request(c);
  assert.deepEqual(validatePrintRequest(r, c), r);
  assert.throws(() => validatePrintRequest({ ...r, problemIds: ['p3'] }, c), /当前章节/);
  assert.throws(() => validatePrintRequest({ ...r, problemIds: ['p1', 'p1'] }, c), /不能重复/);
  assert.throws(() => validatePrintRequest({ ...r, rawtex: '\\input{/etc/passwd}' }, c), /不支持/);
  assert.throws(() => validatePrintRequest({ revision: c.revision, kind: 'book' }, c), /不支持/);
  assert.throws(() => validatePrintRequest({ ...r, solutions: undefined }, c), /排版/);
  assert.throws(() => validatePrintRequest({ ...r, problemIds: [], includeDocuments: false }, c), /不能为空/);
});

test('two SQLite connections enforce shared concurrency and prioritize chapter jobs over books', () => {
  const f = fixture(); const first = new Queue(f.config); const second = new Queue(f.config);
  try {
    const book = first.enqueue(f.course, { revision: f.course.revision, kind: 'book', solutions: 'inline', comments: true });
    const chapter = second.enqueue(f.course, request(f.course));
    const duplicate = first.enqueue(f.course, request(f.course), 'another reader');
    assert.equal(duplicate.reused, true); assert.equal(duplicate.job.id, chapter.job.id);
    const claim = first.claim()!;
    assert.equal(claim.job.id, chapter.job.id);
    assert.equal(second.claim(), undefined);
    assert.equal(second.get(book.job.id)?.position, 1);
    assert.equal(first.complete(claim.job.id, claim.token, join(f.config.stateDir, 'pdf', 'result.pdf')), true);
    assert.equal(second.claim()?.job.id, book.job.id);
  } finally { first.close(); second.close(); f.clean(); }
});

test('expired claims recover on restart, reject stale ownership, and stop after bounded retries', () => {
  const f = fixture(); let queue = new Queue(f.config);
  try {
    const enqueued = queue.enqueue(f.course, request(f.course));
    const now = Date.now(); const first = queue.claim(now)!;
    queue.close(); queue = new Queue(f.config);
    const second = queue.claim(now + f.config.leaseMs + 1)!;
    assert.equal(second.job.id, enqueued.job.id); assert.equal(second.job.attempts, 2);
    assert.equal(queue.heartbeat(first.job.id, first.token, now + f.config.leaseMs + 2), false);
    assert.equal(queue.complete(first.job.id, first.token, 'stale.pdf'), false);
    assert.equal(queue.fail(first.job.id, first.token, 'stale error'), false);
    assert.equal(queue.recoverExpired(now + 2 * f.config.leaseMs + 2), 1);
    assert.equal(queue.get(first.job.id)?.state, 'failed'); assert.equal(queue.claim(), undefined);
  } finally { queue.close(); f.clean(); }
});

test('source limits and queue capacity persist; duplicates do not consume additional capacity', () => {
  const f = fixture(); f.config.maxActivePerSource = 1; f.config.maxQueued = 2;
  const queue = new Queue(f.config);
  try {
    const r = request(f.course); queue.enqueue(f.course, r, 'reader1');
    assert.equal(queue.enqueue(f.course, r, 'reader1').reused, true);
    assert.throws(() => queue.enqueue(f.course, { ...r, comments: false }, 'reader1'), /仍在处理/);
    queue.enqueue(f.course, { ...r, comments: false }, 'reader2');
    assert.throws(() => queue.enqueue(f.course, { ...r, solutions: 'none' }, 'reader3'), /队列已满/);
  } finally { queue.close(); f.clean(); }
});

test('explicit resubmission retries failed jobs and missing PDFs under the same limits', () => {
  const f = fixture(); const queue = new Queue(f.config);
  try {
    const r = request(f.course); const first = queue.enqueue(f.course, r).job;
    const claim = queue.claim()!; queue.fail(claim.job.id, claim.token, 'temporary failure');
    const retry = queue.enqueue(f.course, r);
    assert.equal(retry.reused, false); assert.equal(retry.job.id, first.id); assert.equal(retry.job.attempts, 0);
    const second = queue.claim()!;
    queue.complete(second.job.id, second.token, join(f.config.stateDir, 'pdf', 'missing.pdf'));
    assert.match(queue.get(first.id)!.error!, /缓存已过期/);
    assert.equal(queue.enqueue(f.course, r).job.state, 'queued');
  } finally { queue.close(); f.clean(); }
});

test('cache cleanup bounds storage, expires completed PDFs, and preserves active/unrelated files', async () => {
  const f = fixture(); f.config.cacheMaxBytes = 1; f.config.logTtlMs = 1000;
  const queue = new Queue(f.config);
  try {
    const r = request(f.course); queue.enqueue(f.course, r);
    const claim = queue.claim()!; const cached = join(f.config.stateDir, 'pdf', `${claim.job.id}-${claim.token}.pdf`);
    writeFileSync(cached, '%PDF-completed'); queue.complete(claim.job.id, claim.token, cached);
    queue.enqueue(f.course, { ...r, comments: false }); const running = queue.claim()!;
    const activePdf = join(f.config.stateDir, 'pdf', `${running.job.id}-${running.token}.pdf`); writeFileSync(activePdf, '%PDF-writing');
    const unrelated = join(f.config.stateDir, 'pdf', 'user-file.pdf'); writeFileSync(unrelated, 'retain');
    const abandoned = join(f.config.stateDir, 'work', `${claim.job.id}-${claim.token}`);
    mkdirSync(abandoned, { recursive: true }); writeFileSync(join(abandoned, 'temporary.tex'), 'temporary');
    utimesSync(abandoned, new Date(0), new Date(0));
    await pruneCache(queue);
    assert.equal(existsSync(cached), false); assert.equal(existsSync(abandoned), false);
    assert.equal(existsSync(activePdf), true); assert.equal(existsSync(unrelated), true);
    assert.match(queue.get(claim.job.id)!.error!, /缓存已过期/);
  } finally { queue.close(); f.clean(); }
});

test('removing an orphan from a superseded attempt does not expire the current PDF', async () => {
  const f = fixture(); f.config.cacheTtlMs = 1000; const queue = new Queue(f.config);
  try {
    queue.enqueue(f.course, request(f.course)); const claim = queue.claim()!;
    const current = join(f.config.stateDir, 'pdf', `${claim.job.id}-${claim.token}.pdf`);
    writeFileSync(current, '%PDF-current'); queue.complete(claim.job.id, claim.token, current);
    const orphan = join(f.config.stateDir, 'pdf', `${claim.job.id}-${randomUUID()}.pdf`);
    writeFileSync(orphan, '%PDF-orphan'); utimesSync(orphan, new Date(0), new Date(0));
    await pruneCache(queue);
    assert.equal(existsSync(orphan), false); assert.equal(existsSync(current), true);
    assert.equal(queue.get(claim.job.id)?.state, 'succeeded');
  } finally { queue.close(); f.clean(); }
});

test('API serves mounted course, validates jobs, blocks premature download and follows published revision', async () => {
  const f = fixture(); const app = await createServer({ config: f.config });
  try {
    assert.equal((await app.inject('/healthz')).statusCode, 200);
    const home = await app.inject('/notes/'); assert.equal(home.statusCode, 200); assert.match(home.body, /课程页面/);
    const result = await app.inject({ method: 'POST', url: '/notes/api/print', payload: request(f.course) });
    assert.equal(result.statusCode, 202); const data = result.json(); assert.equal(data.job.state, 'queued');
    assert.equal(data.job.outputPath, undefined); assert.equal(data.job.key, undefined);
    assert.equal((await app.inject(data.statusUrl + '/pdf')).statusCode, 409);
    assert.equal((await app.inject(data.statusUrl)).json().job.position, 1);
    const invalid = await app.inject({ method: 'POST', url: '/notes/api/print', payload: { ...request(f.course), path: '../../secret' } });
    assert.equal(invalid.statusCode, 400);
    const book = await app.inject({ method: 'POST', url: '/notes/api/print', payload: { revision: f.course.revision, kind: 'book' } });
    assert.equal(book.statusCode, 400);
    const next = { ...f.course, revision: 'b'.repeat(32) }; const nextDir = join(f.config.releasesDir, next.revision);
    mkdirSync(join(nextDir, 'site'), { recursive: true });
    writeFileSync(join(nextDir, 'course.json'), JSON.stringify(next)); writeFileSync(join(nextDir, 'site', 'index.html'), '<p>新版本</p>');
    writeFileSync(f.config.currentFile, JSON.stringify({ revision: next.revision }));
    assert.match((await app.inject('/notes/')).body, /新版本/);
    assert.equal(loadCourse(f.course.revision, f.config).revision, f.course.revision);
    assert.throws(() => loadCourse('../secret', f.config), /无效/);
    const oldAssets = join(f.config.releasesDir, f.course.revision, 'site', 'assets');
    mkdirSync(oldAssets); writeFileSync(join(oldAssets, 'figure.svg'), '<svg></svg>');
    const asset = await app.inject(`/notes/_releases/${f.course.revision}/assets/figure.svg`);
    assert.equal(asset.statusCode, 200); assert.match(asset.headers['cache-control']!, /immutable/);
    assert.equal((await app.inject(`/notes/_releases/${f.course.revision}/course.json`)).statusCode, 404);
  } finally { await app.close(); f.clean(); }
});
