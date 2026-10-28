/**
 * 判据的 oracle 单源登记（「你的 oracle 是谁」的机器答案）。
 *
 * 为什么必须存在：一条判据红了，人要去改代码；如果那条判据的真值本身是猜的，
 * 人就是在为「凭空发明的尺子」改代码——这比不扫更贵，因为它会把人带偏。
 * 因此本仓库的硬纪律是：
 *   - `qe/rules/` 里的每条规则**必须**在此登记；没有条目，`toGuard` 在导入期直接抛错，
 *     规则连跑都跑不起来（不许先上车后补票）；
 *   - `kind: 'machine'` 才允许出 error：真值是可复现的机器事实（schema、AST、文件存在性、
 *     字符串语义），谁都能用同样的输入复算出同一个结论；
 *   - `kind: 'human'` 一律只出 warn / info：真值在文档、业务意图或运行环境里，机器只能出候选，
 *     且必须写 `why`（为什么现在只能出候选）与 `promoteBy`（到期未升级即红，
 *     禁止候选池变成永久噪声）；
 *   - `guardedBy` 是「谁守这个 oracle 载体」：只写 registry 里的不变量 id。`human` 档必填，
 *     且必须指向 `enforced` 的不变量——载体自己没人守，就没有资格评价别人。
 *
 * 纪律的机器执行者：`scripts/verify-rule-oracles.ts`（8 条坏样本先红后绿）。
 * 本文件只放声明，不放判据逻辑——第二份真相的下一站是两份答案。
 */

export type RuleTier = 'machine' | 'human'

export interface RuleOracle {
  /**
   * 真值从哪来。必须写成「换个人也能复算」的事实来源，
   * 不接受「经验」「惯例」「一般来说」这类不可复现的表述。
   */
  source: string
  /** machine = 可复算的机器事实（允许 error）；human = 判断/环境（只允许 warn/info） */
  kind: RuleTier
  /** 守这个 oracle 载体的不变量 id（registry 单源）；human 档必填且必须 enforced */
  guardedBy: string[]
  /** human 档的升级期限（ISO 日期）；到期未升级 = 红。machine 档不填 */
  promoteBy?: string
  /** human 档必填：为什么现在只能出候选（缺哪块事实 / 谁来裁决） */
  why?: string
}

export const RULE_ORACLES: Record<string, RuleOracle> = {
  /* ---------- AQ001–AQ011：全部是 machine oracle ---------- */
  aq01: {
    source: '`request.json()` 对不可解析请求体的抛错语义（框架保证），加上 AST 里该调用的实参位置',
    kind: 'machine',
    guardedBy: [],
  },
  aq02: {
    source: 'schema 的 enum 取值清单 × 全仓字面量出现位置：状态判据只允许一份定义',
    kind: 'machine',
    guardedBy: ['INV-CORE-04'],
  },
  aq03: {
    source: 'catch 子句体内最强的动作（抛错/回声/留证），由 AST 边界决定，不依赖命名约定',
    kind: 'machine',
    guardedBy: [],
  },
  aq04: {
    source: '同文件内「先查 → 判空 → 建」的语句顺序 × schema 的 @@unique/@unique 清单',
    kind: 'machine',
    guardedBy: ['INV-DB-02'],
  },
  aq05: {
    source: 'schema 的列清单（含租户收敛列）× 手写 SQL 模板串里的 WHERE 结构',
    kind: 'machine',
    guardedBy: ['INV-CORE-08'],
  },
  aq06: {
    source: '导出函数的 AST 结构（使令动词 + 受保护对象），不靠函数名白名单',
    kind: 'machine',
    guardedBy: [],
  },
  aq07: {
    source: '断言的实参位置 × 该位置是否为字面真值/空集合；反向样本证明它确实会红',
    kind: 'machine',
    guardedBy: [],
  },
  aq08: {
    source: '按 id 读取的 AST 赋值回溯：id 是否来自请求参数 × 查询是否带归属谓词',
    kind: 'machine',
    guardedBy: [],
  },
  aq09: {
    source: 'schema 的唯一键覆盖 × 写入调用的 data 对象字面量字段',
    kind: 'machine',
    guardedBy: ['INV-DB-03'],
  },
  aq10: {
    source: 'SQL SELECT 列表每项的**输出列名**（PG 无别名聚合列的命名规则），由字符串语义复算',
    kind: 'machine',
    guardedBy: ['INV-CORE-19'],
  },
  aq11: {
    source: '工具路径的出现位置 × 该路径是否以仓库根/环境变量为基准（路径形态可复算）',
    kind: 'machine',
    guardedBy: ['INV-CORE-20'],
  },

  /* ---------- AQ012–AQ013：残留族（生产化卫生） ---------- */
  aq12: {
    source: '源码 import/require 图的静态闭包：非测试文件是否可达 mock/seed/fixture 模块，或该入口是否只被 NODE_ENV 门控',
    kind: 'machine',
    guardedBy: ['INV-RES-01'],
  },
  aq13: {
    source: '页面/组件文件内以对象字面量数组作为渲染数据源的形状（≥3 个结构相同的对象项、且未经过任何取数调用）',
    kind: 'human',
    guardedBy: ['INV-META-05'],
    promoteBy: '2027-03-31',
    why:
      '「这段数组是占位数据还是合法常量」在源码里长得一样：空状态文案表、枚举显示名、演示开关都可能长得像数据源。' +
      '机器只能出候选，由人按「该页面是否已有真实取数入口」裁决；裁决结果必须落 waivers.json（理由 + 复审日期），' +
      '载体由 INV-META-05 守。',
  },

  aq14: {
    source:
      'PostgreSQL 的事务语义（语句级错误后事务进入 aborted 状态，后续语句报 25P02）× AST 里 `$transaction` 回调区间与 catch 块的**包含关系**：' +
      'catch 落在回调区间内 ∧ （体内再用事务句柄 ∨ 体内在处理唯一冲突而不只是重抛）',
    kind: 'machine',
    guardedBy: ['INV-DB-04'],
  },

  /* ---------- AQ016–AQ018：假闸门 / 假出网 / 假数据兜底 ---------- */
  aq16: {
    source:
      '函数声明的语法形态：函数名动词前缀 × 形参清单 × 函数体首个有效语句是否为字面量 true 或 `{ ok: true }` × ' +
      '函数体是否出现任何一个形参名（四项都由源码直接复算，不需要理解业务）',
    kind: 'machine',
    guardedBy: ['INV-RES-04'],
  },
  aq17: {
    source:
      '脚本文件的静态 import 说明符（是否引入强制 mock 环境模块）× 出网调用点第一实参的字符串字面量' +
      '（绝对 http(s) 且主机非本机 = external，变量/模板 = unknown，相对地址与本机主机 = local）',
    kind: 'machine',
    guardedBy: ['INV-RES-03'],
  },
  aq18: {
    source:
      'if 判定条件文本是否命中 dev 门控词表 × 分支体（含 catch 体）内 return 的常量数据字面量：' +
      '数组元素数 / 单条记录字段数 / 对象键数与数据字段都可直接计数',
    kind: 'machine',
    guardedBy: ['INV-RES-05'],
  },

  /* ---------- AQ019–AQ022：门禁输入 / 平台保活 / 共用解析层 ---------- */
  aq19: {
    source:
      'middleware/proxy 文件里 `matcher: [...]` 数组的字面量条目 × 扩展名分组前那个点的**源码前一个字符**是否为反斜杠' +
      '（字符事实，换个人用同样的源码复算结论相同）',
    kind: 'machine',
    guardedBy: ['INV-SEC-04'],
  },
  aq20: {
    source:
      '名字含独立 `ip` 词元的函数体 × 客户端可控头读取位置 × 函数体内是否出现传输层地址/可信代理声明/' +
      '两源一致性比较（三类证据都由源码词法直接复算）',
    kind: 'machine',
    guardedBy: ['INV-SEC-05'],
  },
  aq21: {
    source:
      '文件的 Edge/Serverless 能力证据（runtime=edge / ExecutionContext / waitUntil）× `.catch` 实参是否为空处理 × ' +
      '该调用链是否被 await / return / waitUntil(…) 包裹（纯语法位置判定）',
    kind: 'machine',
    guardedBy: ['INV-SEC-06'],
  },
  aq22: {
    source:
      '脚本文件 `.replace` 第一参的原文 × 归一化（去反斜杠与空白）后是否同时含块注释开场符与闭合符' +
      '（模式文本可直接复算）',
    kind: 'machine',
    guardedBy: ['INV-META-06'],
  },

  /* ---------- MP001–MP008：小程序域（宿主时序/样式作用域/配置表） ---------- */
  mp01: {
    source: '定时器回调体的 AST × 页面/组件生命周期钩子（onUnload/detached）与存活短路的出现位置',
    kind: 'machine',
    guardedBy: ['INV-MP-01'],
  },
  mp02: {
    source: 'app.wxss 的类选择器集合 × 组件 wxss 的类集合（两边都是可枚举的样式文本）',
    kind: 'machine',
    guardedBy: ['INV-MP-02'],
  },
  mp03: {
    source: 'attached/created 钩子体内的 setData 调用位置（AST 边界）',
    kind: 'machine',
    guardedBy: ['INV-MP-03'],
  },
  mp04: {
    source: 'navigateBack 调用点 × 调用前 400 字符内是否出现 getCurrentPages().length',
    kind: 'machine',
    guardedBy: ['INV-MP-04'],
  },
  mp05: {
    source: '跳转 API 的对象字面量 url × app.json 的 pages/subpackages 注册表',
    kind: 'machine',
    guardedBy: ['INV-MP-05'],
  },
  mp06: {
    source: '跳转 API 名 × app.json tabBar.list 的 pagePath 清单',
    kind: 'machine',
    guardedBy: ['INV-MP-06'],
  },
  mp07: {
    source: '异步边界（success / then / await 恢复点）之后的 setData × 同一区域内是否出现存活短路',
    kind: 'machine',
    guardedBy: ['INV-MP-07'],
  },
  mp08: {
    source: '组件 wxml 的静态 class 集合 × 组件 wxss + app.wxss + externalClasses 的可解析集合',
    kind: 'machine',
    guardedBy: ['INV-MP-08'],
  },
}
