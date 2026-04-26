import type { GroupMode, HistoryQuery, HistoryRecord } from './types'

export const HISTORY_PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

export const DEFAULT_HISTORY_QUERY: HistoryQuery = {
  page: 1,
  page_size: 12,
  search: '',
  tag: '',
  bookmark_status: 'all',
  sort: 'newest',
}

const HISTORY_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

export function formatHistoryTimestamp(unixSeconds: number) {
  return HISTORY_TIMESTAMP_FORMATTER.format(new Date(unixSeconds * 1000))
}

export function parseTagDraft(value: string) {
  const seen = new Set<string>()
  const tags: string[] = []

  for (const piece of value.split(',')) {
    const compact = piece.trim().replace(/\s+/g, ' ')
    const normalized = compact.toLowerCase()

    if (!compact || seen.has(normalized)) {
      continue
    }

    seen.add(normalized)
    tags.push(compact)
  }

  return tags
}

export function getHistoryGroups(records: HistoryRecord[], groupBy: GroupMode) {
  if (groupBy === 'none') {
    return [{ key: 'all', label: 'All Records', records }]
  }

  const groups = new Map<string, { label: string; records: HistoryRecord[] }>()
  for (const record of records) {
    const date = new Date(record.created_at * 1000)
    const key = historyGroupKey(date, groupBy)
    const label = historyGroupLabel(date, groupBy)
    const current = groups.get(key)

    if (current) {
      current.records.push(record)
    } else {
      groups.set(key, { label, records: [record] })
    }
  }

  return Array.from(groups.entries()).map(([key, group]) => ({
    key,
    label: group.label,
    records: group.records,
  }))
}

function historyGroupKey(date: Date, groupBy: GroupMode) {
  if (groupBy === 'month') {
    return `${date.getFullYear()}-${date.getMonth()}`
  }

  if (groupBy === 'week') {
    const start = startOfWeek(date)
    return `${start.getFullYear()}-${start.getMonth()}-${start.getDate()}`
  }

  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function historyGroupLabel(date: Date, groupBy: GroupMode) {
  if (groupBy === 'month') {
    return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  }

  if (groupBy === 'week') {
    return `Week of ${startOfWeek(date).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })}`
  }

  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)

  if (isSameDay(date, today)) {
    return 'Today'
  }

  if (isSameDay(date, yesterday)) {
    return 'Yesterday'
  }

  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function startOfWeek(date: Date) {
  const result = new Date(date)
  const day = result.getDay()
  const delta = day === 0 ? -6 : 1 - day
  result.setDate(result.getDate() + delta)
  result.setHours(0, 0, 0, 0)
  return result
}

function isSameDay(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}
