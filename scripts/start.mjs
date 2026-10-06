import { runServices } from "./processes.mjs";
runServices([
  { command: "cargo", args: ["run", "-p", "tack-api"] },
  {
    command: process.execPath,
    args: [
      "apps/web/node_modules/vite/bin/vite.js",
      "preview",
      "apps/web",
      "--host",
      "127.0.0.1",
      "--port",
      "4173",
      "--strictPort",
    ],
  },
]);
