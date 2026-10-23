export class NotApplicable extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'NotApplicable'
  }
}
