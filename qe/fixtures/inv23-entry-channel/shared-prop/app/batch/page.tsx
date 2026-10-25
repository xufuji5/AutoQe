import { SignPanel } from '../../components/sign-panel'

export default function BatchPage() {
  // 路径由页面传给单源签署面板，fetch 在面板内部
  return <SignPanel endpoint="/api/sign" />
}
