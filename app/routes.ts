import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  layout("routes/shell.tsx", [
    index("routes/home.tsx"),
    route("chat/:id", "routes/chat.$id.tsx"),
  ]),
  route("api/models", "routes/api.models.ts"),
  route("api/chat", "routes/api.chat.ts"),
  route("api/conversations", "routes/api.conversations.ts"),
  route("api/conversations/:id", "routes/api.conversations.$id.ts"),
  route("api/conversations/:id/messages", "routes/api.conversations.$id.messages.ts"),
  route("api/conversations/:id/title", "routes/api.conversations.$id.title.ts"),
  route("api/conversations/:id/path", "routes/api.conversations.$id.path.ts"),
  route("api/conversations/:id/fork", "routes/api.conversations.$id.fork.ts"),
] satisfies RouteConfig;
