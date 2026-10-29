import { z } from 'zod';

const reserved = new Set(['api', 'healthz', '_engine', '_releases', '_portal', '_projects', '_astro', 'assets', 'vendor', 'downloads', 'fragments']);

export const projectIdentity = {
  id: z.string().max(64).regex(/^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/, '项目 ID 无效'),
  basePath: z.string().regex(/^\/(?:[a-zA-Z0-9_-]+\/)+$/, 'basePath 必须是非根路径的 /分段/ 形式')
    .refine(value => !reserved.has((value.split('/')[1] ?? '').toLowerCase()), 'basePath 使用了保留路径'),
};

export function validateProjectPaths(projects: { id: string; basePath: string }[]): void {
  const ids = new Set<string>();
  const paths: string[] = [];
  for (const project of projects) {
    if (ids.has(project.id)) throw new Error(`重复项目 ID：${project.id}`);
    if (paths.some(existing => existing.startsWith(project.basePath) || project.basePath.startsWith(existing))) {
      throw new Error(`项目路径重复或嵌套：${project.basePath}`);
    }
    ids.add(project.id);
    paths.push(project.basePath);
  }
}
