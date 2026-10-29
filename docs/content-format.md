# 内容格式

内容文件使用 UTF-8。以下路径相对于课程根目录：

```text
course.yaml
math/macros.tex
chapters/limits.md
documents/limits-review.md
problems/limit-squeeze/index.md
problems/limit-squeeze/solutions/direct.md
problems/limit-squeeze/comments/pitfall.md
sets/tutorial-01.md
assets/limit-diagram.svg
assets/limit-diagram.pdf
```

## 课程配置

`course.yaml`：

```yaml
schemaVersion: 1
engineVersion: 0.1.0
title: 高等微积分（1）习题课
author: 夏子睿
language: zh-CN
basePath: /calculus-i/
siteUrl: https://example.com/calculus-i/
chapters: [limits]
```

`subtitle` 可选；`basePath` 以 `/` 开头和结尾，根部署用 `/`。`siteUrl` 填包含课程路径的公开地址，用于 PDF 中的网页链接。多项目清单可以覆盖标题、路径和网址。

所有 ID 全库唯一，以小写字母开头，只含小写字母、数字和连字符。标题可改，供引用的 ID 应保持稳定。未知元数据字段会报错。

## 章节与文档

`chapters/limits.md`：

```markdown
---
id: limits
title: 数列与函数极限
documents: [limits-review]
problems: [limit-squeeze]
sets: [tutorial-01]
---

本章导览正文。
```

`documents/limits-review.md`：

```markdown
---
id: limits-review
title: 知识点复习
tags: [数列极限]
---

## 极限的定义 {#sequence-limit-definition}

设数列 $a_n$ 满足……
```

章节须列入 `course.yaml`。三个列表分别决定文档、题目和习题集的顺序，省略时为空。每道题、每份文档只归属一个章节；习题集可挂靠多个章节。题号由章节及 `problems` 顺序确定，筛选或抽题不改变编号。

## 题目、解答与评语

`problems/limit-squeeze/index.md`，目录名须与题目 ID 相同：

```markdown
---
id: limit-squeeze
title: ""
tags: [数列极限]
sources: []
difficulty: 2
solutions: [solutions/direct.md]
comments: [comments/pitfall.md]
---

证明 $\lim_{n\to\infty}\frac{\sin n}{n}=0$。
```

`difficulty` 为 1–5，未标定时省略或填 `null`。`solutions`、`comments` 可省略；路径相对于该题目录，只能引用本题目录内的 `.md` 文件。题目标题可为空，章节、文档和习题集标题不可为空。

解答与评语使用相同格式，元数据均可省略：

```markdown
---
id: limit-squeeze-direct
title: 夹逼准则
kind: proof
---

由 $-1/n\leq\sin n/n\leq1/n$，结论成立。
```

省略 ID 时自动生成；需要长期引用时显式填写。`kind` 仅作分类说明。

## 习题集

`sets/tutorial-01.md`：

```markdown
---
id: tutorial-01
title: 习题课
groups:
  - title: 课堂讨论
    problems: [limit-squeeze]
---

习题集说明。
```

不分组时用 `problems: [limit-squeeze]` 代替 `groups`。两者同时填写时，题目顺序必须完全一致。一份习题集内不能重复列题，不同习题集可复用题目；跨章题单按章分别打印。

## 公式、宏与引用

行内公式使用 `$...$`，独立公式使用单独成段的 `$$...$$`；也支持 `\(...\)` 和 `\[...\]`。公共宏写入 `math/macros.tex`：

```tex
\newcommand{\RR}{\mathbb{R}}
\newcommand{\abs}[1]{\left|#1\right|}
```

支持 0–9 个固定参数，不支持可选参数、递归宏或正文中定义宏。未知数学命令会报错。

```markdown
参见 [自动文字](ref:limit-squeeze)。
参见 [极限定义](ref:sequence-limit-definition)。

$$
|a_n-a|<\varepsilon \label{eq-sequence-limit}
$$

由 [自动文字](ref:eq-sequence-limit) 可知……
```

空链接文字、`自动文字` 或 `auto` 会替换成题号、式号等标签。`#id` 也可引用全库目标。一个独立公式最多一个 `\label`；多行公式可用 `aligned` 共用编号。公式引用写在正文中，不在公式内使用 `\ref` 或 `\eqref`。

## 定理等语义块

```markdown
::: {.theorem #squeeze-theorem title="夹逼准则"}
若 $a_n\le b_n\le c_n$，且两端同趋于 $L$，则 $b_n\to L$。
:::
```

支持 `theorem`、`definition`、`proposition`、`lemma`、`corollary`、`remark`/`note`、`example`、`exercise`、`warning`、`proof`。标题按纯文本处理，公式写在正文中。

除 `proof` 不编号外，各类块共用每章一个序列，与题号、式号分别计数。顺序为章节正文、文档、题目（题干、解答、评语）、首次挂靠本章的习题集正文。网页和 PDF 共用编号，隐藏或选印内容不会重编。

需要引用的块填写 `#id`，通过 `[自动文字](ref:squeeze-theorem)` 引用。普通标题也可填写 `{#id}`；省略时自动生成锚点。不要手填保留的 `data-semantic-*` 属性。

## 图片与格式限制

图片放在课程根目录的 `assets/`，路径相对于当前 Markdown 文件：

```markdown
![极限示意图](../assets/limit-diagram.svg){#fig-limit}
```

支持 PNG、JPEG、WebP、GIF、静态 SVG。SVG、WebP、GIF 需附同名 PDF 或 PNG 供打印使用，优先 PDF；TikZ 等图形请预先导出。

支持列表、表格、脚注和代码块，不支持任意 HTML、公式外的原始 TeX、远程图片或越出课程目录的路径。SVG 不得含脚本、外部资源或动画；内容目录内不允许符号链接。

执行 `npm run check` 检查格式、引用和资源；公共宏及自动编号以引擎预览为准。
