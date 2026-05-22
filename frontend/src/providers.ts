import type { Provider } from './types'

export const DEFAULT_TRANSLATION_PROMPT =
  `You are a bilingual Chinese-English writing assistant. Your only task is to transform the user's text without answering it or adding commentary.

Determine the primary language of the input:
- If the input is primarily Chinese, translate it into natural, fluent English while preserving the original meaning, tone, intent, and level of formality.
- If the input is primarily English, rewrite it into correct, natural English with improved grammar, spelling, punctuation, word choice, and phrasing while preserving the original meaning and tone.

Preserve names, technical terms, numbers, URLs, code, and formatting unless a minor language correction is clearly needed. Do not add new information, omit meaning, summarize, explain, or change the user's intent.

Return only the final transformed text.`

export const PROVIDER_LABELS: Record<Provider, string> = {
  open_ai: 'OpenAI',
  gemini_ai_studio: 'Gemini AI Studio',
  gemini_vertex: 'Gemini Vertex AI',
  custom_open_ai: 'Custom (OpenAI-compatible)',
}

export const PROVIDER_KEY_LABELS: Record<Provider, string> = {
  open_ai: 'OpenAI API key',
  gemini_ai_studio: 'Google AI Studio API key',
  gemini_vertex: 'Google Cloud API key or OAuth access token',
  custom_open_ai: 'API key',
}

export const PROVIDER_KEY_PLACEHOLDERS: Record<Provider, string> = {
  open_ai: 'sk-...',
  gemini_ai_studio: 'AIza...',
  gemini_vertex: 'AIza... or gcloud auth print-access-token',
  custom_open_ai: 'API key',
}

export const PROVIDER_KEY_HINTS: Partial<Record<Provider, string>> = {
  gemini_vertex:
    'Vertex accepts a Google Cloud API key or an OAuth token. AI Studio API keys do not work here.',
}

export const PROVIDER_MODEL_PLACEHOLDERS: Record<Provider, string> = {
  open_ai: 'gpt-4.1-mini',
  gemini_ai_studio: 'gemini-3.5-flash',
  gemini_vertex: 'gemini-3.5-flash',
  custom_open_ai: 'model name',
}

export const PROVIDER_BASE_URL_PLACEHOLDERS: Record<Provider, string> = {
  open_ai: '',
  gemini_ai_studio: '',
  gemini_vertex:
    'https://aiplatform.googleapis.com/v1/projects/MY_PROJECT/locations/global',
  custom_open_ai: 'https://api.together.xyz',
}

export const PROVIDER_BASE_URL_HINTS: Partial<Record<Provider, string>> = {
  gemini_vertex:
    'Optional. Leave this blank to use your active gcloud project, or the global express-mode endpoint when using only a Vertex API key.',
  custom_open_ai:
    'Required for deployed Model Garden OpenAI-compatible endpoints and other OpenAI-style APIs.',
}
