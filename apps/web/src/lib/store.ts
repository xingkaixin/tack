import { openDB } from "idb";
import {
  cacheDocuments,
  hasUnsyncedDocuments,
  closeDocuments,
  pendingDocumentIds,
} from "./collaboration";
import { QueryClient } from "@tanstack/react-query";
import type {
  Snapshot,
  Operation,
  Fields,
  Issue,
  Comment,
  Attachment,
  Project,
  Workspace,
} from "./types";
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
const database = openDB("tack-local", 1, {
  upgrade(db) {
    db.createObjectStore("state");
    db.createObjectStore("files");
  },
});
export class ApiError extends Error {
  constructor(
    public status: number,
    public data: Record<string, unknown>,
  ) {
    super(String(data.error || "server_error"));
  }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "server_error" }));
    throw new ApiError(response.status, data);
  }
  return response.json();
}
let base: Snapshot | undefined;
let queue: Operation[] = [];
let busy = false;
let ready = false;
let sequence = Promise.resolve();
const channel = new BroadcastChannel("tack-state");
const listeners = new Set<() => void>();
export type SyncState = {
  pending: Operation[];
  documents: string[];
  busy: boolean;
  online: boolean;
  error: string | null;
};
let sync: SyncState = {
  pending: [],
  documents: [],
  busy: false,
  online: navigator.onLine,
  error: null,
};
export const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getSync = () => sync;
function emit(error: string | null = sync.error) {
  sync = {
    pending: [...queue],
    documents: base ? pendingDocumentIds(base.user.id) : [],
    busy,
    online: navigator.onLine,
    error,
  };
  listeners.forEach((fn) => fn());
}
function projected() {
  if (!base) return;
  const data = structuredClone(base);
  for (const op of queue) {
    const p = op.payload;
    const id = String(p.id);
    if (op.kind === "workspace.create") data.workspaces.push({ ...p, role: "admin" } as Workspace);
    if (op.kind === "project.create") data.projects.push(p as Project);
    if (op.kind === "issue.create") {
      const project = data.projects.find((project) => project.id === p.project_id);
      if (!data.issues.some((issue) => issue.id === id))
        data.issues.unshift({
          ...p,
          workspace_id: project?.workspace_id,
          identifier: `${project?.identifier || "…"}-…`,
          number: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          created_by: data.user.id,
        } as Issue);
    }
    if (op.kind === "issue.patch") {
      const issue = data.issues.find((issue) => issue.id === id);
      if (issue) issue.fields = { ...issue.fields, ...(p.fields as Partial<Fields>) };
    }
    if (op.kind === "comment.create" && !data.comments.some((comment) => comment.id === id))
      data.comments.push({
        ...p,
        user_id: data.user.id,
        created_at: new Date().toISOString(),
      } as Comment);
    if (op.kind === "attachment.create" && !data.attachments.some((file) => file.id === id))
      data.attachments.push({
        ...p,
        user_id: data.user.id,
        name: op.file?.name,
        size: op.file?.size,
        mime: op.file?.type,
        created_at: new Date().toISOString(),
      } as Attachment);
  }
  return data;
}
function publish() {
  queryClient.setQueryData(["snapshot"], projected());
  emit();
}
async function save() {
  const db = await database;
  await db.put("state", { base, queue }, "session");
  channel.postMessage("changed");
}
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = () =>
    navigator.locks.request("tack-state", async () => {
      const cached = await (await database).get("state", "session");
      base = cached?.base;
      queue = cached?.queue || [];
      return work();
    });
  const next = sequence.then(run, run);
  sequence = next.then(
    () => {},
    () => {},
  );
  return next;
}
export async function initialize() {
  if (ready) return;
  const cached = await (await database).get("state", "session");
  if (cached) {
    base = cached.base;
    queue = cached.queue || [];
    publish();
  }
  ready = true;
}
export async function refresh() {
  await initialize();
  const data = await api<Snapshot>("/snapshot");
  await exclusive(async () => {
    if (base && base.user.id !== data.user.id && queue.length) throw new Error("sessionMismatch");
    if (base && base.user.id !== data.user.id) {
      await (await database).clear("files");
    }
    await cacheDocuments(data.user.id, data.documents, base?.documents || []);
    base = data;
    await save();
    publish();
    emit(null);
  });
  return projected()!;
}
export async function enqueue(
  kind: string,
  payload: Record<string, unknown>,
  original?: Partial<Fields>,
  file?: File,
) {
  await exclusive(async () => {
    if (file) await (await database).put("files", file, `${base?.user.id}:${payload.id}`);
    queue.push({ id: crypto.randomUUID(), kind, payload, base: original, file });
    await save();
    publish();
  });
  void flush();
}
export async function flush() {
  if (busy || !navigator.onLine || !base) return;
  await navigator.locks.request("tack-sync", { ifAvailable: true }, async (lock) => {
    if (lock) await drain();
  });
}
async function drain() {
  await exclusive(async () => publish());
  busy = true;
  emit(null);
  try {
    for (;;) {
      if (!queue.length) {
        await refresh();
        if (!queue.length) break;
      }
      const op = queue[0];
      if (op.error) break;
      try {
        if (op.kind === "attachment.create") {
          const form = new FormData();
          form.append("file", op.file!);
          await api(`/issues/${op.payload.issue_id}/attachments/${op.payload.id}`, {
            method: "POST",
            body: form,
          });
        } else await api("/operations", { method: "POST", body: JSON.stringify(op) });
        await exclusive(async () => {
          // Apply successful writes to the local base before removing them, even if the next refresh is offline.
          const rest = queue.filter((item) => item.id !== op.id);
          queue = [op];
          base = projected();
          queue = rest;
          await save();
          publish();
        });
      } catch (error) {
        if (error instanceof ApiError && error.status < 500) {
          await exclusive(async () => {
            const pending = queue.find((item) => item.id === op.id);
            if (!pending) return;
            pending.error = error.message;
            pending.current = error.data.current as Fields | undefined;
            await save();
            emit(error.status === 401 ? "authExpired" : null);
          });
        } else emit("network_error");
        break;
      }
    }
  } catch (error) {
    emit(error instanceof Error ? error.message : "network_error");
  } finally {
    busy = false;
    emit();
  }
}
export async function resolve(id: string, keep: boolean) {
  await exclusive(async () => {
    const op = queue.find((op) => op.id === id);
    if (!op) return;
    if (keep) {
      if (op.current) op.base = op.current;
      delete op.error;
      delete op.current;
    } else {
      if (op.current && base) {
        const issue = base.issues.find((issue) => issue.id === op.payload.id);
        if (issue) issue.fields = op.current;
      }
      queue = queue.filter((op) => op.id !== id);
    }
    await save();
    publish();
  });
  void flush();
}
export async function logout() {
  if (queue.length || (base && hasUnsyncedDocuments(base.user.id)))
    throw new Error("logoutPending");
  closeDocuments();
  await api("/auth/logout", { method: "POST" });
  base = undefined;
  queue = [];
  await (await database).clear("state");
  await (await database).clear("files");
  queryClient.clear();
  emit(null);
}
export async function attachmentBlob(id: string): Promise<Blob> {
  const db = await database;
  const key = `${base?.user.id}:${id}`;
  let blob: Blob | undefined = await db.get("files", key);
  const pending = queue.find((op) => op.payload.id === id && op.file);
  if (pending) blob = pending.file;
  if (!blob) {
    const response = await fetch(`/api/attachments/${id}`);
    if (!response.ok) throw new Error(response.status === 401 ? "authExpired" : "network_error");
    blob = await response.blob();
    await db.put("files", blob, key);
  }
  return blob;
}
export async function download(file: Attachment) {
  const url = URL.createObjectURL(await attachmentBlob(file.id));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
channel.onmessage = () => {
  void exclusive(async () => publish());
};
window.addEventListener("online", () => {
  emit();
  void flush();
});
window.addEventListener("offline", () => emit());
window.addEventListener("tack-documents", () => emit());
window.addEventListener("storage", () => emit());
setInterval(() => {
  if (base && !busy && navigator.onLine) {
    if (queue.length) void flush();
    else
      void refresh().catch((error) =>
        emit(error instanceof ApiError && error.status === 401 ? "authExpired" : "network_error"),
      );
  }
}, 10000);
