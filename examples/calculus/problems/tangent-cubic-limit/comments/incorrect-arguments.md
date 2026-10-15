---
id: tangent-cubic-limit-incorrect-arguments
title: 错解
kind: 易错点
---

**(1) 错误使用等价无穷小替换。**

$$
\dlim_{x\to 0}\frac{\tan x-x}{x^3}
=\dlim_{x\to 0}\frac{x-x+o(x)}{x^3}
=\dlim_{x\to 0}\frac{o(x)}{x^3}=\ ?
$$

**(2) 预先假设极限存在。**

$$
\begin{aligned}
L&=\dlim_{x\to 0}\frac{\tan x-x}{x^3}
=\dlim_{x\to 0}\frac{\tan 2x-2x}{(2x)^3}
=\frac{1}{4}\dlim_{x\to 0}\frac{\frac{1}{2}\tan 2x-x}{x^3}\\
4L-L&=\dlim_{x\to 0}\frac{\frac{1}{2}\tan 2x-\tan x}{x^3}
=\dlim_{x\to 0}\frac{\tan^3 x}{x^3(1-\tan^2x)}=1\\
\implies L&=\frac{1}{3}.
\end{aligned}
$$

类似 (2) 的思路，我们可以证明很多离谱的“极限”，如

$$
L=\dlim_{x\to 0}\frac{1}{x}
\implies\frac{L}{2}=\dlim_{x\to 0}\frac{1}{2x}=L
\implies L=0.
$$
