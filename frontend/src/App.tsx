import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_HISTORY_QUERY,
  HISTORY_PAGE_SIZE_OPTIONS,
  formatHistoryTimestamp,
  getHistoryGroups,
  parseTagDraft,
} from './history'
import { getLinguaFixClient } from './linguafixClient'
import {
  DEFAULT_TRANSLATION_PROMPT,
  PROVIDER_BASE_URL_HINTS,
  PROVIDER_BASE_URL_PLACEHOLDERS,
  PROVIDER_KEY_HINTS,
  PROVIDER_KEY_LABELS,
  PROVIDER_KEY_PLACEHOLDERS,
  PROVIDER_LABELS,
  PROVIDER_MODEL_PLACEHOLDERS,
} from './providers'
import type {
  AppConfig,
  BookmarkStatusFilter,
  GroupMode,
  HistoryPagination,
  HistoryQuery,
  HistoryRecord,
  HistorySort,
  HistoryTagSummary,
  PopupMode,
  Provider,
  StatusKind,
  TaskKind,
} from './types'
import './App.css'

type Page = 'main' | 'history' | 'settings'

function App() {
  const linguafix = useMemo(() => getLinguaFixClient(), [])
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
    selection_popup_enabled: true,
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
  const [historyBusyIds, setHistoryBusyIds] = useState<Set<number>>(() => new Set())
  const [historyClearing, setHistoryClearing] = useState(false)
  const [historyTagDrafts, setHistoryTagDrafts] = useState<Record<number, string>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [showQuickTranslateOverlay, setShowQuickTranslateOverlay] = useState(false)
  const [popupMode, setPopupMode] = useState<PopupMode>('manual')
  const [status, setStatus] = useState<{ kind: StatusKind; text: string }>({
    kind: 'idle',
    text: '',
  })
  const hasInput = input.trim().length > 0
  const canRunTask = hasInput && !busy && !loading
  const historyGroups = useMemo(
    () => getHistoryGroups(history, historyGroupBy),
    [history, historyGroupBy],
  )
  const textStats = useMemo(() => getTextStats(input), [input])

  const loadHistory = useCallback(async (nextQuery: HistoryQuery) => {
    setHistoryError('')

    try {
      const response = await linguafix.getHistory({
        page: nextQuery.page,
        page_size: nextQuery.page_size,
        search: nextQuery.search || undefined,
        tag: nextQuery.tag || undefined,
        bookmark_status:
          nextQuery.bookmark_status === 'all' ? undefined : nextQuery.bookmark_status,
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
  }, [linguafix])

  useEffect(() => {
    linguafix
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
  }, [linguafix, loadHistory])

  useEffect(() => {
    if (!isQuickTranslatePopup) {
      return
    }

    const unsubscribe = linguafix.onPopupSession((session) => {
      setPopupMode(session.mode)

      if (typeof session.input === 'string') {
        setPreviousInput(session.source_text ?? '')
        setInput(session.input)
      }

      if (session.mode === 'selection_translation') {
        setStatus({ kind: 'success', text: 'Selected text translated to Chinese.' })
      } else {
        setStatus({ kind: 'idle', text: '' })
      }

      window.setTimeout(() => popupInputRef.current?.focus(), 0)
    })

    popupInputRef.current?.focus()

    const handleVisibility = () => {
      popupInputRef.current?.focus()
    }

    window.addEventListener('focus', handleVisibility)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', handleVisibility)
    }
  }, [isQuickTranslatePopup, linguafix])

  useEffect(() => {
    if (isQuickTranslatePopup) {
      return
    }

    return linguafix.onShowQuickTranslateOverlay(() => {
      setShowQuickTranslateOverlay(true)
      window.setTimeout(() => overlayInputRef.current?.focus(), 0)
    })
  }, [isQuickTranslatePopup, linguafix])

  useEffect(() => {
    if (!showQuickTranslateOverlay) {
      return
    }

    overlayInputRef.current?.focus()
  }, [showQuickTranslateOverlay])

  async function persistConfig(nextConfig: AppConfig) {
    setConfig(nextConfig)

    try {
      const savedConfig = await linguafix.saveConfig(nextConfig)
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
      const response = await linguafix.processText({ task, text: input })
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
      await linguafix.hidePopup()
    } catch {
      // Ignore close errors.
    }
  }

  function closeQuickTranslateOverlay() {
    setShowQuickTranslateOverlay(false)
  }

  function setHistoryTagDraft(id: number, value: string) {
    setHistoryTagDrafts((current) => ({ ...current, [id]: value }))
  }

  function setHistoryRecordBusy(id: number, isBusy: boolean) {
    setHistoryBusyIds((current) => {
      const next = new Set(current)

      if (isBusy) {
        next.add(id)
      } else {
        next.delete(id)
      }

      return next
    })
  }

  async function refreshHistory(showSuccess = false) {
    setHistoryLoading(true)
    const ok = await loadHistory(historyQuery)

    if (showSuccess && ok) {
      setStatus({ kind: 'success', text: 'History refreshed.' })
    }
  }

  async function deleteHistoryRecord(record: HistoryRecord) {
    if (record.is_bookmarked) {
      setStatus({ kind: 'error', text: 'Remove the bookmark before deleting this history record.' })
      return
    }

    if (!window.confirm('Delete this history record?')) {
      return
    }

    setHistoryRecordBusy(record.id, true)

    try {
      await linguafix.deleteHistoryRecord(record.id)
      setHistoryLoading(true)
      const ok = await loadHistory(historyQuery)
      if (!ok) {
        return
      }
      setHistoryTagDrafts((current) => {
        const nextDrafts = { ...current }
        delete nextDrafts[record.id]
        return nextDrafts
      })
      setStatus({ kind: 'success', text: 'History record deleted.' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not delete history record.'
      setStatus({ kind: 'error', text: message })
    } finally {
      setHistoryRecordBusy(record.id, false)
    }
  }

  async function clearHistory() {
    if (!history.length) {
      return
    }

    if (!window.confirm('Delete all unbookmarked history records? Bookmarked items will be kept.')) {
      return
    }

    setHistoryClearing(true)

    try {
      await linguafix.clearHistory()
      setHistoryLoading(true)
      const ok = await loadHistory({ ...historyQuery, page: 1 })
      if (!ok) {
        return
      }
      setHistoryTagDrafts({})
      setStatus({ kind: 'success', text: 'Unbookmarked history cleared. Bookmarks kept.' })
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

  async function updateHistoryTags(id: number, nextTags: string[]) {
    setHistoryRecordBusy(id, true)

    try {
      await linguafix.updateHistoryRecordTags(id, nextTags)
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
      setHistoryRecordBusy(id, false)
    }
  }

  async function toggleHistoryBookmark(record: HistoryRecord) {
    setHistoryRecordBusy(record.id, true)

    try {
      await linguafix.setHistoryRecordBookmark(record.id, !record.is_bookmarked)
      setHistoryLoading(true)
      const ok = await loadHistory(historyQuery)
      if (!ok) {
        return
      }
      setStatus({
        kind: 'success',
        text: record.is_bookmarked ? 'Bookmark removed.' : 'History record bookmarked.',
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Could not update bookmark state.'
      setStatus({ kind: 'error', text: message })
    } finally {
      setHistoryRecordBusy(record.id, false)
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

  const pageTitle =
    page === 'settings' ? 'Application Settings' : page === 'history' ? 'Translation History' : 'LinguaFix'
  const pageSubtitle =
    page === 'settings'
      ? 'Local configuration'
      : page === 'history'
        ? 'Saved translations'
        : 'Writing Studio'
  const isSelectionTranslationPopup = popupMode === 'selection_translation'
  const popupTitle = isSelectionTranslationPopup ? 'Selection Translation' : 'Quick Translate'

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

  function renderTextActionButtons({
    includeUndo = true,
    includeImprove = true,
  }: {
    includeUndo?: boolean
    includeImprove?: boolean
  } = {}) {
    return (
      <>
        <button className="toolbar-chip" disabled={!hasInput} onClick={() => void copyOutput()}>
          Copy
        </button>
        {includeUndo ? (
          <button className="toolbar-chip" disabled={!previousInput} onClick={undoLastChange}>
            Undo
          </button>
        ) : null}
        {includeImprove ? (
          <button
            className="toolbar-chip toolbar-chip-primary"
            disabled={!canRunTask}
            onClick={() => void runTask('auto_process')}
          >
            Improve
          </button>
        ) : null}
      </>
    )
  }

  if (isQuickTranslatePopup) {
    return (
      <div className={`app-frame popup-frame${isMac ? ' macos-frame' : ''}`}>
        <header className="popup-bar">
          <span className="popup-bar-title">{popupTitle}</span>
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
            readOnly={isSelectionTranslationPopup}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                void hideQuickTranslatePopup()
              }

              if (
                !isSelectionTranslationPopup &&
                canRunTask &&
                (event.metaKey || event.ctrlKey) &&
                event.key === 'Enter'
              ) {
                event.preventDefault()
                void runTask('auto_process')
              }
            }}
            placeholder={
              isSelectionTranslationPopup
                ? 'Chinese translation'
                : 'Text to improve'
            }
          />
        </div>

        <footer className="popup-footer">
          <div className="popup-footer-status">
            {status.text ? <div className={`status ${status.kind}`}>{status.text}</div> : null}
          </div>
          <div className="popup-footer-actions">
            {renderTextActionButtons({
              includeUndo: !isSelectionTranslationPopup,
              includeImprove: !isSelectionTranslationPopup,
            })}
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
              {renderTextActionButtons()}
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
                Clear
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

      <div className={`app-shell app-shell-${page}`}>
        {page === 'settings' ? (
          <section className="panel settings-panel">
            <div className="panel-heading">
              <div>
                <h2>Application Settings</h2>
              </div>
            </div>

            <div className="settings-grid">
              <label className="settings-row">
                <span>Provider</span>
                <div className="settings-control">
                  <select
                    value={config.provider}
                    onChange={(event) => {
                      const provider = event.target.value as Provider
                      const nextConfig = {
                        ...config,
                        provider,
                        api_key: '',
                        model: '',
                        base_url: '',
                      }
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
                </div>
              </label>

              <label className="settings-row">
                <span>Model</span>
                <div className="settings-control">
                  <input
                    type="text"
                    value={config.model}
                    onChange={(event) =>
                      setConfig((current) => ({ ...current, model: event.target.value }))
                    }
                    onBlur={() => void persistConfig(config)}
                    placeholder={PROVIDER_MODEL_PLACEHOLDERS[config.provider]}
                  />
                </div>
              </label>

              <label className="settings-row">
                <span>{PROVIDER_KEY_LABELS[config.provider]}</span>
                <div className="settings-control">
                  <input
                    type="password"
                    value={config.api_key}
                    onChange={(event) =>
                      setConfig((current) => ({ ...current, api_key: event.target.value }))
                    }
                    onBlur={() => void persistConfig(config)}
                    placeholder={PROVIDER_KEY_PLACEHOLDERS[config.provider]}
                  />
                  {PROVIDER_KEY_HINTS[config.provider] && (
                    <small>{PROVIDER_KEY_HINTS[config.provider]}</small>
                  )}
                </div>
              </label>

              {(config.provider === 'gemini_vertex' ||
                config.provider === 'aws_bedrock' ||
                config.provider === 'custom_open_ai') && (
                <label className="settings-row">
                  <span>
                    {config.provider === 'gemini_vertex'
                      ? 'Vertex endpoint'
                      : config.provider === 'aws_bedrock'
                        ? 'AWS region or endpoint'
                        : 'Base URL'}
                  </span>
                  <div className="settings-control">
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
                  </div>
                </label>
              )}

              <label className="settings-row">
                <span>Data directory</span>
                <div className="settings-control">
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
                    directory. Entries older than one year are removed automatically unless
                    bookmarked.
                  </small>
                </div>
              </label>

              <div className="settings-row">
                <span>Selection translation</span>
                <div className="settings-control">
                  <div className="settings-action-row">
                    <button
                      type="button"
                      className={`toolbar-chip${config.selection_popup_enabled ? ' toolbar-chip-primary' : ''}`}
                      onClick={() => {
                        const nextConfig = {
                          ...config,
                          selection_popup_enabled: !config.selection_popup_enabled,
                        }
                        setConfig(nextConfig)
                        void persistConfig(nextConfig)
                      }}
                    >
                      {config.selection_popup_enabled ? 'On' : 'Off'}
                    </button>
                  </div>
                  <small>
                    Show a floating translation icon when you select text with the mouse in any
                    app (macOS). Requires Accessibility and Input Monitoring permissions.
                  </small>
                </div>
              </div>

              <label className="settings-row settings-row-prompt">
                <span>Translation prompt</span>
                <div className="settings-control">
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
                </div>
              </label>
            </div>
          </section>
        ) : page === 'history' ? (
          <section className="panel history-page">
            <div className="panel-heading">
              <div>
                <h2 data-index="02">Translation History</h2>
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

              <label className="history-filter">
                <span>Bookmark Status</span>
                <select
                  value={historyQuery.bookmark_status}
                  onChange={(event) =>
                    void applyHistoryQuery({
                      page: 1,
                      bookmark_status: event.target.value as BookmarkStatusFilter,
                    })
                  }
                >
                  <option value="all">All</option>
                  <option value="bookmarked">Bookmarked</option>
                  <option value="unbookmarked">Unbookmarked</option>
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
                  Clear unbookmarked
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
                No translation records yet.
              </div>
            ) : (
              <>
                <div className="history-group-list">
                  {historyGroups.map((group) => (
                    <section key={group.key} className="history-group">
                      <div className="history-group-header">
                        <h3>{group.label}</h3>
                        <span>{group.records.length}</span>
                      </div>

                      <div className="history-list history-list-page">
                        {group.records.map((record) => {
                          const busy = historyClearing || historyBusyIds.has(record.id)

                          return (
                            <article key={record.id} className="history-card history-card-page">
                              <div className="history-card-meta">
                                <div className="history-card-meta-primary">
                                  <span>{formatHistoryTimestamp(record.created_at)}</span>
                                  {record.is_bookmarked ? (
                                    <span className="history-bookmark-badge">Bookmarked</span>
                                  ) : null}
                                </div>
                                <div className="history-card-actions">
                                  <button
                                    className={`toolbar-chip${record.is_bookmarked ? ' toolbar-chip-primary' : ''}`}
                                    disabled={busy}
                                    onClick={() => void toggleHistoryBookmark(record)}
                                  >
                                    {record.is_bookmarked ? 'Bookmarked' : 'Bookmark'}
                                  </button>
                                  <button
                                    className="toolbar-chip toolbar-chip-danger"
                                    disabled={busy || record.is_bookmarked}
                                    onClick={() => void deleteHistoryRecord(record)}
                                  >
                                    Delete
                                  </button>
                                </div>
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
                                        disabled={busy}
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
                                    placeholder="Tags"
                                    disabled={busy}
                                  />
                                  <button className="toolbar-chip" disabled={busy} type="submit">
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
            <div className="editor-surface">
              <div className="editor-meta">
                <span>{textStats.words} Words</span>
                <span>{textStats.characters} Characters</span>
              </div>
              <textarea
                className="main-textarea"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    canRunTask &&
                    (event.metaKey || event.ctrlKey) &&
                    event.key === 'Enter'
                  ) {
                    event.preventDefault()
                    void runTask('auto_process')
                  }
                }}
                placeholder="Draft text"
              />
            </div>

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

                  if (canRunTask && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault()
                    void runTask('auto_process')
                  }
                }}
                placeholder="Text to improve"
              />
            </div>

            <footer className="popup-footer">
              <div className="popup-footer-status">
                {status.text ? <div className={`status ${status.kind}`}>{status.text}</div> : null}
              </div>
              <div className="popup-footer-actions">
                {renderTextActionButtons()}
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

function getTextStats(value: string) {
  const words = value.trim() ? value.trim().split(/\s+/).length : 0

  return {
    characters: value.length,
    words,
  }
}

export default App
