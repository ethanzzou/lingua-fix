use std::env;
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

const APP_NAME: &str = "LinguaFix";
const OPENAI_RESPONSES_URL: &str = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL: &str = "gpt-4.1-mini";
const DEFAULT_PORT: u16 = 8787;

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
    let normalized = AppConfig {
        api_key: config.api_key.trim().to_owned(),
        model: if config.model.trim().is_empty() {
            DEFAULT_MODEL.to_owned()
        } else {
            config.model.trim().to_owned()
        },
    };

    normalized
        .save()
        .map_err(|error| ApiError::internal(format!("Could not save config: {error}")))?;

    Ok(Json(normalized))
}

async fn process_text(
    State(_state): State<AppState>,
    Json(request): Json<ProcessRequest>,
) -> Result<Json<ProcessResponse>, ApiError> {
    let config = AppConfig::load();
    let text = request.text.trim().to_owned();

    if text.is_empty() {
        return Err(ApiError::bad_request("Input text is empty."));
    }

    if config.api_key.trim().is_empty() {
        return Err(ApiError::bad_request(
            "OpenAI API key is missing. Save it in settings first.",
        ));
    }

    let task = request.task;
    let client = OpenAiClient {
        api_key: config.api_key,
        model: config.model,
    };

    let output = client
        .run(task, &text)
        .await
        .map_err(ApiError::internal)?;

    Ok(Json(ProcessResponse { output }))
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct AppConfig {
    api_key: String,
    model: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            api_key: env::var("OPENAI_API_KEY").unwrap_or_default(),
            model: DEFAULT_MODEL.to_owned(),
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
            config.api_key = env::var("OPENAI_API_KEY").unwrap_or_default();
        }

        if config.model.trim().is_empty() {
            config.model = DEFAULT_MODEL.to_owned();
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

fn config_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(APP_NAME).join("config.json")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AiTask {
    AutoProcess,
}

impl AiTask {
    fn system_prompt(&self) -> &'static str {
        match self {
            Self::AutoProcess => {
                "Decide what to do from the user's text. If the input is primarily Chinese, translate it into natural English while preserving meaning and tone. If the input is primarily English, rewrite it into correct, natural English with improved grammar, spelling, punctuation, and phrasing while preserving meaning and tone. Return only the final text with no explanation."
            }
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

struct OpenAiClient {
    api_key: String,
    model: String,
}

impl OpenAiClient {
    async fn run(&self, task: AiTask, input: &str) -> Result<String, String> {
        let body = ResponsesRequest {
            model: self.model.clone(),
            input: vec![
                InputMessage::system(task.system_prompt()),
                InputMessage::user(input),
            ],
        };

        let client = reqwest::Client::builder()
            .build()
            .map_err(|error| format!("Could not build HTTP client: {error}"))?;

        let response = client
            .post(OPENAI_RESPONSES_URL)
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
    fn system(text: &'static str) -> Self {
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
