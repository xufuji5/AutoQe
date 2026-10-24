---
id: SK003
title: 异常被吞（空 catch / 只打日志）
status: rule
rules: [AQ003]
defectClass: 错误收口 / 静默失败
provenance: 试点 A catch-taxonomy 守卫 + 试点 B 多次「回滚失败被吞」事故
question: 每一个 catch，失败之后有没有人会被叫醒？
---

# 异常被吞（空 catch / 只打日志）
## 长什么样

```ts
try { await saveOrder(o) } catch (e) { }
try { await saveOrder(o) } catch (e) { console.log('failed', e) }
```

## 为什么贵

异常不会消失，它会变成**数据不一致**：写一半的订单、没回滚的库存、
没发出的退款通知。几个月后表现为「对账差 X 笔」，那时没人能定位到那个 catch。

## 怎么判（看 catch 体内最强的收口动作）

| 体内内容 | 判定 |
|---|---|
| 空 / 只有注释 | 红（high） |
| 只有 console / logger | 红（medium）—— 记录不等于处置 |
| return 兜底值、无上报 | **不报**（合法降级） |
| throw / 上报 / 回滚 | 不报 |

## 误报边界

`catch { return null }` 常是**刻意**的降级（「查不到」）。静态判据区分不了
「查不到」与「真出错」—— 那是行为探针（fault-inject）的射程，不是本条。
所以本条只抓最明确的两档，宁少不多。

## 修复形态

要么抛出带错误码的业务错误，要么上报后返回明确失败：
`reportError(e); return { ok: false, reason: 'SAVE_FAILED' }`。
