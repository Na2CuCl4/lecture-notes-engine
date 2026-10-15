import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { existsSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { basePrefix, loadCourse, Queue, QueueError, queueConfigFromEnv, validRevision, validatePrintRequest } from './queue.js';
import { readProjectCatalog } from './projects.js';
import type { QueueConfig } from './queue.js';
import type { Course, PrintJob, ProjectEntry } from './types.js';

function publicJob(job: PrintJob) {
  const { outputPath: _outputPath, key: _key, ...view } = job;
  return view;
}
function projectFromCourse(course: Course): ProjectEntry {
  return { id: course.projectId ?? 'default', title: course.title, basePath: course.basePath, revision: course.revision,
    ...(course.subtitle ? { subtitle: course.subtitle } : {}), ...(course.author ? { author: course.author } : {}) };
}
function safeRequestPath(request: FastifyRequest): string {
  let pathname: string;
  try { pathname = decodeURIComponent(request.url.split('?')[0]); }
  catch { throw new QueueError('无效的资源路径。', 400); }
  if (!pathname.startsWith('/') || /[\\\0]/.test(pathname) || pathname.split('/').some(part => part.startsWith('.'))) {
    throw new QueueError('无效的资源路径。', 400);
  }
  return pathname;
}
function sameProject(course: Course, project: ProjectEntry, legacy: boolean): void {
  if ((legacy ? (course.projectId ?? 'default') : course.projectId) !== project.id || basePrefix(course.basePath) !== basePrefix(project.basePath)) {
    throw new QueueError('课程版本不属于当前项目或发布路径不匹配。', 404);
  }
}

export async function createServer(options: { config?: QueueConfig; logger?: boolean } = {}) {
  const config = options.config ?? queueConfigFromEnv();
  const queue = new Queue(config);
  try { if (!readProjectCatalog(config)) loadCourse(undefined, config); }
  catch (error) { queue.close(); throw error; }
  const trustedProxies = process.env.TRUST_PROXY?.split(',').map(value => value.trim()).filter(value => value && value !== 'false');
  if (trustedProxies?.some(value => value === 'true' || value === '*')) {
    queue.close(); throw new Error('TRUST_PROXY 请填写可信反向代理 IP/CIDR（逗号分隔），不能信任所有来源。');
  }
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 64 * 1024, trustProxy: trustedProxies?.length ? trustedProxies : false });
  app.addHook('onClose', async () => { queue.close(); });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof QueueError ? error.statusCode : Number((error as { statusCode?: number }).statusCode ?? 500);
    if (status >= 500) app.log.error(error);
    const message = error instanceof Error ? error.message : String(error);
    reply.code(status).send({ error: status >= 500 && !(error instanceof QueueError) ? '服务暂时不可用，请稍后重试。' : message });
  });
  await app.register(fastifyStatic, { root: config.releasesDir, serve: false, dotfiles: 'deny', cacheControl: false });
  await app.register(rateLimit, { global: false });

  function projectRoute(pathname: string) {
    const catalog = readProjectCatalog(config);
    const projects = catalog?.projects ?? [projectFromCourse(loadCourse(undefined, config))];
    const project = projects.find(entry => {
      const prefix = basePrefix(entry.basePath);
      return pathname === prefix || pathname.startsWith(`${prefix}/`);
    });
    if (!project) throw new QueueError('项目不存在。', 404);
    return { project, legacy: !catalog, prefix: basePrefix(project.basePath), relative: pathname.slice(basePrefix(project.basePath).length).replace(/^\//, '') };
  }
  function getJob(id: string): PrintJob {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new QueueError('打印任务不存在。', 404);
    const job = queue.get(id);
    if (!job) throw new QueueError('打印任务不存在。', 404);
    return job;
  }
  function jobResponse(job: PrintJob) {
    const course = loadCourse(job.request.revision, config);
    const project = projectFromCourse(course);
    const printRequest = job.request;
    const title = 'kind' in printRequest ? `${course.title} · 全文` : printRequest.title ?? course.chapters.find(chapter => chapter.id === printRequest.chapterId)?.title ?? course.title;
    return { job: publicJob(job), title, project: { id: project.id, title: project.title, basePath: project.basePath },
      statusUrl: `/_engine/jobs/${job.id}`, ...(job.state === 'succeeded' ? { downloadUrl: `/_engine/jobs/${job.id}/pdf` } : {}) };
  }
  async function download(job: PrintJob, reply: FastifyReply) {
    if (job.state === 'failed' && job.error?.includes('缓存已过期')) throw new QueueError(job.error, 410);
    if (job.state !== 'succeeded' || !job.outputPath) throw new QueueError('PDF 尚未生成成功。', 409);
    const root = resolve(config.stateDir, 'pdf'); const file = resolve(job.outputPath);
    if (!file.startsWith(root + sep) || basename(file) !== file.slice(root.length + 1) || !existsSync(file)) {
      throw new QueueError('PDF 文件已缺失，请联系维护者。', 410);
    }
    return reply.header('Cache-Control', 'private, no-cache').header('Content-Disposition', `attachment; filename="lecture-${job.id}.pdf"`).type('application/pdf').sendFile(basename(file), root);
  }

  app.get('/healthz', async () => {
    const catalog = readProjectCatalog(config);
    return catalog ? { ok: true, projects: catalog.projects.length } : { ok: true, revision: loadCourse(undefined, config).revision };
  });
  app.get('/_engine/projects', async (_request, reply) => {
    reply.header('Cache-Control', 'no-cache');
    const catalog = readProjectCatalog(config);
    if (catalog) return { ...catalog, isMultiProject: true };
    const course = loadCourse(undefined, config);
    return { schemaVersion: 1, title: '讲义项目', projects: [projectFromCourse(course)], isMultiProject: false };
  });
  app.get<{ Params: { id: string } }>('/_engine/jobs/:id', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-cache');
    return jobResponse(getJob(request.params.id));
  });
  app.get<{ Params: { id: string } }>('/_engine/jobs/:id/pdf', async (request, reply) => {
    const job = getJob(request.params.id);
    // Retired projects remain downloadable from fixed snapshots, never a mutable current pointer.
    loadCourse(job.request.revision, config);
    return download(job, reply);
  });

  app.post('/*', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (request, reply) => {
    const route = projectRoute(safeRequestPath(request));
    if (route.relative !== 'api/print') throw new QueueError('接口不存在。', 404);
    const input = request.body as Record<string, unknown> | null;
    if (!input || !validRevision(input.revision)) throw new QueueError('必须提供有效的课程版本。');
    const course = loadCourse(input.revision, config);
    sameProject(course, route.project, route.legacy);
    const print = validatePrintRequest(input, course, config.maxProblems);
    const result = queue.enqueue(course, print, request.ip);
    reply.code(result.reused ? 200 : 202).header('Cache-Control', 'private, no-cache');
    return { ...jobResponse(queue.get(result.job.id)!), reused: result.reused };
  });

  const servePage = async (request: FastifyRequest, reply: FastifyReply) => {
    const pathname = safeRequestPath(request);
    if (pathname.startsWith('/_engine/')) throw new QueueError('接口不存在。', 404);
    if (pathname === '/') {
      const catalog = readProjectCatalog(config);
      if (catalog) {
        reply.header('Cache-Control', 'no-cache');
        const first = catalog.projects[0];
        if (!first) return reply.type('text/html; charset=utf-8').send('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>讲义项目</title><h1>讲义项目</h1><p>暂无已发布的项目。</p></html>');
        const course = loadCourse(first.revision, config); sameProject(course, first, false);
        return reply.sendFile('portal/index.html', join(config.releasesDir, course.revision, 'site'));
      }
    }
    const route = projectRoute(pathname);
    if (pathname === route.prefix) return reply.redirect(`${route.prefix}/`);
    if (route.relative === 'api/health') {
      const course = loadCourse(route.project.revision, config); sameProject(course, route.project, route.legacy);
      return reply.header('Cache-Control', 'no-cache').send({ ok: true, revision: course.revision, queue: queue.counts() });
    }
    const scopedJob = /^api\/jobs\/([^/]+)(\/pdf)?$/.exec(route.relative);
    if (scopedJob) {
      const job = getJob(scopedJob[1]);
      sameProject(loadCourse(job.request.revision, config), route.project, route.legacy);
      return scopedJob[2] ? download(job, reply) : reply.header('Cache-Control', 'private, no-cache').send(jobResponse(job));
    }
    if (route.relative.startsWith('api/')) throw new QueueError('接口不存在。', 404);
    if (route.relative.startsWith('_releases/')) {
      const [, revision, ...parts] = route.relative.split('/');
      if (!validRevision(revision)) throw new QueueError('无效的课程版本。');
      if (!['assets', '_astro', 'vendor', 'downloads', 'fragments'].includes(parts[0]) || parts.length < 2) throw new QueueError('该版本资源不可访问。', 404);
      sameProject(loadCourse(revision, config), route.project, route.legacy);
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      return reply.sendFile(parts.join('/'), join(config.releasesDir, revision, 'site'));
    }
    const course = loadCourse(route.project.revision, config);
    sameProject(course, route.project, route.legacy);
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile(route.relative || 'index.html', join(config.releasesDir, course.revision, 'site'));
  };
  app.get('/', servePage);
  app.get('/*', servePage);
  await app.ready();
  return app;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await createServer({ logger: true });
  const shutdown = () => { void app.close().then(() => process.exit(0)); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3000) });
}
