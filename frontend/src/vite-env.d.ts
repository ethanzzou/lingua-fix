/// <reference types="vite/client" />

type LinguaFixConfig = {
  api_key: string
  model: string
}

type LinguaFixTask = 'auto_process'

type LinguaFixProcessRequest = {
  task: LinguaFixTask
  text: string
}

type LinguaFixProcessResponse = {
  output: string
}

interface Window {
  linguafix: {
    getConfig: () => Promise<LinguaFixConfig>
    saveConfig: (config: LinguaFixConfig) => Promise<LinguaFixConfig>
    processText: (request: LinguaFixProcessRequest) => Promise<LinguaFixProcessResponse>
    hidePopup: () => Promise<void>
    onPopulateQuickTranslateInput: (callback: (text: string) => void) => () => void
    onShowQuickTranslateOverlay: (callback: () => void) => () => void
  }
}
