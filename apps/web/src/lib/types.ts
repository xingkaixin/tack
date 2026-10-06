export type User = { id: string; name: string; email: string };
export type Workspace = { id: string; name: string; role: "admin" | "member" };
export type Member = User & { workspace_id: string; role: "admin" | "member" };
export type Project = {
  id: string;
  workspace_id: string;
  name: string;
  identifier: string;
  description: string;
};
export const statuses = ["backlog", "todo", "in_progress", "done", "cancelled"] as const;
export const priorities = ["none", "low", "medium", "high", "urgent"] as const;
export type Fields = {
  title: string;
  status: (typeof statuses)[number];
  priority: (typeof priorities)[number];
  assignee: string | null;
  due_date: string | null;
  labels: string[];
  parent: string | null;
  blocked_by: string[];
};
export type Issue = {
  id: string;
  project_id: string;
  workspace_id: string;
  identifier: string;
  number: number;
  fields: Fields;
  created_at: string;
  updated_at: string;
  created_by: string;
};
export type Comment = {
  id: string;
  issue_id: string;
  user_id: string;
  body: string;
  created_at: string;
};
export type Activity = {
  id: number;
  issue_id: string;
  user_id: string;
  action: string;
  detail: { changes?: Partial<Fields>; name?: string };
  created_at: string;
};
export type Attachment = {
  id: string;
  issue_id: string;
  user_id: string;
  name: string;
  mime: string;
  size: number;
  created_at: string;
};
export type Snapshot = {
  documents: { issue_id: string; state: string }[];
  user: User;
  workspaces: Workspace[];
  members: Member[];
  projects: Project[];
  issues: Issue[];
  comments: Comment[];
  activity: Activity[];
  attachments: Attachment[];
};
export type Operation = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  base?: Partial<Fields>;
  file?: File;
  error?: string;
  current?: Fields;
};
export const emptyFields: Fields = {
  title: "",
  status: "backlog",
  priority: "none",
  assignee: null,
  due_date: null,
  labels: [],
  parent: null,
  blocked_by: [],
};
