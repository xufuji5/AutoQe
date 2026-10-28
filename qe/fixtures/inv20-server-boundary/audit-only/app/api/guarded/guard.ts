import { logAccessDeny } from './audit'

export function checkAccess(actor: unknown, targetId: string): void {
  if (!actor) {
    void logAccessDeny(actor, { attempted: 'guarded.read', targetId })
    throw new Error('denied')
  }
}
