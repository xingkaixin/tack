use crate::{
    App,
    error::{Error, Result},
};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, HeaderValue},
};
use rand_core::OsRng;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

pub fn token(headers: &HeaderMap) -> Option<String> {
    headers
        .get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| part.trim().strip_prefix("tack_session=").map(str::to_owned))
}
fn digest(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}
pub async fn user(app: &App, headers: &HeaderMap) -> Result<Uuid> {
    let token = token(headers).ok_or_else(Error::unauthorized)?;
    sqlx::query_scalar("SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now()")
        .bind(digest(&token))
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(Error::unauthorized)
}
pub async fn member<'e>(
    executor: impl sqlx::PgExecutor<'e>,
    uid: Uuid,
    workspace: Uuid,
    admin: bool,
) -> Result<()> {
    let role: Option<String> =
        sqlx::query_scalar("SELECT role FROM members WHERE workspace_id=$1 AND user_id=$2")
            .bind(workspace)
            .bind(uid)
            .fetch_optional(executor)
            .await?;
    match role {
        Some(role) if !admin || role == "admin" => Ok(()),
        _ => Err(Error::forbidden()),
    }
}
pub fn hash(password: &str) -> Result<String> {
    if password.chars().count() < 10 || password.chars().count() > 256 {
        return Err(Error::bad("password_length"));
    }
    Argon2::default()
        .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
        .map(|hash| hash.to_string())
        .map_err(|_| Error::bad("password_invalid"))
}
#[derive(Deserialize)]
pub struct Credentials {
    pub email: String,
    pub password: String,
    pub name: Option<String>,
    pub workspace: Option<String>,
}
fn cookie(token: &str) -> HeaderMap {
    let secure = std::env::var("COOKIE_SECURE").unwrap_or_default() == "true";
    let mut headers = HeaderMap::new();
    headers.insert(
        "set-cookie",
        HeaderValue::from_str(&format!(
            "tack_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={};{}",
            if token.is_empty() { 0 } else { 2592000 },
            if secure { " Secure" } else { "" }
        ))
        .unwrap(),
    );
    headers
}
async fn session(app: &App, uid: Uuid) -> Result<(HeaderMap, Json<Value>)> {
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    sqlx::query("INSERT INTO sessions(token_hash,user_id) VALUES($1,$2)")
        .bind(digest(&token))
        .bind(uid)
        .execute(&app.db)
        .await?;
    Ok((cookie(&token), Json(json!({"id":uid}))))
}
pub async fn status(State(app): State<App>) -> Result<Json<Value>> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users)")
        .fetch_one(&app.db)
        .await?;
    Ok(Json(json!({"initialized":exists})))
}
pub async fn setup(
    State(app): State<App>,
    Json(input): Json<Credentials>,
) -> Result<(HeaderMap, Json<Value>)> {
    let email = validate_email(&input.email)?;
    let name = crate::required(input.name.as_deref().unwrap_or(""), 100)?;
    let workspace = crate::required(input.workspace.as_deref().unwrap_or(""), 100)?;
    let password = hash(&input.password)?;
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(817235)")
        .execute(&mut *tx)
        .await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users)")
        .fetch_one(&mut *tx)
        .await?;
    if exists {
        return Err(Error::forbidden());
    }
    let uid = Uuid::new_v4();
    let wid = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)")
        .bind(uid)
        .bind(email)
        .bind(name)
        .bind(password)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO workspaces(id,name) VALUES($1,$2)")
        .bind(wid)
        .bind(workspace)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO members VALUES($1,$2,'admin')")
        .bind(wid)
        .bind(uid)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    session(&app, uid).await
}
pub fn validate_email(value: &str) -> Result<String> {
    let email = value.trim().to_lowercase();
    if email.len() > 254 || !email.contains('@') || email.contains(char::is_whitespace) {
        return Err(Error::bad("email_invalid"));
    }
    Ok(email)
}
pub async fn login(
    State(app): State<App>,
    Json(input): Json<Credentials>,
) -> Result<(HeaderMap, Json<Value>)> {
    if input.password.chars().count() > 256 {
        return Err(Error::unauthorized());
    }
    let row = sqlx::query("SELECT id,password_hash FROM users WHERE email=$1")
        .bind(input.email.trim().to_lowercase())
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(Error::unauthorized)?;
    let encoded: String = row.get("password_hash");
    let parsed = PasswordHash::new(&encoded).map_err(|_| Error::unauthorized())?;
    Argon2::default()
        .verify_password(input.password.as_bytes(), &parsed)
        .map_err(|_| Error::unauthorized())?;
    session(&app, row.get("id")).await
}
pub async fn logout(
    State(app): State<App>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<Value>)> {
    if let Some(token) = token(&headers) {
        sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
            .bind(digest(&token))
            .execute(&app.db)
            .await?;
    }
    Ok((cookie(""), Json(json!({"ok":true}))))
}
