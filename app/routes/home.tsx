import type { Route } from "./+types/home";
import { Chat } from "../components/Chat";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Chat WebUI" }];
}

export default function Home() {
  return <Chat conversationId={null} initialMessages={[]} />;
}
