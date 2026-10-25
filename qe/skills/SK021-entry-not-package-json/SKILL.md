---
id: SK021
title: 入口不只有 package.json
status: rule
rules: [INV-CORE-13]
defectClass: 误报 / 判据口径
provenance: 2026-10-24 外部试跑：试点 C 的「脚本无入口」报了 119 处，项目实际用发现制 harness 全量跑
question: 我说这个脚本「跑不到」，是我查过它的所有入口，还是只查了我认识的那一种入口？
---

# 入口不只有 package.json

## 血案

「在盘但无入口」在试点 C 报了 119 处，其中 64 是 `scripts/smoke-*.ts`。
项目的总闸门长这样：

```ts
// scripts/run-all-tests.ts
const all = readdirSync(scriptsDir).filter(f => /^smoke-.+\.ts$/.test(f)).filter(f => !RAW_EXCLUDE.includes(f))
```

**通配符发现制**：新增脚本不需要登记就自动入闸（这份 harness 自己的注释写着
「同一根因已复发四次，每次都靠人记得登记——纪律已证明失效」）。

于是「无 npm 别名」在这个项目里恰恰是**设计要求**，报它 119 次等于要求人去做
四次事故之后刚刚被废掉的登记动作。这是「用旧口径判新机制」的典型。

## 判据纪律

1. 「可寻址」的入口集合至少四种，判据必须逐个问过：
   ① 包管理器脚本（`package.json` scripts）② 通配符/发现制 harness（`readdir` + 正则）
   ③ CI 配置里直接 `node/tsx 路径` ④ 被其它脚本 `import` 进来当模块用。
2. 判据只认 ① 时，结论要降级成 `warn` 并**写明「只查了 package.json」**，
   不许说「跑不到」——「我没找到入口」和「没有入口」是两件事，前者是我们的事实，后者是代码的事实。
3. 发现制里的 `EXCLUDE` 清单是**必须人表态**的面，比白名单安全：
   漏登的失败模式是「跑起来当场红」，不是「静默永不运行」。判据只该盯这份清单。
4. 反过来也成立：发现制 harness 的 glob 写窄了（只扫 `smoke-*.ts`，
   漏掉 `verify-*.ts` / `*.check.ts`），那才是真缺陷 —— 判据该扫的是 glob 覆盖率，
   不是「有没有别名」。

## 反证

```
项目用别名制          → 无别名的 smoke 必须报（这是真跑不到）
项目用发现制 harness  → 同一批 smoke 必须不报（机制已覆盖）
harness 的 glob 只覆盖 smoke-  → 其余前缀的脚本必须报（glob 覆盖不足是真缺陷）
```

## 怎么问

- 这个「跑不到」的结论，我是查过几种入口之后得出的？
- 项目里有没有一个文件，靠目录扫描决定跑什么？它的 glob 我读过吗？
- 我的报告用词是「无入口」还是「未发现入口」？
