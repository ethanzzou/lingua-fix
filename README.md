# LinguaFix

LinguaFix is a desktop AI writing assistant for fast text rewriting and translation.

It is built for a simple workflow:

- Chinese input -> natural English
- English input -> cleaner, more natural English

The app combines an Electron desktop shell, a React frontend, and a Rust local service. It also includes global shortcuts for quick text processing on macOS.

## Features

- Automatic text handling based on input language
- English rewriting for grammar, spelling, punctuation, and phrasing
- Chinese-to-English translation
- Quick popup workflow for short text edits
- macOS in-place processing for selected text
- English-to-Chinese popup translation shortcut
- Local translation history with search, tags, bookmarks, and pagination
- Configurable model provider, API key, model, prompt, and data directory
- Local SQLite storage

## Shortcuts

- `Ctrl+Shift+L` opens the quick popup
- `Ctrl+Shift+T` processes the current selection in place on macOS
- `Ctrl+Shift+R` translates the current English selection into Simplified Chinese in a popup

The in-place macOS workflow copies the selected text, sends it through LinguaFix, pastes the result back, and restores the clipboard.

## Supported Providers

- OpenAI
- Gemini AI Studio
- Gemini Vertex AI
- DeepSeek
- AWS Bedrock
- Custom OpenAI-compatible APIs

## Tech Stack

- Electron
- React 19
- TypeScript
- Vite
- Rust
- Axum
- SQLite via `rusqlite`

## Project Structure

```text
.
|-- electron/          # Electron main process, preload, shortcuts, tray integration
|-- frontend/          # React UI
|-- src/main.rs        # Rust local API service and persistence layer
|-- scripts/           # Packaging and macOS helper scripts
|-- design/            # Icons and design assets
|-- package.json       # Top-level desktop scripts
`-- Cargo.toml         # Rust dependencies
```

## Getting Started

### Requirements

- Node.js
- npm
- Rust toolchain
- At least one valid API key for a supported provider

### Install

```bash
npm install
npm --prefix frontend install
```

### Run in Development

```bash
npm run dev
```

This starts:

- the Vite frontend dev server
- the Electron desktop app
- the Rust local service, launched by Electron

### Build

```bash
npm run build
npm start
```

### Install as a macOS App

```bash
npm run install:mac-app
```

## Configuration

LinguaFix stores configuration locally in:

- `LinguaFix/config.json`

The configurable fields include:

- provider
- API key
- model
- base URL
- translation prompt
- data directory

Provider notes:

- DeepSeek uses the OpenAI-compatible chat completions API at `https://api.deepseek.com`.
- AWS Bedrock uses the Runtime `InvokeModel` API with Anthropic Claude Messages models. The key field accepts `access_key_id:secret_access_key[:session_token]`, or you can leave it empty and set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally `AWS_SESSION_TOKEN`.
- For Bedrock, the base URL field is used as an AWS region such as `us-east-1`, or as a full Bedrock Runtime endpoint URL. If left blank, LinguaFix uses `AWS_REGION`, then `AWS_DEFAULT_REGION`, then `us-east-1`.

By default, the app also stores translation history locally in:

- `LinguaFix/translations.sqlite3`

You can override the data directory from Settings or with the `LINGUAFIX_DATA_DIR` environment variable.

## History

Processed results are saved locally and can be managed from the history view.

Current history capabilities:

- search
- tag filtering
- bookmark filtering
- sort by newest or oldest
- per-record tags
- per-record bookmarks
- delete individual records
- clear all history

Unbookmarked records are automatically pruned over time. In the current codebase, the retention window is 365 days.

## Architecture

LinguaFix is split into three layers:

- Electron handles the desktop shell, windows, shortcuts, notifications, and IPC
- React handles the UI, settings, popup flows, and history screens
- Rust handles local HTTP APIs, config persistence, provider requests, and SQLite history

The Rust service exposes endpoints for:

- health checks
- config load/save
- text processing
- history listing
- history deletion
- bookmark updates
- tag updates

## Notes

- The macOS in-place replacement workflow requires Accessibility permission because the app simulates copy and paste.
- The Rust service listens on `127.0.0.1` and is started locally by Electron.

## Contributing

Contributions are easiest when changes stay within the existing split:

- Electron changes in `electron/`
- UI changes in `frontend/`
- service and persistence changes in `src/main.rs`

If you add a new text-processing mode or provider, prefer implementing the core behavior in the Rust service rather than spreading request logic across the frontend.
