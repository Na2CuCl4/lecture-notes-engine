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
