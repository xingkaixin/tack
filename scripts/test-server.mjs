import { runServices } from "./processes.mjs";
const url = new URL(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
if (!process.env.TEST_DATABASE_URL) url.pathname = "/tack_test";
if (!url.pathname.endsWith("_test")) throw new Error("The test database name must end with _test");
runServices([
  {
    command: "cargo",
    args: ["run", "-p", "tack-api"],
    env: {
      DATABASE_URL: url.toString(),
      BIND_ADDR: "127.0.0.1:3002",
      APP_ORIGIN: "http://127.0.0.1:4174",
    },
  },
  {
    command: process.execPath,
    args: [
      "apps/web/node_modules/vite/bin/vite.js",
      "preview",
      "apps/web",
      "--host",
      "127.0.0.1",
      "--port",
      "4174",
      "--strictPort",
    ],
    env: { TACK_API_ORIGIN: "http://127.0.0.1:3002" },
  },
]);
