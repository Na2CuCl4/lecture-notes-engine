# 演示内容来源与转换记录

记录日期：2026-10-15。演示内容位于 `examples/calculus/`；只读提取自 `E:\Projects\Website\calculus-i`，未改动历史仓库，也未迁移 `advanced-calculus-i` 的正式章节。

本次为格式转换和引擎验收样例，不是整章迁移或数学审校。章节名、题目标题、标签、习题集编排与难度是演示元数据；有难度的题目均为示例初评，不能作为正式教学难度标准。`tangent-one-bound` 使用 `null` 表示未标定难度，并保留原稿无解答的状态。

## 原文位置

下表路径相对于历史仓库根目录，行号来自本次只读查看的工作区文件。

| 内容 ID | 原文件与行号 | 转换范围 |
| --- | --- | --- |
| `number-systems` | `chapter/chapter1.tex:47–74` | 数系扩张与完备性段落；定理环境改为 Markdown 语义块，脚注保留，新增两级阅读标题 |
| `fig-number-system` | `figure/1-1.png`，原引用 `chapter/chapter1.tex:51–56` | 原图按字节复制到 `assets/number-system.png`，已实际查看 |
| `differentiation-review` | `chapter/chapter5.tex:134–176` | 导数与微分概念、应用及注；公式保持数学内容，增加稳定锚点 |
| `quotient-continuity` | `chapter/chapter2.tex:27–53` | 题干与完整原证明；保留原稿用于推导参数选择的问号不等式 |
| `nth-root-limit` | `chapter/chapter2.tex:520–534` | 题干与原解法一、二，拆成两个独立解答文件；未选录依赖另一例题的原解法三（536–538 行） |
| `numerical-cancellation` | `chapter/chapter2.tex:556–564` | 题干与原解答；标题刻意为空以验证无标题题目的显示 |
| `tangent-cubic-limit` | `chapter/chapter4.tex:857–884` | 题干、原“错解”评注及首种展开式解法；未选录 885–900 行的第二种推导 |
| `composition-second-derivative` | `chapter/chapter5.tex:566–577` | 题干与完整解答 |
| `strict-convexity` | `chapter/chapter5.tex:589–625` | 题干与完整证明；原文标签 `ex:5.3.9` 映射为题目 ID |
| `tangent-one-bound` | `chapter/chapter6.tex:808–810` | 原稿只有题干，没有解答，本样例同样不附解答 |
| 公共数学宏 | `mathcmd.tex:2–24` | 选录本样例使用的数学简写，未带入 `\qed` 等布局命令 |

章节 `limits`、`derivatives` 与习题集 `limits-tutorial`、`derivatives-tutorial`、`mixed-review` 是本次新建的演示组织关系，不声称与历史讲义的课次和原题号一一对应。

## 有意作出的格式调整

- `equation` 转成 `$$` 数学块；保留 `aligned`、`cases` 等数学环境；常规空格、标点、分式花括号只作排版整理。
- `note`、`theorem` 转成 Markdown 语义块，段落与列表保持原有内容；LaTeX 浮动布局不迁移。
- 图片使用相对路径，所有实体用稳定 ID，原稿的展示编号不作为实体 ID。
- `differentiation-review` 末尾新增的“阅读导航”已明示为演示新增文本，用于验证同页公式引用和跨章题目引用。习题集说明也是演示编排文本。
- `macros.tex` 中 `\renewcommand{\hat}[1]{\widehat{#1}}` 是兼容性样例配置，非原稿数学改写；原图和公式中的字符没有据此重写。
- 首种正切极限解法中的 `\frac{x^3}6{+o(x^3)-...}` 改为等义的 `\frac{x^3}{6}+o(x^3)-...`，只规整原 LaTeX 花括号。

## 保留的原稿疑点

在 `chapter/chapter5.tex:622`，辅助函数定义为 `h(t)`，随后正文写 `h(x)>...`。样例按原文保留 `h(x)`，没有擅自校改。正式迁移与数学审校时应另行确认该处变量笔误。

这些样例仅覆盖选录的内容及格式，不意味着旧讲义整体已经迁移或完成数学复核。
