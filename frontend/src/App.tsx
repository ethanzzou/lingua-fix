import { useEffect, useRef, useState } from 'react'
import './App.css'

type TaskKind = 'grammar_fix' | 'translate_chinese' | 'translate_chinese_to_english'

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
  const [output, setOutput] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ kind: StatusKind; text: string }>({
    kind: 'idle',
    text: 'Enter English text, then choose grammar fix or Chinese translation.',
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
    setOutput('')
    setStatus({
      kind: 'loading',
      text:
        task === 'grammar_fix'
          ? 'Fixing grammar...'
          : task === 'translate_chinese'
            ? 'Translating to Chinese...'
            : 'Translating to English...',
    })

    try {
      const response = await window.linguafix.processText({ task, text: input })
      setOutput(response.output)
      setStatus({ kind: 'success', text: 'Completed.' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request failed.'
      setStatus({ kind: 'error', text: message })
    } finally {
      setBusy(false)
    }
  }

  async function copyOutput() {
    if (!output.trim()) {
      setStatus({ kind: 'error', text: 'There is no output to copy.' })
      return
    }

    try {
      await navigator.clipboard.writeText(output)
      setStatus({ kind: 'success', text: 'Output copied to clipboard.' })
    } catch {
      setStatus({ kind: 'error', text: 'Could not copy output.' })
    }
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
            <h1>Chinese to English</h1>
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
              <h2>Quick Translate</h2>
              <p>Paste Chinese text and translate it into natural English.</p>
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
                void runTask('translate_chinese_to_english')
              }
            }}
            placeholder="输入中文，然后按 Cmd/Ctrl+Enter 翻译成英文..."
          />

          <div className="action-row">
            <button disabled={busy || loading} onClick={() => void runTask('translate_chinese_to_english')}>
              Translate to English
            </button>
            <button className="secondary" disabled={busy} onClick={() => void copyOutput()}>
              Copy Output
            </button>
          </div>

          <textarea
            className="popup-textarea output"
            value={output}
            readOnly
            placeholder="English output appears here..."
          />
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
            Desktop writing help for English cleanup and English-to-Chinese translation, with a
            React renderer and a local Rust service.
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
            <h2>Actions</h2>
            <p>Run one task at a time against the local Rust service.</p>
          </div>
          <div className={`status ${status.kind}`}>{status.text}</div>
        </div>

        <div className="action-row">
          <button disabled={busy || loading} onClick={() => void runTask('grammar_fix')}>
            Fix English Grammar
          </button>
          <button disabled={busy || loading} onClick={() => void runTask('translate_chinese')}>
            Translate to Chinese
          </button>
          <button disabled={busy || loading} onClick={() => void runTask('translate_chinese_to_english')}>
            Translate Chinese to English
          </button>
          <button className="secondary" disabled={busy} onClick={() => void copyOutput()}>
            Copy Output
          </button>
        </div>
      </section>

      <section className="workspace">
        <article className="panel editor-panel">
          <div className="panel-heading">
            <div>
              <h2>English Input</h2>
              <p>Paste or write the original English text here.</p>
            </div>
          </div>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Write the English text you want to improve or translate..."
          />
        </article>

        <article className="panel editor-panel">
          <div className="panel-heading">
            <div>
              <h2>Output</h2>
              <p>The corrected English or Simplified Chinese translation appears here.</p>
            </div>
          </div>
          <textarea value={output} readOnly placeholder="The response will appear here..." />
        </article>
      </section>
    </div>
  )
}

export default App
