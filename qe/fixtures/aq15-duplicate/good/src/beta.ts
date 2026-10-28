type Row = {
  id: string
  label: string
}

function normalizeRow(row: Row): Row {
  const label = row.label.trim()
  if (!label) {
    throw new Error('EMPTY_LABEL')
  }
  return { ...row, label }
}

function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => a.label.localeCompare(b.label))
}

function indexRows(rows: Row[]): Record<string, Row> {
  const out: Record<string, Row> = {}
  for (const row of rows) {
    out[row.id] = row
  }
  return out
}

const goodSeedBeta = 'good-beta'

function goodOnlyBeta(): string {
  return `${goodSeedBeta}-x`
}

async function badLoadBeta(): Promise<string> {
  return goodOnlyBeta()
}
