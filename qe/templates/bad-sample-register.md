# Bad-Sample Register · <INV ID / guard id>

> **中文摘要**：一条判据一个坏样本；注入必红、还原必绿，两个方向都要记录。
> 坏样本由对账方构造，禁止实现者自造（自己造数测自己的闸 = 永绿）。

> One criterion, one bad sample; it must turn red when injected and green when reverted — record both directions.
> The bad sample is **constructed by the reconciler**, never by the implementer (testing your own gate with your own data = permanently green).

| Field / 字段 | Content / 内容 |
|---|---|
| Invariant / 不变量 | INV-CORE-XX |
| Guard id / alias / 守卫 id 与别名 | invXX-... / `qe:guard:invXX` |
| Bad-sample location / 坏样本位置 | `qe/fixtures/<guard>/bad/` |
| Construction (one sentence) / 构造方式 | |
| Injected on / by / 注入日期与注入人 | |
| Red reading (errors/warnings) / 红读数 | |
| Green reading after revert / 还原后绿读数 | |
| Frozen into `--self-test`? / 是否固化进 `--self-test` | Yes / No (a "No" requires a reason) |
| Blind spots (what this criterion cannot see) / 盲区 | |

## Re-run commands / 复跑命令

```bash
npm run qe:selftest
node qe/cli.ts run --only <guardId> --root <fixtureDir>
```

## Review record / 复核记录

| Date / 日期 | Reviewer / 复核人 | Conclusion / 结论 |
|---|---|---|
| | | |
