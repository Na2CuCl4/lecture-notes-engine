---
id: differentiation-review
title: 导数与微分的概念
tags: [知识点复习, 导数, 微分]
---

## 重要概念回顾 {#differentiation-definitions}

内点、开集、线性函数。

**可微**：设 $a$ 是集合 $I\subseteq\RR$ 的内点，称 $f:I\to\RR$ 在 $a$ 处可微，若存在常数 $A$ 使得

$$
f(a+h)=f(a)+Ah+o(h),\quad h\to 0.
\label{eq-differentiability}
$$

此时称以 $A$ 为系数的线性函数 $h\mapsto Ah$ 为 $f$ 在 $a$ 处的微分，记为

$$
\dd f(a):\RR\to\RR,\quad\dd f(a)(h)=Ah.
$$

**可导**：（接可微）易见

$$
A=\lim_{x\to a}\frac{f(x)-f(a)}{x-a}
=\lim_{h\to 0}\frac{f(a+h)-f(a)}{h}.
\label{eq-derivative-definition}
$$

称上式等号右侧的极限为 $f$ 在 $a$ 处的导数，记为 $f'(a)=\frac{\dd f}{\dd x}(a)$。所以

$$
\dd f(a)(h)=f'(a)h.
$$

**导函数**：若 $f$ 在任意 $x\in I$ 处都可微，则称 $f$ 在 $I$ 上可微，此时称 $f':I\to\RR$ 为 $f$ 在 $I$ 上的导函数。

## 重要定理回顾 {#differentiation-continuity}

::: {.theorem}
若 $f$ 在 $a$ 可微，则 $f(x)-f(a)=\oO(x-a)$，$x\to a$，从而 $f$ 在 $a$ 处连续。
:::

## 应用 {#differentiation-applications}

1. 任何线性函数 $L(x)=\lambda x$ 是可微的，且有 $\dd L(a)=L$。用传统符号表示为 $\dd(\lambda x)=\lambda\dd x$。
2. $f(x)=x^2$ 的微分是 $\dd(x^2)=2x\dd x$。
3. $f(x)=\frac{1}{x}$ 的微分是 $\dd\left(\frac{1}{x}\right)=-\frac{1}{x^2}\dd x$。
4. $f(x)=\ee^x$ 的微分是 $\dd(\ee^x)=\ee^x\dd x$。
5. $f(x)=\sin x$ 的微分是 $\dd(\sin x)=\cos x\dd x$，$f(x)=\cos x$ 的微分是 $\dd(\cos x)=-\sin x\dd x$。
6. $f(x)=\sqrt[3]{x}$ 在 $x=0$ 处连续，但不可微。

## 注 {#differentiation-notes}

1. **微分的几何意义**：上述定义表明，若 $f$ 在 $a$ 处可微，则在 $a$ 附近 $f$ 可以近似写为 $f(a)+f'(a)(x-a)$，即 $f$ 在 $a$ 处的图像在 $a$ 点的切线附近可以近似看作一条直线。
2. **微分的符号表达**：定义坐标映射函数 $\dd x(x_0):\RR\to\RR$，$\dd x(x_0)(h)=h$，则有 $\dd f(x_0)(h)=f'(x_0)\dd x(x_0)(h)$。所以作为函数，$\dd f(x)=f'(x)\dd x$。
3. 绝大多数作者在定义可微和导数时，要求 $a$ 是定义域内点；但也不尽然，比如 Terence Tao 在 *Analysis I* 4th edition 中仅要求 $a\in I$ 是 $I$ 的聚点。

::: {.note}
阅读导航：可以回看[导数定义](ref:eq-derivative-definition)，并与上一章的[连续函数的商](ref:quotient-continuity)对照。本段导航为演示内容新增。
:::
