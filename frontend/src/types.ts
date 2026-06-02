export type TaskKind = 'auto_process'

export type PopupMode = 'manual' | 'selection_translation'

export type Provider =
  | 'open_ai'
  | 'gemini_ai_studio'
  | 'gemini_vertex'
  | 'deep_seek'
  | 'aws_bedrock'
  | 'custom_open_ai'

export type AppConfig = {
  provider: Provider
  api_key: string
  model: string
  base_url: string
  translation_prompt: string
  data_dir: string
  selection_popup_enabled: boolean
}

export type HistoryRecord = {
  id: number
  original_text: string
  translated_text: string
  created_at: number
  is_bookmarked: boolean
  tags: string[]
}

export type HistoryTagSummary = {
  name: string
  count: number
}

export type HistoryPagination = {
  page: number
  page_size: number
  total_records: number
  total_pages: number
}

export type HistorySort = 'newest' | 'oldest'
export type BookmarkStatusFilter = 'all' | 'bookmarked' | 'unbookmarked'
export type GroupMode = 'none' | 'day' | 'week' | 'month'

export type HistoryQuery = {
  page: number
  page_size: number
  search: string
  tag: string
  bookmark_status: BookmarkStatusFilter
  sort: HistorySort
}

export type HistoryRequestQuery = Partial<HistoryQuery>

export type HistoryResponse = {
  records: HistoryRecord[]
  pagination: HistoryPagination
  available_tags: HistoryTagSummary[]
}

export type PopupSession = {
  mode: PopupMode
  input?: string
  source_text?: string
}

export type ProcessRequest = {
  task: TaskKind
  text: string
}

export type ProcessResponse = {
  output: string
}

export type ActionResponse = {
  ok: boolean
}

export type StatusKind = 'idle' | 'loading' | 'success' | 'error'
