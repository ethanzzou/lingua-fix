import { useEffect, useRef, useState } from 'react'
import './App.css'

type TaskKind = 'auto_process'

type AppConfig = {
  api_key: string
  model: string
}

type StatusKind = 'idle' | 'loading' | 'success' | 'error'

type Page = 'main' | 'settings'

function App() {
  const isQuickTranslatePopup =
    new URLSearchParams(window.location.search).get('popup') === 'quick-translate'
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  const popupInputRef = useRef<HTMLTextAreaElement | null>(null)
  const overlayInputRef = useRef<HTMLTextAreaElement | null>(null)
  const [page, setPage] = useState<Page>('main')
  const [config, setConfig] = useState<AppConfig>({ api_key: '', model: 'gpt-4.1-mini' })
  const [input, setInput] = useState('')
  const [previousInput, setPreviousInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [showQuickTranslateOverlay, setShowQuickTranslateOverlay] = useState(false)
  const [status, setStatus] = useState<{ kind: StatusKind; text: string }>({
    kind: 'idle',
    text: '',
  })

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
      await window.linguafix.saveConfig(nextConfig)
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
          <span className="control-bar-title-primary">
            {page === 'settings' ? 'Application Settings' : 'LinguaFix'}
          </span>
          <span className="control-bar-title-secondary">
            {page === 'settings' ? 'Local configuration' : 'Writing Studio'}
          </span>
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
              <button className="toolbar-chip" onClick={() => setPage('settings')}>
                Settings
              </button>
            </>
          ) : (
            <button className="toolbar-chip" onClick={() => setPage('main')}>
              Back
            </button>
          )}
        </div>
      </header>

      <div className="app-shell">
        {page === 'settings' ? (
          <section className="panel settings-panel">
            <div className="panel-heading">
              <div>
                <h2 data-index="01">Model Parameters</h2>
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
                <span>OpenAI API key</span>
                <input
                  type="password"
                  value={config.api_key}
                  onChange={(event) =>
                    setConfig((current) => ({ ...current, api_key: event.target.value }))
                  }
                  onBlur={() => void persistConfig(config)}
                  placeholder="sk-..."
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
                  placeholder="gpt-4.1-mini"
                />
              </label>
            </div>
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

export default App
