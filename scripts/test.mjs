import { spawn } from "node:child_process";
import { runServices } from "./processes.mjs";
async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}
for (const port of [3002, 4174]) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    throw new Error(`Port ${port} is in use. Stop test:serve before running pnpm test.`);
  } catch (error) {
    if (error.message.includes("is in use")) throw error;
  }
}
await run("pnpm", ["build"]);
await run("cargo", ["build", "-p", "tack-api"]);
const services = runServices([{ command: "node", args: ["scripts/test-server.mjs"] }]);
try {
  for (let attempt = 0; ; attempt++) {
    if (services.children[0].exitCode !== null) throw new Error("Test services failed to start");
    try {
      const api = await fetch("http://127.0.0.1:3002/api/health", {
        signal: AbortSignal.timeout(1000),
      });
      if (api.ok) {
        const web = await fetch("http://127.0.0.1:4174/api/health", {
          signal: AbortSignal.timeout(1000),
        });
        if (web.ok) break;
      }
    } catch {
      /* The services have not bound their ports yet. */
    }
    if (attempt >= 90) throw new Error("Test services did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await run("node", ["--test", "scripts/acceptance.test.mjs"]);
} finally {
  services.stop();
}
