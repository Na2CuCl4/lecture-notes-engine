---
id: strict-convexity
title: 二阶导数与严格凸性
tags: [高阶导数, 凸性, Rolle 定理]
sources: [微积分 A(1) 习题课讲义]
difficulty: 3
solutions: [solutions/auxiliary-function.md]
comments: []
---

设 $f$ 在区间 $(a,b)$ 内满足 $f''>0$，证明：

1. $\forall x_0\in(a,b)$，$\forall x\in(a,b)\setminus\{x_0\}$，都有

   $$
   f(x)>f(x_0)+f'(x_0)(x-x_0).
   $$

2. $\forall x_1,x_2\in(a,b)$ 且 $x_1\neq x_2$，以及 $\forall t\in(0,1)$，都有

   $$
   f((1-t)x_1+tx_2)<(1-t)f(x_1)+tf(x_2).
   \label{eq-strict-convexity}
   $$

   满足上式的函数 $f$ 称为**严格凸函数**（下凸），满足相反不等式的函数称为**严格凹函数**（上凸）。若将上式中的严格不等号改为不等号，则称为**凸函数**或**凹函数**。
