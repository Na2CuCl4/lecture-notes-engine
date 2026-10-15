import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { parseMarkdown, renderHtml } from './pandoc.js';
import { parseMacros, validateMath, validateMacroConfig } from './macros.js';
import { semanticBlock, semanticBlocks, semanticHeading } from './semantic-blocks.js';
import type { Body, Chapter, Course, Document, ExerciseSet, PandocDocument, PandocNode, Part, Problem, Reference } from './types.js';

const idSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, 'ID 必须以小写字母开头，只含小写字母、数字、连字符');
const ids = z.array(idSchema).default([]);
const words = z.array(z.string().trim().min(1)).default([]);
const configSchema = z.object({
  schemaVersion: z.literal(1), engineVersion: z.literal('0.1.0'),
  title: z.string().min(1), subtitle: z.string().optional(), author: z.string(),
  language: z.string().default('zh-CN'), basePath: z.string().default('/'),
  siteUrl: z.string().url(), chapters: z.array(idSchema).min(1),
}).strict();
const chapterSchema = z.object({ id: idSchema, title: z.string().min(1), documents: ids, problems: ids, sets: ids }).strict();
const documentSchema = z.object({ id: idSchema, title: z.string().min(1), tags: words }).strict();
const setSchema = z.object({
  id: idSchema, title: z.string().min(1), problems: ids,
  groups: z.array(z.object({ title: z.string().min(1), problems: ids }).strict()).optional(),
}).strict();
const problemSchema = z.object({
  id: idSchema, title: z.string().default(''), tags: words, sources: words,
  difficulty: z.number().int().min(1).max(5).nullable().default(null),
  solutions: z.array(z.string().min(1)).default([]), comments: z.array(z.string().min(1)).default([]),
}).strict();
const partSchema = z.object({ id: idSchema.optional(), title: z.string().optional(), kind: z.string().optional() }).strict();
const containers = new Set(Object.keys(semanticBlocks));
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);

function fail(source: string, message: string): never { throw new Error(`${source}：${message}`); }
function slash(value: string) { return value.split(path.sep).join('/'); }
function digest(data: Buffer | string) { return createHash('sha256').update(data).digest('hex'); }
function unique(values: string[], source: string, field: string) {
  if (new Set(values).size !== values.length) fail(source, `${field} 含重复引用`);
}
function yaml(text: string, source: string): unknown {
  const parsed = parseDocument(text, { uniqueKeys: true });
  if (parsed.errors.length) fail(source, `YAML 无效：${parsed.errors[0].message}`);
  try { return parsed.toJS({ maxAliasCount: 0 }) ?? {}; }
  catch (error) { return fail(source, `YAML 别名不受支持：${String(error)}`); }
}
function metadata<S extends z.ZodTypeAny>(schema: S, value: unknown, source: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) fail(source, result.error.issues.map(issue => `${issue.path.join('.') || '元数据'} ${issue.message}`).join('；'));
  return result.data;
}
function frontmatter(text: string, source: string): { meta: unknown; markdown: string } {
  text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { meta: {}, markdown: text };
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) {
    if (text.endsWith('\n---')) return { meta: yaml(text.slice(4, -4), source), markdown: '' };
    return fail(source, 'front matter 缺少结束分隔行 ---');
  }
  return { meta: yaml(text.slice(4, end), source), markdown: text.slice(end + 5) };
}
function plain(nodes: any): string {
  if (Array.isArray(nodes)) return nodes.map(plain).join('');
  if (!nodes || typeof nodes !== 'object') return '';
  if (nodes.t === 'Str') return nodes.c;
  if (nodes.t === 'Space' || nodes.t === 'SoftBreak' || nodes.t === 'LineBreak') return ' ';
  if (nodes.t === 'Math' || nodes.t === 'Code') return nodes.c[1];
  if (nodes.t === 'Link' || nodes.t === 'Image' || nodes.t === 'Span') return plain(nodes.c[1]);
  if (nodes.t === 'Header') return plain(nodes.c[2]);
  if (nodes.t === 'Para' || nodes.t === 'Plain') return plain(nodes.c) + '\n';
  return plain(nodes.c);
}
function inlineText(text: string): PandocNode[] { return [{ t: 'Str', c: text }]; }
function attrFor(node: PandocNode): any[] | undefined {
  if (node.t === 'Header') return node.c[1];
  if (['Link', 'Image', 'Code', 'CodeBlock', 'Span', 'Div', 'Table', 'Figure'].includes(node.t)) return node.c[0];
  return undefined;
}
function walk(nodes: any, action: (node: PandocNode) => void) {
  if (Array.isArray(nodes)) { for (const item of nodes) walk(item, action); return; }
  if (!nodes || typeof nodes !== 'object') return;
  if (typeof nodes.t === 'string') action(nodes);
  if (nodes.c !== undefined) walk(nodes.c, action);
}

interface PendingBody { body: Body; markdown: string; ownerId: string; chapterId?: string; url: string }

/** Parse and validate one immutable course snapshot. No writes or network requests. */
export async function buildCourse(contentDir: string): Promise<Course> {
  const root = path.resolve(contentDir);
  const originals = new Map<string, Buffer>();
  const registry = new Map<string, string>();
  const pending: PendingBody[] = [];
  const assets: Course['assets'] = [];
  const references: Record<string, Reference> = Object.create(null);
  const visitedResources = new Set<string>();

  async function safePath(relative: string, source = relative): Promise<string> {
    if (path.isAbsolute(relative) || relative.includes('\0') || /^[a-z]:/i.test(relative)) fail(source, '不允许绝对路径');
    const absolute = path.resolve(root, relative);
    const rel = path.relative(root, absolute);
    if (rel.startsWith('..') || path.isAbsolute(rel)) fail(source, '路径越出内容根目录');
    const segments = rel.split(path.sep).filter(Boolean);
    let current = root;
    for (const segment of segments) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current).catch(() => fail(source, `文件不存在：${slash(rel)}`));
      if (stat.isSymbolicLink()) fail(source, `不允许符号链接：${slash(path.relative(root, current))}`);
    }
    return absolute;
  }
  async function read(relative: string): Promise<string> {
    const absolute = await safePath(relative);
    const buffer = await fs.readFile(absolute);
    if (buffer.length > 2 * 1024 * 1024) fail(relative, '文本文件超过 2 MiB');
    const text = new TextDecoder('utf-8', { fatal: true });
    let decoded: string;
    try { decoded = text.decode(buffer); } catch { return fail(relative, '必须使用 UTF-8 编码'); }
    originals.set(slash(relative), buffer);
    return decoded;
  }
  async function files(directory: string, optional = true): Promise<string[]> {
    const absolute = path.join(root, directory);
    if (optional && !(await fs.stat(absolute).catch(() => null))) return [];
    await safePath(directory);
    const result: string[] = [];
    for (const entry of (await fs.readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = slash(path.join(directory, entry.name));
      if (entry.isSymbolicLink()) fail(relative, '不允许符号链接');
      if (entry.isDirectory()) result.push(...await files(relative, false));
      else if (entry.isFile()) result.push(relative);
      else fail(relative, '只支持普通文件');
    }
    return result;
  }
  function claim(id: string, source: string) {
    const before = registry.get(id);
    if (before) fail(source, `ID ${id} 重复，已在 ${before} 定义`);
    registry.set(id, source);
  }
  function register(ref: Reference, source: string, alreadyClaimed = false) {
    if (!alreadyClaimed) claim(ref.id, source);
    references[ref.id] = ref;
  }
  async function makeBody(markdown: string, source: string, ownerId: string, url: string, chapterId?: string): Promise<Body> {
    let ast: PandocDocument;
    try { ast = await parseMarkdown(markdown); }
    catch (error) { return fail(source, String(error)); }
    const body = { ast, html: '', text: '', headings: [], source };
    pending.push({ body, markdown, ownerId, url, chapterId });
    return body;
  }
  async function readItem(relative: string) { return frontmatter(await read(relative), relative); }

  const config = metadata(configSchema, yaml(await read('course.yaml'), 'course.yaml'), 'course.yaml');
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(config.basePath)) fail('course.yaml', 'basePath 必须是 / 或 /分段/ 形式，不含查询、空格或 ..');
  if (!/^https?:\/\//.test(config.siteUrl)) fail('course.yaml', 'siteUrl 只支持 http(s)');
  unique(config.chapters, 'course.yaml', 'chapters');
  const route = (kind: string, id: string) => `${config.basePath}${kind}/${id}/`;
  const macros = (await fs.stat(path.join(root, 'math/macros.tex')).catch(() => null)) ? await read('math/macros.tex') : '';
  const macroConfig = parseMacros(macros);
  validateMacroConfig(macroConfig, 'math/macros.tex');
  const course: Course = {
    ...config, revision: '', builtAt: new Date().toISOString(), chapters: [],
    documents: Object.create(null), problems: Object.create(null), sets: Object.create(null), references, macros, macroConfig, assets,
  };

  const chapterFiles = new Map<string, { source: string; data: z.infer<typeof chapterSchema>; markdown: string }>();
  for (const source of await files('chapters')) {
    if (!source.endsWith('.md')) fail(source, 'chapters 目录只允许 Markdown 文件');
    const { meta, markdown } = await readItem(source);
    const data = metadata(chapterSchema, meta, source);
    claim(data.id, source);
    for (const key of ['documents', 'problems', 'sets'] as const) unique(data[key], source, key);
    chapterFiles.set(data.id, { source, data, markdown });
  }
  for (const id of config.chapters) {
    const entry = chapterFiles.get(id);
    if (!entry) fail('course.yaml', `章节 ${id} 不存在`);
    const { data, source, markdown } = entry;
    const number = course.chapters.length + 1;
    const chapter: Chapter = { ...data, number, body: await makeBody(markdown, source, id, route('chapters', id), id) };
    course.chapters.push(chapter);
    register({ id, title: data.title, label: `第 ${number} 章 ${data.title}`, kind: 'chapter', ownerId: id, chapterId: id, url: route('chapters', id) }, source, true);
  }
  for (const [id, entry] of chapterFiles) if (!config.chapters.includes(id)) fail(entry.source, '章节未列入 course.yaml');

  const problemOwners = new Map<string, Chapter>();
  const documentOwners = new Map<string, Chapter>();
  for (const chapter of course.chapters) {
    for (const [kind, values, owners] of [['题目', chapter.problems, problemOwners], ['文档', chapter.documents, documentOwners]] as const) {
      for (const id of values) {
        if (owners.has(id)) fail(chapter.body.source, `${kind} ${id} 已属于章节 ${owners.get(id)!.id}，只能有一个主归属章节`);
        owners.set(id, chapter);
      }
    }
  }

  for (const source of await files('documents')) {
    if (!source.endsWith('.md')) fail(source, 'documents 目录只允许 Markdown 文件');
    const { meta, markdown } = await readItem(source);
    const data = metadata(documentSchema, meta, source);
    const chapter = documentOwners.get(data.id);
    if (!chapter) fail(source, '文档没有所属章节');
    claim(data.id, source);
    unique(data.tags, source, 'tags');
    const document: Document = { ...data, body: await makeBody(markdown, source, data.id, route('documents', data.id), chapter.id) };
    course.documents[data.id] = document;
    register({ id: data.id, title: data.title, label: data.title, kind: 'document', ownerId: data.id, chapterId: chapter.id, url: route('documents', data.id) }, source, true);
  }

  const allProblemFiles = await files('problems');
  const usedProblemFiles = new Set<string>();
  for (const source of allProblemFiles.filter(file => /^problems\/[^/]+\/index\.md$/.test(file))) {
    usedProblemFiles.add(source);
    const { meta, markdown } = await readItem(source);
    const data = metadata(problemSchema, meta, source);
    if (source.split('/')[1] !== data.id) fail(source, '题目目录名必须与 id 相同');
    const chapter = problemOwners.get(data.id);
    if (!chapter) fail(source, '题目没有主归属章节');
    claim(data.id, source);
    unique(data.tags, source, 'tags'); unique(data.sources, source, 'sources');
    unique([...data.solutions, ...data.comments], source, '解答/评语路径');
    const number = `${chapter.number}.${chapter.problems.indexOf(data.id) + 1}`;
    const problem: Problem = {
      id: data.id, title: data.title, tags: data.tags, sources: data.sources, difficulty: data.difficulty,
      chapterId: chapter.id, number, body: await makeBody(markdown, source, data.id, route('problems', data.id), chapter.id), solutions: [], comments: [],
    };
    course.problems[data.id] = problem;
    register({ id: data.id, title: data.title, label: `题 ${number}${data.title ? ` ${data.title}` : ''}`, kind: 'problem', ownerId: data.id, chapterId: chapter.id, url: route('problems', data.id) }, source, true);
    for (const kind of ['solutions', 'comments'] as const) {
      for (const [index, partPath] of data[kind].entries()) {
        const relative = slash(path.normalize(path.join(path.dirname(source), partPath)));
        if (!relative.startsWith(`problems/${data.id}/`) || !relative.endsWith('.md')) fail(source, `解答/评语必须是同一题目目录内的 Markdown：${partPath}`);
        if (usedProblemFiles.has(relative)) fail(source, `文件重复使用：${relative}`);
        await safePath(relative, source);
        usedProblemFiles.add(relative);
        const item = await readItem(relative);
        const part = metadata(partSchema, item.meta, relative);
        const id = part.id ?? `${data.id}-${kind === 'solutions' ? 'solution' : 'comment'}-${index + 1}`;
        const title = part.title ?? `${kind === 'solutions' ? '解答' : '评语'} ${index + 1}`;
        claim(id, relative);
        const parsed: Part = { id, title, kind: part.kind, body: await makeBody(item.markdown, relative, data.id, route('problems', data.id), chapter.id) };
        problem[kind].push(parsed);
        register({ id, title, label: `题 ${number} · ${title}`, kind: 'heading', ownerId: data.id, chapterId: chapter.id, url: route('problems', data.id) + '#' + id }, relative, true);
      }
    }
  }
  for (const source of allProblemFiles) if (!usedProblemFiles.has(source)) fail(source, '题目目录中存在未引用文件；图片请统一放入 assets/');

  for (const source of await files('sets')) {
    if (!source.endsWith('.md')) fail(source, 'sets 目录只允许 Markdown 文件');
    const { meta, markdown } = await readItem(source);
    const data = metadata(setSchema, meta, source);
    claim(data.id, source);
    const chapters = course.chapters.filter(chapter => chapter.sets.includes(data.id));
    if (!chapters.length) fail(source, '习题集未挂靠任何章节');
    const groupIds = data.groups?.flatMap(group => group.problems) ?? [];
    unique(groupIds, source, 'groups'); unique(data.problems, source, 'problems');
    if (groupIds.length && data.problems.length && (groupIds.length !== data.problems.length || groupIds.some((id, i) => id !== data.problems[i]))) fail(source, '同时使用 groups 和 problems 时，groups 展开后须与 problems 的顺序完全一致');
    const problemIds = groupIds.length ? groupIds : data.problems;
    for (const id of problemIds) if (!course.problems[id]) fail(source, `题目 ${id} 不存在`);
    const set: ExerciseSet = { ...data, problems: problemIds, body: await makeBody(markdown, source, data.id, route('sets', data.id), chapters[0].id) };
    course.sets[data.id] = set;
    register({ id: data.id, title: data.title, label: data.title, kind: 'set', ownerId: data.id, chapterId: chapters[0].id, url: route('sets', data.id) }, source, true);
  }
  for (const chapter of course.chapters) {
    for (const [field, records] of [['documents', course.documents], ['problems', course.problems], ['sets', course.sets]] as const) {
      for (const id of chapter[field]) if (!records[id]) fail(chapter.body.source, `${field} 引用的 ${id} 不存在`);
    }
  }

  // Hash every asset, even if currently unused: publication revisions identify all content bytes.
  for (const source of await files('assets')) {
    const absolute = await safePath(source);
    const data = await fs.readFile(absolute);
    if (data.length > 32 * 1024 * 1024) fail(source, '单个资源超过 32 MiB');
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.pdf'].includes(path.extname(source).toLowerCase())) fail(source, 'assets 只支持 PNG/JPEG/WebP/GIF/SVG/PDF');
    if (source.toLowerCase().endsWith('.svg')) {
      const svg = data.toString('utf8')
        .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_match, value) => {
          const point = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : parseInt(value, 10);
          return point <= 0x10ffff ? String.fromCodePoint(point) : '';
        })
        .replace(/\s+xmlns(?::[\w-]+)?\s*=\s*(['"])[^'"]*\1/g, '');
      const externalCss = [...svg.matchAll(/url\(([^)]*)\)/gi)].some(match => !/^(?:#[\w:.-]+|"#[\w:.-]+"|'#[\w:.-]+')$/.test(match[1].trim()));
      if (/<(?:[\w-]+:)?(?:script|foreignObject|iframe|object|embed|animate\w*|set)\b|\bon\w+\s*=|(?:javascript|data|https?):|<!ENTITY|<!DOCTYPE|@import/i.test(svg)
        || /\b(?:[\w-]+:)?href\s*=\s*(['"])(?!#)[\s\S]*?\1/i.test(svg)
        || externalCss) fail(source, 'SVG 必须是无脚本、无外部资源的静态图片');
    }
    originals.set(source, data);
    assets.push({ source, path: source, digest: digest(data) });
    visitedResources.add(source);
  }

  const bodyOrder = new Map<Body, number>();
  let nextBody = 0;
  for (const chapter of course.chapters) {
    bodyOrder.set(chapter.body, nextBody++);
    for (const id of chapter.documents) bodyOrder.set(course.documents[id].body, nextBody++);
    for (const id of chapter.problems) {
      const problem = course.problems[id];
      bodyOrder.set(problem.body, nextBody++);
      for (const part of [...problem.solutions, ...problem.comments]) bodyOrder.set(part.body, nextBody++);
    }
    for (const id of chapter.sets) if (!bodyOrder.has(course.sets[id].body)) bodyOrder.set(course.sets[id].body, nextBody++);
  }
  pending.sort((a, b) => bodyOrder.get(a.body)! - bodyOrder.get(b.body)!);
  const equationCounts = new Map<string, number>();
  const figureCounts = new Map<string, number>();
  const semanticCounts = new Map<string, number>();
  for (const entry of pending) {
    const { body, markdown, ownerId, chapterId, url } = entry;
    const explicitIds = new Set([...markdown.matchAll(/\{[^}\n]*#([A-Za-z][\w-]*)[^}\n]*\}/g)].map(match => match[1]));
    let headingCount = 0;
    let semanticCount = 0;
    const namespace = `${ownerId}-${digest(body.source).slice(0, 6)}`;
    const chapterNumber = course.chapters.find(chapter => chapter.id === chapterId)?.number ?? 0;
    walk(body.ast.blocks, node => {
      if (node.t === 'RawBlock' || node.t === 'RawInline') fail(body.source, `不支持原始 ${node.c[0]}；请改用 Markdown、数学公式或语义块`);
      if (node.t === 'Cite') fail(body.source, '暂不支持文献引用，请使用普通链接');
      const attr = attrFor(node);
      if (attr) {
        for (const [key, value] of attr[2]) {
          if (key === 'title') continue;
          if ((key === 'width' || key === 'height') && /^\d+(?:\.\d+)?(?:%|px|pt|cm|mm|in)?$/.test(value)) continue;
          fail(body.source, `不支持属性 ${key}`);
        }
        if (node.t === 'Div' && (attr[1].length !== 1 || !containers.has(attr[1][0]))) fail(body.source, `语义块须使用 ${[...containers].join('/')} 之一`);
        if (node.t !== 'Div' && node.t !== 'CodeBlock' && attr[1].length) fail(body.source, `不支持 ${node.t} 的自定义 class`);
        if (attr[0] && node.t !== 'Header' && node.t !== 'Image' && node.t !== 'Figure' && node.t !== 'Div') {
          metadata(idSchema, attr[0], body.source);
          register({ id: attr[0], title: attr[2].find((pair: string[]) => pair[0] === 'title')?.[1] || attr[0], label: attr[0], ownerId, chapterId, kind: 'heading', url: url + '#' + attr[0] }, body.source);
        }
      }
      if (node.t === 'Div') {
        const attributes = node.c[0];
        const semantic = semanticBlock(attributes[1][0])!;
        semanticCount++;
        attributes[0] ||= `${namespace}-block-${semanticCount}`;
        metadata(idSchema, attributes[0], body.source);
        const title = (attributes[2].find(([key]: string[]) => key === 'title')?.[1] ?? '').trim();
        let number: string | undefined;
        if (semantic.numbered) {
          if (!chapterId || !chapterNumber) fail(body.source, '编号语义块必须属于一个有效章节');
          const count = (semanticCounts.get(chapterId) ?? 0) + 1;
          semanticCounts.set(chapterId, count);
          number = `${chapterNumber}.${count}`;
        }
        // Only the compiler can add these attributes: user-supplied data-* values
        // were rejected above. Keep prose untouched for the PDF renderer.
        attributes[2].push(['data-semantic-label', semantic.label]);
        if (number) attributes[2].push(['data-semantic-number', number]);
        if (title) attributes[2].push(['data-semantic-title', title]);
        const label = semanticHeading(semantic.label, number, number ? undefined : title);
        register({ id: attributes[0], title: title || label, label, ownerId, chapterId, kind: 'semantic', url: url + '#' + attributes[0] }, body.source);
      }
      if (node.t === 'Header') {
        const [level, attributes, inlines] = node.c;
        headingCount++;
        if (!explicitIds.has(attributes[0])) attributes[0] = `${namespace}-section-${headingCount}`;
        else metadata(idSchema, attributes[0], body.source);
        const title = plain(inlines);
        body.headings.push({ id: attributes[0], text: title, level });
        register({ id: attributes[0], title, label: title, ownerId, chapterId, kind: 'heading', url: url + '#' + attributes[0] }, body.source);
      }
      if (node.t === 'Math') {
        let formula: string = node.c[1];
        const labels = [...formula.matchAll(/\\label\{([^}]+)\}/g)];
        if (labels.length && node.c[0].t !== 'DisplayMath') fail(body.source, '公式 label 只能用于独立公式');
        if (labels.length > 1) fail(body.source, '一个独立公式只支持一个 label，请拆分公式');
        formula = formula.replace(/\\label\{[^}]+\}/g, '');
        if (/\\(?:ref|eqref|autoref|pageref)\s*(?:\{|\[)?/.test(formula)) fail(body.source, '请将公式内的引用移到正文，使用 [自动文字](ref:id)');
        if (/\\label\b/.test(formula)) fail(body.source, '公式 label 必须写成 \\label{id}，且只能用于独立公式');
        if (/\\(?:tag|notag|nonumber)\b/.test(formula)) fail(body.source, '公式编号由构建器统一生成，不支持 \\tag、\\notag 或 \\nonumber');
        validateMath(formula, node.c[0].t === 'DisplayMath', macroConfig, body.source);
        node.c[1] = formula;
        if (labels.length) {
          const id = metadata(idSchema, labels[0][1], body.source);
          const count = (equationCounts.get(chapterId ?? '') ?? 0) + 1;
          equationCounts.set(chapterId ?? '', count);
          const number = `${chapterNumber}.${count}`;
          register({ id, title: `式 (${number})`, label: `式 (${number})`, ownerId, chapterId, kind: 'equation', url: url + '#' + id }, body.source);
          // Temporary marker is replaced by a block Div below, never sent to Pandoc.
          (node as any).__equation = { id, number };
        }
      }
      if (node.t === 'Link') {
        const href: string = node.c[2][0];
        if (href.startsWith('#')) node.c[2][0] = 'ref:' + href.slice(1);
        else if (!/^(?:ref:|https?:\/\/|mailto:)/i.test(href)) fail(body.source, `链接只支持 ref:id、#id、http(s) 或 mailto：${href}`);
      }
      if (node.t === 'Image') {
        const href: string = node.c[2][0];
        let decoded: string;
        try { decoded = decodeURIComponent(href); } catch { return fail(body.source, `图片路径编码无效：${href}`); }
        if (/^[a-z]+:|^[\/]|[?#]|\\/i.test(decoded)) fail(body.source, `图片必须使用相对文件路径：${href}`);
        const relative = slash(path.normalize(path.join(path.dirname(body.source), decoded)));
        if (!relative.startsWith('assets/') || !visitedResources.has(relative)) fail(body.source, `图片必须存在于 assets/：${href}`);
        const extension = path.extname(relative).toLowerCase();
        if (!imageExtensions.has(extension)) fail(body.source, `网页图片不支持该格式：${href}`);
        if (['.svg', '.webp', '.gif'].includes(extension)) {
          const stem = relative.slice(0, -extension.length);
          if (!visitedResources.has(stem + '.pdf') && !visitedResources.has(stem + '.png')) fail(body.source, `图片 ${relative} 需同名 PDF 或 PNG 打印替代文件，例如 ${stem}.pdf`);
        }
        node.c[2][0] = relative;
      }
      if ((node.t === 'Image' || node.t === 'Figure') && node.c[0][0]) {
        const id = metadata(idSchema, node.c[0][0], body.source);
        const count = (figureCounts.get(chapterId ?? '') ?? 0) + 1;
        figureCounts.set(chapterId ?? '', count);
        const number = `${chapterNumber}.${count}`;
        register({ id, title: plain(node.c[1]).trim(), label: `图 ${number}`, ownerId, chapterId, kind: 'figure', url: url + '#' + id }, body.source);
      }
    });
    function equations(value: any): void {
      if (!Array.isArray(value)) { if (value && typeof value === 'object') equations(value.c); return; }
      for (let i = 0; i < value.length; i++) {
        const node = value[i];
        if (node?.t === 'Para' || node?.t === 'Plain') {
          const marked = node.c.filter((inline: any) => inline.__equation);
          if (marked.length) {
            if (marked.length !== 1 || node.c.some((inline: any) => inline !== marked[0] && !['SoftBreak', 'Space'].includes(inline.t))) fail(body.source, '带 label 的独立公式须单独成段');
            const marker = marked[0].__equation;
            delete marked[0].__equation;
            value[i] = { t: 'Div', c: [[marker.id, ['equation'], [['data-equation-number', marker.number]]], [node]] };
          }
        }
        if (Array.isArray(value[i])) equations(value[i]);
        else equations(value[i]?.c);
      }
    }
    equations(body.ast.blocks);
  }

  for (const { body } of pending) {
    walk(body.ast.blocks, node => {
      if (node.t !== 'Link' || !node.c[2][0].startsWith('ref:')) return;
      const id = node.c[2][0].slice(4);
      const target = references[id];
      if (!target) fail(body.source, `引用目标不存在：${id}`);
      const text = plain(node.c[1]).trim();
      if (!text || text === '自动文字' || text === 'auto') node.c[1] = inlineText(target.label);
    });
    const web = structuredClone(body.ast);
    walk(web.blocks, node => {
      if (node.t === 'Link' && node.c[2][0].startsWith('ref:')) node.c[2][0] = references[node.c[2][0].slice(4)].url;
      if (node.t === 'Image') node.c[2][0] = config.basePath + node.c[2][0].split('/').map(encodeURIComponent).join('/');
      if (node.t === 'Div' && semanticBlock(node.c[0][1][0])) {
        const attributes = new Map<string, string>(node.c[0][2]);
        const heading = semanticHeading(attributes.get('data-semantic-label')!, attributes.get('data-semantic-number'), attributes.get('data-semantic-title'));
        // Titles remain plain Str nodes: HTML and TeX syntax is displayed literally.
        node.c[1].unshift({ t: 'Div', c: [['', ['semantic-title'], []], [{ t: 'Plain', c: [{ t: 'Strong', c: inlineText(heading) }] }]] });
      }
    });
    body.text = plain(web.blocks).trim();
    body.html = await renderHtml(web);
  }

  // Re-read the exact snapshot before publishing: never mix concurrent author edits.
  const hash = createHash('sha256');
  for (const [source, buffer] of [...originals.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const current = await fs.readFile(await safePath(source));
    if (!current.equals(buffer)) fail(source, '构建过程中内容发生变化，请重试');
    hash.update(source).update('\0').update(buffer).update('\0');
  }
  course.revision = hash.digest('hex');
  return course;
}
