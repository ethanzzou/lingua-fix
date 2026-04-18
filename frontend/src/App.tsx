import { useEffect, useRef, useState } from 'react'
import './App.css'

type TaskKind = 'auto_process'

type Provider = 'open_ai' | 'gemini_ai_studio' | 'gemini_vertex' | 'custom_open_ai'

type AppConfig = {
  provider: Provider
  api_key: string
  model: string
  base_url: string
  translation_prompt: string
  data_dir: string
}

type HistoryRecord = {
  id: number
  original_text: string
  translated_text: string
  created_at: number
  tags: string[]
}

type HistoryTagSummary = {
  name: string
  count: number
}

type HistoryPagination = {
  page: number
  page_size: number
  total_records: number
  total_pages: number
}

type HistorySort = 'newest' | 'oldest'

type GroupMode = 'none' | 'day' | 'week' | 'month'

type HistoryQuery = {
  page: number
  page_size: number
  search: string
  tag: string
  sort: HistorySort
}

const DEFAULT_TRANSLATION_PROMPT =
  "Decide what to do from the user's text. If the input is primarily Chinese, translate it into natural English while preserving meaning and tone. If the input is primarily English, rewrite it into correct, natural English with improved grammar, spelling, punctuation, and phrasing while preserving meaning and tone. Return only the final text with no explanation."

const PROVIDER_LABELS: Record<Provider, string> = {
  open_ai: 'OpenAI',
  gemini_ai_studio: 'Gemini AI Studio',
  gemini_vertex: 'Gemini Vertex AI',
  custom_open_ai: 'Custom (OpenAI-compatible)',
}

const PROVIDER_KEY_LABELS: Record<Provider, string> = {
  open_ai: 'OpenAI API key',
  gemini_ai_studio: 'Google AI Studio API key',
  gemini_vertex: 'OAuth access token',
  custom_open_ai: 'API key',
}

const PROVIDER_KEY_PLACEHOLDERS: Record<Provider, string> = {
  open_ai: 'sk-...',
  gemini_ai_studio: 'AIza...',
  gemini_vertex: 'gcloud auth print-access-token',
  custom_open_ai: 'API key',
}

const PROVIDER_MODEL_PLACEHOLDERS: Record<Provider, string> = {
  open_ai: 'gpt-4.1-mini',
  gemini_ai_studio: 'gemini-2.0-flash',
  gemini_vertex: 'gemini-2.0-flash',
  custom_open_ai: 'model name',
}

const PROVIDER_BASE_URL_PLACEHOLDERS: Record<Provider, string> = {
  open_ai: '',
  gemini_ai_studio: '',
  gemini_vertex:
    'https://aiplatform.googleapis.com/v1/projects/MY_PROJECT/locations/global',
  custom_open_ai: 'https://api.together.xyz',
}

const PROVIDER_BASE_URL_HINTS: Partial<Record<Provider, string>> = {
  gemini_vertex:
    'Optional. Leave this blank to use your active gcloud project and the global Vertex endpoint.',
  custom_open_ai:
    'Required for deployed Model Garden OpenAI-compatible endpoints and other OpenAI-style APIs.',
}

type StatusKind = 'idle' | 'loading' | 'success' | 'error'

type Page = 'main' | 'history' | 'settings'

const HISTORY_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const HISTORY_PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

const DEFAULT_HISTORY_QUERY: HistoryQuery = {
  page: 1,
  page_size: 12,
  search: '',
  tag: '',
  sort: 'newest',
}

function App() {
  const isQuickTranslatePopup =
    new URLSearchParams(window.location.search).get('popup') === 'quick-translate'
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  const popupInputRef = useRef<HTMLTextAreaElement | null>(null)
  const overlayInputRef = useRef<HTMLTextAreaElement | null>(null)
  const [page, setPage] = useState<Page>('main')
  const [config, setConfig] = useState<AppConfig>({
    provider: 'open_ai',
    api_key: '',
    model: 'gpt-4.1-mini',
    base_url: '',
    translation_prompt: DEFAULT_TRANSLATION_PROMPT,
    data_dir: '',
  })
  const [input, setInput] = useState('')
  const [previousInput, setPreviousInput] = useState('')
  const [history, setHistory] = useState<HistoryRecord[]>([])
  const [historyQuery, setHistoryQuery] = useState<HistoryQuery>(DEFAULT_HISTORY_QUERY)
  const [historySearchInput, setHistorySearchInput] = useState('')
  const [historyGroupBy, setHistoryGroupBy] = useState<GroupMode>('day')
  const [historyPagination, setHistoryPagination] = useState<HistoryPagination>({
    page: 1,
    page_size: DEFAULT_HISTORY_QUERY.page_size,
    total_records: 0,
    total_pages: 1,
  })
  const [availableTags, setAvailableTags] = useState<HistoryTagSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState('')
  const [historyBusyIds, setHistoryBusyIds] = useState<number[]>([])
  const [historyClearing, setHistoryClearing] = useState(false)
  const [historyTagDrafts, setHistoryTagDrafts] = useState<Record<number, string>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [showQuickTranslateOverlay, setShowQuickTranslateOverlay] = useState(false)
  const [status, setStatus] = useState<{ kind: StatusKind; text: string }>({
    kind: 'idle',
    text: '',
  })

  async function loadHistory(nextQuery: HistoryQuery) {
    setHistoryError('')

    try {
      const response = await window.linguafix.getHistory({
        page: nextQuery.page,
        page_size: nextQuery.page_size,
        search: nextQuery.search || undefined,
        tag: nextQuery.tag || undefined,
        sort: nextQuery.sort,
      })

      setHistory(response.records)
      setHistoryPagination(response.pagination)
      setAvailableTags(response.available_tags)
      setHistoryQuery({
        ...nextQuery,
        page: response.pagination.page,
        page_size: response.pagination.page_size,
      })
      return true
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Could not load translation history.'
      setHistoryError(message)
      return false
    } finally {
      setHistoryLoading(false)
    }
  }

  useEffect(() => {
    window.linguafix
      .getConfig()
      .then((nextConfig) => {
        setConfig(nextConfig)
        setLoading(false)
      })
      .catch((error: Error) => {
        setStatus({ kind: 'error', text: error.message })
        setLoading(false)
      })

    void loadHistory(DEFAULT_HISTORY_QUERY)
  }, [])

  useEffect(() => {
    if (!isQuickTranslatePopup) {
      return
    }

    popupInputRef.current?.focus()

    const handleVisibility = () => {
      popupInputRef.current?.focus()
    }

    window.addEventListener('focus', handleVisibility)
    return () => window.removeEventListener('focus', handleVisibility)
  }, [isQuickTranslatePopup])

  useEffect(() => {
    if (isQuickTranslatePopup) {
      return
    }

    return window.linguafix.onShowQuickTranslateOverlay(() => {
      setShowQuickTranslateOverlay(true)
      window.setTimeout(() => overlayInputRef.current?.focus(), 0)
    })
  }, [isQuickTranslatePopup])

  useEffect(() => {
    if (!showQuickTranslateOverlay) {
      return
    }

    overlayInputRef.current?.focus()
  }, [showQuickTranslateOverlay])

  async function persistConfig(nextConfig: AppConfig) {
    setConfig(nextConfig)

    try {
      const savedConfig = await window.linguafix.saveConfig(nextConfig)
      setConfig(savedConfig)
      setHistoryLoading(true)
      await loadHistory(historyQuery)
      setStatus({ kind: 'success', text: 'Settings saved locally.' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save settings.'
      setStatus({ kind: 'error', text: message })
    }
  }

  async function runTask(task: TaskKind) {
    if (!input.trim()) {
      setStatus({ kind: 'error', text: 'Input text is empty.' })
      return
    }

    setBusy(true)
    setPreviousInput(input)
    setStatus({
      kind: 'loading',
      text: 'Processing text...',
    })

    try {
      const response = await window.linguafix.processText({ task, text: input })
      setInput(response.output)
      setHistoryLoading(true)
      await loadHistory(historyQuery)
      setStatus({ kind: 'success', text: 'Completed.' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request failed.'
      setStatus({ kind: 'error', text: message })
    } finally {
      setBusy(false)
    }
  }

  async function copyOutput() {
    if (!input.trim()) {
      setStatus({ kind: 'error', text: 'There is no text to copy.' })
      return
    }

    try {
      await navigator.clipboard.writeText(input)
      setStatus({ kind: 'success', text: 'Text copied to clipboard.' })
    } catch {
      setStatus({ kind: 'error', text: 'Could not copy output.' })
    }
  }

  function undoLastChange() {
    if (!previousInput) {
      setStatus({ kind: 'error', text: 'There is no previous version to restore.' })
      return
    }

    const currentInput = input
    setInput(previousInput)
    setPreviousInput(currentInput)
    setStatus({ kind: 'success', text: 'Previous version restored.' })
  }

  async function hideQuickTranslatePopup() {
    try {
      await window.linguafix.hidePopup()
    } catch {
      // Ignore close errors.
    }
  }

  function closeQuickTranslateOverlay() {
    setShowQuickTranslateOverlay(false)
  }

  function formatHistoryTimestamp(unixSeconds: number) {
    return HISTORY_TIMESTAMP_FORMATTER.format(new Date(unixSeconds * 1000))
  }

  function setHistoryTagDraft(id: number, value: string) {
    setHistoryTagDrafts((current) => ({ ...current, [id]: value }))
  }

  async function refreshHistory(showSuccess = false) {
    setHistoryLoading(true)
    const ok = await loadHistory(historyQuery)

    if (showSuccess && ok) {
      setStatus({ kind: 'success', text: 'History refreshed.' })
    }
  }

  async function deleteHistoryRecord(id: number) {
    if (!window.confirm('Delete this history record?')) {
      return
    }

    setHistoryBusyIds((current) => [...current, id])

    try {
      await window.linguafix.deleteHistoryRecord(id)
      setHistoryLoading(true)
      const ok = await loadHistory(historyQuery)
      if (!ok) {
        return
      }
      setHistoryTagDrafts((current) => {
        const nextDrafts = { ...current }
        delete nextDrafts[id]
        return nextDrafts
      })
      setStatus({ kind: 'success', text: 'History record deleted.' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not delete history record.'
      setStatus({ kind: 'error', text: message })
    } finally {
      setHistoryBusyIds((current) => current.filter((value) => value !== id))
    }
  }

  async function clearHistory() {
    if (!history.length) {
      return
    }

    if (!window.confirm('Delete all saved history records?')) {
      return
    }

    setHistoryClearing(true)

    try {
      await window.linguafix.clearHistory()
      setHistoryLoading(true)
      const ok = await loadHistory({ ...historyQuery, page: 1 })
      if (!ok) {
        return
      }
      setHistoryTagDrafts({})
      setStatus({ kind: 'success', text: 'History cleared.' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not clear history.'
      setStatus({ kind: 'error', text: message })
    } finally {
      setHistoryClearing(false)
    }
  }

  async function applyHistoryQuery(partialQuery: Partial<HistoryQuery>) {
    const nextQuery = {
      ...historyQuery,
      ...partialQuery,
    }

    setHistoryLoading(true)
    await loadHistory(nextQuery)
  }

  async function applyHistoryFilters() {
    await applyHistoryQuery({
      page: 1,
      search: historySearchInput.trim(),
    })
  }

  async function resetHistoryFilters() {
    setHistorySearchInput('')
    setHistoryLoading(true)
    const ok = await loadHistory(DEFAULT_HISTORY_QUERY)
    if (ok) {
      setStatus({ kind: 'success', text: 'History filters reset.' })
    }
  }

  function parseTagDraft(value: string) {
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

  async function updateHistoryTags(id: number, nextTags: string[]) {
    setHistoryBusyIds((current) => [...current, id])

    try {
      await window.linguafix.updateHistoryRecordTags(id, nextTags)
      setHistoryLoading(true)
      const ok = await loadHistory(historyQuery)
      if (!ok) {
        return
      }
      setStatus({ kind: 'success', text: 'Tags updated.' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not update tags.'
      setStatus({ kind: 'error', text: message })
    } finally {
      setHistoryBusyIds((current) => current.filter((value) => value !== id))
    }
  }

  async function addHistoryTags(id: number, currentTags: string[]) {
    const draft = historyTagDrafts[id] ?? ''
    const newTags = parseTagDraft(draft)

    if (!newTags.length) {
      return
    }

    const mergedTags = [...currentTags]
    for (const tag of newTags) {
      if (!mergedTags.some((existingTag) => existingTag.toLowerCase() === tag.toLowerCase())) {
        mergedTags.push(tag)
      }
    }

    await updateHistoryTags(id, mergedTags)
    setHistoryTagDraft(id, '')
  }

  async function removeHistoryTag(id: number, currentTags: string[], tagToRemove: string) {
    await updateHistoryTags(
      id,
      currentTags.filter((tag) => tag !== tagToRemove),
    )
  }

  function getHistoryGroups(records: HistoryRecord[]) {
    if (historyGroupBy === 'none') {
      return [{ key: 'all', label: 'All Records', records }]
    }

    const groups = new Map<string, { label: string; records: HistoryRecord[] }>()
    for (const record of records) {
      const date = new Date(record.created_at * 1000)
      const key = historyGroupKey(date, historyGroupBy)
      const label = historyGroupLabel(date, historyGroupBy)
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

  const pageTitle =
    page === 'settings' ? 'Application Settings' : page === 'history' ? 'Translation History' : 'LinguaFix'
  const pageSubtitle =
    page === 'settings'
      ? 'Local configuration'
      : page === 'history'
        ? 'Saved translations'
        : 'Writing Studio'

  const toolbarState = (() => {
    if (page === 'settings') {
      if (loading) {
        return { kind: 'loading' as StatusKind, text: 'Loading' }
      }

      if (status.kind === 'error') {
        return { kind: 'error' as StatusKind, text: 'Attention' }
      }

      if (status.kind === 'success') {
        return { kind: 'success' as StatusKind, text: 'Saved' }
      }

      return { kind: 'idle' as StatusKind, text: 'Ready' }
    }

    if (page === 'history') {
      if (historyLoading || historyClearing) {
        return { kind: 'loading' as StatusKind, text: 'Loading' }
      }

      if (historyError || status.kind === 'error') {
        return { kind: 'error' as StatusKind, text: 'Attention' }
      }

      if (status.kind === 'success') {
        return { kind: 'success' as StatusKind, text: 'Updated' }
      }

      return { kind: 'idle' as StatusKind, text: 'Ready' }
    }

    if (busy || status.kind === 'loading') {
      return { kind: 'loading' as StatusKind, text: 'Working' }
    }

    if (status.kind === 'error') {
      return { kind: 'error' as StatusKind, text: 'Attention' }
    }

    if (status.kind === 'success') {
      return { kind: 'success' as StatusKind, text: 'Updated' }
    }

    return loading
      ? { kind: 'loading' as StatusKind, text: 'Loading' }
      : { kind: 'idle' as StatusKind, text: 'Ready' }
  })()

  if (isQuickTranslatePopup) {
    return (
      <div className={`app-frame popup-frame${isMac ? ' macos-frame' : ''}`}>
        <header className="popup-bar">
          <span className="popup-bar-title">Quick Translate</span>
          <div className="popup-bar-actions">
            <button className="toolbar-chip" onClick={() => void hideQuickTranslatePopup()}>
              Close
            </button>
          </div>
        </header>

        <div className="popup-shell">
          <textarea
            ref={popupInputRef}
            className="popup-textarea"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                void hideQuickTranslatePopup()
              }

              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                void runTask('auto_process')
              }
            }}
            placeholder="Paste or type text to improve…"
          />
        </div>

        <footer className="popup-footer">
          <div className="popup-footer-status">
            {status.text ? <div className={`status ${status.kind}`}>{status.text}</div> : null}
          </div>
          <div className="popup-footer-actions">
            <button
              className="toolbar-chip"
              disabled={!previousInput}
              onClick={undoLastChange}
            >
              Undo
            </button>
            <button className="toolbar-chip" onClick={() => void copyOutput()}>
              Copy
            </button>
            <button
              className="toolbar-chip toolbar-chip-primary"
              disabled={busy || loading}
              onClick={() => void runTask('auto_process')}
            >
              Improve
            </button>
          </div>
        </footer>
      </div>
    )
  }

  return (
    <div className={`app-frame${isMac ? ' macos-frame' : ''}`}>
      <header className="control-bar">
        <div className="control-bar-leading">
          <button
            className="toolbar-icon"
            disabled={page === 'main'}
            onClick={() => setPage('main')}
            aria-label="Go back"
          >
            <ChevronLeftIcon />
          </button>
          <button className="toolbar-icon" disabled aria-label="Go forward">
            <ChevronRightIcon />
          </button>
        </div>

        <div className="control-bar-title">
          <span className="control-bar-title-primary">{pageTitle}</span>
          <span className="control-bar-title-secondary">{pageSubtitle}</span>
        </div>

        <div className="control-bar-actions">
          <span className={`toolbar-indicator ${toolbarState.kind}`}>{toolbarState.text}</span>

          {page === 'main' ? (
            <>
              <button className="toolbar-chip" onClick={() => void copyOutput()}>
                Copy
              </button>
              <button className="toolbar-chip" disabled={!previousInput} onClick={undoLastChange}>
                Undo
              </button>
              <button
                className="toolbar-chip toolbar-chip-primary"
                disabled={busy || loading}
                onClick={() => void runTask('auto_process')}
              >
                Improve
              </button>
              <button className="toolbar-chip" onClick={() => setPage('history')}>
                History
              </button>
              <button className="toolbar-chip" onClick={() => setPage('settings')}>
                Settings
              </button>
            </>
          ) : page === 'history' ? (
            <>
              <button className="toolbar-chip" onClick={() => void refreshHistory(true)}>
                Refresh
              </button>
              <button
                className="toolbar-chip toolbar-chip-danger"
                disabled={historyLoading || historyClearing || history.length === 0}
                onClick={() => void clearHistory()}
              >
                Clear All
              </button>
              <button className="toolbar-chip" onClick={() => setPage('settings')}>
                Settings
              </button>
            </>
          ) : (
            <>
              <button className="toolbar-chip" onClick={() => setPage('history')}>
                History
              </button>
              <button className="toolbar-chip" onClick={() => setPage('main')}>
                Compose
              </button>
            </>
          )}
        </div>
      </header>

      <div className="app-shell">
        {page === 'settings' ? (
          <section className="panel settings-panel">
            <div className="panel-heading">
              <div>
                <h2 data-index="01">Application Settings</h2>
                <p>Managed by the Rust service and saved in your local config folder.</p>
              </div>
              {loading ? (
                <span className="badge muted">Loading</span>
              ) : (
                <span className="badge">Ready</span>
              )}
            </div>

            <div className="settings-grid">
              <label>
                <span>Provider</span>
                <select
                  value={config.provider}
                  onChange={(event) => {
                    const provider = event.target.value as Provider
                    const nextConfig = { ...config, provider, api_key: '', model: '', base_url: '' }
                    setConfig(nextConfig)
                    void persistConfig(nextConfig)
                  }}
                >
                  {(Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => (
                    <option key={p} value={p}>
                      {PROVIDER_LABELS[p]}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>{PROVIDER_KEY_LABELS[config.provider]}</span>
                <input
                  type="password"
                  value={config.api_key}
                  onChange={(event) =>
                    setConfig((current) => ({ ...current, api_key: event.target.value }))
                  }
                  onBlur={() => void persistConfig(config)}
                  placeholder={PROVIDER_KEY_PLACEHOLDERS[config.provider]}
                />
              </label>

              <label>
                <span>Model</span>
                <input
                  type="text"
                  value={config.model}
                  onChange={(event) =>
                    setConfig((current) => ({ ...current, model: event.target.value }))
                  }
                  onBlur={() => void persistConfig(config)}
                  placeholder={PROVIDER_MODEL_PLACEHOLDERS[config.provider]}
                />
              </label>

              {(config.provider === 'gemini_vertex' || config.provider === 'custom_open_ai') && (
                <label>
                  <span>{config.provider === 'gemini_vertex' ? 'Vertex endpoint (optional)' : 'Base URL'}</span>
                  <input
                    type="text"
                    value={config.base_url}
                    onChange={(event) =>
                      setConfig((current) => ({ ...current, base_url: event.target.value }))
                    }
                    onBlur={() => void persistConfig(config)}
                    placeholder={PROVIDER_BASE_URL_PLACEHOLDERS[config.provider]}
                  />
                  <small>{PROVIDER_BASE_URL_HINTS[config.provider]}</small>
                </label>
              )}

              <label className="settings-field-wide">
                <span>Data directory</span>
                <input
                  type="text"
                  value={config.data_dir}
                  onChange={(event) =>
                    setConfig((current) => ({ ...current, data_dir: event.target.value }))
                  }
                  onBlur={() => void persistConfig(config)}
                  placeholder="/path/to/LinguaFix"
                />
                <small>
                  Translation logs are stored in <code>translations.sqlite3</code> in this
                  directory. Entries older than 30 days are removed automatically.
                </small>
              </label>

              <label className="settings-field-wide">
                <span>Translation prompt</span>
                <textarea
                  value={config.translation_prompt}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      translation_prompt: event.target.value,
                    }))
                  }
                  onBlur={() => void persistConfig(config)}
                  placeholder={DEFAULT_TRANSLATION_PROMPT}
                  rows={7}
                />
                <small>
                  Used as the system prompt for translation and English rewriting across all
                  providers.
                </small>
                <div className="settings-action-row">
                  <button
                    type="button"
                    className="toolbar-chip"
                    onClick={() => {
                      const nextConfig = {
                        ...config,
                        translation_prompt: DEFAULT_TRANSLATION_PROMPT,
                      }
                      setConfig(nextConfig)
                      void persistConfig(nextConfig)
                    }}
                  >
                    Reset prompt
                  </button>
                </div>
              </label>
            </div>
          </section>
        ) : page === 'history' ? (
          <section className="panel history-page">
            <div className="panel-heading">
              <div>
                <h2 data-index="02">Translation History</h2>
                <p>Browse, filter, paginate, group, tag, delete, or clear saved records.</p>
              </div>
              {historyLoading ? (
                <span className="badge muted">Loading</span>
              ) : historyPagination.total_records > 0 ? (
                <span className="badge">{historyPagination.total_records} Items</span>
              ) : (
                <span className="badge muted">Empty</span>
              )}
            </div>

            <form
              className="history-controls"
              onSubmit={(event) => {
                event.preventDefault()
                void applyHistoryFilters()
              }}
            >
              <label className="history-filter history-filter-search">
                <span>Search</span>
                <input
                  type="text"
                  value={historySearchInput}
                  onChange={(event) => setHistorySearchInput(event.target.value)}
                  placeholder="Search text or tags"
                />
              </label>

              <label className="history-filter">
                <span>Tag</span>
                <select
                  value={historyQuery.tag}
                  onChange={(event) =>
                    void applyHistoryQuery({ page: 1, tag: event.target.value })
                  }
                >
                  <option value="">All tags</option>
                  {availableTags.map((tag) => (
                    <option key={tag.name} value={tag.name}>
                      {tag.name} ({tag.count})
                    </option>
                  ))}
                </select>
              </label>

              <label className="history-filter">
                <span>Sort</span>
                <select
                  value={historyQuery.sort}
                  onChange={(event) =>
                    void applyHistoryQuery({
                      page: 1,
                      sort: event.target.value as HistorySort,
                    })
                  }
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                </select>
              </label>

              <label className="history-filter">
                <span>Group</span>
                <select
                  value={historyGroupBy}
                  onChange={(event) => setHistoryGroupBy(event.target.value as GroupMode)}
                >
                  <option value="day">By day</option>
                  <option value="week">By week</option>
                  <option value="month">By month</option>
                  <option value="none">No grouping</option>
                </select>
              </label>

              <label className="history-filter">
                <span>Page size</span>
                <select
                  value={historyQuery.page_size}
                  onChange={(event) =>
                    void applyHistoryQuery({
                      page: 1,
                      page_size: Number(event.target.value),
                    })
                  }
                >
                  {HISTORY_PAGE_SIZE_OPTIONS.map((size) => (
                    <option key={size} value={size}>
                      {size} per page
                    </option>
                  ))}
                </select>
              </label>

              <div className="history-page-actions">
                <button className="toolbar-chip" type="submit">
                  Apply
                </button>
                <button
                  className="toolbar-chip"
                  type="button"
                  onClick={() => void resetHistoryFilters()}
                >
                  Reset
                </button>
                <button
                  className="toolbar-chip"
                  type="button"
                  onClick={() => void refreshHistory(true)}
                >
                  Refresh
                </button>
                <button
                  className="toolbar-chip toolbar-chip-danger"
                  type="button"
                  disabled={historyLoading || historyClearing || historyPagination.total_records === 0}
                  onClick={() => void clearHistory()}
                >
                  Clear all records
                </button>
              </div>
            </form>

            <div className="history-summary">
              <span>
                Page {historyPagination.page} of {historyPagination.total_pages}
              </span>
              <span>
                {historyPagination.total_records === 0
                  ? 'No records'
                  : `Showing ${history.length} records on this page`}
              </span>
            </div>

            {historyError ? <div className="status error">{historyError}</div> : null}

            {!historyLoading && !historyError && historyPagination.total_records === 0 ? (
              <div className="history-empty history-empty-page">
                Translation records will appear here after you run the first request.
              </div>
            ) : (
              <>
                <div className="history-group-list">
                  {getHistoryGroups(history).map((group) => (
                    <section key={group.key} className="history-group">
                      <div className="history-group-header">
                        <h3>{group.label}</h3>
                        <span>{group.records.length}</span>
                      </div>

                      <div className="history-list history-list-page">
                        {group.records.map((record) => {
                          const deleting = historyClearing || historyBusyIds.includes(record.id)

                          return (
                            <article key={record.id} className="history-card history-card-page">
                              <div className="history-card-meta">
                                <span>{formatHistoryTimestamp(record.created_at)}</span>
                                <button
                                  className="toolbar-chip toolbar-chip-danger"
                                  disabled={deleting}
                                  onClick={() => void deleteHistoryRecord(record.id)}
                                >
                                  Delete
                                </button>
                              </div>
                              <div className="history-card-copy">
                                <div className="history-card-block">
                                  <span>Original</span>
                                  <p>{record.original_text}</p>
                                </div>
                                <div className="history-card-block">
                                  <span>Result</span>
                                  <p>{record.translated_text}</p>
                                </div>
                              </div>

                              <div className="history-tag-panel">
                                <div className="history-tag-row">
                                  {record.tags.length > 0 ? (
                                    record.tags.map((tag) => (
                                      <button
                                        key={tag}
                                        className="history-tag-chip"
                                        disabled={deleting}
                                        onClick={() =>
                                          void removeHistoryTag(record.id, record.tags, tag)
                                        }
                                      >
                                        {tag}
                                        <span>×</span>
                                      </button>
                                    ))
                                  ) : (
                                    <span className="history-tag-empty">No tags yet</span>
                                  )}
                                </div>

                                <form
                                  className="history-tag-editor"
                                  onSubmit={(event) => {
                                    event.preventDefault()
                                    void addHistoryTags(record.id, record.tags)
                                  }}
                                >
                                  <input
                                    type="text"
                                    value={historyTagDrafts[record.id] ?? ''}
                                    onChange={(event) =>
                                      setHistoryTagDraft(record.id, event.target.value)
                                    }
                                    placeholder="Add tags (comma separated)"
                                    disabled={deleting}
                                  />
                                  <button className="toolbar-chip" disabled={deleting} type="submit">
                                    Save tags
                                  </button>
                                </form>
                              </div>
                            </article>
                          )
                        })}
                      </div>
                    </section>
                  ))}
                </div>

                <div className="history-pagination">
                  <button
                    className="toolbar-chip"
                    disabled={historyLoading || historyPagination.page <= 1}
                    onClick={() =>
                      void applyHistoryQuery({ page: historyPagination.page - 1 })
                    }
                  >
                    Previous
                  </button>
                  <span>
                    Page {historyPagination.page} of {historyPagination.total_pages}
                  </span>
                  <button
                    className="toolbar-chip"
                    disabled={
                      historyLoading || historyPagination.page >= historyPagination.total_pages
                    }
                    onClick={() =>
                      void applyHistoryQuery({ page: historyPagination.page + 1 })
                    }
                  >
                    Next
                  </button>
                </div>
              </>
            )}
          </section>
        ) : (
          <div className="main-body">
            <textarea
              className="main-textarea"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault()
                  void runTask('auto_process')
                }
              }}
              placeholder="Paste or write something. Press ⌘↵ to improve it."
            />

            <div className="main-footer">
              {status.text ? <div className={`status ${status.kind}`}>{status.text}</div> : null}
            </div>
          </div>
        )}
      </div>

      {showQuickTranslateOverlay ? (
        <div className="popup-overlay" onClick={closeQuickTranslateOverlay}>
          <div
            className={`popup-overlay-dialog popup-frame${isMac ? ' macos-frame' : ''}`}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="popup-bar">
              <span className="popup-bar-title">Quick Translate</span>
              <div className="popup-bar-actions">
                <button className="toolbar-chip" onClick={closeQuickTranslateOverlay}>
                  Close
                </button>
              </div>
            </header>

            <div className="popup-shell">
              <textarea
                ref={overlayInputRef}
                className="popup-textarea"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    closeQuickTranslateOverlay()
                  }

                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault()
                    void runTask('auto_process')
                  }
                }}
                placeholder="Paste or type text to improve…"
              />
            </div>

            <footer className="popup-footer">
              <div className="popup-footer-status">
                {status.text ? <div className={`status ${status.kind}`}>{status.text}</div> : null}
              </div>
              <div className="popup-footer-actions">
                <button className="toolbar-chip" disabled={!previousInput} onClick={undoLastChange}>
                  Undo
                </button>
                <button className="toolbar-chip" onClick={() => void copyOutput()}>
                  Copy
                </button>
                <button
                  className="toolbar-chip toolbar-chip-primary"
                  disabled={busy || loading}
                  onClick={() => void runTask('auto_process')}
                >
                  Improve
                </button>
              </div>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9.75 3.75 5.5 8l4.25 4.25" />
    </svg>
  )
}

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.25 3.75 10.5 8l-4.25 4.25" />
    </svg>
  )
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

export default App
