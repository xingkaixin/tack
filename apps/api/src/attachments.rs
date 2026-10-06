use crate::{
    App, auth,
    data::issue_workspace,
    error::{Error, Result},
};
use axum::{
    Json,
    body::Body,
    extract::{Multipart, Path, State},
    http::{HeaderMap, StatusCode, header},
    response::Response,
};
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

pub async fn upload(
    State(app): State<App>,
    headers: HeaderMap,
    Path((issue, id)): Path<(Uuid, Uuid)>,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    let uid = auth::user(&app, &headers).await?;
    issue_workspace(&app.db, uid, issue).await?;
    let field = multipart
        .next_field()
        .await
        .map_err(|_| Error::bad("file_invalid"))?
        .ok_or_else(|| Error::bad("file_invalid"))?;
    let name = field
        .file_name()
        .unwrap_or("attachment")
        .chars()
        .filter(|c| !c.is_control())
        .take(200)
        .collect::<String>();
    let mime = field
        .content_type()
        .unwrap_or("application/octet-stream")
        .to_owned();
    let bytes = field
        .bytes()
        .await
        .map_err(|_| Error::bad("file_too_large"))?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err(Error::bad("file_too_large"));
    }
    let mut tx = app.db.begin().await?;
    let inserted=sqlx::query("INSERT INTO attachments(id,issue_id,user_id,name,mime,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING").bind(id).bind(issue).bind(uid).bind(&name).bind(mime).bind(bytes.to_vec()).execute(&mut *tx).await?.rows_affected();
    if inserted > 0 {
        sqlx::query(
            "INSERT INTO activity(issue_id,user_id,action,detail) VALUES($1,$2,'attached',$3)",
        )
        .bind(issue)
        .bind(uid)
        .bind(json!({"name":name}))
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"id":id})))
}
pub async fn download(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let uid = auth::user(&app, &headers).await?;
    let row = sqlx::query("SELECT issue_id,data FROM attachments WHERE id=$1")
        .bind(id)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(Error::missing)?;
    issue_workspace(&app.db, uid, row.get("issue_id")).await?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_DISPOSITION, "attachment")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .body(Body::from(row.get::<Vec<u8>, _>("data")))
        .unwrap())
}
