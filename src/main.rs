use std::env;
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use std::{cmp, collections::HashSet};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use hmac::{Hmac, Mac};
use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, Transaction, params, params_from_iter};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::format_description::FormatItem;
use time::macros::format_description;

const APP_NAME: &str = "LinguaFix";
const DEFAULT_PORT: u16 = 8787;
const BEDROCK_SERVICE: &str = "bedrock";
const BEDROCK_SIGNING_TERMINATOR: &str = "aws4_request";
const BEDROCK_MODEL_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}')
    .add(b'/')
    .add(b':');
const AMZ_DATE_FORMAT: &[FormatItem<'static>] =
    format_description!("[year][month][day]T[hour][minute][second]Z");
const AWS_DATE_FORMAT: &[FormatItem<'static>] = format_description!("[year][month][day]");
const DEFAULT_TRANSLATION_PROMPT: &str = r#"You are a bilingual Chinese-English writing assistant. Your only task is to transform the user's text without answering it or adding commentary.

Determine the primary language of the input:
- If the input is primarily Chinese, translate it into natural, fluent English while preserving the original meaning, tone, intent, and level of formality.
- If the input is primarily English, rewrite it into correct, natural English with improved grammar, spelling, punctuation, word choice, and phrasing while preserving the original meaning and tone.

Preserve names, technical terms, numbers, URLs, code, and formatting unless a minor language correction is clearly needed. Do not add new information, omit meaning, summarize, explain, or change the user's intent.

Return only the final transformed text."#;
const DEFAULT_ENGLISH_TO_CHINESE_PROMPT: &str = "Translate the English input into natural, accurate Simplified Chinese while preserving meaning, tone, and formatting when possible. Return only the final Chinese translation with no explanation.";
const TRANSLATION_LOG_FILE_NAME: &str = "translations.sqlite3";
const TRANSLATION_LOG_RETENTION_SECONDS: i64 = 365 * 24 * 60 * 60;
const DEFAULT_HISTORY_PAGE_SIZE: usize = 12;
const MAX_HISTORY_PAGE_SIZE: usize = 100;

#[tokio::main]
async fn main() -> Result<(), String> {
    let port = env::var("LINGUAFIX_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);

    let state = AppState {};
    let app = Router::new()
        .route("/health", get(health))
        .route("/config", get(get_config).put(save_config))
        .route("/api/history", get(get_history).delete(clear_history))
        .route("/api/history/{id}", delete(delete_history_entry))
        .route("/api/history/{id}/bookmark", put(update_history_bookmark))
        .route("/api/history/{id}/tags", put(update_history_tags))
        .route("/api/process", post(process_text))
        .with_state(state);

    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|error| format!("Could not bind service: {error}"))?;

    axum::serve(listener, app)
        .await
        .map_err(|error| format!("Service failed: {error}"))
}

#[derive(Clone)]
struct AppState {}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}

async fn get_config() -> Result<Json<AppConfig>, ApiError> {
    Ok(Json(AppConfig::load()))
}

async fn save_config(Json(config): Json<AppConfig>) -> Result<Json<AppConfig>, ApiError> {
    let default_model = config.provider.default_model();
    let normalized = AppConfig {
        provider: config.provider,
        api_key: config.api_key.trim().to_owned(),
        model: if config.model.trim().is_empty() {
            default_model.to_owned()
        } else {
            config.model.trim().to_owned()
        },
        base_url: config.base_url.trim().to_owned(),
        translation_prompt: normalize_translation_prompt(&config.translation_prompt),
        data_dir: normalize_data_dir(&config.data_dir),
    };

    TranslationLogStore::prepare(PathBuf::from(&normalized.data_dir))
        .map_err(|error| ApiError::bad_request(format!("Could not use data directory: {error}")))?;

    normalized
        .save()
        .map_err(|error| ApiError::internal(format!("Could not save config: {error}")))?;

    Ok(Json(normalized))
}

async fn process_text(
    State(_state): State<AppState>,
    Json(request): Json<ProcessRequest>,
) -> Result<Json<ProcessResponse>, ApiError> {
    let AppConfig {
        provider,
        api_key,
        model,
        base_url,
        translation_prompt,
        data_dir,
    } = AppConfig::load();
    let text = request.text.trim().to_owned();

    if text.is_empty() {
        return Err(ApiError::bad_request("Input text is empty."));
    }

    if api_key.trim().is_empty() && !matches!(provider, Provider::AwsBedrock) {
        return Err(ApiError::bad_request(
            "API key is missing. Save it in settings first.",
        ));
    }

    if matches!(provider, Provider::CustomOpenAi) && base_url.trim().is_empty() {
        return Err(ApiError::bad_request(
            "Base URL is required for this provider. Save it in settings first.",
        ));
    }

    let task = request.task;
    let system_prompt = task.system_prompt(&translation_prompt).to_owned();
    let output = match provider {
        Provider::OpenAi => {
            OpenAiClient { api_key, model }
                .run(&system_prompt, &text)
                .await
        }
        Provider::GeminiAiStudio => {
            GeminiClient {
                api_key,
                model,
                base_url: "https://generativelanguage.googleapis.com/v1beta".to_owned(),
                api: GeminiApi::AiStudio,
                auth: GeminiAuth::ApiKey,
            }
            .run(&system_prompt, &text)
            .await
        }
        Provider::GeminiVertex => {
            run_vertex_request(api_key, model, base_url, &system_prompt, &text).await
        }
        Provider::DeepSeek => {
            DeepSeekClient { api_key, model }
                .run(&system_prompt, &text)
                .await
        }
        Provider::AwsBedrock => {
            BedrockClient {
                credentials: BedrockCredentials::load(&api_key).map_err(ApiError::bad_request)?,
                model,
                endpoint: base_url,
            }
            .run(&system_prompt, &text)
            .await
        }
        Provider::CustomOpenAi => {
            ChatCompletionsClient {
                api_key,
                model,
                base_url,
            }
            .run(&system_prompt, &text)
            .await
        }
    }
    .map_err(ApiError::internal)?;

    let original_text = text;
    let translated_text = output.clone();
    let log_result = tokio::task::spawn_blocking(move || {
        TranslationLogStore::record(PathBuf::from(data_dir), original_text, translated_text)
    })
    .await;

    match log_result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("[LinguaFix] Could not log translation: {error}"),
        Err(error) => eprintln!("[LinguaFix] Could not join translation logger: {error}"),
    }

    Ok(Json(ProcessResponse { output }))
}

async fn get_history(Query(query): Query<HistoryQuery>) -> Result<Json<HistoryResponse>, ApiError> {
    let data_dir = AppConfig::load().data_dir;
    let normalized_query = NormalizedHistoryQuery::new(query);
    let response = tokio::task::spawn_blocking(move || {
        TranslationLogStore::list(PathBuf::from(data_dir), normalized_query)
    })
    .await
    .map_err(|error| {
        ApiError::internal(format!(
            "Could not join translation history loader: {error}"
        ))
    })?
    .map_err(ApiError::internal)?;

    Ok(Json(response))
}

async fn delete_history_entry(Path(id): Path<i64>) -> Result<Json<ActionResponse>, ApiError> {
    let data_dir = AppConfig::load().data_dir;
    let outcome = tokio::task::spawn_blocking(move || {
        TranslationLogStore::delete(PathBuf::from(data_dir), id)
    })
    .await
    .map_err(|error| {
        ApiError::internal(format!(
            "Could not join translation history delete operation: {error}"
        ))
    })?
    .map_err(ApiError::internal)?;

    match outcome {
        DeleteHistoryResult::Deleted => Ok(Json(ActionResponse { ok: true })),
        DeleteHistoryResult::Protected => Err(ApiError::bad_request(
            "Bookmarked history records cannot be deleted.",
        )),
        DeleteHistoryResult::Missing => Err(ApiError::not_found("History record was not found.")),
    }
}

async fn clear_history() -> Result<Json<ActionResponse>, ApiError> {
    let data_dir = AppConfig::load().data_dir;
    tokio::task::spawn_blocking(move || TranslationLogStore::clear(PathBuf::from(data_dir)))
        .await
        .map_err(|error| {
            ApiError::internal(format!(
                "Could not join translation history clear operation: {error}"
            ))
        })?
        .map_err(ApiError::internal)?;

    Ok(Json(ActionResponse { ok: true }))
}

async fn update_history_tags(
    Path(id): Path<i64>,
    Json(request): Json<UpdateTagsRequest>,
) -> Result<Json<ActionResponse>, ApiError> {
    let data_dir = AppConfig::load().data_dir;
    let updated = tokio::task::spawn_blocking(move || {
        TranslationLogStore::replace_tags(PathBuf::from(data_dir), id, request.tags)
    })
    .await
    .map_err(|error| {
        ApiError::internal(format!(
            "Could not join translation history tag update operation: {error}"
        ))
    })?
    .map_err(ApiError::internal)?;

    if !updated {
        return Err(ApiError::not_found("History record was not found."));
    }

    Ok(Json(ActionResponse { ok: true }))
}

async fn update_history_bookmark(
    Path(id): Path<i64>,
    Json(request): Json<UpdateBookmarkRequest>,
) -> Result<Json<ActionResponse>, ApiError> {
    let data_dir = AppConfig::load().data_dir;
    let updated = tokio::task::spawn_blocking(move || {
        TranslationLogStore::set_bookmark(PathBuf::from(data_dir), id, request.is_bookmarked)
    })
    .await
    .map_err(|error| {
        ApiError::internal(format!(
            "Could not join translation history bookmark update operation: {error}"
        ))
    })?
    .map_err(ApiError::internal)?;

    if !updated {
        return Err(ApiError::not_found("History record was not found."));
    }

    Ok(Json(ActionResponse { ok: true }))
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
}

#[derive(Serialize)]
struct HistoryResponse {
    records: Vec<TranslationRecord>,
    pagination: HistoryPagination,
    available_tags: Vec<TagSummary>,
}

#[derive(Serialize)]
struct ActionResponse {
    ok: bool,
}

#[derive(Serialize)]
struct TranslationRecord {
    id: i64,
    original_text: String,
    translated_text: String,
    created_at: i64,
    is_bookmarked: bool,
    tags: Vec<String>,
}

#[derive(Serialize)]
struct HistoryPagination {
    page: usize,
    page_size: usize,
    total_records: usize,
    total_pages: usize,
}

#[derive(Serialize)]
struct TagSummary {
    name: String,
    count: usize,
}

#[derive(Deserialize)]
struct UpdateTagsRequest {
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Deserialize)]
struct UpdateBookmarkRequest {
    is_bookmarked: bool,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum HistorySort {
    Oldest,
    #[default]
    Newest,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum BookmarkStatusFilter {
    #[default]
    All,
    Bookmarked,
    Unbookmarked,
}

#[derive(Default, Deserialize)]
struct HistoryQuery {
    page: Option<usize>,
    page_size: Option<usize>,
    search: Option<String>,
    tag: Option<String>,
    #[serde(default)]
    bookmark_status: BookmarkStatusFilter,
    #[serde(default)]
    sort: HistorySort,
}

#[derive(Clone)]
struct NormalizedHistoryQuery {
    page: usize,
    page_size: usize,
    search: Option<String>,
    tag: Option<String>,
    bookmark_status: BookmarkStatusFilter,
    sort: HistorySort,
}

impl NormalizedHistoryQuery {
    fn new(query: HistoryQuery) -> Self {
        let page_size = query
            .page_size
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_HISTORY_PAGE_SIZE)
            .min(MAX_HISTORY_PAGE_SIZE);

        Self {
            page: query.page.filter(|value| *value > 0).unwrap_or(1),
            page_size,
            search: query.search.and_then(normalize_optional_filter),
            tag: query.tag.and_then(normalize_optional_filter),
            bookmark_status: query.bookmark_status,
            sort: query.sort,
        }
    }

    fn offset(&self) -> usize {
        self.page.saturating_sub(1) * self.page_size
    }

    fn with_page(&self, page: usize) -> Self {
        Self {
            page,
            page_size: self.page_size,
            search: self.search.clone(),
            tag: self.tag.clone(),
            bookmark_status: self.bookmark_status,
            sort: self.sort,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Provider {
    #[default]
    OpenAi,
    GeminiAiStudio,
    GeminiVertex,
    DeepSeek,
    AwsBedrock,
    CustomOpenAi,
}

impl Provider {
    fn default_model(&self) -> &'static str {
        match self {
            Self::OpenAi => "gpt-4.1-mini",
            Self::GeminiAiStudio | Self::GeminiVertex => "gemini-3.5-flash",
            Self::DeepSeek => "deepseek-chat",
            Self::AwsBedrock => "anthropic.claude-3-5-haiku-20241022-v1:0",
            Self::CustomOpenAi => "",
        }
    }

    fn env_api_key(&self) -> String {
        match self {
            Self::OpenAi | Self::CustomOpenAi => env::var("OPENAI_API_KEY").unwrap_or_default(),
            Self::GeminiAiStudio | Self::GeminiVertex => env::var("GEMINI_API_KEY")
                .or_else(|_| env::var("GOOGLE_API_KEY"))
                .unwrap_or_default(),
            Self::DeepSeek => env::var("DEEPSEEK_API_KEY").unwrap_or_default(),
            Self::AwsBedrock => String::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct AppConfig {
    #[serde(default)]
    provider: Provider,
    api_key: String,
    model: String,
    #[serde(default)]
    base_url: String,
    #[serde(default = "default_translation_prompt")]
    translation_prompt: String,
    #[serde(default = "default_data_dir")]
    data_dir: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            provider: Provider::default(),
            api_key: Provider::default().env_api_key(),
            model: Provider::default().default_model().to_owned(),
            base_url: String::new(),
            translation_prompt: default_translation_prompt(),
            data_dir: default_data_dir(),
        }
    }
}

impl AppConfig {
    fn load() -> Self {
        let path = config_path();
        let Ok(contents) = fs::read_to_string(path) else {
            return Self::default();
        };

        let mut config = serde_json::from_str::<AppConfig>(&contents).unwrap_or_default();

        if config.api_key.trim().is_empty() {
            config.api_key = config.provider.env_api_key();
        }

        if config.model.trim().is_empty() {
            config.model = config.provider.default_model().to_owned();
        }

        if config.translation_prompt.trim().is_empty() {
            config.translation_prompt = default_translation_prompt();
        }

        if config.data_dir.trim().is_empty() {
            config.data_dir = default_data_dir();
        }

        config
    }

    fn save(&self) -> Result<(), String> {
        let path = config_path();

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }

        let payload =
            serde_json::to_string_pretty(self).map_err(|error| format!("JSON error: {error}"))?;
        fs::write(path, payload).map_err(|error| error.to_string())
    }
}

fn default_translation_prompt() -> String {
    DEFAULT_TRANSLATION_PROMPT.to_owned()
}

fn normalize_translation_prompt(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return default_translation_prompt();
    }

    trimmed.to_owned()
}

fn default_data_dir() -> String {
    default_data_dir_path().to_string_lossy().into_owned()
}

fn default_data_dir_path() -> PathBuf {
    env::var("LINGUAFIX_DATA_DIR")
        .ok()
        .and_then(non_empty)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::data_local_dir()
                .or_else(dirs::data_dir)
                .unwrap_or_else(|| PathBuf::from("."))
                .join(APP_NAME)
        })
}

fn normalize_data_dir(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return default_data_dir();
    }

    trimmed.to_owned()
}

fn config_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(APP_NAME).join("config.json")
}

struct TranslationLogStore;

enum DeleteHistoryResult {
    Deleted,
    Protected,
    Missing,
}

impl TranslationLogStore {
    fn record(
        data_dir: PathBuf,
        original_text: String,
        translated_text: String,
    ) -> Result<(), String> {
        let mut connection = Self::open(data_dir)?;
        let now = current_timestamp()?;
        let cutoff = now - TRANSLATION_LOG_RETENTION_SECONDS;

        let transaction = connection
            .transaction()
            .map_err(|error| format!("Could not open SQLite transaction: {error}"))?;

        transaction
            .execute(
                "INSERT INTO translations (original_text, translated_text, created_at, is_bookmarked) VALUES (?1, ?2, ?3, 0)",
                params![original_text, translated_text, now],
            )
            .map_err(|error| format!("Could not insert translation log: {error}"))?;

        transaction
            .execute(
                "DELETE FROM translations WHERE created_at < ?1 AND is_bookmarked = 0",
                params![cutoff],
            )
            .map_err(|error| format!("Could not prune expired translation logs: {error}"))?;
        Self::prune_unused_tags_tx(&transaction)?;

        transaction
            .commit()
            .map_err(|error| format!("Could not commit translation log transaction: {error}"))
    }

    fn prepare(data_dir: PathBuf) -> Result<(), String> {
        let connection = Self::open(data_dir)?;
        Self::prune_expired(&connection)?;

        Ok(())
    }

    fn list(data_dir: PathBuf, query: NormalizedHistoryQuery) -> Result<HistoryResponse, String> {
        let connection = Self::open(data_dir)?;
        Self::prune_expired(&connection)?;
        let filters = HistorySqlFilter::from_query(&query);

        let count_sql = format!(
            "SELECT COUNT(*) FROM translations tr {}",
            filters.where_clause
        );
        let total_records: usize = connection
            .query_row(&count_sql, params_from_iter(filters.params.iter()), |row| {
                row.get(0)
            })
            .map_err(|error| format!("Could not count translation history rows: {error}"))?;

        let total_pages = cmp::max(1, total_records.div_ceil(query.page_size));
        let normalized_query = query.with_page(query.page.min(total_pages));
        let order_clause = match normalized_query.sort {
            HistorySort::Newest => "tr.created_at DESC, tr.id DESC",
            HistorySort::Oldest => "tr.created_at ASC, tr.id ASC",
        };

        let mut statement = connection
            .prepare(&format!(
                "SELECT tr.id, tr.original_text, tr.translated_text, tr.created_at, tr.is_bookmarked
                FROM translations tr
                {}
                ORDER BY {}
                LIMIT ? OFFSET ?",
                filters.where_clause, order_clause
            ))
            .map_err(|error| format!("Could not prepare translation history query: {error}"))?;

        let limit = i64::try_from(normalized_query.page_size)
            .map_err(|error| format!("History page size overflow: {error}"))?;
        let offset = i64::try_from(normalized_query.offset())
            .map_err(|error| format!("History offset overflow: {error}"))?;
        let mut list_params = filters.params.clone();
        list_params.push(Value::Integer(limit));
        list_params.push(Value::Integer(offset));
        let rows = statement
            .query_map(params_from_iter(list_params.iter()), |row| {
                Ok(TranslationRecord {
                    id: row.get(0)?,
                    original_text: row.get(1)?,
                    translated_text: row.get(2)?,
                    created_at: row.get(3)?,
                    is_bookmarked: row.get(4)?,
                    tags: Vec::new(),
                })
            })
            .map_err(|error| format!("Could not read translation history: {error}"))?;

        let mut records = Vec::new();
        for row in rows {
            let mut record =
                row.map_err(|error| format!("Could not decode translation history row: {error}"))?;
            record.tags = Self::tags_for_translation(&connection, record.id)?;
            records.push(record);
        }

        Ok(HistoryResponse {
            records,
            pagination: HistoryPagination {
                page: normalized_query.page,
                page_size: normalized_query.page_size,
                total_records,
                total_pages,
            },
            available_tags: Self::list_tags(&connection)?,
        })
    }

    fn delete(data_dir: PathBuf, id: i64) -> Result<DeleteHistoryResult, String> {
        let connection = Self::open(data_dir)?;
        Self::prune_expired(&connection)?;

        let is_bookmarked = connection
            .query_row(
                "SELECT is_bookmarked FROM translations WHERE id = ?1",
                params![id],
                |row| row.get::<_, bool>(0),
            )
            .optional()
            .map_err(|error| format!("Could not read translation history row: {error}"))?;

        let Some(is_bookmarked) = is_bookmarked else {
            return Ok(DeleteHistoryResult::Missing);
        };

        if is_bookmarked {
            return Ok(DeleteHistoryResult::Protected);
        }

        connection
            .execute("DELETE FROM translations WHERE id = ?1", params![id])
            .map_err(|error| format!("Could not delete translation history row: {error}"))?;
        Self::prune_unused_tags(&connection)?;

        Ok(DeleteHistoryResult::Deleted)
    }

    fn clear(data_dir: PathBuf) -> Result<(), String> {
        let connection = Self::open(data_dir)?;
        Self::prune_expired(&connection)?;

        connection
            .execute("DELETE FROM translations WHERE is_bookmarked = 0", [])
            .map_err(|error| format!("Could not clear translation history: {error}"))?;
        Self::prune_unused_tags(&connection)?;

        Ok(())
    }

    fn set_bookmark(data_dir: PathBuf, id: i64, is_bookmarked: bool) -> Result<bool, String> {
        let connection = Self::open(data_dir)?;
        Self::prune_expired(&connection)?;

        let updated = connection
            .execute(
                "UPDATE translations SET is_bookmarked = ?1 WHERE id = ?2",
                params![is_bookmarked, id],
            )
            .map_err(|error| format!("Could not update translation bookmark: {error}"))?;

        Ok(updated > 0)
    }

    fn replace_tags(data_dir: PathBuf, id: i64, tags: Vec<String>) -> Result<bool, String> {
        let mut connection = Self::open(data_dir)?;
        Self::prune_expired(&connection)?;
        let tags = normalize_tags(tags);

        let transaction = connection
            .transaction()
            .map_err(|error| format!("Could not open SQLite transaction: {error}"))?;

        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM translations WHERE id = ?1)",
                params![id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not verify translation history row: {error}"))?;

        if !exists {
            return Ok(false);
        }

        transaction
            .execute(
                "DELETE FROM translation_tags WHERE translation_id = ?1",
                params![id],
            )
            .map_err(|error| format!("Could not clear translation tags: {error}"))?;

        for tag in tags {
            let normalized_name = normalize_tag_name(&tag);
            transaction
                .execute(
                    "INSERT INTO tags (name, normalized_name)
                    VALUES (?1, ?2)
                    ON CONFLICT(normalized_name) DO UPDATE SET name = excluded.name",
                    params![tag, normalized_name],
                )
                .map_err(|error| format!("Could not upsert translation tag: {error}"))?;

            let tag_id: i64 = transaction
                .query_row(
                    "SELECT id FROM tags WHERE normalized_name = ?1",
                    params![normalized_name],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Could not read translation tag: {error}"))?;

            transaction
                .execute(
                    "INSERT OR IGNORE INTO translation_tags (translation_id, tag_id)
                    VALUES (?1, ?2)",
                    params![id, tag_id],
                )
                .map_err(|error| format!("Could not attach translation tag: {error}"))?;
        }

        Self::prune_unused_tags_tx(&transaction)?;
        transaction
            .commit()
            .map_err(|error| format!("Could not commit tag update transaction: {error}"))?;

        Ok(true)
    }

    fn open(data_dir: PathBuf) -> Result<Connection, String> {
        fs::create_dir_all(&data_dir).map_err(|error| {
            format!(
                "Could not create data directory {}: {error}",
                data_dir.display()
            )
        })?;

        let database_path = data_dir.join(TRANSLATION_LOG_FILE_NAME);
        let connection = Connection::open(&database_path).map_err(|error| {
            format!(
                "Could not open SQLite database {}: {error}",
                database_path.display()
            )
        })?;

        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                CREATE TABLE IF NOT EXISTS translations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    original_text TEXT NOT NULL,
                    translated_text TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    is_bookmarked INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS idx_translations_created_at
                ON translations (created_at);
                CREATE TABLE IF NOT EXISTS tags (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    normalized_name TEXT NOT NULL UNIQUE
                );
                CREATE TABLE IF NOT EXISTS translation_tags (
                    translation_id INTEGER NOT NULL REFERENCES translations(id) ON DELETE CASCADE,
                    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                    PRIMARY KEY (translation_id, tag_id)
                );
                CREATE INDEX IF NOT EXISTS idx_tags_normalized_name
                ON tags (normalized_name);
                CREATE INDEX IF NOT EXISTS idx_translation_tags_translation
                ON translation_tags (translation_id);
                CREATE INDEX IF NOT EXISTS idx_translation_tags_tag
                ON translation_tags (tag_id);",
            )
            .map_err(|error| format!("Could not initialize translation log database: {error}"))?;

        Self::ensure_translation_column(
            &connection,
            "is_bookmarked",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        connection
            .execute(
                "CREATE INDEX IF NOT EXISTS idx_translations_bookmarked ON translations (is_bookmarked)",
                [],
            )
            .map_err(|error| format!("Could not initialize translation bookmark index: {error}"))?;

        Ok(connection)
    }

    fn prune_expired(connection: &Connection) -> Result<(), String> {
        let cutoff = current_timestamp()? - TRANSLATION_LOG_RETENTION_SECONDS;

        connection
            .execute(
                "DELETE FROM translations WHERE created_at < ?1 AND is_bookmarked = 0",
                params![cutoff],
            )
            .map_err(|error| format!("Could not prune expired translation logs: {error}"))?;
        Self::prune_unused_tags(connection)?;

        Ok(())
    }

    fn list_tags(connection: &Connection) -> Result<Vec<TagSummary>, String> {
        let mut statement = connection
            .prepare(
                "SELECT tags.name, COUNT(translation_tags.translation_id) AS tag_count
                FROM tags
                LEFT JOIN translation_tags ON translation_tags.tag_id = tags.id
                GROUP BY tags.id, tags.name
                ORDER BY LOWER(tags.name) ASC",
            )
            .map_err(|error| format!("Could not prepare tag list query: {error}"))?;

        let rows = statement
            .query_map([], |row| {
                Ok(TagSummary {
                    name: row.get(0)?,
                    count: row.get(1)?,
                })
            })
            .map_err(|error| format!("Could not read tag list: {error}"))?;

        let mut tags = Vec::new();
        for row in rows {
            tags.push(row.map_err(|error| format!("Could not decode tag row: {error}"))?);
        }

        Ok(tags)
    }

    fn tags_for_translation(connection: &Connection, id: i64) -> Result<Vec<String>, String> {
        let mut statement = connection
            .prepare(
                "SELECT tags.name
                FROM translation_tags
                INNER JOIN tags ON tags.id = translation_tags.tag_id
                WHERE translation_tags.translation_id = ?1
                ORDER BY LOWER(tags.name) ASC",
            )
            .map_err(|error| format!("Could not prepare translation tag query: {error}"))?;

        let rows = statement
            .query_map(params![id], |row| row.get(0))
            .map_err(|error| format!("Could not read translation tags: {error}"))?;

        let mut tags = Vec::new();
        for row in rows {
            tags.push(
                row.map_err(|error| format!("Could not decode translation tag row: {error}"))?,
            );
        }

        Ok(tags)
    }

    fn prune_unused_tags(connection: &Connection) -> Result<(), String> {
        connection
            .execute(
                "DELETE FROM tags
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM translation_tags
                    WHERE translation_tags.tag_id = tags.id
                )",
                [],
            )
            .map_err(|error| format!("Could not prune unused translation tags: {error}"))?;

        Ok(())
    }

    fn prune_unused_tags_tx(transaction: &Transaction<'_>) -> Result<(), String> {
        transaction
            .execute(
                "DELETE FROM tags
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM translation_tags
                    WHERE translation_tags.tag_id = tags.id
                )",
                [],
            )
            .map_err(|error| format!("Could not prune unused translation tags: {error}"))?;

        Ok(())
    }

    fn ensure_translation_column(
        connection: &Connection,
        column_name: &str,
        definition: &str,
    ) -> Result<(), String> {
        match connection.execute(
            &format!("ALTER TABLE translations ADD COLUMN {column_name} {definition}"),
            [],
        ) {
            Ok(_) => Ok(()),
            Err(error) => {
                let message = error.to_string();
                if message.contains("duplicate column name") {
                    Ok(())
                } else {
                    Err(format!("Could not migrate translation log schema: {error}"))
                }
            }
        }
    }
}

struct HistorySqlFilter {
    where_clause: String,
    params: Vec<Value>,
}

impl HistorySqlFilter {
    fn from_query(query: &NormalizedHistoryQuery) -> Self {
        let mut conditions = Vec::new();
        let mut params = Vec::new();

        if let Some(search) = query.search.as_ref() {
            let like = format!("%{search}%");
            conditions.push(
                "(tr.original_text LIKE ?
                OR tr.translated_text LIKE ?
                OR EXISTS (
                    SELECT 1
                    FROM translation_tags tag_links
                    INNER JOIN tags tag_search ON tag_search.id = tag_links.tag_id
                    WHERE tag_links.translation_id = tr.id
                    AND tag_search.name LIKE ?
                ))"
                .to_owned(),
            );
            params.push(Value::Text(like.clone()));
            params.push(Value::Text(like.clone()));
            params.push(Value::Text(like));
        }

        if let Some(tag) = query.tag.as_ref() {
            let normalized_tag = normalize_tag_name(tag);
            if !normalized_tag.is_empty() {
                conditions.push(
                    "EXISTS (
                        SELECT 1
                        FROM translation_tags tag_filter_links
                        INNER JOIN tags tag_filter ON tag_filter.id = tag_filter_links.tag_id
                        WHERE tag_filter_links.translation_id = tr.id
                        AND tag_filter.normalized_name = ?
                    )"
                    .to_owned(),
                );
                params.push(Value::Text(normalized_tag));
            }
        }

        match query.bookmark_status {
            BookmarkStatusFilter::All => {}
            BookmarkStatusFilter::Bookmarked => {
                conditions.push("tr.is_bookmarked = 1".to_owned());
            }
            BookmarkStatusFilter::Unbookmarked => {
                conditions.push("tr.is_bookmarked = 0".to_owned());
            }
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };

        Self {
            where_clause,
            params,
        }
    }
}

fn current_timestamp() -> Result<i64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock is before the Unix epoch: {error}"))?;

    i64::try_from(duration.as_secs()).map_err(|error| format!("Timestamp overflow: {error}"))
}

fn normalize_optional_filter(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn normalize_tag_name(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_ascii_lowercase()
}

fn normalize_tag_display(value: &str) -> Option<String> {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = compact.trim();

    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for tag in tags {
        let Some(display) = normalize_tag_display(&tag) else {
            continue;
        };

        let key = normalize_tag_name(&display);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }

        normalized.push(display);
    }

    normalized.sort_by_key(|tag| tag.to_ascii_lowercase());
    normalized
}

fn resolve_vertex_base_url(base_url: &str, auth: GeminiAuth) -> Result<String, String> {
    let trimmed = base_url.trim();
    if !trimmed.is_empty() {
        return Ok(normalize_vertex_base_url(trimmed));
    }

    if matches!(auth, GeminiAuth::ApiKey) {
        if let Some(project) = vertex_project() {
            let location = vertex_location().unwrap_or_else(|| "global".to_owned());
            return Ok(build_vertex_base_url(&project, &location));
        }

        return Ok("https://aiplatform.googleapis.com/v1".to_owned());
    }

    let project = vertex_project().ok_or_else(|| {
        "Vertex AI needs a project endpoint or project ID. Save the Vertex endpoint in settings, or set GOOGLE_CLOUD_PROJECT / gcloud config project.".to_owned()
    })?;
    let location = vertex_location().unwrap_or_else(|| "global".to_owned());

    Ok(build_vertex_base_url(&project, &location))
}

fn normalize_vertex_base_url(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return trimmed.to_owned();
    }

    let normalized = trimmed.trim_start_matches('/');
    if normalized.starts_with("projects/") {
        return format!("https://aiplatform.googleapis.com/v1/{normalized}");
    }

    trimmed.to_owned()
}

fn build_vertex_base_url(project: &str, location: &str) -> String {
    let project = project.trim().trim_matches('/');
    let location = location.trim().trim_matches('/');

    if location.eq_ignore_ascii_case("global") {
        return format!("https://aiplatform.googleapis.com/v1/projects/{project}/locations/global");
    }

    format!(
        "https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}"
    )
}

fn infer_vertex_auth(value: &str) -> GeminiAuth {
    let trimmed = value.trim();

    if trimmed.starts_with("ya29.") || trimmed.starts_with("Bearer ") {
        GeminiAuth::Bearer
    } else {
        GeminiAuth::ApiKey
    }
}

async fn run_vertex_request(
    api_key: String,
    model: String,
    base_url: String,
    system_prompt: &str,
    input: &str,
) -> Result<String, String> {
    let preferred_auth = infer_vertex_auth(&api_key);
    let fallback_auth = match preferred_auth {
        GeminiAuth::ApiKey => GeminiAuth::Bearer,
        GeminiAuth::Bearer => GeminiAuth::ApiKey,
    };

    let primary_base_url = resolve_vertex_base_url(&base_url, preferred_auth)?;
    let primary = GeminiClient {
        api_key: api_key.clone(),
        model: model.clone(),
        base_url: primary_base_url,
        api: GeminiApi::Vertex,
        auth: preferred_auth,
    };

    match primary.run(system_prompt, input).await {
        Ok(output) => Ok(output),
        Err(error) if should_retry_vertex_with_other_auth(&error) => {
            let fallback_base_url = resolve_vertex_base_url(&base_url, fallback_auth)?;
            GeminiClient {
                api_key,
                model,
                base_url: fallback_base_url,
                api: GeminiApi::Vertex,
                auth: fallback_auth,
            }
            .run(system_prompt, input)
            .await
        }
        Err(error) => Err(error),
    }
}

fn should_retry_vertex_with_other_auth(error: &str) -> bool {
    error.contains("\"reason\": \"API_KEY_SERVICE_BLOCKED\"")
        || error.contains("Expected OAuth 2 access token")
        || error.contains("API keys are not supported by this API")
        || error.contains("\"reason\": \"CREDENTIALS_MISSING\"")
}

fn vertex_project() -> Option<String> {
    env::var("GOOGLE_CLOUD_PROJECT")
        .ok()
        .or_else(|| env::var("GCLOUD_PROJECT").ok())
        .or_else(|| env::var("CLOUDSDK_CORE_PROJECT").ok())
        .and_then(non_empty)
        .or_else(|| read_gcloud_property("core", "project"))
}

fn vertex_location() -> Option<String> {
    env::var("GOOGLE_CLOUD_LOCATION")
        .ok()
        .or_else(|| env::var("GOOGLE_CLOUD_REGION").ok())
        .or_else(|| env::var("VERTEX_AI_LOCATION").ok())
        .or_else(|| env::var("CLOUDSDK_COMPUTE_REGION").ok())
        .and_then(non_empty)
        .or_else(|| read_gcloud_property("ai", "region"))
        .or_else(|| read_gcloud_property("compute", "region"))
}

fn read_gcloud_property(section: &str, key: &str) -> Option<String> {
    let config_root = gcloud_config_root()?;
    let active_name = fs::read_to_string(config_root.join("active_config"))
        .ok()
        .and_then(|value| non_empty(value.trim().to_owned()));

    let mut candidates = Vec::new();
    if let Some(active_name) = active_name {
        candidates.push(
            config_root
                .join("configurations")
                .join(format!("config_{active_name}")),
        );
    }
    candidates.push(config_root.join("configurations").join("config_default"));

    for path in candidates {
        let Ok(contents) = fs::read_to_string(path) else {
            continue;
        };

        if let Some(value) = parse_ini_property(&contents, section, key) {
            return Some(value);
        }
    }

    None
}

fn gcloud_config_root() -> Option<PathBuf> {
    let env_root = env::var("CLOUDSDK_CONFIG")
        .ok()
        .map(PathBuf::from)
        .filter(|path| path.exists());
    if env_root.is_some() {
        return env_root;
    }

    let home = dirs::home_dir()?;
    let candidates = [
        home.join(".config").join("gcloud"),
        dirs::config_dir().map(|path| path.join("gcloud"))?,
        home.join("Library")
            .join("Application Support")
            .join("Google")
            .join("Cloud SDK"),
    ];

    candidates.into_iter().find(|path| path.exists())
}

fn parse_ini_property(contents: &str, section: &str, key: &str) -> Option<String> {
    let mut current_section = "";

    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }

        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            current_section = &trimmed[1..trimmed.len() - 1];
            continue;
        }

        if current_section != section {
            continue;
        }

        let Some((candidate_key, value)) = trimmed.split_once('=') else {
            continue;
        };

        if candidate_key.trim() == key {
            return non_empty(value.trim().to_owned());
        }
    }

    None
}

fn non_empty(value: String) -> Option<String> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value.trim().to_owned())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AiTask {
    AutoProcess,
    TranslateEnglishToChinese,
}

impl AiTask {
    fn system_prompt<'a>(&self, translation_prompt: &'a str) -> &'a str {
        match self {
            Self::AutoProcess => translation_prompt,
            Self::TranslateEnglishToChinese => DEFAULT_ENGLISH_TO_CHINESE_PROMPT,
        }
    }
}

#[derive(Deserialize)]
struct ProcessRequest {
    task: AiTask,
    text: String,
}

#[derive(Serialize)]
struct ProcessResponse {
    output: String,
}

// --- OpenAI Responses API ---

struct OpenAiClient {
    api_key: String,
    model: String,
}

impl OpenAiClient {
    async fn run(&self, system_prompt: &str, input: &str) -> Result<String, String> {
        let body = ResponsesRequest {
            model: self.model.clone(),
            input: vec![
                InputMessage::system(system_prompt),
                InputMessage::user(input),
            ],
        };

        let client = reqwest::Client::builder()
            .build()
            .map_err(|error| format!("Could not build HTTP client: {error}"))?;

        let response = client
            .post("https://api.openai.com/v1/responses")
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("Request failed: {error}"))?;

        let status = response.status();

        if !status.is_success() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "The API returned an unreadable error body.".to_owned());
            return Err(format!("OpenAI API error ({status}): {body}"));
        }

        let payload: ResponsesResponse = response
            .json()
            .await
            .map_err(|error| format!("Could not decode OpenAI response: {error}"))?;

        payload
            .first_text()
            .map(|text| text.trim().to_owned())
            .filter(|text| !text.is_empty())
            .ok_or_else(|| "The model response did not contain text output.".to_owned())
    }
}

#[derive(Serialize)]
struct ResponsesRequest {
    model: String,
    input: Vec<InputMessage>,
}

#[derive(Serialize)]
struct InputMessage {
    role: &'static str,
    content: Vec<InputContent>,
}

impl InputMessage {
    fn system(text: &str) -> Self {
        Self {
            role: "system",
            content: vec![InputContent {
                content_type: "input_text",
                text: text.to_owned(),
            }],
        }
    }

    fn user(text: &str) -> Self {
        Self {
            role: "user",
            content: vec![InputContent {
                content_type: "input_text",
                text: text.to_owned(),
            }],
        }
    }
}

#[derive(Serialize)]
struct InputContent {
    #[serde(rename = "type")]
    content_type: &'static str,
    text: String,
}

#[derive(Deserialize)]
struct ResponsesResponse {
    output_text: Option<String>,
    #[serde(default)]
    output: Vec<ResponseItem>,
}

impl ResponsesResponse {
    fn first_text(&self) -> Option<&str> {
        if let Some(text) = self.output_text.as_deref() {
            return Some(text);
        }

        self.output
            .iter()
            .flat_map(|item| item.content.iter())
            .find_map(|content| {
                if content.content_type == "output_text" {
                    content.text.as_deref()
                } else {
                    None
                }
            })
    }
}

#[derive(Deserialize)]
struct ResponseItem {
    #[serde(default)]
    content: Vec<ResponseContent>,
}

#[derive(Deserialize)]
struct ResponseContent {
    #[serde(rename = "type")]
    content_type: String,
    text: Option<String>,
}

// --- Gemini (AI Studio + Vertex AI) ---

#[derive(Clone, Copy)]
enum GeminiAuth {
    ApiKey,
    Bearer,
}

#[derive(Clone, Copy)]
enum GeminiApi {
    AiStudio,
    Vertex,
}

struct GeminiClient {
    api_key: String,
    model: String,
    base_url: String,
    api: GeminiApi,
    auth: GeminiAuth,
}

impl GeminiClient {
    async fn run(&self, system_prompt: &str, input: &str) -> Result<String, String> {
        let body = GeminiRequest {
            system_instruction: GeminiContent {
                parts: vec![GeminiPart {
                    text: system_prompt.to_owned(),
                }],
            },
            contents: vec![GeminiMessage {
                role: "user",
                parts: vec![GeminiPart {
                    text: input.to_owned(),
                }],
            }],
        };

        let client = reqwest::Client::builder()
            .build()
            .map_err(|error| format!("Could not build HTTP client: {error}"))?;

        let url = match (self.api, self.auth) {
            (GeminiApi::AiStudio, GeminiAuth::ApiKey) => {
                format!(
                    "{}/models/{}:generateContent?key={}",
                    self.base_url.trim_end_matches('/'),
                    self.model,
                    self.api_key
                )
            }
            (GeminiApi::Vertex, GeminiAuth::ApiKey) => {
                format!(
                    "{}/publishers/google/models/{}:generateContent?key={}",
                    self.base_url.trim_end_matches('/'),
                    self.model,
                    self.api_key
                )
            }
            (_, GeminiAuth::Bearer) => {
                format!(
                    "{}/publishers/google/models/{}:generateContent",
                    self.base_url.trim_end_matches('/'),
                    self.model
                )
            }
        };

        let mut request = client.post(&url).json(&body);

        if matches!(self.auth, GeminiAuth::Bearer) {
            request = request.bearer_auth(&self.api_key);
        }

        let response = request
            .send()
            .await
            .map_err(|error| format!("Request failed: {error}"))?;

        let status = response.status();

        if !status.is_success() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "The API returned an unreadable error body.".to_owned());
            return Err(format!("Gemini API error ({status}): {body}"));
        }

        let payload: GeminiResponse = response
            .json()
            .await
            .map_err(|error| format!("Could not decode Gemini response: {error}"))?;

        payload
            .candidates
            .into_iter()
            .next()
            .and_then(|c| c.content.parts.into_iter().next())
            .map(|p| p.text.trim().to_owned())
            .filter(|t| !t.is_empty())
            .ok_or_else(|| "The model response did not contain text output.".to_owned())
    }
}

#[derive(Serialize)]
struct GeminiRequest {
    #[serde(rename = "systemInstruction")]
    system_instruction: GeminiContent,
    contents: Vec<GeminiMessage>,
}

#[derive(Serialize)]
struct GeminiContent {
    parts: Vec<GeminiPart>,
}

#[derive(Serialize)]
struct GeminiMessage {
    role: &'static str,
    parts: Vec<GeminiPart>,
}

#[derive(Serialize, Deserialize)]
struct GeminiPart {
    text: String,
}

#[derive(Deserialize)]
struct GeminiResponse {
    #[serde(default)]
    candidates: Vec<GeminiCandidate>,
}

#[derive(Deserialize)]
struct GeminiCandidate {
    content: GeminiCandidateContent,
}

#[derive(Deserialize)]
struct GeminiCandidateContent {
    parts: Vec<GeminiPart>,
}

// --- DeepSeek Chat Completions ---

struct DeepSeekClient {
    api_key: String,
    model: String,
}

impl DeepSeekClient {
    async fn run(&self, system_prompt: &str, input: &str) -> Result<String, String> {
        ChatCompletionsClient {
            api_key: self.api_key.clone(),
            model: self.model.clone(),
            base_url: "https://api.deepseek.com".to_owned(),
        }
        .run_with_path("/chat/completions", system_prompt, input)
        .await
    }
}

// --- Amazon Bedrock Runtime InvokeModel (Anthropic Claude Messages) ---

struct BedrockCredentials {
    access_key_id: String,
    secret_access_key: String,
    session_token: Option<String>,
}

impl BedrockCredentials {
    fn load(value: &str) -> Result<Self, String> {
        let trimmed = value.trim();

        if !trimmed.is_empty() {
            let parts = trimmed.splitn(3, ':').collect::<Vec<_>>();
            if parts.len() >= 2 {
                return Ok(Self {
                    access_key_id: parts[0].trim().to_owned(),
                    secret_access_key: parts[1].trim().to_owned(),
                    session_token: parts
                        .get(2)
                        .and_then(|value| non_empty((*value).to_owned())),
                });
            }
        }

        let access_key_id = non_empty(
            if trimmed.is_empty() {
                env::var("AWS_ACCESS_KEY_ID").unwrap_or_default()
            } else {
                trimmed.to_owned()
            },
        )
        .ok_or_else(|| {
            "AWS credentials are missing. Save access_key_id:secret_access_key in settings, or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.".to_owned()
        })?;
        let secret_access_key = env::var("AWS_SECRET_ACCESS_KEY")
            .ok()
            .and_then(non_empty)
            .ok_or_else(|| {
                "AWS_SECRET_ACCESS_KEY is missing. Save access_key_id:secret_access_key in settings, or set AWS_SECRET_ACCESS_KEY.".to_owned()
            })?;
        let session_token = env::var("AWS_SESSION_TOKEN").ok().and_then(non_empty);

        Ok(Self {
            access_key_id,
            secret_access_key,
            session_token,
        })
    }
}

struct BedrockClient {
    credentials: BedrockCredentials,
    model: String,
    endpoint: String,
}

impl BedrockClient {
    async fn run(&self, system_prompt: &str, input: &str) -> Result<String, String> {
        let region = resolve_bedrock_region(&self.endpoint)?;
        let base_url = resolve_bedrock_base_url(&self.endpoint, &region);
        let encoded_model = utf8_percent_encode(&self.model, BEDROCK_MODEL_ENCODE_SET).to_string();
        let path = format!("/model/{encoded_model}/invoke");
        let url = format!("{}{}", base_url.trim_end_matches('/'), path);
        let body = BedrockClaudeRequest {
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 4096,
            system: system_prompt,
            messages: vec![BedrockClaudeMessage {
                role: "user",
                content: vec![BedrockClaudeContent {
                    content_type: "text",
                    text: input,
                }],
            }],
        };
        let body_bytes = serde_json::to_vec(&body)
            .map_err(|error| format!("Could not encode Bedrock request: {error}"))?;
        let host = reqwest::Url::parse(&url)
            .map_err(|error| format!("Invalid Bedrock endpoint: {error}"))?
            .host_str()
            .ok_or_else(|| "Bedrock endpoint is missing a host.".to_owned())?
            .to_owned();
        let signed = sign_bedrock_request(&self.credentials, &region, &host, &path, &body_bytes)?;

        let client = reqwest::Client::builder()
            .build()
            .map_err(|error| format!("Could not build HTTP client: {error}"))?;
        let mut request = client
            .post(&url)
            .header("authorization", signed.authorization)
            .header("content-type", "application/json")
            .header("host", host)
            .header("x-amz-content-sha256", signed.payload_hash)
            .header("x-amz-date", signed.amz_date)
            .body(body_bytes);

        if let Some(session_token) = &self.credentials.session_token {
            request = request.header("x-amz-security-token", session_token);
        }

        let response = request
            .send()
            .await
            .map_err(|error| format!("Request failed: {error}"))?;
        let status = response.status();

        if !status.is_success() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "The API returned an unreadable error body.".to_owned());
            return Err(format!("Bedrock API error ({status}): {body}"));
        }

        let payload: BedrockClaudeResponse = response
            .json()
            .await
            .map_err(|error| format!("Could not decode Bedrock response: {error}"))?;

        payload
            .content
            .into_iter()
            .find_map(|content| content.text)
            .map(|text| text.trim().to_owned())
            .filter(|text| !text.is_empty())
            .ok_or_else(|| "The model response did not contain text output.".to_owned())
    }
}

#[derive(Serialize)]
struct BedrockClaudeRequest<'a> {
    anthropic_version: &'static str,
    max_tokens: u16,
    system: &'a str,
    messages: Vec<BedrockClaudeMessage<'a>>,
}

#[derive(Serialize)]
struct BedrockClaudeMessage<'a> {
    role: &'static str,
    content: Vec<BedrockClaudeContent<'a>>,
}

#[derive(Serialize)]
struct BedrockClaudeContent<'a> {
    #[serde(rename = "type")]
    content_type: &'static str,
    text: &'a str,
}

#[derive(Deserialize)]
struct BedrockClaudeResponse {
    #[serde(default)]
    content: Vec<BedrockClaudeResponseContent>,
}

#[derive(Deserialize)]
struct BedrockClaudeResponseContent {
    text: Option<String>,
}

struct SignedBedrockRequest {
    authorization: String,
    amz_date: String,
    payload_hash: String,
}

fn sign_bedrock_request(
    credentials: &BedrockCredentials,
    region: &str,
    host: &str,
    path: &str,
    body: &[u8],
) -> Result<SignedBedrockRequest, String> {
    let now = OffsetDateTime::now_utc();
    let amz_date = now
        .format(AMZ_DATE_FORMAT)
        .map_err(|error| format!("Could not format AWS timestamp: {error}"))?;
    let aws_date = now
        .format(AWS_DATE_FORMAT)
        .map_err(|error| format!("Could not format AWS date: {error}"))?;
    let payload_hash = sha256_hex(body);
    let mut canonical_headers = format!(
        "content-type:application/json\nhost:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
    );
    let mut signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date".to_owned();

    if let Some(session_token) = &credentials.session_token {
        canonical_headers.push_str(&format!("x-amz-security-token:{session_token}\n"));
        signed_headers.push_str(";x-amz-security-token");
    }

    let canonical_request =
        format!("POST\n{path}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let credential_scope =
        format!("{aws_date}/{region}/{BEDROCK_SERVICE}/{BEDROCK_SIGNING_TERMINATOR}");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let signing_key = bedrock_signing_key(
        &credentials.secret_access_key,
        &aws_date,
        region,
        BEDROCK_SERVICE,
    )?;
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes())?);
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}",
        credentials.access_key_id
    );

    Ok(SignedBedrockRequest {
        authorization,
        amz_date,
        payload_hash,
    })
}

fn resolve_bedrock_region(value: &str) -> Result<String, String> {
    let trimmed = value.trim();

    if !trimmed.is_empty() && !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Ok(trimmed.to_owned());
    }

    let region = env::var("AWS_REGION")
        .ok()
        .or_else(|| env::var("AWS_DEFAULT_REGION").ok())
        .and_then(non_empty)
        .or_else(|| infer_region_from_bedrock_endpoint(trimmed))
        .unwrap_or_else(|| "us-east-1".to_owned());

    Ok(region)
}

fn resolve_bedrock_base_url(value: &str, region: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_owned()
    } else {
        format!("https://bedrock-runtime.{region}.amazonaws.com")
    }
}

fn infer_region_from_bedrock_endpoint(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value).ok()?;
    let host = url.host_str()?;
    let suffix = ".amazonaws.com";
    let without_suffix = host.strip_suffix(suffix)?;
    let region = without_suffix.strip_prefix("bedrock-runtime.")?;
    non_empty(region.to_owned())
}

fn bedrock_signing_key(
    secret_access_key: &str,
    date: &str,
    region: &str,
    service: &str,
) -> Result<Vec<u8>, String> {
    let date_key = hmac_sha256(
        format!("AWS4{secret_access_key}").as_bytes(),
        date.as_bytes(),
    )?;
    let region_key = hmac_sha256(&date_key, region.as_bytes())?;
    let service_key = hmac_sha256(&region_key, service.as_bytes())?;
    hmac_sha256(&service_key, BEDROCK_SIGNING_TERMINATOR.as_bytes())
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key)
        .map_err(|error| format!("Could not initialize HMAC: {error}"))?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

// --- Custom OpenAI-style Chat Completions ---

struct ChatCompletionsClient {
    api_key: String,
    model: String,
    base_url: String,
}

impl ChatCompletionsClient {
    async fn run(&self, system_prompt: &str, input: &str) -> Result<String, String> {
        self.run_with_path("/v1/chat/completions", system_prompt, input)
            .await
    }

    async fn run_with_path(
        &self,
        path: &str,
        system_prompt: &str,
        input: &str,
    ) -> Result<String, String> {
        let body = ChatRequest {
            model: self.model.clone(),
            messages: vec![
                ChatMessage {
                    role: "system",
                    content: system_prompt,
                },
                ChatMessage {
                    role: "user",
                    content: input,
                },
            ],
        };

        let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);

        let client = reqwest::Client::builder()
            .build()
            .map_err(|error| format!("Could not build HTTP client: {error}"))?;

        let response = client
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("Request failed: {error}"))?;

        let status = response.status();

        if !status.is_success() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "The API returned an unreadable error body.".to_owned());
            return Err(format!("API error ({status}): {body}"));
        }

        let payload: ChatResponse = response
            .json()
            .await
            .map_err(|error| format!("Could not decode chat completions response: {error}"))?;

        payload
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content.trim().to_owned())
            .filter(|t| !t.is_empty())
            .ok_or_else(|| "The model response did not contain text output.".to_owned())
    }
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: String,
    messages: Vec<ChatMessage<'a>>,
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct ChatResponse {
    #[serde(default)]
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatResponseMessage,
}

#[derive(Deserialize)]
struct ChatResponseMessage {
    content: String,
}

// --- Error handling ---

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }
}

impl axum::response::IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (
            self.status,
            Json(ErrorPayload {
                error: self.message,
            }),
        )
            .into_response()
    }
}

#[derive(Serialize)]
struct ErrorPayload {
    error: String,
}
