---
id: SK009
title: 三投影：磁盘 / 索引 / HEAD
status: manual
rules: []
defectClass: 判据看错树 / 发版遗漏
provenance: 试点 A commit-readiness（迁移写了没 add、索引漏文件）+ 多次「本机绿、干净检出红」
question: 这次「绿了」，是对磁盘、索引还是 HEAD 绿的？
---

# 三投影：磁盘 / 索引 / HEAD
## 三个投影

| 投影 | 谁在看 | 典型事故 |
|---|---|---|
| 磁盘 | tsc / 全部 smoke / 静态扫描 | 迁移写了存盘但没 add |
| 索引 | `git commit` 实际提交的 | add 了忘 commit，别人拉下来红 |
| HEAD | 干净检出（发版前唯一必须成立） | registry 改了但总表没跟上 |

## 怎么问

1. 这道门禁读的是哪个树？
2. 发版前的最后一道，是否在**干净检出**上跑过？（`git worktree add --detach HEAD`）
3. 改动里有没有「新增文件」？新增文件最容易漏索引。

## 为什么不能只靠人记得

「工作树绿 ≠ HEAD 绿」不是知识问题，是**投影问题**。靠人记得等于没有机制。
本项目已在 `engine/head-consistency.ts` 提供三投影读取，接进门禁后才算落实。
