---
id: tangent-cubic-limit-taylor
title: 用展开式计算
---

$$
\begin{aligned}
\frac{\tan x-x}{x^3}
&=\frac{\sin x-x\cos x}{x^3\cos x}\\
&=\frac{x-\frac{x^3}{6}+o(x^3)-x\left(1-\frac{x^2}{2}+o(x^2)\right)}{x^3(1+o(1))}\\
&=\frac{\frac{x^3}{3}+o(x^3)}{x^3(1+o(1))}
=\frac{1}{3}+o(1)\to\frac{1}{3},\quad x\to 0.
\end{aligned}
$$
