import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
const providers = new Map<string, CollaborationProvider>();
const dirtyPrefix = (userId: string) => `tack-dirty:${userId}:`;
export const pendingDocumentIds = (userId: string) =>
  Object.keys(localStorage)
    .filter((key) => key.startsWith(dirtyPrefix(userId)))
    .map((key) => key.slice(dirtyPrefix(userId).length));
export const hasUnsyncedDocuments = (userId: string) => pendingDocumentIds(userId).length > 0;
function getDocument(issueId: string, userId: string) {
  const key = `${userId}:${issueId}`;
  let provider = providers.get(key);
  if (!provider) {
    provider = new CollaborationProvider(issueId, userId);
    providers.set(key, provider);
  }
  return provider;
}
export function acquireDocument(issueId: string, userId: string) {
  const provider = getDocument(issueId, userId);
  provider.retain();
  return provider;
}
export function resumeDocuments(userId: string) {
  for (const id of pendingDocumentIds(userId)) getDocument(id, userId);
}
export function closeDocuments() {
  for (const provider of providers.values()) provider.destroy();
}
export async function cacheDocuments(
  userId: string,
  documents: { issue_id: string; state: string }[] = [],
  previous: { issue_id: string; state: string }[] = [],
) {
  for (const item of documents) {
    if (previous.find((doc) => doc.issue_id === item.issue_id)?.state === item.state) continue;
    const bytes = Uint8Array.from(atob(item.state), (c) => c.charCodeAt(0));
    if (!bytes.length) continue;
    const active = providers.get(`${userId}:${item.issue_id}`);
    if (active) {
      Y.applyUpdate(active.doc, bytes, active);
      continue;
    }
    const doc = new Y.Doc();
    const persistence = new IndexeddbPersistence(`tack-doc:${userId}:${item.issue_id}`, doc);
    await persistence.whenSynced;
    Y.applyUpdate(doc, bytes);
    await persistence.destroy();
    doc.destroy();
  }
}
export class CollaborationProvider {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly persistence: IndexeddbPersistence;
  private socket: WebSocket | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sent = 0;
  private references = 0;
  private revision = "";
  private status = "editorLocal";
  private listeners = new Set<() => void>();
  private dirtyKey: string;
  constructor(
    private issueId: string,
    private userId: string,
  ) {
    this.dirtyKey = `${dirtyPrefix(userId)}${issueId}`;
    this.persistence = new IndexeddbPersistence(`tack-doc:${userId}:${issueId}`, this.doc);
    this.doc.on("update", this.onUpdate);
    this.awareness.on("update", this.onAwareness);
    void this.persistence.whenSynced.then(() => {
      if (!this.stopped) this.connect();
    });
    window.addEventListener("online", this.reconnect);
    window.addEventListener("offline", this.disconnect);
  }
  retain() {
    this.references++;
  }
  release() {
    this.references = Math.max(0, this.references - 1);
    if (!this.references) {
      this.awareness.setLocalState(null);
      if (this.status === "editorSaved") this.destroy();
    }
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getStatus = () => this.status;
  private setStatus(status: string) {
    this.status = status;
    this.listeners.forEach((fn) => fn());
  }
  private send(type: number, bytes: Uint8Array) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    const frame = new Uint8Array(bytes.length + 1);
    frame[0] = type;
    frame.set(bytes, 1);
    this.socket.send(frame);
    return true;
  }
  private sendDocument() {
    if (this.send(0, Y.encodeStateAsUpdate(this.doc))) {
      this.sent++;
      this.setStatus("saving");
    }
  }
  private onUpdate = (_update: Uint8Array, origin: unknown) => {
    if (origin === this) return;
    this.revision = crypto.randomUUID();
    localStorage.setItem(this.dirtyKey, this.revision);
    window.dispatchEvent(new Event("tack-documents"));
    this.setStatus("editorLocal");
    this.sendDocument();
  };
  private onAwareness = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin !== this)
      this.send(1, encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]));
  };
  private reconnect = () => {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.timer) clearTimeout(this.timer);
    this.connect();
  };
  private disconnect = () => {
    this.socket?.close();
    this.setStatus("editorLocal");
  };
  private connect() {
    if (this.stopped || !navigator.onLine || this.socket?.readyState === WebSocket.CONNECTING)
      return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/api/issues/${this.issueId}/live`);
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    this.sent = 0;
    socket.onopen = () => {
      this.sendDocument();
      this.send(1, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          this.setStatus(JSON.parse(event.data).error);
        } catch {
          this.setStatus("document_invalid");
        }
        return;
      }
      const bytes = new Uint8Array(event.data);
      if (bytes[0] === 0) Y.applyUpdate(this.doc, bytes.subarray(1), this);
      if (bytes[0] === 1) applyAwarenessUpdate(this.awareness, bytes.subarray(1), this);
      if (bytes[0] === 2) this.send(1, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
      if (bytes[0] === 3) {
        this.sent = Math.max(0, this.sent - 1);
        if (!this.sent) {
          if (localStorage.getItem(this.dirtyKey) === this.revision)
            localStorage.removeItem(this.dirtyKey);
          window.dispatchEvent(new Event("tack-documents"));
          this.setStatus("editorSaved");
          if (!this.references) this.destroy();
        }
      }
    };
    socket.onclose = () => {
      removeAwarenessStates(
        this.awareness,
        [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID),
        this,
      );
      if (!this.stopped) {
        this.setStatus("editorLocal");
        this.timer = setTimeout(() => this.connect(), 2000);
      }
    };
  }
  destroy() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    providers.delete(`${this.userId}:${this.issueId}`);
    window.removeEventListener("online", this.reconnect);
    window.removeEventListener("offline", this.disconnect);
    this.awareness.setLocalState(null);
    this.socket?.close();
    this.doc.off("update", this.onUpdate);
    this.awareness.off("update", this.onAwareness);
    this.awareness.destroy();
    void this.persistence.destroy();
    this.doc.destroy();
  }
}
