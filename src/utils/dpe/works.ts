export interface DpeWork {
  lot:         string
  description: string
  warning?:    string | null
  perf?:       string | null
}

export function extractDpeWorks(rapport: unknown[][]): Record<string, DpeWork> {
  const works: Record<string, DpeWork> = {}

  for (const row of rapport) {
    if (typeof row[0] === "string" && row[0].startsWith("travaux_") && row[1]) {
      const lot  = String(row[1]).trim().toLowerCase()           // ex : "murs"
      const desc = String(row[2] ?? "").trim()
      const warn = row[3] ? String(row[3]).trim() : null
      const perf = row[4] ? String(row[4]).trim() : null

      if (!works[lot] && desc) {
        works[lot] = { lot, description: desc, warning: warn, perf }
      }
    }
  }

  return works                      
}
