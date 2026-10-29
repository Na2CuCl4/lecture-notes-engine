import { readFileSync } from 'node:fs';
import { access, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { loadCourse, QueueError, queueConfigFromEnv, validRevision } from './queue.js';
import { z } from 'zod';
import { projectIdentity, validateProjectPaths } from './project-schema.js';
import type { QueueConfig } from './queue.js';
import type { ProjectCatalog, ProjectEntry } from './types.js';

const titleSchema = z.string().trim().min(1);
const entrySchema = z.object({
  ...projectIdentity, title: titleSchema, revision: z.string().refine(validRevision, '项目版本无效'),
  subtitle: z.string().optional(), author: z.string().optional(),
});
const catalogSchema = z.object({
  schemaVersion: z.literal(1), title: titleSchema, projects: z.array(entrySchema),
});

/** Validate catalog data once, when it enters through disk or publication. */
export function validateCatalog(value: unknown): ProjectCatalog {
  const catalog = catalogSchema.parse(value);
  validateProjectPaths(catalog.projects);
  return catalog;
}

export function readProjectCatalog(config: Pick<QueueConfig, 'releasesDir'>): ProjectCatalog | undefined {
  let input: string;
  try { input = readFileSync(join(config.releasesDir, 'projects.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new QueueError('项目目录无法读取，请联系维护者。', 503);
  }
  try { return validateCatalog(JSON.parse(input)); }
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

async function writeCatalog(releasesDir: string, catalog: ProjectCatalog): Promise<ProjectCatalog> {
  const config = { ...queueConfigFromEnv(), releasesDir };
  for (const project of catalog.projects) {
    const course = loadCourse(project.revision, config);
    if (course.projectId !== project.id || course.basePath !== project.basePath) {
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
  const validated = validateCatalog(catalog);
  await withPublishLock(releasesDir, async () => {
    if (expectedCatalog !== undefined) {
      const current = readProjectCatalog({ releasesDir }) ?? null;
      if (!isDeepStrictEqual(current, expectedCatalog)) throw new Error('构建期间项目目录已被其他发布更新；本次未覆盖，请重新构建发布。');
    }
    await writeCatalog(releasesDir, validated);
  });
}

/** Serialize read/merge/write so concurrent independent project builds cannot lose updates. */
export async function updateProjectCatalog(releasesDir: string, project: ProjectEntry, title?: string): Promise<ProjectCatalog> {
  const entry = entrySchema.parse(project);
  const catalogTitle = title === undefined ? undefined : titleSchema.parse(title);
  return withPublishLock(releasesDir, async () => {
    const existing = readProjectCatalog({ releasesDir });
    const projects = [...(existing?.projects ?? [])];
    const index = projects.findIndex(project => project.id === entry.id);
    if (index < 0) projects.push(entry); else projects[index] = entry;
    validateProjectPaths(projects);
    return writeCatalog(releasesDir, { schemaVersion: 1, title: catalogTitle ?? existing?.title ?? '讲义项目', projects });
  });
}
