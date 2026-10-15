---
id: quotient-continuity-definition
title: 用定义证明
---

由 $f$ 在 $x_0$ 处连续，$\forall\varepsilon'>0$，$\exists\delta_1>0$ 使得

$$
x\in U(x_0,\delta_1)\implies|f(x)-f(x_0)|<\varepsilon'.
$$

由 $g$ 在 $x_0$ 处连续，$\forall\varepsilon'>0$，$\exists\delta_2>0$ 使得

$$
x\in U(x_0,\delta_2)\implies|g(x)-g(x_0)|<\varepsilon'.
$$

因此

$$
|g(x)|\geq |g(x_0)|-|g(x)-g(x_0)|>|g(x_0)|-\varepsilon'
\stackrel{?}{\geq}\frac{1}{2}|g(x_0)|.
$$

取 $0<\varepsilon'\leq\frac{1}{2}|g(x_0)|$，$\delta=\min\{\delta_1,\delta_2\}>0$，则

$$
\begin{aligned}
x\in U(x_0,\delta)\implies
\left|\frac{f(x)}{g(x)}-\frac{f(x_0)}{g(x_0)}\right|
&=\left|\frac{f(x)g(x_0)-f(x_0)g(x)}{g(x)g(x_0)}\right|\\
&=\left|\frac{[f(x)-f(x_0)]g(x_0)+f(x_0)[g(x_0)-g(x)]}{g(x)g(x_0)}\right|\\
&\leq\frac{|f(x)-f(x_0)||g(x_0)|+|f(x_0)||g(x_0)-g(x)|}{|g(x)||g(x_0)|}\\
&<\frac{|g(x_0)|+|f(x_0)|}{|g(x_0)|^2}2\varepsilon'
\stackrel{?}{\leq}\varepsilon.
\end{aligned}
$$

故取

$$
\varepsilon'=\frac{1}{2}|g(x_0)|
\min\left\{1,\frac{|g(x_0)|\varepsilon}{|g(x_0)|+|f(x_0)|}\right\}.
$$

因此 $\frac{f}{g}$ 在 $x_0$ 处连续。
