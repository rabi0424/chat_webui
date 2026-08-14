import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  layout("routes/shell.tsx", [
    index("routes/home.tsx"),
    route("chat/:id", "routes/chat.$id.tsx"),
    route("bots", "routes/bots.tsx"),
    route("bots/new", "routes/bots.new.tsx"),
    route("bots/:id/edit", "routes/bots.$id.edit.tsx"),
  ]),
  route("api/models", "routes/api.models.ts"),
  route("api/conversations", "routes/api.conversations.ts"),
  route("api/conversations/:id", "routes/api.conversations.$id.ts"),
  route("api/conversations/:id/generate", "routes/api.conversations.$id.generate.ts"),
  route("api/conversations/:id/stop", "routes/api.conversations.$id.stop.ts"),
  route("api/conversations/:id/messages/:mid", "routes/api.conversations.$id.messages.$mid.ts"),
  route("api/conversations/:id/title", "routes/api.conversations.$id.title.ts"),
  route("api/conversations/:id/path", "routes/api.conversations.$id.path.ts"),
  route("api/conversations/:id/fork", "routes/api.conversations.$id.fork.ts"),
  route("api/conversations/:id/delete-messages", "routes/api.conversations.$id.delete-messages.ts"),
  route("api/bots", "routes/api.bots.ts"),
  route("api/bots/:id", "routes/api.bots.$id.ts"),
] satisfies RouteConfig;
