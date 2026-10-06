import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { App } from "./App";
import { I18n } from "./lib/i18n";
import { queryClient } from "./lib/store";
import "./styles.css";
const rootRoute = createRootRoute();
const route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: App,
  validateSearch: (search: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(search).filter(
        ([key, value]) =>
          ["workspace", "project", "issue", "page", "view"].includes(key) &&
          typeof value === "string",
      ),
    ) as { workspace?: string; project?: string; issue?: string; page?: string; view?: string },
});
const router = createRouter({ routeTree: rootRoute.addChildren([route]) });
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <I18n>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </I18n>,
);
