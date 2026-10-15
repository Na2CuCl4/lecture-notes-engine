import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalMacros, parseMacros, validateMath } from './macros.ts';
import { semanticBlock } from './semantic-blocks.ts';
import type { Body, Chapter, CompileRequest, Course, PandocDocument, PandocNode, Part, Problem } from './types.ts';

export interface PdfOptions {
  contentDir: string;
  workDir: string;
  outputPath: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Linux shared slot lock; protects against a stale worker outliving its lease. */
  lockPath?: string;
}

const templatePath = fileURLToPath(new URL('../templates/print.tex', import.meta.url));
const text = (value: string): PandocNode[] => [{ t: 'Str', c: value }];
const para = (value: string): PandocNode => ({ t: 'Para', c: text(value) });
const heading = (level: number, title: string, id = '', unnumbered = false, unlisted = unnumbered): PandocNode => ({
  t: 'Header', c: [level, [id, [...(unnumbered ? ['unnumbered'] : []), ...(unlisted ? ['unlisted'] : [])], []], text(title)],
});
const raw = (value: string): PandocNode => ({ t: 'RawBlock', c: ['latex', value] });

/** Escape text inserted by the engine itself. Content prose is escaped by Pandoc. */
export function escapeTex(value: string): string {
  return value.replace(/[\\{}$&#%_^~]/g, (char) => ({
    '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '$': '\\$', '&': '\\&', '#': '\\#',
    '%': '\\%', '_': '\\_', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}',
  }[char]!));
}

function walk(value: unknown, fn: (node: PandocNode) => void): void {
  if (Array.isArray(value)) { for (const child of value) walk(child, fn); return; }
  if (!value || typeof value !== 'object') return;
  const node = value as PandocNode;
  if (typeof node.t === 'string') fn(node);
  if ('c' in node) walk(node.c, fn);
}

function nodeAttr(node: PandocNode): any[] | undefined {
  if (node.t === 'Header') return node.c?.[1];
  if (['Div', 'Span', 'Image', 'Link', 'Code', 'CodeBlock', 'Table', 'Figure'].includes(node.t)) return node.c?.[0];
  return undefined;
}

function copyBody(body: Body, firstHeadingLevel: number): PandocNode[] {
  const blocks = structuredClone(body.ast.blocks);
  let minLevel = 6;
  walk(blocks, (node) => { if (node.t === 'Header') minLevel = Math.min(minLevel, node.c[0]); });
  walk(blocks, (node) => {
    // The source compiler rejects raw HTML/TeX. Do not allow an unvalidated course
    // snapshot to bypass that boundary on the worker.
    if (node.t === 'RawInline' || node.t === 'RawBlock') throw new Error(`${body.source}：打印正文不接受原始 HTML 或 TeX。`);
    if (node.t === 'Header') node.c[0] = Math.min(6, firstHeadingLevel + node.c[0] - minLevel);
  });
  return blocks;
}

function selectedChapters(course: Course, request: CompileRequest): Chapter[] {
  if (request.revision !== course.revision) throw new Error('打印请求的内容版本与快照不一致。');
  if (!['none', 'inline', 'end'].includes(request.solutions)) throw new Error('无效的解答排版方式。');
  if ('kind' in request && request.kind === 'book') return course.chapters;
  if (!('chapterId' in request)) throw new Error('无效的打印请求。');
  const chapter = course.chapters.find((item) => item.id === request.chapterId);
  if (!chapter) throw new Error('打印章节不存在。');
  if (!Array.isArray(request.problemIds) || new Set(request.problemIds).size !== request.problemIds.length) throw new Error('打印题单包含重复或无效的题目。');
  for (const id of request.problemIds) {
    const problem = course.problems[id];
    if (!problem || problem.chapterId !== chapter.id || !chapter.problems.includes(id)) throw new Error(`题目 ${id} 不属于当前打印章节。`);
  }
  return [chapter];
}

function problemTitle(problem: Problem): string {
  return `题 ${problem.number}${problem.title ? `　${problem.title}` : ''}`;
}

function partBlocks(part: Part, title: string, level: number): PandocNode[] {
  return [heading(level, title, part.id, true), ...copyBody(part.body, level + 1)];
}

function solutionBlocks(problem: Problem, level: number): PandocNode[] {
  return problem.solutions.flatMap((part) => partBlocks(part, `解${part.title ? `（${part.title}）` : ''}`, level));
}

function commentBlocks(problem: Problem, level: number): PandocNode[] {
  return problem.comments.flatMap((part) => {
    const title = part.title || (part.kind ? semanticBlock(part.kind)?.label || part.kind : '');
    return partBlocks(part, `注${title && title !== '注' ? `（${title}）` : ''}`, level);
  });
}

/** Keep the Div itself: Pandoc emits its PDF destination before the environment. */
function wrapTheorem(node: PandocNode, environment: string, number?: string, title?: string, counter = 'lecturetheorem'): void {
  // An extra brace group makes literal ']' safe inside TeX's optional title.
  const optional = title ? `[{${escapeTex(title)}}]` : '';
  const fixedNumber = number ? `\\renewcommand{\\the${counter}}{${escapeTex(number)}}\n` : '';
  node.c[1] = [raw(`\\begingroup\n${fixedNumber}\\begin{${environment}}${optional}`), ...node.c[1], raw(`\\end{${environment}}\n\\endgroup`)];
}

function websiteUrl(course: Course, value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  if (!/^https?:\/\//i.test(course.siteUrl)) throw new Error('章外引用需要配置有效的 siteUrl。');
  // siteUrl is the public course root; basePath describes the current preview
  // mount and may be '/', even when production lives under a nested prefix.
  const route = value.startsWith(course.basePath) ? value.slice(course.basePath.length) : value.replace(/^\/+/, '');
  return new URL(route, course.siteUrl.endsWith('/') ? course.siteUrl : `${course.siteUrl}/`).href;
}

/** Combine the exact AST used by the website; no second Markdown parse occurs. */
export function buildPrintAst(course: Course, request: CompileRequest): PandocDocument {
  const chapters = selectedChapters(course, request);
  const book = 'kind' in request && request.kind === 'book';
  const blocks: PandocNode[] = [];
  const printed = new Set<string>();
  const endSolutions: { chapter: Chapter; problems: Problem[] }[] = [];
  for (const chapter of chapters) {
    // A chapter printed on its own still keeps its course number. Pandoc emits
    // a real book chapter so the original chapter opening/layout applies.
    blocks.push(raw(`\\setcounter{chapter}{${chapter.number - 1}}`), heading(1, chapter.title, chapter.id), ...copyBody(chapter.body, 2));
    if (book || ('includeDocuments' in request && request.includeDocuments)) {
      for (const id of chapter.documents) {
        const document = course.documents[id];
        if (!document) throw new Error(`章节 ${chapter.id} 引用了不存在的文档 ${id}。`);
        blocks.push(heading(2, document.title, document.id), ...copyBody(document.body, 3));
      }
    }
    const ids = book ? chapter.problems : ('problemIds' in request ? request.problemIds : []);
    const problems: Problem[] = [];
    for (const id of ids) {
      const problem = course.problems[id];
      if (!problem) throw new Error(`题目 ${id} 不存在。`);
      // Membership is owned by a single chapter, even when a set references it
      // several times or is attached to several chapters.
      if (problem.chapterId !== chapter.id || printed.has(problem.id)) continue;
      printed.add(problem.id);
      problems.push(problem);
    }
    blocks.push(heading(2, book ? '所有习题' : '习题'));
    if (!problems.length) blocks.push(para('本次题单未收录习题。'));
    for (const problem of problems) {
      blocks.push(raw('\\Needspace{7\\baselineskip}'), {
        t: 'Div', c: [[problem.id, ['print-problem'], [['data-problem-number', problem.number], ['title', problem.title]]], copyBody(problem.body, 4)],
      });
      // Old solution/note environments used run-in paragraph headings, not
      // another numbered subsection or a separate table-of-contents entry.
      if (request.solutions === 'inline') blocks.push(...solutionBlocks(problem, 5));
      if (request.comments) blocks.push(...commentBlocks(problem, 5));
    }
    if (request.solutions === 'end' && problems.some((problem) => problem.solutions.length)) endSolutions.push({ chapter, problems });
  }
  if (endSolutions.length) {
    blocks.push(heading(1, '参考解答', '', true, false));
    for (const entry of endSolutions) {
      if (book) blocks.push(heading(2, `第 ${entry.chapter.number} 章　${entry.chapter.title}`, '', true));
      for (const problem of entry.problems) {
        if (!problem.solutions.length) continue;
        blocks.push(raw('\\Needspace{5\\baselineskip}'), heading(3, problemTitle(problem), '', true), ...solutionBlocks(problem, 5));
      }
    }
  }
  const included = new Set<string>();
  walk(blocks, (node) => {
    const attributes = nodeAttr(node);
    const id = attributes?.[0];
    if (id) {
      // Shared documents may be printed more than once. The
      // first occurrence is canonical; duplicate PDF destinations are invalid.
      if (included.has(id)) attributes![0] = '';
      else included.add(id);
    }
  });
  walk(blocks, (node) => {
    if (node.t === 'Link') {
      const target: string = node.c[2][0];
      const id = target.startsWith('ref:') ? target.slice(4) : target.startsWith('#') ? target.slice(1) : undefined;
      if (id) {
        const reference = course.references[id];
        if (!reference && !included.has(id)) throw new Error(`打印引用 ${id} 不存在。`);
        if (!node.c[1]?.length) node.c[1] = text(reference?.label || id);
        node.c[2][0] = included.has(id) ? `#${id}` : websiteUrl(course, reference.url);
      } else if (!/^(https?:|mailto:)/i.test(target)) throw new Error(`打印链接不支持目标 ${target}。`);
    }
    if (node.t === 'Div' && node.c[0][1].includes('equation')) {
      const number = node.c[0][2].find(([key]: [string, string]) => key === 'data-equation-number')?.[1];
      if (number) walk(node.c[1], (child) => {
        if (child.t === 'Math' && child.c[0].t === 'DisplayMath') child.c[1] = `${child.c[1].trim()}\n\\tag{${escapeTex(number)}}`;
      });
    }
    // Removing an original \label can leave blank lines. MathJax accepts them,
    // but TeX interprets an empty line as \par and exits math mode.
    if (node.t === 'Math') node.c[1] = node.c[1].trim().replace(/\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*/g, '\n');
    if (node.t === 'Figure') {
      const reference = course.references[node.c[0][0]];
      const caption = node.c[1][1];
      if (reference?.kind === 'figure') {
        const prefix = { t: 'Str', c: `${reference.label}　` };
        if (caption[0]?.t === 'Plain' || caption[0]?.t === 'Para') caption[0].c.unshift(prefix);
        else caption.unshift({ t: 'Plain', c: [prefix] });
      }
    }
  });
  // Convert only after collecting destinations and resolving references. The
  // fixed numbers come from the same course snapshot as the web headings;
  // changing print order or omitting an earlier block must never renumber them.
  walk(blocks, (node) => {
    if (node.t !== 'Div') return;
    const kind = node.c[0][1][0];
    const properties = Object.fromEntries(node.c[0][2]);
    if (kind === 'print-problem') wrapTheorem(node, 'lectureproblem', properties['data-problem-number'], properties.title, 'lectureproblem');
    else if (semanticBlock(kind)) {
      // Historical releases predate semantic numbering. Preserve their unnumbered
      // headings instead of assigning fresh numbers that disagree with their web page.
      const legacy = semanticBlock(kind)!.numbered && !properties['data-semantic-number'];
      wrapTheorem(node, `lecture${kind}${legacy ? 'unnumbered' : ''}`, properties['data-semantic-number'], properties['data-semantic-title'] || properties.title);
    }
  });
  const firstBody = chapters[0]?.body || Object.values(course.documents)[0]?.body;
  return { 'pandoc-api-version': firstBody?.ast['pandoc-api-version'] || [1, 23, 1], meta: {}, blocks };
}

async function killTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>((done) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => done()); killer.once('close', () => done());
    });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* Process may already have exited. */ }
  }
}

async function run(command: string, args: string[], options: { cwd: string; timeoutMs: number; input?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<string> {
  if (options.timeoutMs <= 0) throw new Error('打印编译超时。');
  if (options.signal?.aborted) throw new Error('打印任务已取消。');
  return new Promise<string>((accept, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd, windowsHide: true, detached: process.platform !== 'win32',
      env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    let out = ''; let err = ''; let timedOut = false; let cancelled = false;
    // TeX errors can be very verbose; retain a bounded diagnostic tail.
    child.stdout.on('data', (chunk: Buffer) => { out = (out + chunk.toString('utf8')).slice(-4_000_000); });
    child.stderr.on('data', (chunk: Buffer) => { err = (err + chunk.toString('utf8')).slice(-500_000); });
    const timer = setTimeout(() => { timedOut = true; void killTree(child.pid); }, options.timeoutMs);
    const abort = () => { cancelled = true; void killTree(child.pid); };
    options.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); reject(new Error(`无法运行 ${command}：${error.message}`)); });
    child.once('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (cancelled) reject(new Error('打印任务已取消。'));
      else if (timedOut) reject(new Error(`打印编译超时（${command}）。\n${out}\n${err}`));
      else if (code !== 0) reject(new Error(`${command} 执行失败（退出码 ${code}）。\n${out}\n${err}`));
      else accept(out);
    });
    child.stdin.on('error', () => { /* Early process exit is handled by close. */ });
    child.stdin.end(options.input ?? '');
  });
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function prepareImages(ast: PandocDocument, contentDir: string, workDir: string): Promise<void> {
  const images: PandocNode[] = [];
  walk(ast.blocks, (node) => { if (node.t === 'Image') images.push(node); });
  if (!images.length) return;
  const root = await realpath(contentDir);
  await mkdir(join(workDir, 'assets'), { recursive: true });
  for (const image of images) {
    const target: string = image.c[2][0];
    if (isAbsolute(target) || /^[a-z]+:/i.test(target) || target.includes('\\') || !target.startsWith('assets/')) throw new Error(`图片 ${target} 不属于内容快照的 assets 目录。`);
    let source = resolve(root, target);
    if (!inside(root, source)) throw new Error(`图片路径越过内容快照：${target}`);
    if (['.svg', '.webp', '.gif'].includes(extname(source).toLowerCase())) {
      const base = source.slice(0, -extname(source).length);
      const alternatives = [`${base}.pdf`, `${base}.png`];
      source = '';
      for (const item of alternatives) {
        try { if ((await stat(item)).isFile()) { source = item; break; } } catch { /* try another pre-rendered asset */ }
      }
      if (!source) throw new Error(`图片 ${target} 需要同名 PDF 或 PNG 打印版本；在线编译不转换 SVG、WebP 或 GIF。`);
    }
    const actual = await realpath(source).catch(() => { throw new Error(`打印图片不存在：${target}`); });
    if (!inside(root, actual)) throw new Error(`图片符号链接越过内容快照：${target}`);
    if (!['.png', '.jpg', '.jpeg', '.pdf'].includes(extname(actual).toLowerCase())) throw new Error(`打印图片格式不支持：${target}，请提供 PNG、JPEG 或 PDF。`);
    const data = await readFile(actual);
    const name = `${createHash('sha256').update(data).digest('hex').slice(0, 24)}${extname(actual).toLowerCase()}`;
    await writeFile(join(workDir, 'assets', name), data);
    image.c[2][0] = `assets/${name}`;
    // Custom width may be a percentage or physical size, but never arbitrary TeX.
    image.c[0][2] = image.c[0][2].filter(([key, value]: [string, string]) => !['width', 'height'].includes(key) || /^\d+(\.\d+)?(%|px|pt|cm|mm|in|em)$/.test(value));
  }
}

/** Generate a complete XeLaTeX source in workDir, useful for inspection/tests. */
export async function buildTex(course: Course, request: CompileRequest, options: Pick<PdfOptions, 'contentDir' | 'workDir' | 'timeoutMs' | 'signal'>): Promise<string> {
  const workDir = resolve(options.workDir);
  await mkdir(workDir, { recursive: true });
  const config = parseMacros(course.macros);
  const ast = buildPrintAst(course, request);
  walk(ast.blocks, (node) => {
    if (node.t === 'Math') validateMath(node.c[1], node.c[0].t === 'DisplayMath', config, 'PDF 数学公式');
  });
  await prepareImages(ast, options.contentDir, workDir);
  const body = await run(process.env.PANDOC_BIN || 'pandoc', ['--from=json', '--to=latex', '--top-level-division=chapter', '--wrap=none', '--no-highlight'], {
    cwd: workDir, timeoutMs: options.timeoutMs ?? 30_000, input: JSON.stringify(ast), signal: options.signal,
  });
  const book = 'kind' in request;
  const chapter = !book && 'chapterId' in request ? course.chapters.find((item) => item.id === request.chapterId) : undefined;
  const title = book ? '完整讲义' : ('title' in request && request.title) || chapter?.title || '章节讲义';
  const date = new Date(course.builtAt);
  if (Number.isNaN(date.getTime())) throw new Error('内容构建日期无效。');
  const dateParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(date);
  const datePart = (type: string) => dateParts.find((part) => part.type === type)?.value;
  const replacements: Record<string, string> = {
    PDF_TITLE: escapeTex(`${course.title} · ${title}`), AUTHOR: escapeTex(course.author),
    COURSE_TITLE: escapeTex(course.title), PRINT_TITLE: escapeTex(title),
    BUILD_DATE: `${datePart('year')} 年 ${datePart('month')} 月 ${datePart('day')} 日`,
    MACROS: canonicalMacros(config), BODY: body,
  };
  const template = await readFile(templatePath, 'utf8');
  return template.replace(/@@([A-Z_]+)@@/g, (_match, key: string) => {
    if (!(key in replacements)) throw new Error(`未知打印模板占位符 ${key}。`);
    return replacements[key];
  });
}

/** Compile with one global time budget. Never invoke a shell or download packages. */
export async function compilePdf(course: Course, request: CompileRequest, options: PdfOptions): Promise<{ durationMs: number; pages?: number }> {
  const started = Date.now();
  const timeout = options.timeoutMs ?? ('kind' in request ? 600_000 : 180_000);
  const remaining = () => timeout - (Date.now() - started);
  const workDir = resolve(options.workDir);
  const logPath = join(workDir, 'compile.log');
  await mkdir(workDir, { recursive: true });
  const log: string[] = [];
  try {
    const source = await buildTex(course, request, { ...options, workDir, timeoutMs: remaining() });
    await writeFile(join(workDir, 'main.tex'), source, 'utf8');
    // openin_any=p is an additional boundary against accidental absolute reads.
    // The content compiler and macro validator reject TeX I/O commands first.
    const env = { ...process.env, openin_any: 'p', openout_any: 'p', shell_escape: 'f', MIKTEX_ENABLE_INSTALLER: '0' };
    let result = '';
    if (options.lockPath) await mkdir(dirname(resolve(options.lockPath)), { recursive: true });
    for (let pass = 1; pass <= 3; pass++) {
      let command = process.env.XELATEX_BIN || 'xelatex';
      let args = ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', 'main.tex'];
      if (process.platform === 'linux' && options.lockPath) {
        args = ['--exclusive', '--timeout', String(Math.max(1, Math.ceil(remaining() / 1000))), resolve(options.lockPath), command, ...args];
        command = 'flock';
      }
      result = await run(command, args, { cwd: workDir, timeoutMs: remaining(), env, signal: options.signal });
      log.push(`--- XeLaTeX 第 ${pass} 遍 ---\n${result}`);
      // A second pass resolves the TOC, then stop unless TeX explicitly asks to rerun.
      if (pass >= 2 && !/Rerun to get|Label\(s\) may have changed|rerunfilecheck Warning/i.test(result)) break;
    }
    if (/There were undefined references|Reference .+ undefined|Citation .+ undefined/i.test(result)) throw new Error('PDF 中存在未解析的引用，请检查内容引用索引。');
    const generated = join(workDir, 'main.pdf');
    if (!(await stat(generated)).size) throw new Error('编译未产生有效 PDF。');
    const output = resolve(options.outputPath);
    await mkdir(dirname(output), { recursive: true });
    if (output !== generated) await copyFile(generated, output);
    await writeFile(logPath, log.join('\n'), 'utf8');
    const pages = /Output written on .*?\((\d+) pages?\b/s.exec(result)?.[1];
    return { durationMs: Date.now() - started, ...(pages ? { pages: Number(pages) } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.push(message);
    await writeFile(logPath, log.join('\n'), 'utf8').catch(() => undefined);
    const diagnostic = message.split('\n').filter((line) => /(^!|Undefined control|Missing .+ inserted|Emergency stop|Fatal error|Error|不存在|不支持|超时|无法运行|越过|需要|无效|一致|不属于|拒绝)/i.test(line)).slice(0, 5).join('；') || message.split('\n')[0];
    throw new Error(`PDF 编译失败：${diagnostic.slice(0, 800)}。日志：${logPath}`);
  }
}
