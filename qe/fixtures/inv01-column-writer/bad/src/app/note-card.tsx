// 页面渲染 body：死列分档里的「用户可见空栏」
export function NoteCard({ n }: { n: { title: string; body: string } }): string {
  return `${n.title} / ${n.body}`
}
