---
id: strict-convexity-auxiliary-function
title: 构造辅助函数
---

(1) 令

$$
g(x):=f(x)-f(x_0)-f'(x_0)(x-x_0),\quad x\in(a,b).
$$

求导可知

$$
\begin{aligned}
g'(x)&=f'(x)-f'(x_0),\\
g''(x)&=f''(x)>0.
\end{aligned}
$$

故 $g'$ 在 $(a,b)$ 上严格增。易见 $g'(x_0)=0$，故当 $x\in(a,x_0)$ 时 $g'(x)<0$，即 $g$ 在 $(a,x_0)$ 严格减；当 $x\in(x_0,b)$ 时 $g'(x)>0$，即 $g$ 在 $(x_0,b)$ 严格增。因此

$$
g(x)>g(x_0)=0,\quad\forall x\in(a,b)\setminus\{x_0\}.
$$

(2) 令

$$
h(t):=(1-t)f(x_1)+tf(x_2)-f((1-t)x_1+tx_2),\quad t\in[0,1].
$$

求导可知

$$
h''(t)=-f''((1-t)x_1+tx_2)(x_2-x_1)^2<0.
$$

故 $h'$ 在 $[0,1]$ 上严格减。易见 $h(0)=h(1)=0$，由 Rolle 定理可知 $\exists t_0\in(0,1)$ 使得 $h'(t_0)=0$，故 $h$ 在 $(0,t_0)$ 上严格增、在 $(t_0,1)$ 上严格减。$h(x)>\min\{h(0),h(1)\}=0$，从而

$$
f((1-t)x_1+tx_2)<(1-t)f(x_1)+tf(x_2),\quad\forall t\in(0,1).
$$
