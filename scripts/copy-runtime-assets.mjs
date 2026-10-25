/**
 * 构建时把运行期需要的非 TS 资源复制到 dist/。
 * 守卫的 selfTest 通过 import.meta.dirname 定位 ../fixtures，因此 fixtures 必须与编译产物同级。
 */
import { cp, mkdir } from 'node:fs/promises'

await mkdir('dist', { recursive: true })
await cp('qe/fixtures', 'dist/fixtures', { recursive: true })
