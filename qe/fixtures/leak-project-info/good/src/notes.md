# 接入说明（示例）

配置放在仓库根的 `qe.config.json`，路径一律相对仓库根：

- schema：`prisma/schema.prisma`
- 源根：`src`、`app`
- 报告：`qe-report/qe-report.md`

凭据走环境变量，示例值写占位符：

```bash
DATABASE_URL=postgres://user:__REDACTED__@db.example.com:5432/app
API_KEY=<your-key>
```

报告里的路径都用仓库相对路径，例如 `src/app/api/records/route.ts:42`。
