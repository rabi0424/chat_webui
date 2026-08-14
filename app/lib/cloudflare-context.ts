import { createContext } from "react-router";

/**
 * WorkerのExecutionContextをルートへ渡すためのコンテキスト。
 * クライアント切断後もバックグラウンド処理（生成の継続）を行うのに使う。
 */
export const cloudflareContext = createContext<{
  env: Env;
  ctx: ExecutionContext;
}>();
