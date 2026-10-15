import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { loadProjectsConfig, selectProjects } from '../src/project-config.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lecture-project-config-'));
  const content = path.join(root, 'content');
  await mkdir(content);
  const file = path.join(root, 'projects.yaml');
  const put = async (projects: Record<string, unknown>[]) => writeFile(file, stringify({ schemaVersion: 1, title: '课程目录', projects }));
  return { root, content, file, put, dispose: () => rm(root, { recursive: true, force: true }) };
}

test('project config: shared sources resolve relative to manifest and retain independent mounts', async () => {
  const f = await fixture();
  try {
    await f.put([{ id: 'first', content: 'content' }, { id: 'second', content: f.content, title: '第二门课', basePath: '/courses/second/', siteUrl: 'https://example.test/courses/second/' }]);
    const config = await loadProjectsConfig(f.file);
    assert.equal(config.title, '课程目录');
    assert.equal(config.projects[0].contentDir, f.content);
    assert.equal(config.projects[1].contentDir, f.content);
    assert.equal(config.projects[0].basePath, '/first/');
    assert.equal(config.projects[1].basePath, '/courses/second/');
    assert.equal(config.projects[1].title, '第二门课');
    assert.deepEqual(selectProjects(config, 'second'), [config.projects[1]]);
    assert.throws(() => selectProjects(config, 'missing'), /没有项目/);
  } finally { await f.dispose(); }
});

test('project config: duplicate IDs, path collisions and reserved root prefixes are rejected', async () => {
  const f = await fixture();
  try {
    for (const projects of [
      [{ id: 'one', content: 'content' }, { id: 'one', content: 'content' }],
      [{ id: 'one', content: 'content', basePath: '/' }],
      [{ id: 'one', content: 'content', basePath: '/course/' }, { id: 'two', content: 'content', basePath: '/course/child/' }],
      [{ id: 'one', content: 'content', basePath: '/same/' }, { id: 'two', content: 'content', basePath: '/same/' }],
      ...['api', 'healthz', '_engine', '_releases', '_portal', '_projects', '_astro', 'assets', 'vendor', 'downloads', 'fragments'].map(prefix => [{ id: 'one', content: 'content', basePath: `/${prefix}/` }]),
    ]) {
      await f.put(projects);
      await assert.rejects(loadProjectsConfig(f.file), /重复|嵌套|根路径|保留路径/);
    }
  } finally { await f.dispose(); }
});

test('project config: missing sources, unsafe mount paths and unsupported URLs fail before building', async () => {
  const f = await fixture();
  try {
    await f.put([{ id: 'one', content: 'missing' }]);
    await assert.rejects(loadProjectsConfig(f.file), /内容目录不存在/);
    for (const basePath of ['/course', '/../', '/course/../', '/course space/', '//course/']) {
      await f.put([{ id: 'one', content: 'content', basePath }]);
      await assert.rejects(loadProjectsConfig(f.file), /basePath/);
    }
    await f.put([{ id: 'one', content: 'content', siteUrl: 'file:///etc/passwd' }]);
    await assert.rejects(loadProjectsConfig(f.file), /http/);
  } finally { await f.dispose(); }
});
