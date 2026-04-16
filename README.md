# LinguaFix

LinguaFix now uses the same general app split you asked for:

- Electron for the desktop shell
- React + TypeScript for the renderer UI
- Rust for the local backend service

The app supports two AI actions:

- Fix English grammar
- Translate English to Simplified Chinese

## Requirements

- Node.js
- npm
- Rust toolchain
- An OpenAI API key

## Development

```bash
npm install
npm run dev
```

That starts:

- the Vite React dev server
- the Electron desktop shell
- the Rust local service, spawned by Electron

## Build

```bash
npm run build
```

This builds the React frontend and the Rust release binary.

## Architecture

- `frontend/`: React + TypeScript UI
- `electron/`: Electron main and preload scripts
- `src/main.rs`: Rust HTTP service that stores config locally and calls OpenAI

The API key and selected model are stored in your platform config directory under `LinguaFix/config.json`.
