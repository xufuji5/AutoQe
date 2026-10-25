export const PublishForm = {
  fields: ['title', 'approvalReportUrl', 'quotaQty'],
}

export function renderFields(): string {
  return PublishForm.fields.join(',')
}
