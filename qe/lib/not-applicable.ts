/**
 * 「本轮不适用」的唯一出口。
 *
 * ## 为什么 code 是必填的
 *
 * 跳过的动机是**单向**的：一条判据每缩一寸射程，它的 findings 就少一批，而读数
 * `errors/warnings` 只会变好。所以「不适用」如果只是一个自由文本 reason，它就会
 * 慢慢退化成一个谁都能拧的静音旋钮 —— 今天写「本仓未配采集器」，明天写「样本太少」，
 * 读数一路绿下去，没有任何一处会变红。
 *
 * 实测代价（某试点仓那一轮）：`skipped=6` 只以**一个数字**出现在报告里。没人能回答
 * 「6 个是什么」「上次是 2 个还是 8 个」。而 `RATCHET` 只跟踪 findings、不跟踪 skip，
 * 于是「把射程关掉」这件事在棘轮上是隐形的：`regressions=0`，全程无感。
 *
 * 修法不是「让 skip 判红」（很多 skip 是正当的：外部仓没 Prisma schema 就是没法判），
 * 而是让 skip **可分类、可棘轮、可比较**：
 *   - `code` 进棘轮键（`skip:<guard>:<code>`）⇒ 新增一类跳过 ＝ 回归，读数必须变差；
 *   - `reason` 只给人读，不进任何键（自由文本做键会把「改了措辞」读成「换了缺陷」）。
 *
 * 因此本类**不提供单参数构造**。想偷懒写 `new NotApplicable('xx 不适用')` 会直接编译不过 ——
 * 让编译器当这条判据，比在运行时再判一次「你忘了分类」更省一层。
 */
export class NotApplicable extends Error {
  /** 稳定标识，进棘轮键；改动它等同于换一类跳过（旧的那类会读成「修好了」） */
  readonly code: string
  /** 人读原因，可随时改写，不参与任何比较 */
  readonly reason: string

  constructor(code: string, reason: string) {
    super(reason)
    this.name = 'NotApplicable'
    this.code = code
    this.reason = reason
  }
}

/**
 * 规则型守卫（`qe/rules/AQ*.ts`）没给自己的不适用原因分类时的兜底 code。
 *
 * 刻意**不**按规则 id 派生：`AQ_NOT_CLASSIFIED` 集中出现本身就是一个待办信号
 * （「这些规则的射程条件还只写在散文里」）。按 id 派生会让它看起来已经分好了。
 */
export const SKIP_CODE_UNCLASSIFIED = 'AQ_NOT_CLASSIFIED'

/** 射程内 0 个文件：最常见的一类，理由见 rule-guard 里的注释 */
export const SKIP_CODE_EMPTY_SCOPE = 'SCOPE_ZERO_FILES'
