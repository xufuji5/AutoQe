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

const goodSeedAlpha = 'good-alpha'

function goodOnlyAlpha(): string {
  return `${goodSeedAlpha}-x`
}

async function goodLoadAlpha(): Promise<string> {
  return goodOnlyAlpha()
}
