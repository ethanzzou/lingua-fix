/// <reference types="vite/client" />

type LinguaFixConfig = {
  api_key: string
  model: string
}

type LinguaFixTask = 'grammar_fix' | 'translate_chinese' | 'translate_chinese_to_english'

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
  }
}
