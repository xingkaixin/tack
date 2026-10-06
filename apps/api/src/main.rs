mod attachments;
mod auth;
mod collab;
mod data;
mod error;
use axum::{
    Router,
    extract::{DefaultBodyLimit, Request, State},
    http::HeaderMap,
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
};
use error::{Error, Result};
use sqlx::PgPool;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{Mutex, broadcast};
use uuid::Uuid;

#[derive(Clone)]
pub struct App {
    db: PgPool,
    rooms: Arc<Mutex<HashMap<Uuid, broadcast::Sender<Vec<u8>>>>>,
    origins: Arc<Vec<String>>,
}
pub fn required(value: &str, max: usize) -> Result<&str> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max {
        return Err(Error::bad("value_invalid"));
    }
    Ok(value)
}
pub fn check_origin(app: &App, headers: &HeaderMap) -> Result<()> {
    if let Some(origin) = headers.get("origin")
        && !app.origins.iter().any(|allowed| origin == allowed.as_str())
    {
        return Err(Error::forbidden());
    }
    Ok(())
}
async fn guard(State(app): State<App>, request: Request, next: Next) -> Result<Response> {
    if request.method() != axum::http::Method::GET {
        check_origin(&app, request.headers())?;
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    Ok(response)
}
#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(10)
        .connect(&std::env::var("DATABASE_URL")?)
        .await?;
    sqlx::migrate!("./migrations").run(&db).await?;
    let origins = std::env::var("APP_ORIGIN")
        .unwrap_or_else(|_| "http://localhost:5173".into())
        .split(',')
        .map(str::to_owned)
        .collect();
    let state = App {
        db,
        rooms: Arc::new(Mutex::new(HashMap::new())),
        origins: Arc::new(origins),
    };
    let app = Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/auth/status", get(auth::status))
        .route("/api/auth/setup", post(auth::setup))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/snapshot", get(data::snapshot))
        .route("/api/operations", post(data::mutate))
        .route("/api/workspaces/{id}/members", post(data::add_member))
        .route(
            "/api/issues/{issue}/attachments/{id}",
            post(attachments::upload),
        )
        .route("/api/attachments/{id}", get(attachments::download))
        .route("/api/issues/{id}/live", get(collab::upgrade))
        .layer(DefaultBodyLimit::max(11 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(
        std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:3001".into()),
    )
    .await?;
    println!("Tack API listening on {}", listener.local_addr()?);
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
        })
        .await?;
    Ok(())
}
