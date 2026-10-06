import { useState, useEffect, useRef, lazy, Suspense } from "react";
import {
  X,
  Plus,
  Paperclip,
  ArrowUpRight,
  GitBranch,
  Link2,
  MessageSquare,
  History,
  Download,
} from "lucide-react";
import { useI18n } from "../lib/i18n";
import { enqueue, download } from "../lib/store";
import { statuses, priorities, type Snapshot, type Issue, type Fields } from "../lib/types";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./ui/dialog";
import { Button } from "./ui/button";
const RichEditor = lazy(() =>
  import("./Editor").then((module) => ({ default: module.RichEditor })),
);
import { CreateForm, Field } from "./Forms";
export function StatusDot({ status }: { status: string }) {
  return <span aria-hidden className={`status-dot ${status}`} />;
}
export function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <span className={`avatar ${small ? "small-avatar" : ""}`} title={name}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
export function IssueDetail({
  issue,
  data,
  onClose,
  onSelect,
}: {
  issue: Issue;
  data: Snapshot;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const [title, setTitle] = useState(issue.fields.title);
  const [labels, setLabels] = useState(issue.fields.labels.join(", "));
  const [comment, setComment] = useState("");
  const [tab, setTab] = useState("comments");
  const [error, setError] = useState("");
  const [subtask, setSubtask] = useState(false);
  const editingTitle = useRef<string | null>(null);
  const editingLabels = useRef<string[] | null>(null);
  useEffect(() => {
    if (editingTitle.current === null) setTitle(issue.fields.title);
    if (editingLabels.current === null) setLabels(issue.fields.labels.join(", "));
  }, [issue.id, issue.fields.title, issue.fields.labels]);
  const patch = async (changes: Partial<Fields>, original?: Partial<Fields>) => {
    try {
      await enqueue(
        "issue.patch",
        { id: issue.id, fields: changes },
        original ||
          Object.fromEntries(
            Object.keys(changes).map((key) => [key, issue.fields[key as keyof Fields]]),
          ),
      );
      setError("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "server_error");
    }
  };
  const members = data.members.filter((m) => m.workspace_id === issue.workspace_id);
  const related = data.issues.filter((i) => i.project_id === issue.project_id && i.id !== issue.id);
  const subtasks = data.issues.filter((i) => i.fields.parent === issue.id);
  const files = data.attachments.filter((a) => a.issue_id === issue.id);
  const comments = data.comments.filter((c) => c.issue_id === issue.id);
  const activities = data.activity.filter((a) => a.issue_id === issue.id);
  const userName = (id: string) => data.members.find((m) => m.id === id)?.name || data.user.name;
  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent side className="issue-panel" showCloseButton={false}>
          <div className="detail-top">
            <span className="issue-id">{issue.identifier}</span>
            <span className="detail-project">
              {data.projects.find((p) => p.id === issue.project_id)?.name}
            </span>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label={t("close")}>
              <X size={18} />
            </Button>
          </div>
          <DialogTitle className="sr-only">{issue.fields.title}</DialogTitle>
          <DialogDescription className="sr-only">{t("description")}</DialogDescription>
          <div className="detail-scroll">
            <div className="detail-main">
              <textarea
                className="issue-title-input"
                aria-label={t("title")}
                value={title}
                rows={2}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={300}
                onFocus={() => {
                  editingTitle.current = issue.fields.title;
                }}
                onBlur={() => {
                  const original = editingTitle.current ?? issue.fields.title;
                  editingTitle.current = null;
                  if (title.trim() && title.trim() !== original)
                    void patch({ title: title.trim() }, { title: original });
                  else setTitle(issue.fields.title);
                }}
              />
              <div className="properties">
                <Field label={t("status")}>
                  <select
                    value={issue.fields.status}
                    onChange={(e) => void patch({ status: e.target.value as Fields["status"] })}
                  >
                    {statuses.map((value) => (
                      <option key={value} value={value}>
                        {t(value)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("priority")}>
                  <select
                    value={issue.fields.priority}
                    onChange={(e) => void patch({ priority: e.target.value as Fields["priority"] })}
                  >
                    {priorities.map((value) => (
                      <option key={value} value={value}>
                        {t(value)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("assignee")}>
                  <select
                    value={issue.fields.assignee || ""}
                    onChange={(e) => void patch({ assignee: e.target.value || null })}
                  >
                    <option value="">{t("unassigned")}</option>
                    {members.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("due_date")}>
                  <input
                    type="date"
                    value={issue.fields.due_date || ""}
                    onChange={(e) => void patch({ due_date: e.target.value || null })}
                  />
                </Field>
                <Field label={t("labels")}>
                  <input
                    value={labels}
                    placeholder={t("labels")}
                    onChange={(e) => setLabels(e.target.value)}
                    onFocus={() => {
                      editingLabels.current = issue.fields.labels;
                    }}
                    onBlur={() => {
                      const next = [
                        ...new Set(
                          labels
                            .split(/[,，]/)
                            .map((s) => s.trim())
                            .filter(Boolean),
                        ),
                      ];
                      const original = editingLabels.current ?? issue.fields.labels;
                      editingLabels.current = null;
                      if (JSON.stringify(next) !== JSON.stringify(original))
                        void patch({ labels: next }, { labels: original });
                    }}
                  />
                </Field>
                <Field label={t("parent")}>
                  <select
                    value={issue.fields.parent || ""}
                    onChange={(e) => void patch({ parent: e.target.value || null })}
                  >
                    <option value="">{t("noParent")}</option>
                    {related.map((other) => (
                      <option key={other.id} value={other.id}>
                        {other.identifier} {other.fields.title}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              {error && (
                <p className="error" role="alert">
                  {t(error)}
                </p>
              )}
              <section className="detail-section">
                <h3>{t("description")}</h3>
                <Suspense fallback={<div className="editor-skeleton" />}>
                  <RichEditor key={issue.id} issueId={issue.id} user={data.user} />
                </Suspense>
              </section>
              <section className="detail-section">
                <div className="section-heading">
                  <h3>
                    <GitBranch size={15} />
                    {t("subtasks")}
                    <span className="count">{subtasks.length}</span>
                  </h3>
                  <Button variant="ghost" size="sm" onClick={() => setSubtask(true)}>
                    <Plus size={14} />
                    {t("add")}
                  </Button>
                </div>
                {subtasks.map((child) => (
                  <button
                    className="relation-row"
                    key={child.id}
                    onClick={() => onSelect(child.id)}
                  >
                    <StatusDot status={child.fields.status} />
                    <span className="issue-id">{child.identifier}</span>
                    <span>{child.fields.title}</span>
                    <ArrowUpRight size={14} />
                  </button>
                ))}
              </section>
              <section className="detail-section">
                <div className="section-heading">
                  <h3>
                    <Link2 size={15} />
                    {t("blocked_by")}
                  </h3>
                </div>
                {issue.fields.blocked_by.map((id) => {
                  const other = data.issues.find((i) => i.id === id);
                  return (
                    <div className="relation-row" key={id}>
                      <button onClick={() => onSelect(id)}>
                        {other?.identifier} {other?.fields.title}
                      </button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t("remove")}
                        onClick={() =>
                          void patch({
                            blocked_by: issue.fields.blocked_by.filter((value) => value !== id),
                          })
                        }
                      >
                        <X size={12} />
                      </Button>
                    </div>
                  );
                })}
                <select
                  aria-label={t("blocked_by")}
                  value=""
                  onChange={(e) => {
                    if (e.target.value)
                      void patch({ blocked_by: [...issue.fields.blocked_by, e.target.value] });
                  }}
                >
                  <option value="">{t("selectIssue")}</option>
                  {related
                    .filter((other) => !issue.fields.blocked_by.includes(other.id))
                    .map((other) => (
                      <option value={other.id} key={other.id}>
                        {other.identifier} {other.fields.title}
                      </option>
                    ))}
                </select>
              </section>
              <section className="detail-section">
                <div className="section-heading">
                  <h3>
                    <Paperclip size={15} />
                    {t("attachments")}
                    <span className="count">{files.length}</span>
                  </h3>
                  <label className="upload-button">
                    <Plus size={14} />
                    {t("upload")}
                    <input
                      type="file"
                      multiple
                      aria-label={t("upload")}
                      onChange={async (e) => {
                        const selected = Array.from(e.target.files || []);
                        e.target.value = "";
                        try {
                          for (const file of selected) {
                            if (file.size > 10 * 1024 * 1024) throw new Error("file_too_large");
                            await enqueue(
                              "attachment.create",
                              { id: crypto.randomUUID(), issue_id: issue.id },
                              undefined,
                              file,
                            );
                          }
                          setError("");
                        } catch (error) {
                          setError(error instanceof Error ? error.message : "file_invalid");
                        }
                      }}
                    />
                  </label>
                </div>
                <p className="muted small">{t("fileHint")}</p>
                {files.map((file) => (
                  <button
                    className="attachment"
                    key={file.id}
                    onClick={() => void download(file).catch((error) => setError(error.message))}
                  >
                    <Paperclip size={16} />
                    <span>
                      {file.name}
                      <small>{(file.size / 1024).toFixed(1)} KB</small>
                    </span>
                    <Download size={14} />
                  </button>
                ))}
              </section>
              <section className="detail-section">
                <div className="detail-tabs">
                  <button
                    className={tab === "comments" ? "active" : ""}
                    onClick={() => setTab("comments")}
                  >
                    <MessageSquare size={15} />
                    {t("comments")} {comments.length || ""}
                  </button>
                  <button
                    className={tab === "activity" ? "active" : ""}
                    onClick={() => setTab("activity")}
                  >
                    <History size={15} />
                    {t("activity")}
                  </button>
                </div>
                {tab === "comments" ? (
                  <>
                    <div className="comments">
                      {comments.length === 0 && <p className="muted small">{t("noComments")}</p>}
                      {comments.map((comment) => (
                        <article className="comment" key={comment.id}>
                          <Avatar name={userName(comment.user_id)} small />
                          <div>
                            <div className="comment-meta">
                              <strong>{userName(comment.user_id)}</strong>
                              <time>{formatDate(comment.created_at)}</time>
                            </div>
                            <p>{comment.body}</p>
                          </div>
                        </article>
                      ))}
                    </div>
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (!comment.trim()) return;
                        await enqueue("comment.create", {
                          id: crypto.randomUUID(),
                          issue_id: issue.id,
                          body: comment.trim(),
                        });
                        setComment("");
                      }}
                    >
                      <textarea
                        value={comment}
                        aria-label={t("comments")}
                        onChange={(e) => setComment(e.target.value)}
                        placeholder={t("commentPlaceholder")}
                        rows={3}
                        maxLength={20000}
                      />
                      <div className="comment-actions">
                        <Button type="submit" disabled={!comment.trim()}>
                          {t("addComment")}
                        </Button>
                      </div>
                    </form>
                  </>
                ) : (
                  <div className="activity-list">
                    {activities.length === 0 && <p className="muted">{t("noActivity")}</p>}
                    {activities.map((activity) => (
                      <div key={activity.id}>
                        <Avatar name={userName(activity.user_id)} small />
                        <p>
                          <strong>{userName(activity.user_id)}</strong> {t(activity.action)}
                          {activity.detail.changes && (
                            <span className="activity-fields">
                              {Object.keys(activity.detail.changes).map(t).join(", ")}
                            </span>
                          )}
                          <time>{formatDate(activity.created_at)}</time>
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {subtask && (
        <CreateForm
          kind="issue"
          data={data}
          workspace={issue.workspace_id}
          parent={issue}
          onClose={() => setSubtask(false)}
        />
      )}
    </>
  );
}
