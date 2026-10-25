// runner 是唯一种子；helper 下三个文件靠不同机制接上线，两个只出现在注释里（必须仍判孤儿）
import { one } from './helper/one'
// join(ROOT, 'scripts', 'helper', 'dead.ts')  ← 注释里的拼接路径不算入口
import { spawnSync } from 'node:child_process'
import path from 'node:path'
// import './helper/commented.ts'
export const run = () => {
  spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', 'helper', 'spawned.ts')])
  return one
}
