// 坏样本（对旧判据）：枚举值被写成映射表键，旧判据只认字符串字面量与 Enum.VALUE。
// 键不是读也不是写 → 应降级为 AMBIGUOUS_PATH warn，不能判死枚举。
export const hazardLabels = {
  banned_chem: '禁用化学品',
  low_risk: '低风险',
}

export function labelOf(key: string): string {
  return hazardLabels[key as keyof typeof hazardLabels] ?? ''
}
