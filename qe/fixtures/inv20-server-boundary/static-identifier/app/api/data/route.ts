/**
 * 返回值是 import 进来的标识符：静态上无法证明它只是常量而不含敏感内容，
 * 因此**不能**按「静态桩」免掉鉴权判据。
 */
import { PUBLIC_BODY } from '../data-const'

export function GET() {
  return Response.json(PUBLIC_BODY)
}
