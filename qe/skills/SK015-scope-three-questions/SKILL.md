---
id: SK015
title: 作用域三问（谁制造数据 / 谁展示 / 谁判定）
status: rule
rules: [AQ002, AQ004]
defectClass: 判据失效 / 作用域过宽
provenance: 2026-10-24 首轮外部试跑：AQ002 478→268、AQ004 55→5，两处都是「把不是判定的代码当成判定」
question: 这段代码是在制造状态、展示状态，还是在判定状态？
---

# 作用域三问

## 血案一：把「制造状态」的地方当成了「旁路状态」

AQ002 在 试点 B 报 478 处，其中约 30 处来自 `scripts/e2e-*.mjs`。
e2e 脚本的工作就是**造出**各种状态（`status: 'PAID'`），它本来就该裸写值。
判它「破坏了状态机单源」是把测试工具当成了被测对象。

## 血案二：把「展示状态」当成了「转移判定」

另约 80 处来自 `app/**/page.tsx`：

```tsx
const cls = batch.status === 'DONE' ? 'tl' : 'bpr'
const done = items.filter((m) => m.status === 'COMPLETED').length
```

这是渲染。规则问的问题是「改一次转移规则要 grep 多少处」——渲染层不是转移规则。
拉回来可以（`includeUi: true`），但默认不拉：噪声会淹掉 `lib/**` 里真正的转移判定。

## 血案三：把「查过又建过」当成了竞态

AQ004 初版只要求「同一模型 find 过、40 行内 create 过」，在 试点 B 报 55 处：

```ts
const prev = await prisma.processStep.findFirst({ where: { stepNo: stepNo - 1 } })
return prisma.processStep.create({ data: { stepNo } })   // 建的是「下一个」工序
```

查到的结果**根本没参与决策**。竞态的必要条件是「判空结果驱动了写入」，
所以判据必须抓到被赋值的变量名，并要求出现 `if (<var>)` / `if (!<var>)`。
收紧后 55 → 5，剩下的 5 处全是「查到没有 → 就建一个」的真形态。

## 三问（写规则前先过一遍）

1. **谁制造数据？** 种子/夹具/e2e/mock —— 排除。
2. **谁展示数据？** 页面/组件/文案映射 —— 降级或排除。
3. **谁做判定？** 服务层/状态机/领域函数 —— **这才是射程**。

## 通用修法：让作用域成为**声明的选项**，不是隐藏的逻辑

```
includeUi: false        // 展示层默认排除，可显式拉回
exclude: e2e/__tests__/fixtures/mocks/seeds
```

写成选项而不是「代码里偷偷 skip」，因为跳过必须是**可见的**（见 SK013）。
