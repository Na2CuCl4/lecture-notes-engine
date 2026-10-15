---
id: nth-root-limit-inequality
title: 解法一：不等式估计
---

$\forall\varepsilon\in(0,1)$，取特定 $N\in\NN$，则

$$
n>N\implies(1+\varepsilon)^{2n}>(n\varepsilon)^2\stackrel{?}{>}n.
$$

取 $N=[\varepsilon^{-2}]+1$，则

$$
1\leq\sqrt[n]{n}<(1+\varepsilon)^2<1+3\varepsilon
\implies\dlim_{n\to+\infty}\sqrt[n]{n}=1.
$$
