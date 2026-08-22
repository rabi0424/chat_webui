import type { EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import { APPEARANCE_INIT_SCRIPT } from "./lib/appearance-init";
import { contentSecurityPolicy, makeNonce, sha256Base64 } from "./lib/csp";

/**
 * 初期化スクリプトのハッシュ。中身は起動中変わらないので、isolate ごとに
 * 一度だけ計算して使い回す（要求ごとに digest を取る必要はない）。
 */
let scriptHash: Promise<string> | null = null;
const appearanceScriptHash = () =>
  (scriptHash ??= sha256Base64(APPEARANCE_INIT_SCRIPT));

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  let shellRendered = false;
  const userAgent = request.headers.get("user-agent");
  const nonce = makeNonce();

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} nonce={nonce} />,
    {
      onError(error: unknown) {
        responseStatusCode = 500;
        // Log streaming rendering errors from inside the shell.  Don't log
        // errors encountered during initial shell rendering since they'll
        // reject and get logged in handleDocumentRequest.
        if (shellRendered) {
          console.error(error);
        }
      },
    },
  );
  shellRendered = true;

  // Ensure requests from bots and SPA Mode renders wait for all content to load before responding
  // https://react.dev/reference/react-dom/server/renderToPipeableStream#waiting-for-all-content-to-load-for-crawlers-and-static-generation
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");
  responseHeaders.set(
    "Content-Security-Policy",
    contentSecurityPolicy({
      nonce,
      scriptHash: await appearanceScriptHash(),
      dev: import.meta.env.DEV,
    }),
  );
  // 申告と違う型で解釈させない（アップロードした画像を HTML として
  // 読ませる類の抜け道を塞ぐ）
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  responseHeaders.set("Referrer-Policy", "same-origin");
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
