/// <reference types="vite/client" />

type LinguaFixConfig = {
  provider: 'open_ai' | 'gemini_ai_studio' | 'gemini_vertex' | 'custom_open_ai'
  api_key: string
  model: string
  base_url: string
  translation_prompt: string
  data_dir: string
}

type LinguaFixTask = 'auto_process'

type LinguaFixProcessRequest = {
  task: LinguaFixTask
  text: string
}

type LinguaFixProcessResponse = {
  output: string
}

type LinguaFixHistoryRecord = {
  id: number
  original_text: string
  translated_text: string
  created_at: number
  is_bookmarked: boolean
  tags: string[]
}

type LinguaFixHistoryTagSummary = {
  name: string
  count: number
}

type LinguaFixHistoryPagination = {
  page: number
  page_size: number
  total_records: number
  total_pages: number
}

type LinguaFixHistoryQuery = {
  page?: number
  page_size?: number
  search?: string
  tag?: string
  bookmark_status?: 'all' | 'bookmarked' | 'unbookmarked'
  sort?: 'newest' | 'oldest'
}

type LinguaFixHistoryResponse = {
  records: LinguaFixHistoryRecord[]
  pagination: LinguaFixHistoryPagination
  available_tags: LinguaFixHistoryTagSummary[]
}

type LinguaFixActionResponse = {
  ok: boolean
}

interface Window {
  linguafix: {
    getConfig: () => Promise<LinguaFixConfig>
    getHistory: (query?: LinguaFixHistoryQuery) => Promise<LinguaFixHistoryResponse>
    deleteHistoryRecord: (id: number) => Promise<LinguaFixActionResponse>
    setHistoryRecordBookmark: (id: number, isBookmarked: boolean) => Promise<LinguaFixActionResponse>
    updateHistoryRecordTags: (id: number, tags: string[]) => Promise<LinguaFixActionResponse>
    clearHistory: () => Promise<LinguaFixActionResponse>
    saveConfig: (config: LinguaFixConfig) => Promise<LinguaFixConfig>
    processText: (request: LinguaFixProcessRequest) => Promise<LinguaFixProcessResponse>
    hidePopup: () => Promise<void>
    onShowQuickTranslateOverlay: (callback: () => void) => () => void
  }
}
