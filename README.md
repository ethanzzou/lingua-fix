# LinguaFix

LinguaFix now uses the same general app split you asked for:

- Electron for the desktop shell
- React + TypeScript for the renderer UI
- Rust for the local backend service

The app supports one automatic AI action:

- If the input is Chinese, it translates it into natural English
- If the input is English, it rewrites it into correct, natural English

The system prompt used for that behavior is configurable from the Settings screen.

Each translation is logged locally with:

- the original input text
- the translated or rewritten result

Logs are stored in a SQLite database named `translations.sqlite3`, and records older than 30 days are removed automatically.

Translation history is available on a dedicated page with pagination, grouping, search and tag filters, per-record tagging, individual deletion, and clear-all controls.

On macOS, LinguaFix also supports an in-place shortcut workflow:

- Select text in another app
- Press `Ctrl+Shift+T`
- LinguaFix copies the selection, processes it, pastes the result back, and restores your clipboard

If there is no active text selection, LinguaFix shows a notification instead of opening a popup.

The popup shortcut is:

- Press `Ctrl+Shift+L` to open the quick-translate popup
- Press `Ctrl+Shift+R` to translate the current English selection into Chinese and show the result in a popup

## Requirements

- Node.js
- npm
- Rust toolchain
- An OpenAI API key

For the in-place shortcut on macOS, you also need to allow Accessibility access for the app so it can send copy and paste keystrokes to the active application.

## Development

```bash
npm install
npm --prefix frontend install
npm run dev
```

That starts:

- the Vite React dev server
- the Electron desktop shell
- the Rust local service, spawned by Electron

## Build

```bash
npm run build
npm start
```

This builds the React frontend and the Rust release binary, then launches the app from the local source checkout using the built assets.

## Architecture

- `frontend/`: React + TypeScript UI
- `electron/`: Electron main and preload scripts
- `src/main.rs`: Rust HTTP service that stores config locally and calls OpenAI

The API key, selected model, translation prompt, and configured data directory are stored in your platform config directory under `LinguaFix/config.json`.

By default, translation logs are written to your platform-local data directory under `LinguaFix/translations.sqlite3`. You can override that location from Settings or with the `LINGUAFIX_DATA_DIR` environment variable.
