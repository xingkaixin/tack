use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

pub struct Error(pub StatusCode, pub Value);
pub type Result<T> = std::result::Result<T, Error>;
impl Error {
    pub fn bad(message: &str) -> Self {
        Self(StatusCode::BAD_REQUEST, json!({"error":message}))
    }
    pub fn unauthorized() -> Self {
        Self(StatusCode::UNAUTHORIZED, json!({"error":"unauthorized"}))
    }
    pub fn forbidden() -> Self {
        Self(StatusCode::FORBIDDEN, json!({"error":"forbidden"}))
    }
    pub fn missing() -> Self {
        Self(StatusCode::NOT_FOUND, json!({"error":"not_found"}))
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}
impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        if let sqlx::Error::Database(ref db) = error
            && db.is_unique_violation()
        {
            return Self::bad("already_exists");
        }
        tracing::error!(%error,"database operation failed");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error":"server_error"}),
        )
    }
}
