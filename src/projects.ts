import { existsSync, readFileSync } from 'node:fs';
import { access, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { basePrefix, loadCourse, QueueError, queueConfigFromEnv, validRevision } from './queue.js';
import type { QueueConfig } from './queue.js';
import type { ProjectCatalog, ProjectEntry } from './types.js';

const reserved = new Set(['api', 'healthz', '_engine', '_releases', '_portal', '_projects', '_astro', 'assets', 'vendor', 'downloads', 'fragments']);
const validId = /^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/;

/** Only public, portable project metadata belongs in the published catalog. */
export function validateCatalog(value: unknown): ProjectCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('项目目录必须为对象');
  const data = value as Record<string, unknown>;
  if (data.schemaVersion !== 1 || typeof data.title !== 'string' || !data.title.trim() || !Array.isArray(data.projects)) {
    throw new Error('项目目录需要 schemaVersion: 1、title 和 projects');
  }
  const ids = new Set<string>(); const prefixes: string[] = [];
  const projects = data.projects.map((value): ProjectEntry => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('项目条目必须为对象');
    const entry = value as Record<string, unknown>;
    if (typeof entry.id !== 'string' || entry.id.length > 64 || !validId.test(entry.id) || ids.has(entry.id)) throw new Error('项目 ID 无效或重复');
    if (typeof entry.title !== 'string' || !entry.title.trim()) throw new Error(`项目 ${entry.id} 缺少标题`);
    if (typeof entry.basePath !== 'string' || !/^\/(?:[a-zA-Z0-9_-]+\/)+$/.test(entry.basePath)) {
      throw new Error(`项目 ${entry.id} 的 basePath 必须是非根目录的 /分段/ 形式`);
    }
    const prefix = basePrefix(entry.basePath);
    if (reserved.has(prefix.split('/')[1]) || prefixes.some(other => prefix === other || prefix.startsWith(other + '/') || other.startsWith(prefix + '/'))) {
      throw new Error(`项目 ${entry.id} 的发布路径与其他项目重叠或使用了保留路径`);
    }
    if (!validRevision(entry.revision)) throw new Error(`项目 ${entry.id} 的版本无效`);
    for (const field of ['subtitle', 'author']) if (entry[field] !== undefined && typeof entry[field] !== 'string') throw new Error(`项目 ${entry.id} 的 ${field} 必须为文字`);
    ids.add(entry.id); prefixes.push(prefix);
    return { id: entry.id, title: entry.title, basePath: `${prefix}/`, revision: entry.revision,
      ...(typeof entry.subtitle === 'string' ? { subtitle: entry.subtitle } : {}),
      ...(typeof entry.author === 'string' ? { author: entry.author } : {}) };
  });
  return { schemaVersion: 1, title: data.title, projects };
}

/** Missing catalog deliberately means the pre-existing single-course mode. */
export function readProjectCatalog(config: Pick<QueueConfig, 'releasesDir'>): ProjectCatalog | undefined {
  const file = join(config.releasesDir, 'projects.json');
  if (!existsSync(file)) return undefined;
  try { return validateCatalog(JSON.parse(readFileSync(file, 'utf8'))); }
  catch { throw new QueueError('项目目录无效，请联系维护者重新发布。', 503); }
}

async function withPublishLock<T>(releasesDir: string, action: () => Promise<T>): Promise<T> {
  await mkdir(releasesDir, { recursive: true });
  const lock = join(releasesDir, '.projects.lock');
  const deadline = Date.now() + 10_000;
  let handle;
  while (!handle) {
    try { handle = await open(lock, 'wx'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('其他进程正在发布项目，请稍后重试；若发布进程曾意外退出，确认后清理 .projects.lock。');
      await setTimeout(25);
    }
  }
  try { return await action(); }
  finally { await handle.close(); await rm(lock, { force: true }); }
}

async function writeCatalog(releasesDir: string, input: ProjectCatalog): Promise<ProjectCatalog> {
  const catalog = validateCatalog(input);
  const config = { ...queueConfigFromEnv(), releasesDir };
  for (const project of catalog.projects) {
    const course = loadCourse(project.revision, config);
    if (course.projectId !== project.id || basePrefix(course.basePath) !== basePrefix(project.basePath)) {
      throw new Error(`项目 ${project.id} 的版本归属或发布路径不匹配`);
    }
    await access(join(releasesDir, project.revision, 'site', 'index.html'));
    await access(join(releasesDir, project.revision, 'site', 'portal', 'index.html'));
  }
  const temporary = join(releasesDir, `.projects-${randomUUID()}.json`);
  try {
    await writeFile(temporary, JSON.stringify(catalog, null, 2) + '\n');
    await rename(temporary, join(releasesDir, 'projects.json'));
  } finally { await rm(temporary, { force: true }); }
  return catalog;
}

/** Publish all projects together after every requested release has built successfully. */
export async function publishCatalog(releasesDir: string, catalog: ProjectCatalog, expectedCatalog?: ProjectCatalog | null): Promise<void> {
  await withPublishLock(releasesDir, async () => {
    if (expectedCatalog !== undefined) {
      const current = readProjectCatalog({ releasesDir }) ?? null;
      const expected = expectedCatalog === null ? null : validateCatalog(expectedCatalog);
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('构建期间项目目录已被其他发布更新；本次未覆盖，请重新构建发布。');
    }
    await writeCatalog(releasesDir, catalog);
  });
}

/** Serialize read/merge/write so concurrent independent project builds cannot lose updates. */
export async function updateProjectCatalog(releasesDir: string, project: ProjectEntry, title?: string): Promise<ProjectCatalog> {
  return withPublishLock(releasesDir, async () => {
    const existing = readProjectCatalog({ releasesDir });
    const projects = [...(existing?.projects ?? [])];
    const index = projects.findIndex(entry => entry.id === project.id);
    if (index < 0) projects.push(project); else projects[index] = project;
    return writeCatalog(releasesDir, { schemaVersion: 1, title: title ?? existing?.title ?? '讲义项目', projects });
  });
}
