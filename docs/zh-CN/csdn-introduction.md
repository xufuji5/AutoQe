# 当 AI 成了主力程序员，质量该怎么管？我开源了 AutoQe：63 条不变量、48 个守卫、602 个坏样本自证的零侵入质量工程

> 项目地址：
> - **GitHub**：https://github.com/xufuji5/AutoQe （Star / Issue / PR 欢迎）
> - **Gitee**：https://gitee.com/xuukai/auto-qe （国内镜像，同步推送）
> - 协议：MIT · Node.js ≥ 22.18 · 纯 TypeScript · 零运行时依赖（仅 typescript）

---

## 一、你可能遇到过这样的场景

AI 写代码的速度，已经超过了人审代码的速度。

两三个月，一个中等规模业务系统就能堆出几十个路由、上百个 server action、几百个字段。功能能跑，演示没问题，测试也绿。但上线之后，问题以另一种方式出现：

- 某个字段全库没人写，界面一直在读，永远显示空值；
- 某个枚举值定义了、类型也通过了，但没有任何一条路径能产生它；
- 接口文档写着「必须传幂等键」，代码里没有一处校验；
- 两个模块各自实现了一遍同一件事，改了一边，另一边悄悄过期；
- `as any` 加了十几处，TypeScript 退化成 AnyScript；
- 某个 React Hook 被塞进了 `if` 块，上线后间歇性 state 错乱；
- `eval(userInput)` 在模板引擎里藏着，测试跑了 300 条没一条能抓到；
- innerHTML 直接赋值，安全团队扫了半年才发现。

这些问题有个共同点：**它们不会报错，只会静默地错**。因为缺陷不在某一条路径上，而在「结构」里。测试是枚举，AI 的缺陷是结构性的——枚举永远追不上结构。

## 二、所以我做了 AutoQe：不变量优先

> **质量 = 约束密度。不变量 > 用例。**
>
> 用例问「这条路径对不对」，不变量问「这件事是否恒成立」。

AutoQe 不是一个 linter、不是一个测试框架、不是一个业务脚手架。它是一套**面向 AI 辅助开发的结构性缺陷扫描器**：

- 它不跑测试（让测试继续做它的事）；
- 它只扫那些**测试永远枚举不到、也永远不会报错**的结构性缺陷；
- 每条规则都是机器可判的约束，有状态、有盲 spot、有审查日期；
- 棘轮基线只准下降，回归直接让 CI 失败。

### 当前能力规模

| 指标 | 数值 |
|------|------|
| 不变量 | **63 条**（22 enforced / 38 partial / 3 open） |
| 自动守卫 | **48 个**（15 INV + 22 AQ + 8 MP + spec/leak/isolation） |
| 纯函数规则 | **27 条** |
| 事故知识库 | **43 条**（每条都追到一次真实事故） |
| 坏样本自证 | **602 个**（必须先红后绿） |
| 安全/类型新规则 | **4 条**（从外部安全扫描器通用化抽取） |

## 三、覆盖哪些缺陷领域

| 领域 | 典型缺陷 | 规则 |
|------|----------|------|
| **数据与结构** | 零写列、零读列、死枚举、软删表漏谓词 | inv01–inv03, inv25 |
| **服务端边界** | 入口无鉴权/校验/幂等键、公开路由无理由、变异端点无限流 | inv20, aq01, aq06, inv28 |
| **接缝与前端状态** | 客户端导入 Prisma/Node、敏感字段被持久化、接口无 UI 发送点、生产代码 import 了 mock | inv21, inv22, inv23, aq12 |
| **并发与一致性** | check-then-act、漏租户谓词、IDOR、幂等键缺失、读形状错误、事务内冲突兜底 | aq04, aq05, aq08–aq10, aq14 |
| **安全边界（新增）** | eval / new Function / 字符串形式计时器、innerHTML 未紧邻 sanitize | **aq41, aq42** |
| **类型与 UI 正确性（新增）** | `as any` / `: any` 密度过高、React Hook 在 if/for/while 内调用 | **aq43, aq44** |
| **假绿** | 永不失败的断言、状态字面值、吞错误、硬编码数据 | aq02, aq03, aq07, aq13 |
| **幽灵规则与空转闸** | 文档承诺无执行点、闸未登记、守卫未注册、规格缺 oracle | inv06, inv07, inv13, inv24, spec-abs |
| **交付健康** | HEAD 干净检出不可构建、工具路径依赖 CWD | inv27, aq11 |
| **泄漏与隔离** | 本机路径/凭据/项目代号入库、commit 消息含泄漏、项目状态混进引擎 | leak, iso01 |
| **小程序域** | 页面死亡后 timer 还在跑、样式未隔离、setData 在首渲染前、栈底 back 无兜底 | mp01–mp08 |

## 四、一个必须写在最前面的原则

这个项目踩过一次大坑，所以我把它升级成了「宪法级」规则——写在所有协议的最前面，用自动守卫强制执行：

> **AutoQe 是开源、中立、普适的质量工程引擎。它永不携带任何被扫描项目的特定信息。**

- ❌ 项目代号（skinlab、试点 A/B）
- ❌ 真实文件路径（app/merchant/layout.tsx、catalog.ts:499）
- ❌ 真实表名/列名（msg_unread、ingredientsRaw）
- ❌ 行业绑定术语（支付处理、合作关联、后台操作、合规机构）
- ❌ 内部审计读数（619 条、472 错误码）
- ❌ 任何能反查到具体仓库或公司的坐标

**每次从 [项目 A] 扫出新缺陷模式 → 抽象成通用规则 → 删掉所有属于 [项目 A] 自己的事实 → 入库。**

`leak-project-info` 守卫必须对本仓跑绿（errors=0）才能合并。AGENTS.md 里的示例词、README 里的例子、甚至代码注释——全部都要通过这道检查。之前有一次我在宪法文档里写了「如支付处理、合作关联」当反面例子，**leak 守卫当场把文档自己报红了**。

## 五、零侵入工作流

AutoQe 引擎仓和被扫描项目是**两个独立的 git 仓库**，互不侵入：

```
D:\AutoQe_workplace          ← 引擎（本仓）
  ├── qe/                    ← 规则、守卫、注册表
  ├── AGENTS.md              ← 协作协议 + 宪法
  └── README.md

D:\某个项目\                  ← 被扫描项目（零改动）

D:\扫描结果\某个项目\          ← 配置 + 结果（引擎仓外、被扫描仓外）
  ├── qe.config.json         ← 唯一的配置文件
  ├── qe.project.json        ← 引擎自动生成的身份文件
  ├── qe/ratchet.json        ← 基线
  ├── qe/waivers.json        ← 已登记的误报豁免
  ├── qe-report/qe-report.md ← 扫描报告
  └── qe-audit/<批次>/       ← 审计批次
```

```bash
# 引擎放在任意目录，不需要复制进被扫描项目
git clone https://github.com/xufuji5/AutoQe.git
cd AutoQe && npm install    # 唯一依赖：typescript

# 第一次体验：跑本仓自证
npm run qe:selftest          # 602 个坏样本自证
npm run qe:ci                # 完整门禁：typecheck → leak guard → invariants → 报告

# 给任意项目做零侵入体检
node qe/cli.ts run --root D:\某个项目 --config D:\扫描结果\某个项目\qe.config.json
# 结果自动落在 config 旁边
```

## 六、真实输出读数（本仓当前）

```text
SELFTEST_RESULT cases=602 passed=602 failed=0 status=green
QE_RESULT guards=48 errors=0 warnings=4 skipped=24 status=yellow
  leak-project-info: errors=0 warnings=1 ✅ 宪法守卫通过
RATCHET status=ok regressions=0 improvements=0 unverified=0 tracked=19 new=0
INV-META invariants=63 enforced=22 partial=38 open=3
```

## 七、三个关键设计哲学

### 1. 坏样本先红后绿，AI 自测不采信
每个守卫上线第一天必须能在独立构造的坏样本上失败。`npm run qe:selftest` 同时检查两件事：坏样本必须红，好样本必须绿。假红和假绿同罪。

### 2. 棘轮只降不升，修过的 bug 不许回来
`qe/ratchet.json` 记录每类缺陷计数基线。数量上升 = CI 失败（exit 1）。新增违规永远不许塞进基线。

### 3. 看不到就 skipped，绝不假绿
schema 适配器或源码收集器配置为 `none` 时，相关守卫输出 `skipped`（黄色），绝不报 0 问题。跳过是诚实，不是成功。

## 八、适用场景

- 用 AI 大量写业务代码，苦于「修完又犯」的团队；
- 技术栈 Next.js + Prisma + PostgreSQL + Zustand 的前后端项目；
- 需要在两周内给存量系统做上线前体检的技术负责人；
- 想给团队建立「先立约束、再写业务」协作协议的小团队；
- 安全团队，想快速扫描 XSS/eval/Hook 违规等基础安全边界。

## 九、一起共建

MIT 协议，复制、修改、商用都可以。

如果这套思路对你有用，欢迎点个 Star，或者提 Issue 说说你遇到的「静默出错」场景——新增一条不变量，往往比新增一百条用例更有价值。

---

**GitHub**：https://github.com/xufuji5/AutoQe
**Gitee**：https://gitee.com/xuukai/auto-qe
文档入口：`QE-00-index.md` · 协作协议：`AGENTS.md` · 许可证：MIT
