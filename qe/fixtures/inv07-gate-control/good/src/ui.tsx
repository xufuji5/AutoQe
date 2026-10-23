export const ListingForm = {
  fields: ['title', 'qcReportUrl', 'stockQty'],
}

export function renderFields(): string {
  return ListingForm.fields.join(',')
}
