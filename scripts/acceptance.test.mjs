import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import * as Y from "yjs";
import WebSocket from "ws";
const origin = "http://127.0.0.1:4174";
const apiOrigin = "http://127.0.0.1:3002";
const password = "Tack-acceptance-only-2026";
let cookie = "";
async function request(path, body, session = cookie) {
  const response = await fetch(`${apiOrigin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Cookie: session },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  return {
    status: response.status,
    value,
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}
async function operation(kind, payload, base, session = cookie, id = randomUUID()) {
  return request("/api/operations", { id, kind, payload, base }, session);
}
const fields = (title) => ({
  title,
  status: "backlog",
  priority: "none",
  assignee: null,
  due_date: null,
  labels: [],
  parent: null,
  blocked_by: [],
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error("Timed out waiting for condition");
}

test(
  "Tack acceptance: permissions, graph integrity, collaboration and offline browser workflows",
  { timeout: 180000 },
  async (t) => {
    const initialized = await request("/api/auth/status");
    const auth = await request(`/api/auth/${initialized.value.initialized ? "login" : "setup"}`, {
      email: "acceptance@tack.test",
      password,
      name: "Test Admin",
      workspace: "Tack Studio",
    });
    assert.equal(auth.status, 200);
    cookie = auth.cookie;
    const snapshot = (await request("/api/snapshot")).value;
    const workspace = snapshot.workspaces[0].id;
    const project = randomUUID();
    const issue = randomUUID();
    const second = randomUUID();
    const suffix = Date.now().toString().slice(-6);
    await t.test("Authentication, workspace isolation and member permissions", async () => {
      assert.equal((await request("/api/snapshot", undefined, "")).status, 401);
      assert.equal(
        (
          await request("/api/auth/setup", {
            email: "other@tack.test",
            password,
            name: "Other",
            workspace: "Other",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await operation("project.create", {
            id: project,
            workspace_id: workspace,
            name: "Product development",
            identifier: `T${suffix}`,
            description: "Ship a clear, focused workspace for the team.",
          })
        ).status,
        200,
      );
      const memberEmail = `member-${suffix}@tack.test`;
      assert.equal(
        (
          await request(`/api/workspaces/${workspace}/members`, {
            email: memberEmail,
            password,
            name: "Alex",
            role: "member",
          })
        ).status,
        200,
      );
      const member = await request("/api/auth/login", { email: memberEmail, password });
      assert.equal(
        (
          await request(
            `/api/workspaces/${workspace}/members`,
            { email: `denied-${suffix}@tack.test`, password, name: "No", role: "admin" },
            member.cookie,
          )
        ).status,
        403,
      );
      const privateWorkspace = randomUUID();
      await operation(
        "workspace.create",
        { id: privateWorkspace, name: "Isolated" },
        undefined,
        member.cookie,
      );
      const privateProject = randomUUID();
      await operation(
        "project.create",
        {
          id: privateProject,
          workspace_id: privateWorkspace,
          name: "Private",
          identifier: "PRIVATE",
        },
        undefined,
        member.cookie,
      );
      assert.equal(
        (
          await operation("issue.create", {
            id: randomUUID(),
            project_id: privateProject,
            fields: fields("Forbidden"),
          })
        ).status,
        403,
      );
    });
    await t.test("Issue creation is idempotent; field conflicts are explicit", async () => {
      const id = randomUUID();
      const payload = {
        id: issue,
        project_id: project,
        fields: fields("Build the first workspace"),
      };
      assert.equal((await operation("issue.create", payload, undefined, cookie, id)).status, 200);
      assert.equal((await operation("issue.create", payload, undefined, cookie, id)).status, 200);
      assert.equal(
        (await request("/api/snapshot")).value.issues.filter((i) => i.id === issue).length,
        1,
      );
      assert.equal(
        (
          await operation(
            "issue.patch",
            { id: issue, fields: { priority: "high" } },
            { priority: "none" },
          )
        ).status,
        200,
      );
      const conflict = await operation(
        "issue.patch",
        { id: issue, fields: { priority: "urgent" } },
        { priority: "none" },
      );
      assert.equal(conflict.status, 409);
      assert.equal(conflict.value.current.priority, "high");
      assert.equal(
        (
          await operation(
            "issue.patch",
            { id: issue, fields: { status: "in_progress" } },
            { status: "backlog" },
          )
        ).status,
        200,
      );
    });
    await t.test("Dependency and parent cycles are rejected", async () => {
      assert.equal(
        (
          await operation("issue.create", {
            id: second,
            project_id: project,
            fields: fields("Review the collaboration flow"),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await operation(
            "issue.patch",
            { id: issue, fields: { blocked_by: [second] } },
            { blocked_by: [] },
          )
        ).status,
        200,
      );
      const cycle = await operation(
        "issue.patch",
        { id: second, fields: { blocked_by: [issue] } },
        { blocked_by: [] },
      );
      assert.equal(cycle.status, 400);
      assert.equal(cycle.value.error, "cycle_detected");
      assert.equal(
        (
          await operation(
            "issue.patch",
            { id: second, fields: { parent: issue } },
            { parent: null },
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await operation(
            "issue.patch",
            { id: issue, fields: { parent: second } },
            { parent: null },
          )
        ).value.error,
        "cycle_detected",
      );
    });
    await t.test(
      "Concurrent mutations complete without exhausting the connection pool",
      async () => {
        const results = await Promise.all(
          Array.from({ length: 15 }, (_, i) =>
            operation("issue.create", {
              id: randomUUID(),
              project_id: project,
              fields: fields(`Parallel issue ${i}`),
            }),
          ),
        );
        assert.ok(results.every((result) => result.status === 200));
      },
    );
    await t.test("Yjs updates merge in Rust, persist and reload for a new client", async () => {
      const a = new Y.Doc();
      const b = new Y.Doc();
      a.getText("test").insert(0, "Alpha");
      b.getText("test").insert(0, "Beta");
      const connect = () =>
        new WebSocket(`ws://127.0.0.1:3002/api/issues/${issue}/live`, {
          headers: { Cookie: cookie, Origin: origin },
        });
      const first = connect();
      const secondSocket = connect();
      let acknowledgements = 0;
      first.on("message", (data) => {
        if (data[0] === 3) acknowledgements++;
      });
      secondSocket.on("message", (data) => {
        if (data[0] === 3) acknowledgements++;
      });
      await Promise.all([
        new Promise((resolve) => first.once("open", resolve)),
        new Promise((resolve) => secondSocket.once("open", resolve)),
      ]);
      first.send(Buffer.concat([Buffer.from([0]), Y.encodeStateAsUpdate(a)]));
      secondSocket.send(Buffer.concat([Buffer.from([0]), Y.encodeStateAsUpdate(b)]));
      await waitFor(() => acknowledgements === 2);
      first.close();
      secondSocket.close();
      const reloaded = new Y.Doc();
      const third = connect();
      third.on("message", (data) => {
        if (data[0] === 0) Y.applyUpdate(reloaded, data.subarray(1));
      });
      await waitFor(
        () =>
          reloaded.getText("test").toString().includes("Alpha") &&
          reloaded.getText("test").toString().includes("Beta"),
      );
      third.close();
      a.destroy();
      b.destroy();
      reloaded.destroy();
    });
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await t.test("Browser sign-in, project navigation and issue editing", async () => {
        await page.goto(origin);
        await page.getByLabel("邮箱", { exact: true }).fill("acceptance@tack.test");
        await page.getByLabel("密码", { exact: true }).fill(password);
        await page.getByRole("button", { name: "登录", exact: true }).click();
        await expect(page.getByRole("heading", { name: "全部任务" })).toBeVisible();
        await page
          .getByRole("button", { name: "Product development", exact: false })
          .last()
          .click();
        await page.getByRole("row", { name: /Build the first workspace/ }).click();
        await expect(page.getByRole("textbox", { name: "标题", exact: true })).toBeVisible();
        await page.getByLabel("截止日期", { exact: true }).last().fill("2026-12-18");
        await page.getByLabel("标签", { exact: true }).fill("design, collaboration");
        await page.getByLabel("标签", { exact: true }).press("Tab");
        const editor = page.locator(".rich-editor");
        await expect(editor).toBeVisible();
        await editor.fill("A shared description from the browser.");
        await expect(page.getByText("内容已同步", { exact: true })).toBeVisible();
        await page
          .getByLabel("评论", { exact: true })
          .fill("The first workflow is ready for review.");
        await page.getByRole("button", { name: "发表评论" }).click();
        await expect(
          page.getByText("The first workflow is ready for review.", { exact: true }),
        ).toBeVisible();
        await page.getByLabel("添加附件", { exact: true }).setInputFiles({
          name: "brief.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Tack attachment acceptance"),
        });
        await waitFor(async () =>
          (await request("/api/snapshot")).value.attachments.some(
            (a) => a.issue_id === issue && a.name === "brief.txt",
          ),
        );
        const downloadEvent = page.waitForEvent("download");
        await page.getByRole("button", { name: /brief.txt/ }).click();
        const download = await downloadEvent;
        assert.equal(download.suggestedFilename(), "brief.txt");
        await mkdir("test-results", { recursive: true });
        await page.screenshot({ path: "test-results/detail.png" });
        await page.getByRole("button", { name: "关闭", exact: true }).click();
        await page.getByRole("button", { name: "看板", exact: true }).click();
        await expect(page.locator(".board")).toBeVisible();
        await page.screenshot({ path: "test-results/board.png" });
      });
      await t.test(
        "Offline edits, new issues, comments and attachments survive reload and synchronize",
        async () => {
          await page.getByRole("button", { name: /Build the first workspace/ }).click();
          await expect(page.locator(".rich-editor")).toBeVisible();
          await page.evaluate(async () => {
            await navigator.serviceWorker.ready;
          });
          await context.setOffline(true);
          await page
            .getByRole("textbox", { name: "标题", exact: true })
            .fill("Offline planning survives reload");
          await page.getByRole("textbox", { name: "标题", exact: true }).press("Tab");
          await page.locator(".rich-editor").fill("Offline shared description.");
          await page.getByLabel("评论", { exact: true }).fill("Written while disconnected.");
          await page.getByRole("button", { name: "发表评论" }).click();
          await page.getByLabel("添加附件", { exact: true }).setInputFiles({
            name: "offline.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("offline file"),
          });
          await page.getByRole("button", { name: "关闭", exact: true }).click();
          await page.getByRole("button", { name: "新建任务", exact: true }).last().click();
          await page.getByRole("textbox", { name: "标题", exact: true }).fill("Created offline");
          await page.getByRole("button", { name: "创建", exact: true }).click();
          await expect(page.locator(".issue-title-input")).toHaveValue("Created offline");
          await page.reload();
          await expect(page.locator(".issue-title-input")).toHaveValue("Created offline");
          await page.getByRole("button", { name: "关闭", exact: true }).click();
          await page.getByRole("button", { name: /Offline planning survives reload/ }).click();
          await expect(page.locator(".rich-editor")).toContainText("Offline shared description.");
          await expect(
            page.getByText("Written while disconnected.", { exact: true }),
          ).toBeVisible();
          await context.setOffline(false);
          await waitFor(async () => {
            const s = (await request("/api/snapshot")).value;
            return (
              s.issues.some((i) => i.fields.title === "Created offline") &&
              s.comments.some((c) => c.body === "Written while disconnected.") &&
              s.attachments.some((a) => a.name === "offline.txt")
            );
          });
          await expect(page.getByText("内容已同步", { exact: true })).toBeVisible();
        },
      );
      await t.test("Two browser clients share edits and show collaborator cursors", async () => {
        const other = await browser.newContext({ viewport: { width: 1200, height: 900 } });
        const secondPage = await other.newPage();
        await secondPage.goto(origin);
        await secondPage.getByLabel("邮箱", { exact: true }).fill("acceptance@tack.test");
        await secondPage.getByLabel("密码", { exact: true }).fill(password);
        await secondPage.getByRole("button", { name: "登录", exact: true }).click();
        await expect(secondPage.getByRole("heading", { name: "全部任务" })).toBeVisible();
        await secondPage.goto(`${origin}/?issue=${issue}`);
        await expect(secondPage.locator(".rich-editor")).toContainText(
          "Offline shared description.",
        );
        await secondPage.locator(".rich-editor").click();
        await secondPage.keyboard.press("End");
        await secondPage.keyboard.type(" Together.");
        await expect(page.locator(".rich-editor")).toContainText("Together.");
        await expect(page.locator(".collaboration-carets__label")).toContainText(
          snapshot.user.name,
        );
        await other.close();
      });
      await t.test(
        "Closed documents synchronize after an offline reload without reopening the editor",
        async () => {
          await context.setOffline(true);
          await page.locator(".rich-editor").fill("Background recovery without reopening.");
          await page.getByRole("button", { name: "关闭", exact: true }).click();
          await page.reload();
          await expect(page.getByRole("heading", { name: "Product development" })).toBeVisible();
          await context.setOffline(false);
          await waitFor(async () => {
            const state = (await request("/api/snapshot")).value.documents?.find(
              (d) => d.issue_id === issue,
            )?.state;
            if (!state) return false;
            const doc = new Y.Doc();
            Y.applyUpdate(doc, Buffer.from(state, "base64"));
            const text = doc.getXmlFragment("default").toString();
            doc.destroy();
            return text.includes("Background recovery without reopening.");
          });
        },
      );
      await t.test(
        "Concurrent offline tabs keep both mutation queues and sync each issue once",
        async () => {
          const other = await context.newPage();
          await other.goto(`${origin}/?project=${project}`);
          await expect(other.getByRole("heading", { name: "Product development" })).toBeVisible();
          await context.setOffline(true);
          const create = async (tab, title) => {
            await tab.getByRole("button", { name: "新建任务", exact: true }).last().click();
            await tab.getByRole("textbox", { name: "标题", exact: true }).fill(title);
            await tab.getByRole("button", { name: "创建", exact: true }).click();
            await expect(tab.locator(".issue-title-input")).toHaveValue(title);
          };
          await Promise.all([create(page, `Tab A ${suffix}`), create(other, `Tab B ${suffix}`)]);
          await page.reload();
          await expect(page.locator(".issue-title-input")).toHaveValue(`Tab A ${suffix}`);
          await context.setOffline(false);
          await waitFor(async () => {
            const issues = (await request("/api/snapshot")).value.issues;
            return (
              issues.filter((i) => i.fields.title === `Tab A ${suffix}`).length === 1 &&
              issues.filter((i) => i.fields.title === `Tab B ${suffix}`).length === 1
            );
          });
          await other.close();
          await page.getByRole("button", { name: "关闭", exact: true }).click();
        },
      );
      await t.test(
        "Conflicting offline changes can be explicitly resolved in the browser",
        async () => {
          await page.goto(`${origin}/?project=${project}&issue=${issue}`);
          await expect(page.locator(".issue-title-input")).toBeVisible();
          const current = (await request("/api/snapshot")).value.issues.find((i) => i.id === issue)
            .fields.priority;
          await context.setOffline(true);
          await page.getByLabel("优先级", { exact: true }).last().selectOption("low");
          assert.equal(
            (
              await operation(
                "issue.patch",
                { id: issue, fields: { priority: "urgent" } },
                { priority: current },
              )
            ).status,
            200,
          );
          await context.setOffline(false);
          await page.getByRole("button", { name: "关闭", exact: true }).click();
          await expect(page.locator(".sync-warning")).toBeVisible();
          await page.locator(".sync-status").click();
          await expect(
            page.getByText("同一字段已被其他人修改，请选择要保留的版本。"),
          ).toBeVisible();
          await page.getByRole("button", { name: "保留我的修改", exact: true }).click();
          await waitFor(
            async () =>
              (await request("/api/snapshot")).value.issues.find((i) => i.id === issue).fields
                .priority === "low",
          );
          await page.keyboard.press("Escape");
        },
      );
      await t.test("Language and theme settings render without client exceptions", async () => {
        await page.getByRole("button", { name: "English", exact: true }).click();
        await expect(
          page.getByRole("button", { name: "New issue", exact: true }).first(),
        ).toBeVisible();
        await page.getByRole("button", { name: "Toggle theme", exact: true }).click();
        await expect(page.locator("html")).toHaveClass("dark");
        await page.screenshot({ path: "test-results/dark.png" });
        await page.getByRole("button", { name: "Toggle theme", exact: true }).click();
        await page.getByRole("button", { name: "List", exact: true }).click();
        await page.screenshot({ path: "test-results/list.png" });
        assert.deepEqual(errors, []);
      });
    } finally {
      await browser.close();
    }
  },
);
