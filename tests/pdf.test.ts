import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPrintAst, buildTex, escapeTex } from '../src/pdf.ts';
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
    macros: '', macroConfig: {},
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
  assert.ok(allNodes(ast).some((node) => node.t === 'Div' && node.c[0][0] === 'p2' && node.c[0][2].some(([key, value]: string[]) => key === 'data-problem-number' && value === '1.2')));
  assert.doesNotMatch(serialized, /唯一文档|唯一解答|唯一评语|唯一题面-p3/);
});

test('invalid revision, duplicate/cross-chapter IDs, and raw TeX fail before conversion', () => {
  assert.throws(() => buildPrintAst(fixture(), request({ revision: 'other' })), /版本/);
  assert.throws(() => buildPrintAst(fixture(), request({ problemIds: ['p1', 'p1'] })), /重复/);
  assert.throws(() => buildPrintAst(fixture(), request({ problemIds: ['p3'] })), /不属于/);
  const course = fixture();
  course.problems.p1.body.ast.blocks.push({ t: 'RawBlock', c: ['latex', '\\input{secret}'] });
  assert.throws(() => buildPrintAst(course, request()), /原始/);
});

test('equations and theorem blocks retain fixed numbers and titles', () => {
  const course = fixture();
  course.problems.p1.body.ast.blocks.push(
    { t: 'Div', c: [['eq-one', ['equation'], [['data-equation-number', '1.3']]], [{ t: 'Para', c: [{ t: 'Math', c: [{ t: 'DisplayMath' }, 'a=b'] }] }]] },
    { t: 'Div', c: [['th-squeeze', ['theorem'], [['data-semantic-title', '夹逼定理'], ['data-semantic-number', '1.7']]], [{ t: 'Para', c: [{ t: 'Str', c: 'statement' }] }]] },
  );
  const serialized = JSON.stringify(buildPrintAst(course, request()));
  assert.match(serialized, /tag\{1\.3\}/);
  assert.match(serialized, /thelecturetheorem.*1\.7/);
  assert.match(serialized, /begin\{lecturetheorem\}\[\{夹逼定理\}\]/);
});

test('nested theorem destinations and safe titles are retained in the print AST', () => {
  const course = fixture();
  const title = ']\\input{private}%';
  course.problems.p2.body.ast.blocks.push({ t: 'BulletList', c: [[
    { t: 'Para', c: [{ t: 'Str', c: '列表里的引理' }] },
    { t: 'Div', c: [['nested-lemma', ['lemma'], [['data-semantic-number', '1.9'], ['data-semantic-title', title]]], [{ t: 'Para', c: [{ t: 'Str', c: '引理正文' }] }]] },
  ]] });
  course.problems.p1.body.ast.blocks.push({ t: 'Para', c: [{ t: 'Link', c: [['', [], []], [{ t: 'Str', c: '引理 1.9' }], ['#nested-lemma', '']] }] });
  const nodes = allNodes(buildPrintAst(course, request({ problemIds: ['p2', 'p1'] })));
  assert.equal(nodes.filter(node => node.t === 'Div' && node.c[0][0] === 'nested-lemma').length, 1);
  assert.ok(nodes.some(node => node.t === 'Link' && node.c[2][0] === '#nested-lemma'));
  const generated = nodes.filter(node => node.t === 'RawBlock').map(node => node.c[1]).join('\n');
  assert.ok(generated.includes(`\\begin{lecturelemma}[{${escapeTex(title)}}]`));
  assert.ok(generated.includes('\\renewcommand{\\thelecturetheorem}{1.9}'));
  assert.doesNotMatch(generated, /\\input\{private\}/);
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
