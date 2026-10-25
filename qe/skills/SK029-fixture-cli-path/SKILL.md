---
id: SK029
title: 夹具取 CLI 路径（写死依赖目录 / argv[1] 当解释器）
status: rule
rules: [AQ011]
defectClass: 隐性陷阱 / 探针结论缺失
provenance: 试点 C（2026-10）：同一批内两次栽在夹具取运行时 CLI 上——先写死 node_modules 绝对路径（worktree 里零输出被读成被测代码抛穿），修法第一版又假设 argv[1] 是运行时 CLI
question: 这个可执行文件在干净 checkout 里存在吗？不存在时子进程会输出什么、而我会把它读成什么？
---

# 夹具取 CLI 路径

## 真实形态

```ts
const cli = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs')
spawnSync(process.execPath, [cli, 'probe.ts'])
```

开发机一直正常（`node_modules` 就在那儿）。到了**干净 checkout**（`git worktree add --detach`、
CI 浅克隆、别人的机器）那个目录不存在，子进程立刻失败、**零输出**。上游把「零输出」
读成「被测代码抛穿了」——**探针结论缺失被当成被测对象有缺陷，方向完全反了**。

第二次栽在同一个假设的变体上：以为 `process.argv[1]` 是运行时 CLI。它其实是**脚本**路径
（运行时会把入口文件重写进去），把它放在命令位等于把入口文件当解释器启动。

## 为什么这类缺陷特别贵

它不是「测试没覆盖到」，是**测试给了错答案**。零输出、空 stderr、退出码非 0，
在「被测代码炸了」和「探针根本没跑起来」之间没有任何区分度。而人会相信那个结论，
然后去修一段本来没问题的代码。

## 修法

- 路径**从仓库根向上逐级找**：worktree 形状下 `node_modules` 常在更上层；
- **找不到就抛**，带一句「依赖未安装」的明确错误——宁可让夹具响亮地失败，
  也不要让它安静地零输出；
- 运行时用 `process.execPath`；CLI 用 `require.resolve(...)` 或显式解析结果；
- `argv[1]` 可以当**参数**（`npx tsx argv[1]` 是跑自己的正确写法），不能当**命令**。

## 自省

- 我在哪个目录下跑过它？换到 `git worktree` 里跑过吗？
- 子进程零输出时，我的解读是「被测代码有问题」还是「探针没跑起来」？我凭什么区分？
- 这个路径是运行时给的，还是我猜的？
