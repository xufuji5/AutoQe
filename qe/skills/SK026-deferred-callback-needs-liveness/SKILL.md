---
id: SK026
title: 回调跑起来的时候，接收方还活着吗、还准备好了吗
status: rule
rules: [MP001, MP003, MP007]
defectClass: 生命周期 / 时序
provenance: 2026-10-24 试点 B：线上崩溃 `__subPageFrameEndTime__` of null 定位到「清了定时器但回调仍写视图」；同仓自查又发现自定义组件在 attached 里同步 setData
question: 这个回调在未来某个时刻执行时，它要写的那个对象还在吗、还处于能接收更新的阶段吗？
---

# 回调跑起来的时候，接收方还活着吗、还准备好了吗

## 血案

线上崩溃的栈底只有一行线索：

```
TypeError: Cannot read property '__subPageFrameEndTime__' of null
  at <setInterval callback function>
```

`__subPageFrameEndTime__` 是宿主记在**页面帧**上的内部字段。页面销毁、帧记录置 null 之后，
仍有一段业务回调在跑并写视图，宿主去查这一帧就拿到 null。

最扎人的是：出事的那批定时器**全都写了清理**。

```js
onLoad() {
  this.timer = setInterval(() => this.setData({ now: Date.now() }), 1000)
},
onUnload() {
  clearInterval(this.timer)   // 看起来已经很谨慎了
},
```

`clearInterval` 只能取消**尚未触发**的后续轮次。**已经进入事件队列的那一次回调照跑**，
而它完全可能排在卸载之后（用户点返回、或跳转跳走的同一个 tick）。
排查思路因此会走进死胡同：静态搜「有没有 clearInterval」是**恒绿**的，因为全都清了。

同源的另一种形态在**起点**而不是终点：组件 `attached` 在首渲染之前执行，
在那里同步 `setData`，视图层还没准备好接收更新：

```
webviewScriptError: Expected updated data but get first rendering data
```

它真机必现、开发者工具常被吞掉，于是活到线上，表现为组件首屏字段恒为初始值或整块白掉。

## 判据纪律

1. **「我取消了」与「它不会跑」是两件事。** 取消只作用于未来的调度，
   已在队列里的那一个已经无法收回。凡是异步回调用到「调用点之外的对象」，
   回调内必须有一次**存活判定**（`if (!this.alive) return`），而不是只在出口清理。
2. **清理挂在出口，判定挂在入口。** 只写 `onUnload` 清理 = 只做了一半；
   两个入口都要有，缺哪个都会漏。
3. **起点也有时序。** 「对象已死」和「对象还没活」是同一个 bug 的两端：
   首渲染前写视图、数据注入前写视图，都属于「接收方还没准备好」。
4. **静态判据只能判「有没有判定」，判不了「判定得对不对」。**
   `mp01` 认 `if (!this.<flag>) return` 这一种短路形态；别的写法（`if (state.dead)`、
   封装成 `isAlive(this)`）会漏。漏报写进盲区，不许算成「已检查」。
5. **写视图的接收者不一定叫 `this`。** `const that = this` 是小程序里的主流写法
   （ES5 风格、`wx.request` 回调、老页面迁移）。只认字面 `this` 的判据在这类页面上是全绿的
   ——实测过：同一份代码只把接收者换成别名，读数从 1 变 0。
   凡是「认 `this`」的判据，都要先问「这个 `this` 会不会被存到别名里」。
   认了别名之后，**存活短路也必须认别名**，否则「别名 + 正确存活判定」会被判红。
6. **别用「深度 0」判断「是不是同步执行」。** 块（`if (x) { … }`）与函数体（`{ … }`）
   在括号深度上不可区分，而前者是同步的、后者不是。要按**语句边界 + 回调标记**判断。

## 反证

```
setInterval(() => this.setData(…))              有 clearInterval，仍必须报
setInterval(function () { that.setData(…) })    that = this，仍必须报
attached() { that.setData(…) }                  that = this，仍必须报
attached() { this.setData(…) }                   必须报
attached() { wx.nextTick(() => this.setData(…)) } 不该报（延后到首渲染后）
setInterval(() => { if (!this.alive) return; … }) 不该报（有存活判定）
setInterval(() => { if (!that.alive) return; … }) 不该报（别名 + 存活判定）
回调只改实例字段（不写视图）                       不该报（没有接收方）
```

## 怎么问

- 这个回调最早可能在什么时刻执行？最晚呢？在这个区间里，它写的东西还活着吗？
- 除了「用户正常退出」，还有哪些路径会让它死在回调之前（跳转、重进同一路由、热重载）？
- 这段代码在 `onUnload` 之后跑，会报错还是会静默写进一个已废弃的对象？两种都要查。

## 第二种出口：等待的不一定是时钟

同一个病根（有一段时间差，且在差里假设对象还活着），出口还有**网络与 Promise**：
`wx.request` 的 `success`、`.then()` 回调、`await` 恢复点之后的那一句。

弱网下这是常态：用户等不及点返回，请求 3 秒后才回来，回调照常 `setData`、甚至照常 `navigateTo`
（把用户从**别的**页面拽走）。判据是 `MP007`，级别是 **warn**：
静态能确定「这里没有判定」，确定不了「这次会炸」——停留 10 秒的列表页几乎不出事，
0.5 秒就返回的确认页必出事。报成 error 会把大量正确代码判红，那是把判据变成噪音源。
