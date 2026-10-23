'use client'

export const listingFields = ['title', 'qcReportUrl'] as const

export function renderListingFields(): string {
  return listingFields.join(',')
}
