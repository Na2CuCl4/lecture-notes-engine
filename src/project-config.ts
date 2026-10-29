import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { projectIdentity, validateProjectPaths } from './project-schema.js';

const projectSchema = z.object({
  id: projectIdentity.id,
  content: z.string().min(1),
  basePath: z.string().optional(),
  title: z.string().min(1).optional(),
  siteUrl: z.string().url().optional(),
}).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().min(1).default('课程讲义'),
  projects: z.array(projectSchema).min(1),
}).strict();

export interface ProjectConfig {
  id: string;
  contentDir: string;
  basePath: string;
  title?: string;
  siteUrl?: string;
}
export interface ProjectsConfig { schemaVersion: 1; title: string; projects: ProjectConfig[]; file: string }

/** Resolve source paths against the manifest, independent of the CLI cwd. */
export async function loadProjectsConfig(file: string): Promise<ProjectsConfig> {
  const absoluteFile = path.resolve(file);
  const parsed = manifestSchema.parse(parse(await readFile(absoluteFile, 'utf8')));
  const entries = parsed.projects.map(project => ({ ...project, basePath: projectIdentity.basePath.parse(project.basePath ?? `/${project.id}/`) }));
  validateProjectPaths(entries);
  const projects: ProjectConfig[] = [];
  for (const project of entries) {
    if (project.siteUrl && !/^https?:\/\//.test(project.siteUrl)) throw new Error(`项目 ${project.id} 的 siteUrl 只支持 http(s)`);
    const contentDir = path.resolve(path.dirname(absoluteFile), project.content);
    if (!await stat(contentDir).then(info => info.isDirectory()).catch(() => false)) throw new Error(`项目 ${project.id} 内容目录不存在：${contentDir}`);
    projects.push({ id: project.id, contentDir, basePath: project.basePath, title: project.title, siteUrl: project.siteUrl });
  }
  return { schemaVersion: 1, title: parsed.title, projects, file: absoluteFile };
}

export function selectProjects(config: ProjectsConfig, id?: string): ProjectConfig[] {
  if (!id) return config.projects;
  const project = config.projects.find(project => project.id === id);
  if (!project) throw new Error(`项目清单中没有项目：${id}`);
  return [project];
}
