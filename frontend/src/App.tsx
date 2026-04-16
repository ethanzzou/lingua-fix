import { useEffect, useRef, useState } from 'react'
import './App.css'

type TaskKind = 'auto_process'

type AppConfig = {
  api_key: string
  model: string
}

type StatusKind = 'idle' | 'loading' | 'success' | 'error'

function App() {
  const isQuickTranslatePopup =
    new URLSearchParams(window.location.search).get('popup') === 'quick-translate'
  const popupInputRef = useRef<HTMLTextAreaElement | null>(null)
  const [config, setConfig] = useState<AppConfig>({ api_key: '', model: 'gpt-4.1-mini' })
  const [input, setInput] = useState('')
  const [previousInput, setPreviousInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ kind: StatusKind; text: string }>({
    kind: 'idle',
    text: 'Paste Chinese or English text. Chinese is translated to English; English is polished into natural grammar.',
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

  if (isQuickTranslatePopup) {
    return (
      <div className="popup-shell">
        <header className="popup-header">
          <div>
            <p className="eyebrow">Hotkey popup</p>
            <h1>Quick Improve</h1>
            <p className="hero-copy">
              Press <strong>Esc</strong> to close. Use <strong>Cmd/Ctrl+Shift+L</strong> to open
              this window from anywhere.
            </p>
          </div>
          <button className="secondary ghost" onClick={() => void hideQuickTranslatePopup()}>
            Close
          </button>
        </header>

        <section className="panel popup-panel">
          <div className="panel-heading">
            <div>
              <h2>Auto Process</h2>
              <p>Chinese becomes natural English. English becomes cleaner, more natural English.</p>
            </div>
            <div className={`status ${status.kind}`}>{status.text}</div>
          </div>

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
            placeholder="输入中文或英文，然后按 Cmd/Ctrl+Enter..."
          />

          <div className="action-row">
            <button disabled={busy || loading} onClick={() => void runTask('auto_process')}>
              Improve Text
            </button>
            <button className="secondary" disabled={busy || !previousInput} onClick={undoLastChange}>
              Undo
            </button>
            <button className="secondary" disabled={busy} onClick={() => void copyOutput()}>
              Copy Text
            </button>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Electron + React + TypeScript + Rust</p>
          <h1>LinguaFix</h1>
          <p className="hero-copy">
            Desktop writing help with one automatic flow: Chinese is translated into English, and
            English is rewritten into correct, natural English.
          </p>
        </div>
        <div className="hero-card">
          <div className="hero-label">Model</div>
          <div className="hero-value">{config.model || 'gpt-4.1-mini'}</div>
          <div className="hero-note">
            Quick popup hotkey: <strong>Cmd/Ctrl+Shift+L</strong>
          </div>
        </div>
      </header>

      <section className="panel settings-panel">
        <div className="panel-heading">
          <div>
            <h2>Settings</h2>
            <p>These values are managed by the Rust service and saved in your local config folder.</p>
          </div>
          {loading ? <span className="badge muted">Loading</span> : <span className="badge">Ready</span>}
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
              onChange={(event) => setConfig((current) => ({ ...current, model: event.target.value }))}
              onBlur={() => void persistConfig(config)}
              placeholder="gpt-4.1-mini"
            />
          </label>
        </div>
      </section>

      <section className="panel actions-panel">
        <div className="panel-heading">
          <div>
            <h2>Action</h2>
            <p>One input box, one AI action. The model decides whether to translate or polish.</p>
          </div>
          <div className={`status ${status.kind}`}>{status.text}</div>
        </div>

        <div className="action-row">
          <button disabled={busy || loading} onClick={() => void runTask('auto_process')}>
            Improve Text
          </button>
          <button className="secondary" disabled={busy || !previousInput} onClick={undoLastChange}>
            Undo
          </button>
          <button className="secondary" disabled={busy} onClick={() => void copyOutput()}>
            Copy Text
          </button>
        </div>
      </section>

      <article className="panel editor-panel single-editor">
        <div className="panel-heading">
          <div>
            <h2>Text</h2>
            <p>Paste Chinese or English text here. Processing replaces the text in this same box.</p>
          </div>
        </div>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="If the text is Chinese, it will be translated into English. If it is English, it will be polished."
        />
      </article>
    </div>
  )
}

export default App
