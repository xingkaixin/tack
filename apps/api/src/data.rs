use crate::{
    App, auth,
    error::{Error, Result},
    required,
};
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

pub async fn snapshot(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    let uid = auth::user(&app, &headers).await?;
    let user: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object('id',id,'name',name,'email',email) FROM users WHERE id=$1",
    )
    .bind(uid)
    .fetch_one(&app.db)
    .await?;
    let workspaces:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(w)||jsonb_build_object('role',m.role) FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at").bind(uid).fetch_all(&app.db).await?;
    let members:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'role',m.role,'workspace_id',m.workspace_id) FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id IN(SELECT workspace_id FROM members WHERE user_id=$1)").bind(uid).fetch_all(&app.db).await?;
    let projects:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(p)-'next_number' FROM projects p WHERE workspace_id IN(SELECT workspace_id FROM members WHERE user_id=$1) ORDER BY created_at").bind(uid).fetch_all(&app.db).await?;
    let issues:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(i)||jsonb_build_object('identifier',p.identifier||'-'||i.number,'workspace_id',p.workspace_id) FROM issues i JOIN projects p ON p.id=i.project_id JOIN members m ON m.workspace_id=p.workspace_id WHERE m.user_id=$1 ORDER BY i.created_at DESC").bind(uid).fetch_all(&app.db).await?;
    let comments:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(c) FROM comments c JOIN issues i ON i.id=c.issue_id JOIN projects p ON p.id=i.project_id JOIN members m ON m.workspace_id=p.workspace_id WHERE m.user_id=$1 ORDER BY c.created_at").bind(uid).fetch_all(&app.db).await?;
    let activity:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(a) FROM activity a JOIN issues i ON i.id=a.issue_id JOIN projects p ON p.id=i.project_id JOIN members m ON m.workspace_id=p.workspace_id WHERE m.user_id=$1 ORDER BY a.created_at DESC LIMIT 2000").bind(uid).fetch_all(&app.db).await?;
    let attachments:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',a.id,'issue_id',a.issue_id,'name',a.name,'mime',a.mime,'size',octet_length(a.data),'user_id',a.user_id,'created_at',a.created_at) FROM attachments a JOIN issues i ON i.id=a.issue_id JOIN projects p ON p.id=i.project_id JOIN members m ON m.workspace_id=p.workspace_id WHERE m.user_id=$1 ORDER BY a.created_at").bind(uid).fetch_all(&app.db).await?;
    let documents:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('issue_id',d.issue_id,'state',encode(d.state,'base64')) FROM documents d JOIN issues i ON i.id=d.issue_id JOIN projects p ON p.id=i.project_id JOIN members m ON m.workspace_id=p.workspace_id WHERE m.user_id=$1").bind(uid).fetch_all(&app.db).await?;
    Ok(Json(
        json!({"documents":documents,"user":user,"workspaces":workspaces,"members":members,"projects":projects,"issues":issues,"comments":comments,"activity":activity,"attachments":attachments}),
    ))
}
pub async fn issue_workspace<'e>(
    executor: impl sqlx::PgExecutor<'e>,
    uid: Uuid,
    id: Uuid,
) -> Result<Uuid> {
    sqlx::query_scalar("SELECT p.workspace_id FROM issues i JOIN projects p ON p.id=i.project_id JOIN members m ON m.workspace_id=p.workspace_id WHERE i.id=$1 AND m.user_id=$2")
        .bind(id).bind(uid).fetch_optional(executor).await?.ok_or_else(Error::missing)
}
#[derive(Deserialize)]
pub struct Operation {
    id: Uuid,
    kind: String,
    payload: Value,
    #[serde(default)]
    base: Value,
}
fn uuid(value: &Value, key: &str) -> Result<Uuid> {
    value
        .get(key)
        .and_then(Value::as_str)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| Error::bad("invalid_id"))
}
fn string<'a>(value: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    required(value.get(key).and_then(Value::as_str).unwrap_or(""), max)
}
async fn log(
    tx: &mut Transaction<'_, Postgres>,
    uid: Uuid,
    issue: Uuid,
    action: &str,
    detail: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO activity(issue_id,user_id,action,detail) VALUES($1,$2,$3,$4)")
        .bind(issue)
        .bind(uid)
        .bind(action)
        .bind(detail)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
async fn validate_fields(
    tx: &mut Transaction<'_, Postgres>,
    fields: &Value,
    project: Uuid,
    id: Uuid,
    workspace: Uuid,
) -> Result<()> {
    string(fields, "title", 300)?;
    if !fields["board_rank"].is_null() {
        let rank = fields["board_rank"]
            .as_str()
            .ok_or_else(|| Error::bad("field_invalid"))?;
        if !rank.starts_with("a0")
            || rank.len() < 3
            || rank.len() > 512
            || rank.ends_with('0')
            || !rank.bytes().all(|c| c.is_ascii_alphanumeric())
        {
            return Err(Error::bad("field_invalid"));
        }
    }
    if !["backlog", "todo", "in_progress", "done", "cancelled"]
        .contains(&fields["status"].as_str().unwrap_or(""))
    {
        return Err(Error::bad("status_invalid"));
    }
    if !["none", "low", "medium", "high", "urgent"]
        .contains(&fields["priority"].as_str().unwrap_or(""))
    {
        return Err(Error::bad("priority_invalid"));
    }
    if let Some(assignee) = fields["assignee"].as_str() {
        let assignee: Uuid = assignee.parse().map_err(|_| Error::bad("invalid_id"))?;
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM members WHERE workspace_id=$1 AND user_id=$2)",
        )
        .bind(workspace)
        .bind(assignee)
        .fetch_one(&mut **tx)
        .await?;
        if !exists {
            return Err(Error::bad("assignee_invalid"));
        }
    } else if !fields["assignee"].is_null() {
        return Err(Error::bad("assignee_invalid"));
    }
    if let Some(date) = fields["due_date"].as_str() {
        chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map_err(|_| Error::bad("date_invalid"))?;
    } else if !fields["due_date"].is_null() {
        return Err(Error::bad("date_invalid"));
    }
    let labels = fields["labels"]
        .as_array()
        .ok_or_else(|| Error::bad("labels_invalid"))?;
    if labels.len() > 20
        || labels.iter().any(|label| {
            label
                .as_str()
                .is_none_or(|s| s.is_empty() || s.chars().count() > 50)
        })
    {
        return Err(Error::bad("labels_invalid"));
    }
    for key in ["parent", "blocked_by"] {
        let ids = if key == "parent" {
            if fields[key].is_null() {
                vec![]
            } else {
                vec![fields[key].clone()]
            }
        } else {
            fields[key]
                .as_array()
                .ok_or_else(|| Error::bad("dependencies_invalid"))?
                .clone()
        };
        if ids.len() > 100 {
            return Err(Error::bad("dependencies_invalid"));
        }
        for value in ids {
            let target: Uuid = value
                .as_str()
                .and_then(|s| s.parse().ok())
                .ok_or_else(|| Error::bad("invalid_id"))?;
            if target == id {
                return Err(Error::bad("cycle_detected"));
            }
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM issues WHERE id=$1 AND project_id=$2)",
            )
            .bind(target)
            .bind(project)
            .fetch_one(&mut **tx)
            .await?;
            if !exists {
                return Err(Error::bad("related_issue_invalid"));
            }
            let query = if key == "parent" {
                "WITH RECURSIVE chain AS (SELECT id,fields FROM issues WHERE id=$1 UNION SELECT i.id,i.fields FROM issues i JOIN chain c ON i.id::text=c.fields->>'parent') SELECT EXISTS(SELECT 1 FROM chain WHERE id=$2)"
            } else {
                "WITH RECURSIVE chain AS (SELECT id,fields FROM issues WHERE id=$1 UNION SELECT i.id,i.fields FROM issues i JOIN chain c ON c.fields->'blocked_by' ? i.id::text) SELECT EXISTS(SELECT 1 FROM chain WHERE id=$2)"
            };
            let cycle: bool = sqlx::query_scalar(query)
                .bind(target)
                .bind(id)
                .fetch_one(&mut **tx)
                .await?;
            if cycle {
                return Err(Error::bad("cycle_detected"));
            }
        }
    }
    Ok(())
}
pub async fn mutate(
    State(app): State<App>,
    headers: HeaderMap,
    Json(op): Json<Operation>,
) -> Result<Json<Value>> {
    let uid = auth::user(&app, &headers).await?;
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(op.id.to_string())
        .execute(&mut *tx)
        .await?;
    let previous: Option<Value> =
        sqlx::query_scalar("SELECT result FROM operations WHERE id=$1 AND user_id=$2")
            .bind(op.id)
            .bind(uid)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(result) = previous {
        return Ok(Json(result));
    }
    let p = &op.payload;
    let result = match op.kind.as_str() {
        "workspace.create" => {
            let id = uuid(p, "id")?;
            let name = string(p, "name", 100)?;
            sqlx::query("INSERT INTO workspaces(id,name) VALUES($1,$2)")
                .bind(id)
                .bind(name)
                .execute(&mut *tx)
                .await?;
            sqlx::query("INSERT INTO members VALUES($1,$2,'admin')")
                .bind(id)
                .bind(uid)
                .execute(&mut *tx)
                .await?;
            json!({"id":id})
        }
        "project.create" => {
            let wid = uuid(p, "workspace_id")?;
            auth::member(&mut *tx, uid, wid, false).await?;
            let id = uuid(p, "id")?;
            let name = string(p, "name", 100)?;
            let identifier = string(p, "identifier", 10)?.to_uppercase();
            if !identifier
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
            {
                return Err(Error::bad("identifier_invalid"));
            }
            sqlx::query("INSERT INTO projects(id,workspace_id,name,identifier,description) VALUES($1,$2,$3,$4,$5)").bind(id).bind(wid).bind(name).bind(identifier).bind(p["description"].as_str().unwrap_or("")).execute(&mut *tx).await?;
            json!({"id":id})
        }
        "issue.create" | "issue.patch" => {
            let id = uuid(p, "id")?;
            let project = if op.kind == "issue.create" {
                uuid(p, "project_id")?
            } else {
                sqlx::query_scalar("SELECT project_id FROM issues WHERE id=$1")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?
                    .ok_or_else(Error::missing)?
            };
            // Serialize graph edits within a project so concurrent edges cannot form a cycle.
            let row = sqlx::query("SELECT workspace_id FROM projects WHERE id=$1 FOR UPDATE")
                .bind(project)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(Error::missing)?;
            let workspace: Uuid = row.get("workspace_id");
            auth::member(&mut *tx, uid, workspace, false).await?;
            let mut fields = if op.kind == "issue.create" {
                json!({"title":"","status":"backlog","priority":"none","assignee":null,"due_date":null,"labels":[],"parent":null,"blocked_by":[]})
            } else {
                sqlx::query_scalar::<_, Value>("SELECT fields FROM issues WHERE id=$1 FOR UPDATE")
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await?
            };
            let changes = p["fields"]
                .as_object()
                .ok_or_else(|| Error::bad("fields_invalid"))?;
            let mut conflicts = serde_json::Map::new();
            for (key, value) in changes {
                if ![
                    "title",
                    "status",
                    "priority",
                    "assignee",
                    "due_date",
                    "labels",
                    "parent",
                    "blocked_by",
                    "board_rank",
                ]
                .contains(&key.as_str())
                {
                    return Err(Error::bad("field_invalid"));
                }
                if op.kind == "issue.patch" && fields[key] != op.base[key] && fields[key] != *value
                {
                    conflicts.insert(key.clone(), fields[key].clone());
                }
            }
            if !conflicts.is_empty() {
                return Err(Error(
                    axum::http::StatusCode::CONFLICT,
                    json!({"error":"conflict","current":fields,"conflicts":conflicts}),
                ));
            }
            let before = fields.clone();
            for (key, value) in changes {
                fields[key] = value.clone();
            }
            validate_fields(&mut tx, &fields, project, id, workspace).await?;
            if op.kind == "issue.create" {
                let number:i32=sqlx::query_scalar("UPDATE projects SET next_number=next_number+1 WHERE id=$1 RETURNING next_number").bind(project).fetch_one(&mut *tx).await?;
                sqlx::query("INSERT INTO issues(id,project_id,number,fields,created_by) VALUES($1,$2,$3,$4,$5)").bind(id).bind(project).bind(number).bind(&fields).bind(uid).execute(&mut *tx).await?;
                log(&mut tx, uid, id, "created", json!({})).await?;
            } else {
                sqlx::query("UPDATE issues SET fields=$2,updated_at=now() WHERE id=$1")
                    .bind(id)
                    .bind(&fields)
                    .execute(&mut *tx)
                    .await?;
                log(
                    &mut tx,
                    uid,
                    id,
                    "updated",
                    json!({"before":before,"changes":changes}),
                )
                .await?;
            }
            json!({"id":id,"fields":fields})
        }
        "comment.create" => {
            let issue = uuid(p, "issue_id")?;
            issue_workspace(&mut *tx, uid, issue).await?;
            let id = uuid(p, "id")?;
            let body = string(p, "body", 20000)?;
            sqlx::query("INSERT INTO comments(id,issue_id,user_id,body) VALUES($1,$2,$3,$4)")
                .bind(id)
                .bind(issue)
                .bind(uid)
                .bind(body)
                .execute(&mut *tx)
                .await?;
            log(&mut tx, uid, issue, "commented", json!({})).await?;
            json!({"id":id})
        }
        _ => return Err(Error::bad("operation_invalid")),
    };
    sqlx::query("INSERT INTO operations(id,user_id,result) VALUES($1,$2,$3)")
        .bind(op.id)
        .bind(uid)
        .bind(&result)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(result))
}
#[derive(Deserialize)]
pub struct MemberInput {
    email: String,
    name: String,
    password: String,
    role: String,
}
pub async fn add_member(
    State(app): State<App>,
    headers: HeaderMap,
    Path(workspace): Path<Uuid>,
    Json(input): Json<MemberInput>,
) -> Result<Json<Value>> {
    let uid = auth::user(&app, &headers).await?;
    auth::member(&app.db, uid, workspace, true).await?;
    if !["admin", "member"].contains(&input.role.as_str()) {
        return Err(Error::bad("role_invalid"));
    }
    let email = auth::validate_email(&input.email)?;
    let name = required(&input.name, 100)?;
    let mut tx = app.db.begin().await?;
    let existing: Option<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE email=$1")
        .bind(&email)
        .fetch_optional(&mut *tx)
        .await?;
    let id = if let Some(id) = existing {
        id
    } else {
        let id = Uuid::new_v4();
        let hash = auth::hash(&input.password)?;
        sqlx::query("INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)")
            .bind(id)
            .bind(email)
            .bind(name)
            .bind(hash)
            .execute(&mut *tx)
            .await?;
        id
    };
    sqlx::query("INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,$3)")
        .bind(workspace)
        .bind(id)
        .bind(input.role)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"id":id})))
}
