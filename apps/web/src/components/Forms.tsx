import {
  Children,
  cloneElement,
  isValidElement,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useI18n } from "../lib/i18n";
import { api, enqueue, refresh } from "../lib/store";
import { emptyFields, statuses, priorities, type Snapshot, type Issue } from "../lib/types";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./ui/dialog";
import { Button } from "./ui/button";
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className={wide ? "form-modal wide" : "form-modal"} showCloseButton={false}>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="sr-only">{title}</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {Children.map(children, (child) =>
        isValidElement<{ "aria-label"?: string; type?: string }>(child) &&
        child.props.type !== "hidden"
          ? cloneElement(child, { "aria-label": label })
          : child,
      )}
    </label>
  );
}
export function CreateForm({
  kind,
  data,
  workspace,
  project,
  parent,
  onClose,
  onCreated,
}: {
  kind: "issue" | "project" | "workspace" | "member";
  data: Snapshot;
  workspace: string;
  project?: string;
  parent?: Issue;
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const { t } = useI18n();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const id = crypto.randomUUID();
    try {
      if (kind === "member") {
        await api(`/workspaces/${workspace}/members`, {
          method: "POST",
          body: JSON.stringify(values),
        });
        await refresh();
      }
      if (kind === "workspace") await enqueue("workspace.create", { id, name: values.name });
      if (kind === "project")
        await enqueue("project.create", {
          id,
          workspace_id: workspace,
          name: values.name,
          identifier: String(values.identifier).toUpperCase(),
          description: values.description,
        });
      if (kind === "issue")
        await enqueue("issue.create", {
          id,
          project_id: values.project_id,
          fields: {
            ...emptyFields,
            title: String(values.title).trim(),
            status: values.status,
            priority: values.priority,
            assignee: values.assignee || null,
            parent: parent?.id || null,
          },
        });
      onCreated?.(id);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "server_error");
    } finally {
      setBusy(false);
    }
  };
  const projects = data.projects.filter((p) => p.workspace_id === workspace);
  return (
    <Modal
      title={t(
        {
          issue: parent ? "newSubtask" : "newIssue",
          project: "newProject",
          workspace: "newWorkspace",
          member: "addMember",
        }[kind],
      )}
      onClose={onClose}
    >
      <form onSubmit={submit} className="form-stack">
        {kind === "issue" ? (
          <>
            <Field label={t("project")}>
              <select
                name="project_id"
                defaultValue={parent?.project_id || project || projects[0]?.id}
                required
                disabled={Boolean(parent)}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              {parent && <input type="hidden" name="project_id" value={parent.project_id} />}
            </Field>
            <Field label={t("title")}>
              <input
                name="title"

                maxLength={300}
                required
                placeholder={t("emptyTitle")}
              />
            </Field>
            <div className="form-grid">
              <Field label={t("status")}>
                <select name="status">
                  {statuses.map((value) => (
                    <option key={value} value={value}>
                      {t(value)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("priority")}>
                <select name="priority">
                  {priorities.map((value) => (
                    <option key={value} value={value}>
                      {t(value)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label={t("assignee")}>
              <select name="assignee">
                <option value="">{t("unassigned")}</option>
                {data.members
                  .filter((m) => m.workspace_id === workspace)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </Field>
          </>
        ) : (
          <Field label={t("name")}>
            <input name="name" required maxLength={100} />
          </Field>
        )}
        {kind === "project" && (
          <>
            <Field label={t("identifier")}>
              <input
                name="identifier"
                pattern="[A-Za-z0-9]{1,10}"
                required
                maxLength={10}
                placeholder="TACK"
                style={{ textTransform: "uppercase" }}
              />
            </Field>
            <Field label={t("projectDescription")}>
              <textarea name="description" rows={3} maxLength={2000} />
            </Field>
          </>
        )}
        {kind === "member" && (
          <>
            <Field label={t("email")}>
              <input name="email" type="email" required />
            </Field>
            <Field label={t("password")}>
              <input
                name="password"
                type="password"
                minLength={10}
                maxLength={256}
                autoComplete="new-password"
                placeholder={t("passwordHint")}
              />
            </Field>
            <Field label={t("role")}>
              <select name="role">
                <option value="member">{t("member")}</option>
                <option value="admin">{t("admin")}</option>
              </select>
            </Field>
            <p className="muted small">{t("existingMemberHint")}</p>
          </>
        )}
        {error && (
          <p role="alert" className="error">
            {t(error)}
          </p>
        )}
        <div className="form-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" disabled={busy}>
            {t(kind === "member" ? "add" : "create")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
