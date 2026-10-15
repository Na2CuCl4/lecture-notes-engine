import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCourse } from '../src/content.js';
import { parseMacros, validateMath } from '../src/macros.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lecture-content-test-'));
  const put = async (name: string, text: string | Buffer) => {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text, 'utf8');
  };
  await put('course.yaml', 'schemaVersion: 1\nengineVersion: 0.1.0\ntitle: 测试课程\nauthor: 测试作者\nlanguage: zh-CN\nbasePath: /course/\nsiteUrl: https://example.test\nchapters: [limits, continuity]\n');
  await put('math/macros.tex', String.raw`\newcommand{\RR}{\mathbb{R}}
\newcommand{\abs}[1]{\left|#1\right|}
\renewcommand{\hat}[1]{\widehat{#1}}
`);
  await put('chapters/limits.md', '---\nid: limits\ntitle: 极限\ndocuments: [review]\nproblems: [squeeze]\nsets: [tutorial]\n---\n本章研究极限。\n');
  await put('chapters/continuity.md', '---\nid: continuity\ntitle: 连续\nproblems: [continuous]\nsets: [tutorial]\n---\n第二章。\n');
  await put('documents/review.md', String.raw`---
id: review
title: 极限复习
tags: [极限]
---
## 定义 {#limit-definition}

设 $a_n\in\RR$。参见 [自动文字](ref:squeeze) 和 [自动文字](ref:eq-bound)。

![示意图](../assets/diagram.svg){#fig-diagram}
`);
  await put('problems/squeeze/index.md', String.raw`---
id: squeeze
title: ""
tags: [夹逼准则]
sources: [教材]
difficulty: 2
solutions: [solutions/direct.md]
comments: [comments/note.md]
---
证明 $\lim_{n\to\infty} \sin(n)/n=0$。

$$
-1/n\leq \sin(n)/n\leq 1/n \label{eq-bound}
$$

参见 [定义](#limit-definition) 和 [自动文字](ref:fig-diagram)。

1. 在分项内也可以给公式编号：

   $$
   \lim_{n\to\infty} 1/n = 0 \label{eq-list-bound}
   $$
`);
  await put('problems/squeeze/solutions/direct.md', '---\nid: squeeze-direct\ntitle: 用夹逼准则\n---\n由夹逼准则即得。\n');
  await put('problems/squeeze/comments/note.md', '---\ntitle: 注意符号\nkind: pitfall\n---\n::: {.note}\n注意两侧均趋于零。\n:::\n');
  await put('problems/continuous/index.md', '---\nid: continuous\ntitle: 连续函数\ndifficulty: null\n---\n请举出一个连续函数。\n');
  await put('sets/tutorial.md', '---\nid: tutorial\ntitle: 综合训练\ngroups:\n  - title: 第一组\n    problems: [squeeze]\n  - title: 第二组\n    problems: [continuous]\n---\n一道题可以在多章挂靠的题单中出现。\n');
  await put('assets/diagram.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 10L10 0"/></svg>');
  await put('assets/diagram.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8ioAAAAASUVORK5CYII=', 'base64'));
  return { root, put, remove: () => fs.rm(root, { recursive: true, force: true }) };
}

test('content: project mounts use distinct links and revisions without editing course sources', async () => {
  const f = await fixture();
  try {
    const original = await fs.readFile(path.join(f.root, 'course.yaml'), 'utf8');
    const first = await buildCourse(f.root, { basePath: '/project1/', title: '项目一', siteUrl: 'https://example.test/project1/' });
    const second = await buildCourse(f.root, { basePath: '/project2/', title: '项目二', siteUrl: 'https://example.test/project2/' });
    assert.equal(first.title, '项目一'); assert.equal(second.title, '项目二');
    assert.equal(first.references.squeeze.url, '/project1/problems/squeeze/');
    assert.equal(second.references.squeeze.url, '/project2/problems/squeeze/');
    assert.match(first.documents.review.body.html, /src="\/project1\/assets\/diagram.svg"/);
    assert.match(second.documents.review.body.html, /href="\/project2\/problems\/squeeze\/#eq-bound"/);
    assert.notEqual(first.revision, second.revision);
    assert.equal(await fs.readFile(path.join(f.root, 'course.yaml'), 'utf8'), original);
    await assert.rejects(buildCourse(f.root, { basePath: '/../' }), /basePath/);
  } finally { await f.remove(); }
});

test('content: cross-file references, figures, equation numbers, parts and deterministic revisions', async () => {
  const f = await fixture();
  try {
    const course = await buildCourse(f.root);
    assert.equal(course.problems.squeeze.number, '1.1');
    assert.equal(course.problems.continuous.number, '2.1');
    assert.deepEqual(course.sets.tutorial.problems, ['squeeze', 'continuous']);
    assert.equal(course.problems.squeeze.comments[0].id, 'squeeze-comment-1');
    assert.equal(course.references['eq-bound'].label, '式 (1.1)');
    assert.equal(course.references['fig-diagram'].label, '图 1.1');
    assert.equal(course.references['limit-definition'].url, '/course/documents/review/#limit-definition');
    assert.match(course.documents.review.body.html, /href="\/course\/problems\/squeeze\/#eq-bound"/);
    assert.match(course.documents.review.body.html, /src="\/course\/assets\/diagram.svg"/);
    assert.match(course.problems.squeeze.body.html, /data-equation-number="1.1"/);
    assert.match(course.problems.squeeze.body.html, /id="eq-list-bound"/);
    assert.match(course.problems.squeeze.body.html, /data-equation-number="1.2"/);
    assert.doesNotMatch(JSON.stringify(course.problems.squeeze.body.ast), /__equation/);
    assert.match(JSON.stringify(course.problems.squeeze.body.ast), /ref:limit-definition/);
    assert.ok(course.assets.some(asset => asset.source === 'assets/diagram.svg'));
    assert.equal((await buildCourse(f.root)).revision, course.revision);
    await f.put('assets/diagram.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="2"/></svg>');
    assert.notEqual((await buildCourse(f.root)).revision, course.revision);
  } finally { await f.remove(); }
});

test('content: semantic headings share chapter numbers in declared content order', async () => {
  const f = await fixture();
  try {
    await f.put('chapters/limits.md', '---\nid: limits\ntitle: 极限\ndocuments: [z-review, review]\nproblems: [squeeze]\nsets: [tutorial]\n---\n本章研究极限。\n');
    // The declared order deliberately differs from the lexical filename order.
    await f.put('documents/z-review.md', '---\nid: z-review\ntitle: 先读这篇\n---\n::: {.definition #first-definition title="数列"}\n第一条定义。\n:::\n');
    const kinds = ['theorem', 'definition', 'proposition', 'lemma', 'corollary', 'remark', 'note', 'example', 'exercise', 'warning'];
    const labels = ['定理', '定义', '命题', '引理', '推论', '注', '注', '例', '练习', '警示'];
    const original = await fs.readFile(path.join(f.root, 'documents/review.md'), 'utf8');
    await f.put('documents/review.md', original + '\n' + kinds.map(kind => `::: {.${kind} #block-${kind} title="${kind} 标题"}\n${kind} 的正文。\n:::\n`).join('\n')
      + '\n::: {.proof #block-proof title="用定义"}\n证明内容。\n:::\n\n参见 [自动文字](ref:block-theorem) 和 [自动文字](ref:block-proof)。\n');
    await f.put('problems/squeeze/solutions/direct.md', '---\nid: squeeze-direct\ntitle: 用夹逼准则\n---\n::: {.lemma #solution-lemma}\n本题解答中的引理。\n:::\n');
    await f.put('problems/continuous/index.md', '---\nid: continuous\ntitle: 连续函数\n---\n::: {.theorem #second-chapter-theorem}\n第二章的定理。\n:::\n');
    const setText = await fs.readFile(path.join(f.root, 'sets/tutorial.md'), 'utf8');
    await f.put('sets/tutorial.md', setText + '\n::: {.theorem #shared-set-theorem}\n题集说明中的定理。\n:::\n');

    const course = await buildCourse(f.root);
    assert.equal(course.references['first-definition'].label, '定义 1.1');
    for (const [index, kind] of kinds.entries()) {
      const label = `${labels[index]} 1.${index + 2}`;
      const ref = course.references[`block-${kind}`];
      assert.equal(ref.kind, 'semantic');
      assert.equal(ref.label, label);
      assert.equal(ref.title, `${kind} 标题`);
      assert.equal(ref.url, `/course/documents/review/#block-${kind}`);
      assert.ok(course.documents.review.body.html.includes(`${label}（${kind} 标题）`));
    }
    assert.equal(course.references['block-proof'].label, '证明（用定义）');
    assert.equal(course.references['solution-lemma'].label, '引理 1.12');
    assert.equal(course.references['shared-set-theorem'].label, '定理 1.14');
    assert.equal(course.references['second-chapter-theorem'].label, '定理 2.1');
    assert.match(course.documents.review.body.html, /href="\/course\/documents\/review\/#block-theorem">定理 1\.2<\/a>/);
    assert.match(course.documents.review.body.html, /class="semantic-title"/);
    assert.match(course.problems.continuous.body.html, /<strong>定理 2\.1<\/strong>/);
    assert.doesNotMatch(JSON.stringify(course.documents.review.body.ast), /"semantic-title"/);
    assert.match(JSON.stringify(course.documents.review.body.ast), /data-semantic-number/);
    const proof = course.documents.review.body.ast.blocks.find(node => node.t === 'Div' && node.c[0][0] === 'block-proof');
    assert.equal(proof?.c[0][2].some(([key]: string[]) => key === 'data-semantic-number'), false);

    // Reusing and reordering problems in a multi-chapter set changes no source number.
    await f.put('sets/tutorial.md', '---\nid: tutorial\ntitle: 综合训练\nproblems: [continuous, squeeze]\n---\n::: {.theorem #shared-set-theorem}\n题集说明中的定理。\n:::\n');
    const reordered = await buildCourse(f.root);
    for (const [id, ref] of Object.entries(course.references).filter(([, ref]) => ref.kind === 'semantic')) {
      assert.equal(reordered.references[id].label, ref.label);
    }
  } finally { await f.remove(); }
});

test('content: semantic titles are literal text and automatic anchors are repeatable', async () => {
  const f = await fixture();
  try {
    await f.put('problems/continuous/index.md', String.raw`---
id: continuous
title: 连续函数
---
::: {.theorem title="<script>alert(1)</script> & \input{secret}"}
定理正文。
:::

::: {.proof}
证明正文。
:::
`);
    const course = await buildCourse(f.root);
    const body = course.problems.continuous.body;
    const refs = Object.values(course.references).filter(ref => ref.ownerId === 'continuous' && ref.kind === 'semantic');
    assert.equal(refs.length, 2);
    assert.match(refs[0].id, /^continuous-[a-f0-9]{6}-block-1$/);
    assert.equal(refs[0].label, '定理 2.1');
    assert.equal(refs[1].label, '证明');
    assert.match(body.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp;/);
    assert.doesNotMatch(body.html, /<script>|<\/script>/);
    assert.match(body.text, /定理 2\.1（<script>alert\(1\)<\/script> & \\input\{secret\}）/);
    assert.equal(body.ast.blocks[0].c[1][0].t, 'Para');
    assert.equal(body.ast.blocks[0].c[1].length, 1);
    assert.deepEqual(Object.values((await buildCourse(f.root)).references).filter(ref => ref.ownerId === 'continuous' && ref.kind === 'semantic'), refs);

    await f.put('problems/continuous/index.md', '---\nid: continuous\ntitle: 连续函数\n---\n::: {.theorem data-semantic-number="9.9"}\n伪造编号。\n:::\n');
    await assert.rejects(buildCourse(f.root), /不支持属性 data-semantic-number/);
  } finally { await f.remove(); }
});

test('content: missing references and invalid metadata are actionable failures', async () => {
  const f = await fixture();
  try {
    await f.put('problems/continuous/index.md', '---\nid: continuous\ntitle: 测试\ndifficulty: 6\n---\n内容。\n');
    await assert.rejects(buildCourse(f.root), /problems\/continuous\/index.md.*difficulty/);
    await f.put('problems/continuous/index.md', '---\nid: continuous\ntitle: 测试\n---\n[自动文字](ref:missing-problem)\n');
    await assert.rejects(buildCourse(f.root), /引用目标不存在：missing-problem/);
    await f.put('problems/continuous/index.md', '---\nid: continuous\ntitle: 测试\n---\n## 重复锚点 {#limit-definition}\n');
    await assert.rejects(buildCourse(f.root), /ID limit-definition 重复/);
  } finally { await f.remove(); }
});

test('content: duplicated ownership and missing problems fail before publication', async () => {
  const f = await fixture();
  try {
    await f.put('chapters/continuity.md', '---\nid: continuity\ntitle: 连续\nproblems: [squeeze, continuous]\n---\n');
    await assert.rejects(buildCourse(f.root), /只能有一个主归属章节/);
    await f.put('chapters/continuity.md', '---\nid: continuity\ntitle: 连续\nproblems: [continuous, absent]\n---\n');
    await assert.rejects(buildCourse(f.root), /problems 引用的 absent 不存在/);
  } finally { await f.remove(); }
});

test('content: rejects escaped part paths, unsafe HTML, missing images and active SVG', async () => {
  const f = await fixture();
  try {
    await f.put('problems/continuous/index.md', '---\nid: continuous\ntitle: 测试\nsolutions: [../../documents/review.md]\n---\n内容。\n');
    await assert.rejects(buildCourse(f.root), /同一题目目录/);
    await f.put('problems/continuous/index.md', '---\nid: continuous\ntitle: 测试\n---\n<script>alert(1)</script>\n');
    await assert.rejects(buildCourse(f.root), /不支持原始 html/);
    await f.put('problems/continuous/index.md', '---\nid: continuous\ntitle: 测试\n---\n![图](../../assets/missing.png)\n');
    await assert.rejects(buildCourse(f.root), /图片必须存在于 assets/);
    await f.put('problems/continuous/index.md', '---\nid: continuous\ntitle: 测试\n---\n内容。\n');
    await fs.rm(path.join(f.root, 'assets/diagram.png'));
    await assert.rejects(buildCourse(f.root), /同名 PDF 或 PNG 打印替代/);
    await f.put('assets/diagram.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8ioAAAAASUVORK5CYII=', 'base64'));
    await f.put('assets/diagram.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await assert.rejects(buildCourse(f.root), /无脚本/);
  } finally { await f.remove(); }
});

test('content: unknown mathematical commands and runtime macro mutation fail', async () => {
  const f = await fixture();
  try {
    await f.put('problems/continuous/index.md', String.raw`---
id: continuous
title: 测试
---
$\notARealMathCommand{x}$
`);
    await assert.rejects(buildCourse(f.root), /未知数学命令/);
    await f.put('problems/continuous/index.md', String.raw`---
id: continuous
title: 测试
---
$\newcommand{\foo}{x}\foo$
`);
    await assert.rejects(buildCourse(f.root), /不允许命令 \\newcommand/);
    await f.put('problems/continuous/index.md', String.raw`---
id: continuous
title: 测试
---
$\label {bad}$
`);
    await assert.rejects(buildCourse(f.root), /公式 label 必须写成/);
    await f.put('problems/continuous/index.md', String.raw`---
id: continuous
title: 测试
---
$\ref {bad}$
`);
    await assert.rejects(buildCourse(f.root), /公式内的引用/);
  } finally { await f.remove(); }
});

test('content: symlink assets cannot escape content root', async t => {
  const f = await fixture();
  try {
    const link = path.join(f.root, 'assets', 'linked.svg');
    try { await fs.symlink(path.join(f.root, 'assets', 'diagram.svg'), link, 'file'); }
    catch (error: any) {
      if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
      // Windows junctions normally need no Developer Mode privilege. The same
      // lstat rule rejects them before traversal, so exercise that path too.
      try { await fs.symlink(path.join(f.root, 'problems'), path.join(f.root, 'assets', 'linked-directory'), 'junction'); }
      catch (junctionError: any) {
        if (junctionError.code === 'EPERM' || junctionError.code === 'EACCES') { t.skip('OS does not grant symlink or junction creation'); return; }
        throw junctionError;
      }
    }
    await assert.rejects(buildCourse(f.root), /不允许符号链接/);
  } finally { await f.remove(); }
});

test('macros: fixed-parameter definitions and standard redefinitions are order-independent', () => {
  const macros = parseMacros(String.raw`% Shared declarations
\newcommand{\RR}{\mathbb{R}}
\newcommand{\norm}[1]{\left\|#1\right\|}
\renewcommand{\hat}[1]{\widehat{#1}}
\newcommand{\dd}{\mathop{}\!\mathrm{d}}
\newcommand{\uniconv}{\rightrightarrows}
`);
  assert.equal(macros.RR, String.raw`\mathbb{R}`);
  assert.deepEqual(macros.norm, [String.raw`\left\|#1\right\|`, 1]);
  validateMath(String.raw`\hat{x}\in\RR,\quad\norm{x}\uniconv 0,\quad\int f\dd x`, true, macros, 'test.md');
  assert.throws(() => parseMacros(String.raw`\newcommand{\foo}[1][x]{#1}`), /可选宏参数/);
  assert.throws(() => parseMacros(String.raw`\newcommand{\foo}{\bar}\newcommand{\bar}{\foo}`), /递归宏/);
  assert.throws(() => parseMacros(String.raw`\newcommand{\bad}{\input{secret}}`), /不允许命令/);
  assert.throws(() => parseMacros(String.raw`\newcommand{\bad}{\unknowncommand}`), /未知数学命令/);
  assert.throws(() => validateMath(String.raw`\text{\notreal}`, false, macros, 'test.md'), /未知数学命令/);
  assert.throws(() => validateMath(String.raw`\text{\end{document}}`, false, macros, 'test.md'), /数学公式无法解析|不支持.*环境/);
  const aliases = parseMacros(String.raw`\renewcommand{\hat}{\widehat}`);
  validateMath(String.raw`\hat{x}`, false, aliases, 'test.md');
});
