import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("api/models", "routes/api.models.ts"),
  route("api/chat", "routes/api.chat.ts"),
] satisfies RouteConfig;
