import { spawn } from "node:child_process";
export function runServices(commands) {
  const children = commands.map(({ command, args, env }) =>
    spawn(command, args, { stdio: "inherit", detached: true, env: { ...process.env, ...env } }),
  );
  let stopping = false;
  const stop = (signal = "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal));
  for (const child of children) {
    child.on("error", (error) => {
      console.error(error.message);
      stop();
      process.exitCode = 1;
    });
    child.on("exit", (code) => {
      const unexpected = !stopping;
      stop();
      if (unexpected) process.exitCode = code ?? 1;
    });
  }
  return { children, stop };
}
