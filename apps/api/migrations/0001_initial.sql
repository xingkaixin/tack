CREATE TABLE users (
 id uuid PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL,
 password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days'
);
CREATE TABLE workspaces (id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE members (
 workspace_id uuid NOT NULL REFERENCES workspaces(id), user_id uuid NOT NULL REFERENCES users(id),
 role text NOT NULL CHECK (role IN ('admin','member')), PRIMARY KEY(workspace_id,user_id)
);
CREATE TABLE projects (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), name text NOT NULL,
 identifier text NOT NULL, description text NOT NULL DEFAULT '', next_number int NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,identifier)
);
CREATE TABLE issues (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), number int NOT NULL,
 fields jsonb NOT NULL, created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,number)
);
CREATE INDEX issues_project ON issues(project_id);
CREATE TABLE comments (
 id uuid PRIMARY KEY, issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id), body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE activity (
 id bigserial PRIMARY KEY, issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id), action text NOT NULL, detail jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE attachments (
 id uuid PRIMARY KEY, issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id), name text NOT NULL, mime text NOT NULL,
 data bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE documents (
 issue_id uuid PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE, state bytea NOT NULL
);
CREATE TABLE operations (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
