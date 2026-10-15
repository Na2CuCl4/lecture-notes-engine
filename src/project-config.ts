import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const projectId = z.string().max(64).regex(/^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/, '项目 ID 只能包含小写字母、数字、下划线和短横线，首尾必须是字母或数字');
const projectSchema = z.object({
  id: projectId,
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
  const ids = new Set<string>();
  const paths: string[] = [];
  const projects: ProjectConfig[] = [];
  for (const project of parsed.projects) {
    if (ids.has(project.id)) throw new Error(`重复项目 ID：${project.id}`);
    ids.add(project.id);
    const basePath = project.basePath ?? `/${project.id}/`;
    if (!/^\/(?:[a-zA-Z0-9_-]+\/)+$/.test(basePath)) throw new Error(`项目 ${project.id} 的 basePath 必须是 /项目路径/ 形式，不能占用根路径`);
    const prefix = basePath.split('/')[1].toLowerCase();
    if (['api', 'healthz', '_engine', '_releases', '_portal', '_projects', '_astro', 'assets', 'vendor', 'downloads', 'fragments'].includes(prefix)) throw new Error(`项目 ${project.id} 的 basePath 占用了保留路径：${basePath}`);
    if (paths.some(existing => existing.startsWith(basePath) || basePath.startsWith(existing))) throw new Error(`项目路径重复或嵌套：${basePath}`);
    paths.push(basePath);
    if (project.siteUrl && !/^https?:\/\//.test(project.siteUrl)) throw new Error(`项目 ${project.id} 的 siteUrl 只支持 http(s)`);
    const contentDir = path.resolve(path.dirname(absoluteFile), project.content);
    if (!await stat(contentDir).then(info => info.isDirectory()).catch(() => false)) throw new Error(`项目 ${project.id} 内容目录不存在：${contentDir}`);
    projects.push({ id: project.id, contentDir, basePath, title: project.title, siteUrl: project.siteUrl });
  }
  return { schemaVersion: 1, title: parsed.title, projects, file: absoluteFile };
}

export function selectProjects(config: ProjectsConfig, id?: string): ProjectConfig[] {
  if (!id) return config.projects;
  const project = config.projects.find(project => project.id === id);
  if (!project) throw new Error(`项目清单中没有项目：${id}`);
  return [project];
}
