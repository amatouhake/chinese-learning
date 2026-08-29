import { Hono } from "hono";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/api/health", (context) =>
  context.json({
    ok: true,
    service: "chinese-learning",
  }),
);

app.all("/mcp", (context) =>
  context.json(
    {
      error: "Remote MCP is reserved for a later read-only slice.",
    },
    501,
  ),
);

app.onError((error, context) => {
  console.error(
    JSON.stringify({
      message: "request failed",
      error: error.message,
      path: context.req.path,
    }),
  );
  return context.json({ error: "Internal server error" }, 500);
});

export default app;
