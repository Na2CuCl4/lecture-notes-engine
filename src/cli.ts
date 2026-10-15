import { mkdir, readFile, writeFile, rename, rm, cp, readdir, lstat, access, copyFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { buildCourse } from './content.js';
import type { Course, ProjectEntry } from './types.js';
import { loadProjectsConfig, selectProjects, type ProjectConfig, type ProjectsConfig } from './project-config.js';
import { readProjectCatalog, publishCatalog, updateProjectCatalog } from './projects.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exists = async (p: string) => { try { await access(p); return true; } catch { return false; } };
const ignored = new Set(['.git', 'node_modules', '.state', '.work', 'dist', '.DS_Store']);

async function contentManifest(directory: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(dir: string) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(entry.name)) continue;
      const target = path.join(dir, entry.name);
      if ((await lstat(target)).isSymbolicLink()) throw new Error(`内容快照不能包含符号链接：${target}`);
      hash.update(path.relative(directory, target).split(path.sep).join('/'));
      hash.update(entry.isDirectory() ? '\0directory\0' : '\0file\0');
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) hash.update(createHash('sha256').update(await readFile(target)).digest());
    }
  }
  await visit(directory);
  return hash.digest('hex');
}

async function copyContent(source: string, target: string) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if ((await lstat(from)).isSymbolicLink()) throw new Error(`内容快照不能包含符号链接：${from}`);
    if (entry.isDirectory()) await copyContent(from, to);
    else if (entry.isFile()) await copyFile(from, to);
  }
}

async function engineDigest() {
  const hash = createHash('sha256');
  async function add(p: string) {
    if (!await exists(p)) return;
    const stat = await lstat(p);
    if (stat.isDirectory()) {
      for (const name of (await readdir(p)).sort()) {
        if (!['.astro', 'node_modules', 'dist', 'vendor'].includes(name)) await add(path.join(p, name));
      }
    } else { hash.update(path.relative(root, p)); hash.update(await readFile(p)); }
  }
  for (const dir of ['src', 'site', 'templates', 'package.json', 'package-lock.json']) await add(path.join(root, dir));
  return hash.digest('hex');
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`)));
  });
}

export async function publishRelease(releasesDir: string, revision: string) {
  if (readProjectCatalog({ releasesDir })) throw new Error('当前发布目录已启用多项目；请使用 publish --project <项目 ID>，或为单项目使用独立 --out 目录');
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('无效版本号');
  const release = path.join(releasesDir, revision);
  await access(path.join(release, 'site', 'index.html'));
  const course = JSON.parse(await readFile(path.join(release, 'course.json'), 'utf8')) as Course;
  if (course.projectId) throw new Error('这是多项目快照；请使用 publish --project <项目 ID>');
  const temp = path.join(releasesDir, `.current-${randomUUID()}.json`);
  await writeFile(temp, JSON.stringify({ revision }, null, 2) + '\n');
  await rename(temp, path.join(releasesDir, 'current.json'));
}

export async function buildRelease(options: { contentDir: string; releasesDir: string; publish?: boolean; book?: boolean; localWorker?: boolean; project?: ProjectConfig }) {
  const releasesDir = path.resolve(options.releasesDir);
  const contentDir = path.resolve(options.contentDir);
  if (releasesDir === contentDir || releasesDir.startsWith(contentDir + path.sep)) throw new Error('输出目录必须位于内容目录之外');
  await mkdir(releasesDir, { recursive: true });
  const staging = path.join(releasesDir, `.staging-${randomUUID()}`);
  // Astro 7 uses a temporary prerender directory inside the project when its
  // output is outside cwd. Keep both temporary output and cache on the same
  // writable filesystem, then copy the completed site into the release volume.
  const astroWork = path.join(root, '.work', `astro-${randomUUID()}`);
  await mkdir(staging);
  await mkdir(astroWork, { recursive: true });
  try {
    // Reject concurrent edits rather than publishing a mix of old/new files.
    const before = await contentManifest(contentDir);
    await copyContent(contentDir, path.join(staging, 'content'));
    if (before !== await contentManifest(contentDir) || before !== await contentManifest(path.join(staging, 'content'))) {
      throw new Error('复制期间内容发生变化，本次构建未发布；请保存完成后重试。');
    }
    const course = await buildCourse(path.join(staging, 'content'), options.project ? {
      basePath: options.project.basePath, title: options.project.title, siteUrl: options.project.siteUrl,
    } : undefined);
    if (options.project) course.projectId = options.project.id;
    course.revision = createHash('sha256').update(course.revision).update(await engineDigest())
      .update(JSON.stringify({ projectId: course.projectId, basePath: course.basePath, title: course.title, siteUrl: course.siteUrl })).digest('hex');
    const assetPrefix = `${course.basePath}_releases/${course.revision}/assets/`;
    const bodies = [
      ...course.chapters.map(chapter => chapter.body), ...Object.values(course.documents).map(doc => doc.body),
      ...Object.values(course.sets).map(set => set.body),
      ...Object.values(course.problems).flatMap(problem => [problem.body, ...problem.solutions.map(part => part.body), ...problem.comments.map(part => part.body)]),
    ];
    for (const body of bodies) body.html = body.html.replaceAll(`"${course.basePath}assets/`, `"${assetPrefix}`);
    const release = path.join(releasesDir, course.revision);
    if (!await exists(release)) {
      const json = path.join(staging, 'course.json');
      const astroSite = path.join(astroWork, 'site');
      await writeFile(json, JSON.stringify(course, null, 2) + '\n');
      const astroPackage = JSON.parse(await readFile(path.join(root, 'node_modules/astro/package.json'), 'utf8'));
      const astroBin = typeof astroPackage.bin === 'string' ? astroPackage.bin : astroPackage.bin.astro;
      await run(process.execPath, [path.join(root, 'node_modules/astro', astroBin), 'build', '--root', path.join(root, 'site')], {
        COURSE_JSON: json, SITE_OUTPUT_DIR: astroSite, ASTRO_CACHE_DIR: path.join(astroWork, '.astro'), ASTRO_TELEMETRY_DISABLED: '1',
      });
      await cp(astroSite, path.join(staging, 'site'), { recursive: true });
      const site = path.join(staging, 'site');
      await mkdir(path.join(site, 'vendor'), { recursive: true });
      await cp(path.join(root, 'node_modules/mathjax-full/es5'), path.join(site, 'vendor/mathjax'), { recursive: true });
      if (await exists(path.join(staging, 'content/assets'))) await cp(path.join(staging, 'content/assets'), path.join(site, 'assets'), { recursive: true });
      if (!await exists(path.join(site, 'main.html'))) await copyFile(path.join(site, 'index.html'), path.join(site, 'main.html'));
      await rename(staging, release);
    }
    if (options.book) await bookPdf(releasesDir, course.revision, !!options.localWorker);
    if (options.publish !== false) {
      if (options.project) await updateProjectCatalog(releasesDir, projectEntry(course));
      else await publishRelease(releasesDir, course.revision);
    }
    console.log(`已构建 ${course.title}：${Object.keys(course.problems).length} 题，版本 ${course.revision}`);
    return { course, release };
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(astroWork, { recursive: true, force: true });
  }
}

function projectEntry(course: Course): ProjectEntry {
  if (!course.projectId) throw new Error('课程快照缺少项目 ID');
  return { id: course.projectId, title: course.title, subtitle: course.subtitle, author: course.author, basePath: course.basePath, revision: course.revision };
}

export async function buildProjects(options: { config: ProjectsConfig; releasesDir: string; projectId?: string; publish?: boolean; book?: boolean; localWorker?: boolean }) {
  const previous = readProjectCatalog({ releasesDir: options.releasesDir });
  const results: Awaited<ReturnType<typeof buildRelease>>[] = [];
  for (const project of selectProjects(options.config, options.projectId)) {
    results.push(await buildRelease({ contentDir: project.contentDir, releasesDir: options.releasesDir, project,
      publish: false, book: options.book, localWorker: options.localWorker }));
  }
  // No live pointer changes until every selected website and requested PDF succeeds.
  if (options.publish !== false) {
    if (options.projectId) await updateProjectCatalog(options.releasesDir, projectEntry(results[0].course), options.config.title);
    else await publishCatalog(options.releasesDir, {
      schemaVersion: 1, title: options.config.title, projects: results.map(result => projectEntry(result.course)),
    }, previous ?? null);
  }
  return results;
}

export async function publishProjectRelease(releasesDir: string, revision: string, projectId: string, config?: ProjectsConfig) {
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('无效版本号');
  const course = JSON.parse(await readFile(path.join(releasesDir, revision, 'course.json'), 'utf8')) as Course;
  if (course.projectId !== projectId || course.revision !== revision) throw new Error('快照与目标项目不匹配，不能跨项目发布');
  const configured = config && selectProjects(config, projectId)[0];
  const published = readProjectCatalog({ releasesDir })?.projects.find(project => project.id === projectId);
  const expectedPath = configured?.basePath ?? published?.basePath;
  if (!expectedPath) throw new Error('首次发布项目需要 --projects 提供项目清单');
  if (course.basePath !== expectedPath) throw new Error(`快照路径 ${course.basePath} 与项目路径 ${expectedPath} 不匹配，请重新构建`);
  await updateProjectCatalog(releasesDir, projectEntry(course), config?.title);
}

async function bookPdf(releasesDir: string, revision?: string, localWorker = false, enqueueOnly = false) {
  const { queueConfigFromEnv, loadCourse, enqueueBook, waitForJob } = await import('./queue.js');
  const config = { ...queueConfigFromEnv(), releasesDir, currentFile: path.join(releasesDir, 'current.json') };
  const course = await loadCourse(revision, config);
  const job = enqueueBook(course, { solutions: 'inline', comments: true }, config);
  console.log(`全文 PDF 任务：${job.id} (${job.state})`);
  if (enqueueOnly) return;
  const stop = new AbortController();
  let worker: Promise<void> | undefined;
  if (localWorker) worker = (await import('./worker.js')).runWorker({ config, signal: stop.signal });
  try {
    const done = await waitForJob(job.id, config, 1_800_000);
    if (!done.outputPath) throw new Error('PDF 任务未返回输出文件');
    const downloadDir = path.join(releasesDir, course.revision, 'site/downloads');
    await mkdir(downloadDir, { recursive: true });
    const temp = path.join(downloadDir, `.main-${randomUUID()}.pdf`);
    await copyFile(path.resolve(done.outputPath), temp);
    await rename(temp, path.join(downloadDir, 'main.pdf'));
    console.log(`全文 PDF 已生成：${path.join(downloadDir, 'main.pdf')}`);
  } finally { stop.abort(); await worker; }
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    content: { type: 'string' }, projects: { type: 'string' }, project: { type: 'string' }, out: { type: 'string' }, revision: { type: 'string' }, port: { type: 'string' },
    book: { type: 'boolean' }, 'no-publish': { type: 'boolean' }, 'local-worker': { type: 'boolean' }, 'enqueue-only': { type: 'boolean' },
  } });
  const command = positionals[0] || 'help';
  if (values.content && (values.projects || values.project)) throw new Error('--content 是单项目模式，不能与 --projects 或 --project 同时使用');
  const contentDir = path.resolve(values.content || process.env.CONTENT_DIR || path.join(root, 'examples/calculus'));
  const releasesDir = path.resolve(values.out || process.env.RELEASES_DIR || path.join(root, 'dist/releases'));
  const defaultManifest = process.env.PROJECTS_FILE || path.join(root, 'projects.yaml');
  const manifest = values.projects || (!values.content && await exists(defaultManifest) ? defaultManifest : undefined);
  const projects = manifest && ['check', 'build', 'publish', 'pdf', 'dev'].includes(command) ? await loadProjectsConfig(manifest) : undefined;
  if (values.project && projects) selectProjects(projects, values.project);
  if (values.project && !projects && ['check', 'build', 'dev'].includes(command)) throw new Error('--project 需要 --projects 项目清单');
  if (!projects && ['build', 'dev'].includes(command) && !values['no-publish'] && readProjectCatalog({ releasesDir })) {
    throw new Error('当前发布目录已启用多项目；请使用 --projects，或为 --content 指定独立 --out 目录');
  }
  if (command === 'check') {
    for (const project of projects ? selectProjects(projects, values.project) : [undefined]) {
      const course = await buildCourse(project?.contentDir ?? contentDir, project ? { basePath: project.basePath, title: project.title, siteUrl: project.siteUrl } : undefined);
      console.log(`校验通过${project ? ` [${project.id}]` : ''}：${course.chapters.length} 章、${Object.keys(course.documents).length} 文档、${Object.keys(course.problems).length} 题、${Object.keys(course.sets).length} 习题集`);
    }
  } else if (command === 'build') {
    if (projects) await buildProjects({ config: projects, releasesDir, projectId: values.project, publish: !values['no-publish'], book: values.book, localWorker: values['local-worker'] });
    else await buildRelease({ contentDir, releasesDir, publish: !values['no-publish'], book: values.book, localWorker: values['local-worker'] });
  } else if (command === 'publish') {
    const revision = values.revision || positionals[1] || '';
    if (values.project) await publishProjectRelease(releasesDir, revision, values.project, projects);
    else await publishRelease(releasesDir, revision);
  } else if (command === 'pdf') {
    if (!values.book) throw new Error('命令行 PDF 使用 --book；章节打印请从网页选择');
    const catalog = readProjectCatalog({ releasesDir });
    if (!values.revision && (projects || catalog) && !values.project) throw new Error('多项目全文 PDF 请指定 --project <项目 ID> 或 --revision <版本>');
    const selected = values.project ? catalog?.projects.find(project => project.id === values.project) : undefined;
    if (values.project && !values.revision && !selected) throw new Error(`尚未发布项目：${values.project}`);
    const revision = values.revision || selected?.revision;
    if (values.project && revision) {
      if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('无效版本号');
      const snapshot = JSON.parse(await readFile(path.join(releasesDir, revision, 'course.json'), 'utf8')) as Course;
      if (snapshot.projectId !== values.project) throw new Error('PDF 快照与 --project 不匹配');
    }
    await bookPdf(releasesDir, revision, !!values['local-worker'], !!values['enqueue-only']);
  } else if (command === 'concurrency') {
    const limit = Number(positionals[1]);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('并发数必须为正整数');
    const { Queue, queueConfigFromEnv } = await import('./queue.js');
    const config = queueConfigFromEnv();
    const databasePath = path.join(config.stateDir, 'jobs.sqlite');
    if (await exists(databasePath)) {
      const { DatabaseSync } = await import('node:sqlite');
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const setting = database.prepare("SELECT value FROM settings WHERE name = 'max_parallel'").get() as { value: number } | undefined;
        if (setting) config.maxParallel = setting.value;
      } finally { database.close(); }
    }
    const queue = new Queue(config);
    try { queue.setConcurrency(limit); } finally { queue.close(); }
    console.log(`持久队列并发已设为 ${limit}。请将所有服务的 PRINT_CONCURRENCY 同步为 ${limit} 后重启。`);
  } else if (command === 'dev') {
    process.env.RELEASES_DIR = releasesDir;
    process.env.CURRENT_FILE = path.join(releasesDir, 'current.json');
    if (projects) await buildProjects({ config: projects, releasesDir, projectId: values.project, book: true, localWorker: true });
    else await buildRelease({ contentDir, releasesDir, book: true, localWorker: true });
    const { createServer } = await import('./server.js');
    const app = await createServer();
    const port = Number(values.port || process.env.PORT || 3000);
    await app.listen({ port, host: process.env.HOST || '127.0.0.1' });
    if (projects) {
      console.log(`项目主界面：http://127.0.0.1:${port}/`);
      for (const project of selectProjects(projects, values.project)) console.log(`${project.id}：http://127.0.0.1:${port}${project.basePath}`);
    } else {
      const course = JSON.parse(await readFile(path.join(releasesDir, JSON.parse(await readFile(path.join(releasesDir, 'current.json'), 'utf8')).revision, 'course.json'), 'utf8')) as Course;
      console.log(`本地预览：http://127.0.0.1:${port}${course.basePath}`);
    }
    const stop = new AbortController();
    const worker = (await import('./worker.js')).runWorker({ signal: stop.signal });
    let timer: NodeJS.Timeout | undefined;
    let busy = false;
    const dirty = new Set<string>();
    const watched = projects ? selectProjects(projects, values.project) : [];
    async function rebuild() {
      if (busy) return;
      busy = true;
      const changed = new Set(dirty); dirty.clear();
      try {
        if (projects) {
          for (const project of watched.filter(project => changed.has(project.contentDir))) {
            try { await buildProjects({ config: projects, releasesDir, projectId: project.id, book: true }); }
            catch (error) { console.error(`项目 ${project.id} 更新未发布，继续显示上一版：`, error); }
          }
        } else await buildRelease({ contentDir, releasesDir, book: true });
      } catch (error) { console.error('更新未发布，继续显示上一版：', error); }
      finally { busy = false; if (dirty.size) void rebuild(); }
    }
    const watchers = [...new Set(projects ? watched.map(project => project.contentDir) : [contentDir])].map(directory =>
      watch(directory, { recursive: true }, (_event, file) => {
        if (file?.split(/[\\/]/).some(part => ignored.has(part))) return;
        dirty.add(directory);
        clearTimeout(timer); timer = setTimeout(() => void rebuild(), 400);
      }));
    if (projects) watchers.push(watch(projects.file, () => console.log('项目清单已修改。请重启 npm run dev 以应用项目增删及路径变更。')));
    let closing = false;
    const close = async () => { if (closing) return; closing = true; for (const watcher of watchers) watcher.close(); clearTimeout(timer); stop.abort(); await app.close(); await worker; process.exit(0); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  } else {
    console.log('lecture-notes-engine\n  check [--projects projects.yaml | --content <目录>] [--project <ID>]\n  build [--projects projects.yaml | --content <目录>] [--project <ID>] --out <发布目录> [--book --local-worker] [--no-publish]\n  pdf --book [--project <ID>] [--revision <版本>] [--local-worker] [--enqueue-only]\n  publish <版本> [--project <ID>] [--projects projects.yaml] --out <发布目录>\n  concurrency <正整数>\n  dev [--projects projects.yaml | --content <目录>] [--project <ID>] [--port 3000]');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
