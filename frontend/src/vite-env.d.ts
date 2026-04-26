/// <reference types="vite/client" />

import type {
  ActionResponse,
  AppConfig,
  HistoryRequestQuery,
  HistoryResponse,
  PopupSession,
  ProcessRequest,
  ProcessResponse,
} from './types'

declare global {
  interface Window {
    linguafix: {
      getConfig: () => Promise<AppConfig>
      getHistory: (query?: HistoryRequestQuery) => Promise<HistoryResponse>
      deleteHistoryRecord: (id: number) => Promise<ActionResponse>
      setHistoryRecordBookmark: (id: number, isBookmarked: boolean) => Promise<ActionResponse>
      updateHistoryRecordTags: (id: number, tags: string[]) => Promise<ActionResponse>
      clearHistory: () => Promise<ActionResponse>
      saveConfig: (config: AppConfig) => Promise<AppConfig>
      processText: (request: ProcessRequest) => Promise<ProcessResponse>
      hidePopup: () => Promise<void>
      onPopupSession: (callback: (session: PopupSession) => void) => () => void
      onShowQuickTranslateOverlay: (callback: () => void) => () => void
    }
  }
}

export {}
