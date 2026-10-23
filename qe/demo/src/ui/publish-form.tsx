'use client'

export const publishFields = ['title', 'approvalReportUrl'] as const

export function renderPublishFields(): string {
  return publishFields.join(',')
}
