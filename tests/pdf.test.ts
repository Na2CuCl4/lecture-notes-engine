import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPrintAst, buildTex, compilePdf, escapeTex } from '../src/pdf.ts';
import type { Body, Course, PandocNode, PrintRequest, Problem } from '../src/types.ts';

function body(value: string, nodes: PandocNode[] = []): Body {
  return { source: 'fixture.md', text: value, html: '', headings: [], ast: {
    'pandoc-api-version': [1, 23, 1], meta: {}, blocks: [{ t: 'Para', c: [{ t: 'Str', c: value }] }, ...nodes],
  } };
}
function fixture(): Course {
  const problem = (id: string, chapterId: string, number: string): Problem => ({
    id, chapterId, number, title: `标题 ${id}`, tags: ['极限'], sources: ['旧讲义'], difficulty: 2,
    body: body(`唯一题面-${id}`),
    solutions: [{ id: `${id}-solution`, title: '直接证明', body: body(`唯一解答-${id}`) }],
    comments: [{ id: `${id}-comment`, title: '易错点', kind: 'warning', body: body(`唯一评语-${id}`) }],
  });
  const course: Course = {
    schemaVersion: 1, engineVersion: 'test', revision: 'fixed-revision', builtAt: '2026-10-15T00:00:00Z',
    title: '高等微积分(1)', author: 'Author', language: 'zh-CN', basePath: '/course/', siteUrl: 'https://example.org/course/',
    macros: '', macroConfig: {}, assets: [],
    chapters: [
      { id: 'one', title: '极限', number: 1, body: body('章一说明'), documents: ['intro'], problems: ['p1', 'p2'], sets: ['tutorial'] },
      { id: 'two', title: '连续', number: 2, body: body('章二说明'), documents: [], problems: ['p3'], sets: ['tutorial'] },
    ],
    documents: { intro: { id: 'intro', title: '文档', tags: [], body: body('唯一文档') } },
    problems: { p1: problem('p1', 'one', '1.1'), p2: problem('p2', 'one', '1.2'), p3: problem('p3', 'two', '2.1') },
    sets: { tutorial: { id: 'tutorial', title: '习题课', body: body('习题集说明'), problems: ['p1', 'p3'] } },
    references: {},
  };
  for (const p of Object.values(course.problems)) course.references[p.id] = { id: p.id, title: p.title, label: `题 ${p.number}`, url: `/course/problems/${p.id}/`, ownerId: p.id, chapterId: p.chapterId, kind: 'problem' };
  return course;
}
function request(overrides: Partial<PrintRequest> = {}): PrintRequest {
  return { revision: 'fixed-revision', chapterId: 'one', problemIds: ['p1', 'p2'], includeDocuments: true, solutions: 'inline', comments: true, ...overrides };
}
function allNodes(value: any): PandocNode[] {
  if (Array.isArray(value)) return value.flatMap(allNodes);
  if (value && typeof value === 'object') return [...(value.t ? [value] : []), ...allNodes(value.c ?? value.blocks)];
  return [];
}

test('chapter print preserves selected order, stable numbers, and optional content', () => {
  const ast = buildPrintAst(fixture(), request({ problemIds: ['p2', 'p1'], includeDocuments: false, solutions: 'none', comments: false }));
  const serialized = JSON.stringify(ast);
  assert.ok(serialized.indexOf('唯一题面-p2') < serialized.indexOf('唯一题面-p1'));
  assert.match(serialized, /题 1\.2/);
  assert.doesNotMatch(serialized, /唯一文档|唯一解答|唯一评语|唯一题面-p3/);
});

test('standalone later chapter retains its course number without numbering problems twice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lecture-pdf-chapter-'));
  try {
    const course = fixture();
    const selected = request({ chapterId: 'two', problemIds: ['p3'] });
    const ast = buildPrintAst(course, selected);
    const headers = allNodes(ast).filter((node) => node.t === 'Header');
    assert.equal(headers[0].c[0], 1);
    assert.deepEqual(headers[0].c[2], [{ t: 'Str', c: '连续' }]);
    const problem = headers.find((node) => node.c[1][0] === 'p3')!;
    assert.ok(problem.c[1][1].includes('unnumbered'));
    assert.ok(problem.c[1][1].includes('unlisted'));
    const solution = headers.find((node) => node.c[1][0] === 'p3-solution')!;
    assert.equal(solution.c[0], 5);
    const source = await buildTex(course, selected, { contentDir: dir, workDir: dir });
    assert.match(source, /\\setcounter\{chapter\}\{1\}[\s\S]*\\chapter\{连续\}/);
    assert.match(source, /\\subsection\*\{题 2\.1/);
    assert.match(source, /\\paragraph\*\{直接证明\}/);
    assert.doesNotMatch(source, /@@[A-Z_]+@@/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('end answers are after all question bodies; source AST is immutable', () => {
  const course = fixture(); const before = JSON.stringify(course);
  const serialized = JSON.stringify(buildPrintAst(course, request({ solutions: 'end' })));
  assert.ok(serialized.indexOf('唯一解答-p1') > serialized.indexOf('唯一题面-p2'));
  assert.match(serialized, /参考解答/);
  assert.match(serialized, /唯一评语-p1/);
  assert.equal(JSON.stringify(course), before);
});

test('book prints each question once, sets retain indexes, and duplicate destinations are removed', () => {
  const ast = buildPrintAst(fixture(), { revision: 'fixed-revision', kind: 'book', solutions: 'inline', comments: true });
  const serialized = JSON.stringify(ast);
  for (const id of ['p1', 'p2', 'p3']) assert.equal(serialized.split(`唯一题面-${id}`).length - 1, 1);
  assert.equal(serialized.split('习题集说明').length - 1, 2);
  const headers = allNodes(ast).filter((node) => node.t === 'Header');
  assert.equal(headers.filter((node) => node.c[1][0] === 'tutorial').length, 1);
  assert.ok(allNodes(ast).some((node) => node.t === 'Link' && node.c[2][0] === '#p3'));
});

test('excluded targets link to website; included targets remain internal', () => {
  const course = fixture();
  course.problems.p1.body.ast.blocks.push({ t: 'Para', c: ['p2', 'p3'].map((id) => ({ t: 'Link', c: [['', [], []], [], [`ref:${id}`, '']] })) });
  const links = allNodes(buildPrintAst(course, request())).filter((node) => node.t === 'Link');
  assert.equal(links[0].c[2][0], '#p2');
  assert.equal(links[1].c[2][0], 'https://example.org/course/problems/p3/');
  assert.equal(links[1].c[1][0].c, '题 2.1');
});

test('invalid revision, duplicate/cross-chapter IDs, and raw TeX fail before conversion', () => {
  assert.throws(() => buildPrintAst(fixture(), request({ revision: 'other' })), /版本/);
  assert.throws(() => buildPrintAst(fixture(), request({ problemIds: ['p1', 'p1'] })), /重复/);
  assert.throws(() => buildPrintAst(fixture(), request({ problemIds: ['p3'] })), /不属于/);
  const course = fixture();
  course.problems.p1.body.ast.blocks.push({ t: 'RawBlock', c: ['latex', '\\input{secret}'] });
  assert.throws(() => buildPrintAst(course, request()), /原始/);
});

test('equations retain stable tags and semantic blocks retain human-readable labels', () => {
  const course = fixture();
  course.problems.p1.body.ast.blocks.push(
    { t: 'Div', c: [['eq-one', ['equation'], [['data-equation-number', '1.3']]], [{ t: 'Para', c: [{ t: 'Math', c: [{ t: 'DisplayMath' }, 'a=b'] }] }]] },
    { t: 'Div', c: [['', ['theorem'], [['title', '夹逼定理']]], [{ t: 'Para', c: [{ t: 'Str', c: 'statement' }] }]] },
  );
  const serialized = JSON.stringify(buildPrintAst(course, request()));
  assert.match(serialized, /tag\{1\.3\}/);
  assert.match(serialized, /定理（夹逼定理）/);
});

test('generated text cannot inject TeX commands', () => {
  assert.equal(escapeTex('a_b%{\\input}'), 'a\\_b\\%\\{\\textbackslash{}input\\}');
});

test('image paths cannot escape snapshot; SVG requires a pre-rendered sibling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lecture-pdf-'));
  try {
    const course = fixture();
    const image = { t: 'Image', c: [['', [], []], [], ['assets/../../secret.png', '']] };
    course.problems.p1.body.ast.blocks.push({ t: 'Para', c: [image] });
    await assert.rejects(buildTex(course, request(), { contentDir: dir, workDir: join(dir, 'work') }), /越过/);
    image.c[2][0] = 'assets/figure.svg';
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'assets', 'figure.svg'), '<svg/>');
    await assert.rejects(buildTex(course, request(), { contentDir: dir, workDir: join(dir, 'work') }), /同名 PDF 或 PNG/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failed compilation produces a persistent diagnostic log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lecture-pdf-failure-'));
  try {
    await assert.rejects(compilePdf(fixture(), request({ revision: 'invalid' }), { contentDir: dir, workDir: dir, outputPath: join(dir, 'result.pdf') }), /日志/);
    assert.match(await readFile(join(dir, 'compile.log'), 'utf8'), /版本/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancelled jobs never start a converter and retain a clear failure log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lecture-pdf-abort-'));
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(compilePdf(fixture(), request(), {
      contentDir: dir, workDir: dir, outputPath: join(dir, 'result.pdf'), signal: controller.signal,
    }), /取消/);
    assert.match(await readFile(join(dir, 'compile.log'), 'utf8'), /取消/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
