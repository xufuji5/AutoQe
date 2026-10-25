# Batch Closeout · <batch id / date>

> **中文摘要**：批次收尾清单：方向裁决在册、触及面与 schema 对账、新守卫反证、三源同批、复跑读数、红项归属与未 commit 项标「排期声明」。
> 「零分歧」也必须写下这句话——没写 = 该批未收尾；附读数快照与未收尾项。

> "Zero disagreement" must still be written down — if it is missing, the batch is not closed.

- [ ] Direction adjudications recorded (fix the spec / fix the code, no fudging)
- [ ] Blast-radius vs. schema reconciliation conclusion written here (including "zero disagreement")
- [ ] New-guard counter-proof recorded (bad sample + red reading + green reading), see `bad-sample-register.md`
- [ ] New codes / new number ranges landed in the same batch across three sources (registry / spec / consumers)
- [ ] `npm run typecheck` re-run now (do not cite last round's reading)
- [ ] `npm run qe:selftest` fully green; every red item from `npm run qe` classified and assigned
- [ ] Red items from parallel batches carry an owner (do not fix them here, but state whose they are)
- [ ] Uncommitted items marked "scheduled", never "done"
- [ ] New open items registered in the ledger with a review trigger; triggers that came due are handled

## Reading snapshot / 读数快照

| Metric / 指标 | This batch / 本批读数 | Last batch / 上批读数 | Delta / 变化 |
|---|---|---|---|
| Guard counter-proof coverage | | | |
| Zero-write columns / 零写入列 | | | |
| Dead enum values / 死枚举值 | | | |
| New defects landing in old entries / 新缺陷落旧条目率 | | | |

## Open items / 未收尾项

| Item / 项 | Owner / 归属 | Closure condition / 销项条件 | Review date / 复审日期 |
|---|---|---|---|
| | | | |
