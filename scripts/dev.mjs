import { spawn } from "node:child_process";
const children = [
  spawn("cargo", ["run", "-p", "tack-api"], { stdio: "inherit" }),
  spawn("pnpm", ["--filter", "@tack/web", "dev"], { stdio: "inherit" }),
];
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => children.forEach((child) => child.kill(signal)));
for (const child of children)
  child.on("exit", (code) => {
    children.forEach((other) => other !== child && other.kill());
    process.exitCode = code ?? 1;
  });
