import { describe, expect, it } from "vitest";
import {
  classifyUpstreamFailure,
  type UpstreamFailure,
} from "../app/lib/upstream-outcome";

/**
 * 上流の失敗の分け方。根拠は窓口の文書:
 *   - OpenRouter: https://openrouter.ai/docs/api-reference/errors
 *   - Poe: https://creator.poe.com/docs/external-applications/openai-compatible-api
 *
 * 表の1行を1件として、文書に書かれている状態コードと型をそのまま
 * 並べる。分け方を変えるときは、この表と要件の表を一緒に直すこと。
 */
const or = (f: Omit<UpstreamFailure, "provider">): UpstreamFailure => ({
  provider: "openrouter",
  ...f,
});
const poe = (f: Omit<UpstreamFailure, "provider">): UpstreamFailure => ({
  provider: "poe",
  ...f,
});

describe("一時的な不調（待ってから投げ直す。試行に数えない）", () => {
  it.each([
    ["OpenRouter 408 Request Timeout", or({ status: 408 })],
    ["OpenRouter 429 rate limited", or({ status: 429 })],
    ["OpenRouter 502 model down", or({ status: 502 })],
    ["OpenRouter 503 no available provider", or({ status: 503 })],
    ["Poe 408 timeout_error", poe({ status: 408, type: "timeout_error" })],
    ["Poe 429 rate_limit_error", poe({ status: 429, type: "rate_limit_error" })],
    ["Poe 500 provider_error", poe({ status: 500, type: "provider_error" })],
    ["Poe 502 upstream_error", poe({ status: 502, type: "upstream_error" })],
    ["Poe 529 overloaded_error", poe({ status: 529, type: "overloaded_error" })],
    ["つながらない・ヘッダが来ない・途中で切れた（状態なし）", or({ status: null })],
    ["本文の中のエラーで code が無い", poe({ status: null, message: "x" })],
  ])("%s", (_name, f) => {
    expect(classifyUpstreamFailure(f).kind).toBe("transient");
  });
});

describe("直らない（その場で止める）", () => {
  it.each([
    ["OpenRouter 401 invalid credentials", or({ status: 401 })],
    ["OpenRouter 402 insufficient credits", or({ status: 402 })],
    ["Poe 401 authentication_error", poe({ status: 401, type: "authentication_error" })],
    ["Poe 402 insufficient_credits", poe({ status: 402, type: "insufficient_credits" })],
    ["Poe 404 not_found_error", poe({ status: 404, type: "not_found_error" })],
    ["Poe 413 request_too_large", poe({ status: 413, type: "request_too_large" })],
    ["知らない 4xx", or({ status: 418 })],
  ])("%s", (_name, f) => {
    expect(classifyUpstreamFailure(f).kind).toBe("fatal");
  });

  it("文言は見ない。残高不足や認証切れは、何が書いてあっても直らない", () => {
    expect(
      classifyUpstreamFailure(or({ status: 402, message: "flagged by moderation" })).kind,
    ).toBe("fatal");
    expect(
      classifyUpstreamFailure(poe({ status: 401, type: "moderation_error", message: "safety" })).kind,
    ).toBe("fatal");
  });
});

/**
 * セーフティ判定と「不正な依頼」は同じコードで届き、文言でしか区別
 * できない。文言の一覧は知らないので見ない。区別できないものは投げ直す
 * 側に倒す（誤って止めるとこの機能が使えない。誤って投げ直しても
 * 失うのは試行回数だけ）。
 */
describe("断られた（投げ直す。試行に数える）", () => {
  it.each([
    ["OpenRouter 403（moderation flag / guardrail / permissions のどれでも）", or({ status: 403 })],
    ["OpenRouter 403 に判定の理由が付いている", or({ status: 403, raw: JSON.stringify({ reasons: ["x"], flagged_input: "…" }) })],
    ["Poe 403 moderation_error", poe({ status: 403, type: "moderation_error" })],
    ["Poe 403 で型が無い", poe({ status: 403 })],
    ["OpenRouter 400（文言が何であれ）", or({ status: 400, message: "Bad Request" })],
    ["元プロバイダのセーフティ判定が 400 で包まれて届く", or({ status: 400, message: "Your request was rejected by the safety system." })],
    ["Poe 400 invalid_request_error", poe({ status: 400, type: "invalid_request_error" })],
    ["422", or({ status: 422 })],
    ["200 のあとに本文の中で届いた 400（OpenRouter は元プロバイダの状態を code に入れる）", or({ status: 400, type: "provider_error" })],
  ])("%s", (_name, f) => {
    expect(classifyUpstreamFailure(f).kind).toBe("refused");
  });

  it("本文の中で届いた 5xx は一時的な不調", () => {
    expect(classifyUpstreamFailure(or({ status: 502, type: "provider_error" })).kind).toBe(
      "transient",
    );
  });
});
