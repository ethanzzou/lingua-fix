import { DEFAULT_TRANSLATION_PROMPT } from './providers'
import type {
  ActionResponse,
  AppConfig,
  HistoryRecord,
  HistoryRequestQuery,
  HistoryResponse,
  ProcessRequest,
  ProcessResponse,
} from './types'

type LinguaFixClient = Window['linguafix']

const demoNow = Math.floor(Date.now() / 1000)

let demoConfig: AppConfig = {
  provider: 'open_ai',
  api_key: '',
  model: 'gpt-4.1-mini',
  base_url: '',
  translation_prompt: DEFAULT_TRANSLATION_PROMPT,
  data_dir: '~/LinguaFix',
}

let demoHistory: HistoryRecord[] = [
  {
    id: 1,
    original_text: '这个句子需要自然一点的英文表达。',
    translated_text: 'This sentence needs a more natural English expression.',
    created_at: demoNow,
    is_bookmarked: true,
    tags: ['translation', 'draft'],
  },
  {
    id: 2,
    original_text: 'Please help polish this update before I send it.',
    translated_text: 'Please help polish this update before I send it.',
    created_at: demoNow - 86400,
    is_bookmarked: false,
    tags: ['email'],
  },
  {
    id: 3,
    original_text: '我们明天同步一下项目进展。',
    translated_text: 'Let us sync up on the project progress tomorrow.',
    created_at: demoNow - 172800,
    is_bookmarked: false,
    tags: ['meeting'],
  },
]

export function getLinguaFixClient(): LinguaFixClient {
  if (window.linguafix) {
    return window.linguafix
  }

  if (import.meta.env.DEV) {
    return demoClient
  }

  throw new Error('LinguaFix preload API is unavailable.')
}

const demoClient: LinguaFixClient = {
  getConfig: async () => demoConfig,
  getHistory: async (query = {}) => buildDemoHistoryResponse(query),
  deleteHistoryRecord: async (id) => {
    demoHistory = demoHistory.filter((record) => record.id !== id)
    return ok()
  },
  setHistoryRecordBookmark: async (id, isBookmarked) => {
    demoHistory = demoHistory.map((record) =>
      record.id === id ? { ...record, is_bookmarked: isBookmarked } : record,
    )
    return ok()
  },
  updateHistoryRecordTags: async (id, tags) => {
    demoHistory = demoHistory.map((record) =>
      record.id === id ? { ...record, tags } : record,
    )
    return ok()
  },
  clearHistory: async () => {
    demoHistory = demoHistory.filter((record) => record.is_bookmarked)
    return ok()
  },
  saveConfig: async (config) => {
    demoConfig = { ...config }
    return demoConfig
  },
  processText: async (request) => processDemoText(request),
  hidePopup: async () => undefined,
  onPopupSession: () => noop,
  onShowQuickTranslateOverlay: () => noop,
}

function buildDemoHistoryResponse(query: HistoryRequestQuery): HistoryResponse {
  const page = Math.max(1, Number(query.page ?? 1))
  const pageSize = Math.max(1, Number(query.page_size ?? 12))
  const search = String(query.search ?? '').trim().toLowerCase()
  const tag = String(query.tag ?? '')
  const bookmarkStatus = query.bookmark_status ?? 'all'
  const sort = query.sort ?? 'newest'

  let records = [...demoHistory]

  if (search) {
    records = records.filter((record) => {
      const haystack = [
        record.original_text,
        record.translated_text,
        ...record.tags,
      ].join(' ')

      return haystack.toLowerCase().includes(search)
    })
  }

  if (tag) {
    records = records.filter((record) => record.tags.includes(tag))
  }

  if (bookmarkStatus !== 'all') {
    const bookmarked = bookmarkStatus === 'bookmarked'
    records = records.filter((record) => record.is_bookmarked === bookmarked)
  }

  records.sort((left, right) =>
    sort === 'oldest' ? left.created_at - right.created_at : right.created_at - left.created_at,
  )

  const totalRecords = records.length
  const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize))
  const safePage = Math.min(page, totalPages)
  const start = (safePage - 1) * pageSize

  return {
    records: records.slice(start, start + pageSize),
    pagination: {
      page: safePage,
      page_size: pageSize,
      total_records: totalRecords,
      total_pages: totalPages,
    },
    available_tags: getDemoTagSummary(),
  }
}

function getDemoTagSummary() {
  const counts = new Map<string, number>()

  for (const record of demoHistory) {
    for (const tag of record.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }

  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

async function processDemoText(request: ProcessRequest): Promise<ProcessResponse> {
  const source = request.text.trim()
  const output = source ? source.replace(/\s+/g, ' ') : ''

  if (output) {
    demoHistory = [
      {
        id: Math.max(0, ...demoHistory.map((record) => record.id)) + 1,
        original_text: source,
        translated_text: output,
        created_at: Math.floor(Date.now() / 1000),
        is_bookmarked: false,
        tags: [],
      },
      ...demoHistory,
    ]
  }

  return { output }
}

function ok(): ActionResponse {
  return { ok: true }
}

function noop() {}
