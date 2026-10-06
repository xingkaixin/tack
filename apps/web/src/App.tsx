import { useState, useEffect, useSyncExternalStore, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  Layers,
  Plus,
  Search,
  List,
  Columns3,
  Users,
  Folder,
  Sun,
  Moon,
  LogOut,
  Globe,
  Check,
  CloudOff,
  RefreshCw,
  AlertCircle,
  ChevronsUpDown,
  UserRound,
  ArrowUpRight,
} from "lucide-react";
import { useI18n } from "./lib/i18n";
import {
  api,
  initialize,
  refresh,
  queryClient,
  subscribe,
  getSync,
  flush,
  resolve,
  logout,
  ApiError,
} from "./lib/store";
import { resumeDocuments } from "./lib/collaboration";
import { statuses, priorities, type Snapshot } from "./lib/types";
import { Button } from "./components/ui/button";
import { CreateForm, Modal, Field } from "./components/Forms";
import { IssueList } from "./components/IssueList";
import { IssueDetail, Avatar } from "./components/IssueDetail";

export function App() {
  const [ready, setReady] = useState(false);
  const [auth, setAuth] = useState(false);
  const [initialized, setInitialized] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    void (async () => {
      await initialize();
      const cached = queryClient.getQueryData<Snapshot>(["snapshot"]);
      if (cached) {
        setAuth(true);
        setReady(true);
      }
      try {
        const status = await api<{ initialized: boolean }>("/auth/status");
        setInitialized(status.initialized);
        if (status.initialized) {
          await refresh();
          setAuth(true);
          void flush();
        }
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 401) && !cached)
          setError("network_error");
      } finally {
        setReady(true);
      }
    })();
  }, []);
  if (!ready)
    return (
      <div className="loading-screen">
        <span className="logo-mark">t</span>
        <span>Tack</span>
      </div>
    );
  if (!auth)
    return (
      <Auth
        initialized={initialized}
        initialError={error}
        onSuccess={async () => {
          await refresh();
          setAuth(true);
          setError("");
          void flush();
        }}
      />
    );
  return <WorkspaceApp onLogout={() => setAuth(false)} />;
}
function Auth({
  initialized,
  initialError,
  onSuccess,
}: {
  initialized: boolean;
  initialError: string;
  onSuccess: () => Promise<void>;
}) {
  const { t, toggle } = useI18n();
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/auth/${initialized ? "login" : "setup"}`, {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))),
      });
      await onSuccess();
    } catch (error) {
      setError(error instanceof Error ? error.message : "network_error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-page">
      <div className="auth-brand">
        <div className="wordmark">
          <span className="logo-mark">t</span>tack
        </div>
        <div className="auth-message">
          <h1>{t("welcome")}</h1>
          <p>{t("welcomeHint")}</p>
          <div className="auth-illustration">
            <div>
              <span className="status-dot done" />
              <i />
              <Check size={16} />
            </div>
            <div>
              <span className="status-dot in_progress" />
              <i />
              <span className="illustration-avatar">K</span>
            </div>
            <div>
              <span className="status-dot todo" />
              <i />
            </div>
          </div>
        </div>
        <span className="auth-foot">Tack / {t("workspace")}</span>
      </div>
      <main className="auth-main">
        <Button className="auth-language" variant="ghost" onClick={toggle}>
          <Globe size={15} />
          {t("language")}
        </Button>
        <form className="auth-form" onSubmit={submit}>
          <h2>{t(initialized ? "login" : "setup")}</h2>
          <p>{t(initialized ? "loginHint" : "setupHint")}</p>
          {!initialized && (
            <>
              <Field label={t("name")}>
                <input name="name" required maxLength={100} autoComplete="name" />
              </Field>
              <Field label={t("workspaceName")}>
                <input name="workspace" required maxLength={100} />
              </Field>
            </>
          )}
          <Field label={t("email")}>
            <input name="email" type="email" required autoComplete="email" />
          </Field>
          <Field label={t("password")}>
            <input
              name="password"
              type="password"
              required
              minLength={initialized ? 1 : 10}
              maxLength={256}
              autoComplete={initialized ? "current-password" : "new-password"}
            />
          </Field>
          {error && (
            <p className="error" role="alert">
              {t(error === "Failed to fetch" ? "network_error" : error)}
            </p>
          )}
          <Button type="submit" size="lg" disabled={busy}>
            {t(initialized ? "login" : "create")}
            <ArrowUpRight size={16} />
          </Button>
        </form>
      </main>
    </div>
  );
}
function WorkspaceApp({ onLogout }: { onLogout: () => void }) {
  const { t, toggle } = useI18n();
  const sync = useSyncExternalStore(subscribe, getSync);
  const { data } = useQuery({ queryKey: ["snapshot"], queryFn: refresh, staleTime: Infinity });
  useEffect(() => {
    if (data) resumeDocuments(data.user.id);
  }, [data]);
  const pendingCount = sync.pending.length + sync.documents.length;
  const search = useSearch({ strict: false }) as {
    workspace?: string;
    project?: string;
    issue?: string;
    page?: string;
    view?: string;
  };
  const navigate = useNavigate();
  const [form, setForm] = useState<"issue" | "project" | "workspace" | "member" | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [assignee, setAssignee] = useState("");
  const [error, setError] = useState("");
  const [showSync, setShowSync] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [dark, setDark] = useState(localStorage.getItem("tack-theme") === "dark");
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("tack-theme", dark ? "dark" : "light");
  }, [dark]);
  const go = (patch: Record<string, string | undefined>) =>
    void navigate({ to: "/", search: { ...search, ...patch } });
  if (!data)
    return (
      <div className="empty-state">
        <p>{t("loadError")}</p>
        <Button onClick={() => void refresh()}>{t("tryAgain")}</Button>
      </div>
    );
  const workspace = data.workspaces.find((w) => w.id === search.workspace) || data.workspaces[0];
  if (!workspace) return null;
  const projects = data.projects.filter((p) => p.workspace_id === workspace.id);
  const project = projects.find((p) => p.id === search.project);
  const page = search.page || "issues";
  const view = search.view || "list";
  const members = data.members.filter((m) => m.workspace_id === workspace.id);
  const workspaceIssues = data.issues.filter((i) => i.workspace_id === workspace.id);
  const issues = workspaceIssues.filter(
    (i) =>
      (!project || i.project_id === project.id) &&
      (page !== "mine" || i.fields.assignee === data.user.id) &&
      (!status || i.fields.status === status) &&
      (!priority || i.fields.priority === priority) &&
      (!assignee || i.fields.assignee === assignee) &&
      `${i.fields.title} ${i.identifier} ${i.fields.labels.join(" ")}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const selected = workspaceIssues.find((i) => i.id === search.issue);
  const title =
    page === "members"
      ? t("members")
      : project?.name || t(page === "mine" ? "myIssues" : "allIssues");
  const create = () => setForm(projects.length ? "issue" : "project");
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="wordmark">
          <span className="logo-mark">t</span>tack
        </div>
        <div className="workspace-switch">
          <Avatar name={workspace.name} />
          <select
            aria-label={t("selectWorkspace")}
            value={workspace.id}
            onChange={(e) => {
              go({
                workspace: e.target.value,
                project: undefined,
                issue: undefined,
                page: "issues",
              });
              setQuery("");
            }}
          >
            {data.workspaces.map((w) => (
              <option value={w.id} key={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <ChevronsUpDown size={13} />
        </div>
        <Button variant="outline" className="sidebar-create" onClick={create}>
          <Plus size={16} />
          {t("newIssue")}
        </Button>
        <nav>
          <button
            className={page === "issues" && !project ? "active" : ""}
            onClick={() => go({ page: "issues", project: undefined })}
          >
            <Layers size={17} />
            {t("allIssues")}
            <span>{workspaceIssues.length}</span>
          </button>
          <button
            className={page === "mine" ? "active" : ""}
            onClick={() => go({ page: "mine", project: undefined })}
          >
            <UserRound size={17} />
            {t("myIssues")}
          </button>
          <button
            className={page === "members" ? "active" : ""}
            onClick={() => go({ page: "members", project: undefined })}
          >
            <Users size={17} />
            {t("members")}
          </button>
          <div className="nav-heading">
            <span>{t("projects")}</span>
            <button aria-label={t("newProject")} onClick={() => setForm("project")}>
              <Plus size={15} />
            </button>
          </div>
          {projects.map((p) => (
            <button
              key={p.id}
              className={project?.id === p.id ? "active" : ""}
              onClick={() => go({ project: p.id, page: "issues" })}
            >
              <span className="project-icon">{p.identifier.slice(0, 1)}</span>
              <span className="project-name">{p.name}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={`sync-status ${sync.pending.some((op) => op.error) ? "sync-warning" : ""}`}
            onClick={() => setShowSync(true)}
          >
            {!sync.online ? (
              <CloudOff size={14} />
            ) : sync.busy ? (
              <RefreshCw size={14} className="spinning" />
            ) : sync.pending.some((op) => op.error) ? (
              <AlertCircle size={14} />
            ) : (
              <Check size={14} />
            )}
            <span>
              {t(
                !sync.online
                  ? "offline"
                  : sync.busy
                    ? "syncing"
                    : pendingCount
                      ? "pending"
                      : "synced",
              )}
              {pendingCount ? ` · ${pendingCount}` : ""}
            </span>
          </button>
          <div className="account">
            <Avatar name={data.user.name} />
            <div>
              <strong>{data.user.name}</strong>
              <small>{workspace.role === "admin" ? t("admin") : t("member")}</small>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("logout")}
              onClick={async () => {
                try {
                  await logout();
                  onLogout();
                } catch (error) {
                  setError(error instanceof Error ? error.message : "server_error");
                }
              }}
            >
              <LogOut size={15} />
            </Button>
          </div>
          <div className="sidebar-tools">
            <Button variant="ghost" size="sm" onClick={toggle}>
              <Globe size={14} />
              {t("language")}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("theme")}
              onClick={() => setDark(!dark)}
            >
              {dark ? <Sun size={15} /> : <Moon size={15} />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("newWorkspace")}
              onClick={() => setForm("workspace")}
            >
              <Plus size={15} />
            </Button>
          </div>
        </div>
      </aside>
      <main className="main-area">
        <header className="page-header">
          <div className="breadcrumb">
            <span>{workspace.name}</span>
            <span>/</span>
            <strong>{title}</strong>
          </div>
          {page !== "members" && (
            <div className="view-toggle">
              <Button
                variant="ghost"
                aria-pressed={view === "list"}
                size="sm"
                onClick={() => go({ view: "list" })}
              >
                <List size={15} />
                {t("list")}
              </Button>
              <Button
                variant="ghost"
                aria-pressed={view === "board"}
                size="sm"
                onClick={() => go({ view: "board" })}
              >
                <Columns3 size={15} />
                {t("board")}
              </Button>
            </div>
          )}
        </header>
        {!sync.online && (
          <div className="notice">
            <CloudOff size={14} />
            {t("offlineHint")}
          </div>
        )}
        {sync.error === "authExpired" && (
          <div className="notice warning">
            {t("authExpired")}
            <Button size="sm" onClick={() => setReauth(true)}>
              {t("login")}
            </Button>
          </div>
        )}
        {error && (
          <div className="notice warning" role="alert">
            {t(error)}
            <button onClick={() => setError("")}>{t("close")}</button>
          </div>
        )}
        <div className="content-heading">
          <div>
            <h1>
              {title}
              <span>{page === "members" ? members.length : issues.length}</span>
            </h1>
            {project?.description && <p>{project.description}</p>}
          </div>
          {page === "members" ? (
            workspace.role === "admin" && (
              <Button onClick={() => setForm("member")}>
                <Plus size={15} />
                {t("addMember")}
              </Button>
            )
          ) : (
            <Button onClick={create}>
              <Plus size={15} />
              {t("newIssue")}
            </Button>
          )}
        </div>
        {page === "members" ? (
          <div className="member-list">
            <div className="member-list-heading">
              <span>{t("name")}</span>
              <span>{t("email")}</span>
              <span>{t("role")}</span>
            </div>
            {members.map((member) => (
              <div className="member-row" key={member.id}>
                <span>
                  <Avatar name={member.name} />
                  <strong>{member.name}</strong>
                </span>
                <span className="muted">{member.email}</span>
                <span className="role-badge">{t(member.role)}</span>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="filters">
              <div className="search-input">
                <Search size={15} />
                <input
                  aria-label={t("search")}
                  placeholder={t("search")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <select
                aria-label={t("status")}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">{t("allStatuses")}</option>
                {statuses.map((value) => (
                  <option value={value} key={value}>
                    {t(value)}
                  </option>
                ))}
              </select>
              <select
                aria-label={t("priority")}
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                <option value="">{t("allPriorities")}</option>
                {priorities.map((value) => (
                  <option value={value} key={value}>
                    {t(value)}
                  </option>
                ))}
              </select>
              <select
                aria-label={t("assignee")}
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              >
                <option value="">{t("allMembers")}</option>
                {members.map((member) => (
                  <option value={member.id} key={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
              {(query || status || priority || assignee) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setQuery("");
                    setStatus("");
                    setPriority("");
                    setAssignee("");
                  }}
                >
                  {t("clearFilters")}
                </Button>
              )}
            </div>
            {!projects.length ? (
              <div className="empty-state">
                <div className="empty-icon">
                  <Folder size={28} />
                </div>
                <h2>{t("noProjects")}</h2>
                <p>{t("noProjectsHint")}</p>
                <Button onClick={() => setForm("project")}>
                  <Plus size={15} />
                  {t("newProject")}
                </Button>
              </div>
            ) : (
              <IssueList
                issues={issues}
                members={members}
                view={view}
                onSelect={(id) => go({ issue: id })}
                onCreate={create}
              />
            )}
          </>
        )}
      </main>
      {form && (
        <CreateForm
          kind={form}
          data={data}
          workspace={workspace.id}
          project={project?.id}
          onClose={() => setForm(null)}
          onCreated={(id) => {
            if (form === "issue") go({ issue: id });
            if (form === "project") go({ project: id, page: "issues" });
            if (form === "workspace") go({ workspace: id, project: undefined, page: "issues" });
          }}
        />
      )}
      {selected && (
        <IssueDetail
          key={selected.id}
          issue={selected}
          data={data}
          onClose={() => go({ issue: undefined })}
          onSelect={(id) => go({ issue: id })}
        />
      )}
      {showSync && (
        <Modal title={t("syncIssues")} onClose={() => setShowSync(false)} wide>
          <div className="sync-dialog">
            {sync.documents.map((id) => (
              <div className="sync-item" key={id}>
                <strong>
                  {data.issues.find((issue) => issue.id === id)?.fields.title || t("description")}
                </strong>
                <p className="muted small">{t("editorLocal")}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setShowSync(false);
                    go({ issue: id });
                  }}
                >
                  {t("open")}
                </Button>
              </div>
            ))}
            {pendingCount === 0 ? (
              <p>{t("synced")}</p>
            ) : (
              sync.pending.map((op) => (
                <div className="sync-item" key={op.id}>
                  <strong>
                    {String(
                      (op.payload.fields as { title?: string })?.title ||
                        op.payload.body ||
                        op.file?.name ||
                        data.issues.find((i) => i.id === op.payload.id)?.fields.title ||
                        t("pending"),
                    )}
                  </strong>
                  {op.error && (
                    <p className="error">{t(op.error === "conflict" ? "conflict" : op.error)}</p>
                  )}
                  {op.current && (
                    <div className="conflict-values">
                      {Object.entries(op.payload.fields as Record<string, unknown>).map(
                        ([key, value]) => (
                          <div key={key}>
                            <strong>{t(key)}</strong>
                            <p>
                              {t("local")}:{" "}
                              {Array.isArray(value) ? value.join(", ") : t(String(value ?? "—"))}
                            </p>
                            <p>
                              {t("server")}:{" "}
                              {Array.isArray(op.current![key as keyof typeof op.current])
                                ? JSON.stringify(op.current![key as keyof typeof op.current])
                                : t(String(op.current![key as keyof typeof op.current] ?? "—"))}
                            </p>
                          </div>
                        ),
                      )}
                    </div>
                  )}
                  <div className="form-actions">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        if (confirm(t("deleteConfirm"))) void resolve(op.id, false);
                      }}
                    >
                      {t(op.current ? "useServer" : "discard")}
                    </Button>
                    {op.error && (
                      <Button onClick={() => void resolve(op.id, true)}>
                        {t(op.current ? "keepMine" : "retry")}
                      </Button>
                    )}
                  </div>
                </div>
              ))
            )}
            <Button variant="outline" onClick={() => void flush()} disabled={sync.busy}>
              <RefreshCw size={14} />
              {t("retry")}
            </Button>
          </div>
        </Modal>
      )}
      {reauth && (
        <Modal title={t("login")} onClose={() => setReauth(false)}>
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api("/auth/login", {
                  method: "POST",
                  body: JSON.stringify(Object.fromEntries(new FormData(e.currentTarget))),
                });
                await refresh();
                for (const op of sync.pending.filter((op) => op.error === "unauthorized"))
                  await resolve(op.id, true);
                setReauth(false);
              } catch (error) {
                setError(error instanceof Error ? error.message : "network_error");
              }
            }}
          >
            <Field label={t("email")}>
              <input name="email" type="email" defaultValue={data.user.email} required />
            </Field>
            <Field label={t("password")}>
              <input name="password" type="password" required />
            </Field>
            <Button type="submit">{t("login")}</Button>
          </form>
        </Modal>
      )}
    </div>
  );
}
