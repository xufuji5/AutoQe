# 夹具：schema.path 落在被 git 忽略的路径上（INV-META-03 反证）

`.gitignore` 声明忽略 `ignored-target/`，而配置里的 `schema.path` 偏偏指向
`ignored-target/schema.prisma`：开发机上文件存在（守卫绿），干净检出时文件不存在（CI 红），
或更糟——扫空集恒真、两边都绿。本守卫必须报 ASSERT_ON_IGNORED。

## 提交纪律（重要）

`ignored-target/schema.prisma` 被 `.gitignore` 命中，普通 `git add` 加不进去，
必须 `git add -f qe/fixtures/inv24-assert-target/bad-ignored/ignored-target/schema.prisma`。
这正是本不变量管的形态：被忽略的断言对象连提交都要靠强制——它就不该当判据对象。
