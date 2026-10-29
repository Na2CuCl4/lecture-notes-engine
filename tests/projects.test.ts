import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishCatalog, readProjectCatalog, updateProjectCatalog } from '../src/projects.js';
import { Queue, queueConfigFromEnv } from '../src/queue.js';
import { createServer } from '../src/server.js';
import { publishProjectRelease } from '../src/cli.js';
import type { Body, Course, PrintRequest, ProjectCatalog, ProjectEntry } from '../src/types.js';

const body: Body = { ast: { 'pandoc-api-version': [1, 23], meta: {}, blocks: [] }, html: '', text: '', headings: [], source: 'test.md' };
function course(id: string, basePath: string, digit: string): Course {
  return { schemaVersion: 1, engineVersion: 'test-projects', projectId: id, revision: digit.repeat(64), builtAt: '2026-10-15T00:00:00Z',
    title: `课程 ${id}`, subtitle: `简介 ${id}`, author: '测试', language: 'zh-CN', basePath, siteUrl: `https://example.test${basePath}`,
    chapters: [{ id: 'chapter', title: '同名章节', number: 1, body, documents: [], problems: ['problem'], sets: [] }], documents: {}, sets: {},
    problems: { problem: { id: 'problem', title: '同名题目', tags: [], sources: [], difficulty: 1, chapterId: 'chapter', number: '1.1', body, solutions: [], comments: [] } },
    references: {}, macros: '', macroConfig: {} };
}
function entry(course: Course): ProjectEntry {
  return { id: course.projectId!, title: course.title, basePath: course.basePath, revision: course.revision, subtitle: course.subtitle, author: course.author };
}
function request(course: Course): PrintRequest {
  return { revision: course.revision, chapterId: 'chapter', problemIds: ['problem'], includeDocuments: false, solutions: 'inline', comments: true };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lecture-projects-'));
  const config = { ...queueConfigFromEnv(), stateDir: join(root, 'state'), releasesDir: join(root, 'releases') };
  function writeCourse(course: Course) {
    const release = join(config.releasesDir, course.revision);
    for (const directory of ['assets', 'portal', 'fragments/problems/problem']) mkdirSync(join(release, 'site', directory), { recursive: true });
    writeFileSync(join(release, 'course.json'), JSON.stringify(course));
    writeFileSync(join(release, 'site', 'index.html'), `<p>${course.title} ${course.revision}</p>`);
    writeFileSync(join(release, 'site', 'portal/index.html'), '<p>所有项目入口</p>');
    writeFileSync(join(release, 'site', 'assets/figure.svg'), `<svg>${course.projectId}</svg>`);
    writeFileSync(join(release, 'site', 'fragments/problems/problem/index.html'), `<article>${course.title}</article>`);
  }
  const a = course('project1', '/project1/', 'a'), b = course('project2', '/xiazr20/project2/', 'b');
  writeCourse(a); writeCourse(b);
  const catalog: ProjectCatalog = { schemaVersion: 1, title: '讲义库', projects: [entry(a), entry(b)] };
  return { root, config, a, b, catalog, writeCourse, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test('catalog publication verifies snapshot ownership and atomically merges concurrent independent updates', async () => {
  const f = fixture();
  try {
    assert.equal(readProjectCatalog(f.config), undefined);
    await publishCatalog(f.config.releasesDir, f.catalog, null);
    const target = { id: f.a.projectId!, basePath: f.a.basePath, contentDir: f.root };
    await publishProjectRelease(f.config.releasesDir, f.a.revision, target, f.catalog.title);
    await assert.rejects(publishProjectRelease(f.config.releasesDir, '../secret', target, f.catalog.title), /无效/);
    await assert.rejects(publishProjectRelease(f.config.releasesDir, f.b.revision, target, f.catalog.title), /不匹配/);
    await assert.rejects(publishProjectRelease(f.config.releasesDir, f.a.revision, { ...target, basePath: '/different/' }, f.catalog.title), /不匹配/);
    const original = readFileSync(join(f.config.releasesDir, 'projects.json'), 'utf8');
    await assert.rejects(publishCatalog(f.config.releasesDir, { ...f.catalog, projects: [{ ...entry(f.a), revision: f.b.revision }] }), /归属/);
    await assert.rejects(publishCatalog(f.config.releasesDir, { ...f.catalog, projects: [{ ...entry(f.a), revision: 'e'.repeat(64) }] }), /不存在/);
    assert.equal(readFileSync(join(f.config.releasesDir, 'projects.json'), 'utf8'), original);
    const nextA = { ...f.a, revision: 'c'.repeat(64) }, nextB = { ...f.b, revision: 'd'.repeat(64) };
    f.writeCourse(nextA); f.writeCourse(nextB);
    await Promise.all([updateProjectCatalog(f.config.releasesDir, entry(nextA)), updateProjectCatalog(f.config.releasesDir, entry(nextB))]);
    const published = readProjectCatalog(f.config)!;
    assert.deepEqual(published.projects.map(project => project.revision), [nextA.revision, nextB.revision]);
    await assert.rejects(publishCatalog(f.config.releasesDir, f.catalog, f.catalog), /其他发布/);
    assert.deepEqual(readProjectCatalog(f.config), published);
  } finally { f.clean(); }
});

test('multi-project HTTP isolates identical problem IDs, shared print queue and fixed revision resources', async () => {
  const f = fixture(); await publishCatalog(f.config.releasesDir, f.catalog);
  const app = await createServer({ config: f.config }); const queue = new Queue(f.config);
  try {
    const home = await app.inject('/'); assert.equal(home.statusCode, 200); assert.match(home.body, /所有项目入口/);
    assert.equal(home.headers['cache-control'], 'no-cache');
    const catalog = await app.inject('/_engine/projects'); assert.equal(catalog.statusCode, 200);
    assert.equal(catalog.json().projects.length, 2); assert.equal(catalog.headers['cache-control'], 'no-cache');
    assert.equal((await app.inject('/project1')).headers.location, '/project1/');
    assert.match((await app.inject('/project1/')).body, /课程 project1/);
    assert.match((await app.inject('/xiazr20/project2/')).body, /课程 project2/);
    assert.equal((await app.inject('/project10/')).statusCode, 404);
    assert.equal((await app.inject('/project1/api/health')).statusCode, 404);
    for (const payload of [null, {}, { revision: '../secret' }, { revision: 'a'.repeat(32) }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/project1/api/print', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) })).statusCode, 400);
    }
    const submittedA = await app.inject({ method: 'POST', url: '/project1/api/print', payload: request(f.a) });
    const submittedB = await app.inject({ method: 'POST', url: '/xiazr20/project2/api/print', payload: request(f.b) });
    assert.equal(submittedA.statusCode, 202); assert.equal(submittedB.statusCode, 202);
    const jobA = submittedA.json(), jobB = submittedB.json();
    assert.notEqual(jobA.job.id, jobB.job.id); assert.equal(jobA.project.id, 'project1'); assert.equal(jobB.project.id, 'project2');
    assert.match(jobA.statusUrl, /^\/_engine\/jobs\//); assert.equal(jobA.job.key, undefined); assert.equal(jobA.job.outputPath, undefined);
    assert.equal((await app.inject({ method: 'POST', url: '/project1/api/print', payload: request(f.b) })).statusCode, 404);
    assert.equal((await app.inject(`/project1/api/jobs/${jobB.job.id}`)).statusCode, 404);
    assert.equal((await app.inject(`/project1/api/jobs/${jobB.job.id}/pdf`)).statusCode, 404);
    assert.equal((await app.inject(`/_engine/jobs/${jobB.job.id}`)).json().project.basePath, f.b.basePath);
    assert.equal((await app.inject('/_engine/jobs')).statusCode, 404);
    assert.equal((await app.inject(`/project1/_releases/${f.b.revision}/assets/figure.svg`)).statusCode, 404);
    assert.equal((await app.inject(`/project1/_releases/${f.a.revision}/course.json`)).statusCode, 404);
    const fragment = await app.inject(`/project1/_releases/${f.a.revision}/fragments/problems/problem/index.html`);
    assert.match(fragment.body, /课程 project1/); assert.match(fragment.headers['cache-control']!, /immutable/);
    for (const url of [
      `/project1/_releases/${f.a.revision}/assets/%2e%2e/course.json`,
      `/project1/_releases/${f.a.revision}/assets/%5c..%5ccourse.json`, '/project1/.hidden', '/project1/%00secret',
    ]) assert.ok((await app.inject(url)).statusCode >= 400, url);
    const claim = queue.claim()!;
    assert.equal(queue.claim(), undefined, 'both projects share the same concurrency slot');
    const pdf = join(f.config.stateDir, 'pdf', `${claim.job.id}.pdf`); writeFileSync(pdf, '%PDF-test');
    assert.equal(queue.complete(claim.job.id, claim.token, pdf), true);
    const status = await app.inject(`/_engine/jobs/${claim.job.id}`);
    assert.equal(status.json().job.state, 'succeeded'); assert.equal(status.headers['cache-control'], 'private, no-cache');
    const downloaded = await app.inject(status.json().downloadUrl);
    assert.equal(downloaded.body, '%PDF-test'); assert.equal(downloaded.headers['cache-control'], 'private, no-cache');
    rmSync(pdf);
    assert.equal((await app.inject(status.json().downloadUrl)).statusCode, 410);
    const expired = (await app.inject(`/_engine/jobs/${claim.job.id}`)).json();
    assert.equal(expired.job.state, 'failed'); assert.match(expired.job.error, /缓存已过期/);
  } finally { queue.close(); await app.close(); f.clean(); }
});
