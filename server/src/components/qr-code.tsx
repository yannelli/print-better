import { useMemo } from 'react'
import { qrMatrix } from '@/lib/qr'

const QUIET_ZONE = 4

function modulePath(matrix: boolean[][]): string {
  let path = ''
  matrix.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      if (!row[c]) continue
      const start = c
      while (row[c + 1]) c++
      const width = c - start + 1
      path += `M${start + QUIET_ZONE} ${r + QUIET_ZONE}h${width}v1h-${width}z`
    }
  })
  return path
}

/** Black on white in every theme, because scanners need the contrast. */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const matrix = useMemo(() => qrMatrix(value), [value])
  const path = useMemo(() => modulePath(matrix), [matrix])
  const size = matrix.length + QUIET_ZONE * 2
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" className={className}>
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}
