import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { existsSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { basePrefix, loadCourse, Queue, QueueError, queueConfigFromEnv, validRevision, validatePrintRequest } from './queue.js';
import type { QueueConfig } from './queue.js';
import type { PrintJob } from './types.js';

function publicJob(job: PrintJob) {
  const { outputPath: _outputPath, key: _key, ...view } = job;
  return view;
}
export async function createServer(options: { config?: QueueConfig; logger?: boolean } = {}) {
  const config = options.config ?? queueConfigFromEnv();
  const queue = new Queue(config);
  let startupCourse;
  try { startupCourse = loadCourse(undefined, config); } catch (error) { queue.close(); throw error; }
  const prefix = basePrefix(startupCourse.basePath);
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
  app.get('/healthz', async () => ({ ok: true, revision: loadCourse(undefined, config).revision }));
  app.get(`${prefix}/api/health`, async () => ({ ok: true, revision: loadCourse(undefined, config).revision, queue: queue.counts() }));
  app.post(`${prefix}/api/print`, { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = request.body as Record<string, unknown> | null;
    if (!input || !validRevision(input.revision)) throw new QueueError('必须提供有效的课程版本。');
    const course = loadCourse(input.revision, config);
    const print = validatePrintRequest(input, course, config.maxProblems);
    const result = queue.enqueue(course, print, request.ip);
    reply.code(result.reused ? 200 : 202);
    return { job: publicJob(queue.get(result.job.id)!), reused: result.reused, statusUrl: `${prefix}/api/jobs/${result.job.id}`,
      ...(result.job.state === 'succeeded' ? { downloadUrl: `${prefix}/api/jobs/${result.job.id}/pdf` } : {}) };
  });
  app.get<{ Params: { id: string } }>(`${prefix}/api/jobs/:id`, async request => {
    const job = queue.get(request.params.id);
    if (!job) throw new QueueError('打印任务不存在。', 404);
    return { job: publicJob(job), ...(job.state === 'succeeded' ? { downloadUrl: `${prefix}/api/jobs/${job.id}/pdf` } : {}) };
  });
  app.get<{ Params: { id: string } }>(`${prefix}/api/jobs/:id/pdf`, async (request, reply) => {
    const job = queue.get(request.params.id);
    if (!job) throw new QueueError('打印任务不存在。', 404);
    if (job.state !== 'succeeded' || !job.outputPath) throw new QueueError('PDF 尚未生成成功。', 409);
    const root = resolve(config.stateDir, 'pdf'); const file = resolve(job.outputPath);
    if (!file.startsWith(root + sep) || basename(file) !== file.slice(root.length + 1) || !existsSync(file)) {
      throw new QueueError('PDF 文件已缺失，请联系维护者。', 410);
    }
    return reply.header('Cache-Control', 'private, no-cache').header('Content-Disposition', `attachment; filename="lecture-${job.id}.pdf"`).type('application/pdf').sendFile(basename(file), root);
  });
  app.get<{ Params: { revision: string; '*': string } }>(`${prefix}/_releases/:revision/*`, async (request, reply) => {
    const { revision } = request.params; const relative = request.params['*'];
    if (!validRevision(revision)) throw new QueueError('无效的课程版本。');
    const parts = relative.split(/[\\/]/);
    if (!['assets', '_astro', 'vendor', 'downloads', 'fragments'].includes(parts[0]) || parts.some(part => part === '..' || part.startsWith('.')) || relative.includes('\0')) {
      throw new QueueError('该版本资源不可访问。', 404);
    }
    const course = loadCourse(revision, config);
    if (basePrefix(course.basePath) !== prefix) throw new QueueError('版本发布路径不匹配。', 404);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.sendFile(relative, join(config.releasesDir, revision, 'site'));
  });
  // Resolve the active release per request; publishing only replaces current.json atomically.
  if (prefix) app.get(prefix, async (_request, reply) => reply.redirect(`${prefix}/`));
  app.get<{ Params: { '*': string } }>(`${prefix}/*`, async (request, reply) => {
    const course = loadCourse(undefined, config);
    if (basePrefix(course.basePath) !== prefix) throw new QueueError('发布路径已更改，请重启 web 服务。', 503);
    const relative = request.params['*'] || 'index.html';
    if (relative.split(/[\\/]/).some(part => part === '..' || part.startsWith('.')) || relative.includes('\0')) {
      throw new QueueError('无效的资源路径。', 400);
    }
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile(relative, join(config.releasesDir, course.revision, 'site'));
  });
  await app.ready();
  return app;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await createServer({ logger: true });
  const shutdown = () => { void app.close().then(() => process.exit(0)); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3000) });
}
