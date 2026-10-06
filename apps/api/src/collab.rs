use crate::{
    App, auth,
    data::issue_workspace,
    error::{Error, Result},
};
use axum::{
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::HeaderMap,
    response::Response,
};
use tokio::sync::broadcast;
use uuid::Uuid;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update, updates::decoder::Decode};

fn merge(previous: &[u8], incoming: &[u8]) -> Result<Vec<u8>> {
    let doc = Doc::new();
    let mut tx = doc.transact_mut();
    if !previous.is_empty() {
        tx.apply_update(Update::decode_v1(previous).map_err(|_| Error::bad("document_invalid"))?)
            .map_err(|_| Error::bad("document_invalid"))?;
    }
    tx.apply_update(Update::decode_v1(incoming).map_err(|_| Error::bad("document_invalid"))?)
        .map_err(|_| Error::bad("document_invalid"))?;
    Ok(tx.encode_state_as_update_v1(&StateVector::default()))
}
pub async fn upgrade(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    ws: WebSocketUpgrade,
) -> Result<Response> {
    let uid = auth::user(&app, &headers).await?;
    issue_workspace(&app.db, uid, id).await?;
    crate::check_origin(&app, &headers)?;
    Ok(ws
        .max_message_size(2 * 1024 * 1024)
        .on_upgrade(move |socket| serve(app, id, uid, headers, socket)))
}
async fn persist(app: &App, id: Uuid, bytes: &[u8]) -> Result<Vec<u8>> {
    let mut tx = app.db.begin().await?;
    sqlx::query("INSERT INTO documents(issue_id,state) VALUES($1,$2) ON CONFLICT DO NOTHING")
        .bind(id)
        .bind(Vec::<u8>::new())
        .execute(&mut *tx)
        .await?;
    let previous: Vec<u8> =
        sqlx::query_scalar("SELECT state FROM documents WHERE issue_id=$1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    let state = merge(&previous, bytes)?;
    if state.len() > 2 * 1024 * 1024 {
        return Err(Error::bad("document_too_large"));
    }
    sqlx::query("UPDATE documents SET state=$2 WHERE issue_id=$1")
        .bind(id)
        .bind(&state)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(state)
}
async fn serve(app: App, id: Uuid, uid: Uuid, headers: HeaderMap, mut socket: WebSocket) {
    let (channel, mut rx) = {
        let mut rooms = app.rooms.lock().await;
        let channel = rooms
            .entry(id)
            .or_insert_with(|| broadcast::channel(128).0)
            .clone();
        let rx = channel.subscribe();
        (channel, rx)
    };
    let initial: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT state FROM documents WHERE issue_id=$1")
            .bind(id)
            .fetch_optional(&app.db)
            .await
            .unwrap_or(None);
    if let Some(state) = initial {
        let mut frame = vec![0];
        frame.extend(state);
        if socket.send(Message::Binary(frame.into())).await.is_err() {
            return;
        }
    }
    let _ = channel.send(vec![2]);
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(20));
    loop {
        tokio::select! {
            message=socket.recv()=>{
                match message{
                    Some(Ok(Message::Binary(bytes))) if !bytes.is_empty()=>{
                        match bytes[0]{
                            0=>match persist(&app,id,&bytes[1..]).await{
                                Ok(state)=>{let mut frame=vec![0];frame.extend(state);let _=channel.send(frame);if socket.send(Message::Binary(vec![3].into())).await.is_err(){break;}},
                                Err(error)=>{let _=socket.send(Message::Text(error.1.to_string().into())).await;break;}
                            },
                            1 if bytes.len()<65536=>{let _=channel.send(bytes.to_vec());},
                            _=>break
                        }
                    },
                    Some(Ok(Message::Ping(bytes)))=>{if socket.send(Message::Pong(bytes)).await.is_err(){break;}},
                    Some(Ok(Message::Pong(_)))=>{},
                    _=>break
                }
            },
            event=rx.recv()=>match event{
                Ok(bytes)=>if socket.send(Message::Binary(bytes.into())).await.is_err(){break;},
                Err(_)=>break
            },
            _=heartbeat.tick()=>{
                if auth::user(&app,&headers).await.is_err()||issue_workspace(&app.db,uid,id).await.is_err(){break;}
                if socket.send(Message::Ping(vec![].into())).await.is_err(){break;}
            }
        }
    }
    drop(rx);
    let mut rooms = app.rooms.lock().await;
    if channel.receiver_count() == 0 {
        rooms.remove(&id);
    }
}
