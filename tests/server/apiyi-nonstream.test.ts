import { describe, expect, it } from "vitest";

/**
 * ストリームで返さない上流を読む。
 *
 * 画像生成のモデルには stream に対応しないものがあり（API易の画像系は
 * 上流の文書に明記がある）、`stream: true` を付けても中継は普通の JSON を
 * 1つ返す。SSE として読むと `data: ` で始まる行が1つも無いまま終わる
 * ので、**本文も画像も使用量も丸ごと落ちて「本文のない応答」**になる。
 * 画面には「モデルから本文のない応答が返りました」とだけ出て、上流では
 * 生成が終わって課金されている——気づく手立てが無い壊れ方なので、
 * 見分けと読み取りの両方をここで見る。
 */
const { readUpstreamJson, readUpstreamResponse } = await import(
  "../../app/lib/generation.server"
);

const encoder = new TextEncoder();

function bodyOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** 本文を複数の塊に割って流す（1回の read で全部は来ない）。 */
function chunked(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(encoder.encode(p));
      controller.close();
    },
  });
}

const imageReply = {
  choices: [
    {
      message: { content: "できました\n\n![image](https://cdn.example/x.png)" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 3400 },
};

describe("readUpstreamJson", () => {
  it("本文・使用量・終了理由を取り出す", async () => {
    const result = await readUpstreamJson(bodyOf(JSON.stringify(imageReply)));
    expect(result.content).toContain("https://cdn.example/x.png");
    expect(result.finishReason).toBe("stop");
    expect(JSON.parse(result.usageJson ?? "{}")).toMatchObject({
      promptTokens: 12,
      completionTokens: 3400,
    });
    expect(result.interrupted).toBeUndefined();
  });

  it("塊に割れて届いても、つなげてから読む", async () => {
    const text = JSON.stringify(imageReply);
    const half = Math.floor(text.length / 2);
    const result = await readUpstreamJson(
      chunked([text.slice(0, half), text.slice(half)]),
    );
    expect(result.content).toContain("https://cdn.example/x.png");
  });

  it("content が部品の配列でも、文章と画像を拾う", async () => {
    /*
     * 非ストリームの応答では content が
     * [{type:"text"}, {type:"image_url"}] の形で来ることがある。
     * 文字列としてだけ読むと、そこにある画像も文章も落ちる。
     */
    const result = await readUpstreamJson(
      bodyOf(
        JSON.stringify({
          choices: [
            {
              message: {
                content: [
                  { type: "text", text: "はい" },
                  {
                    type: "image_url",
                    image_url: { url: "https://cdn.example/y.png" },
                  },
                ],
              },
            },
          ],
        }),
      ),
    );
    expect(result.content).toBe("はい");
    expect(result.imageUrls).toEqual(["https://cdn.example/y.png"]);
  });

  it("images フィールドで返る画像も拾う", async () => {
    const result = await readUpstreamJson(
      bodyOf(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                images: [
                  { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
                ],
              },
            },
          ],
        }),
      ),
    );
    expect(result.imageUrls).toEqual(["data:image/png;base64,AAA"]);
  });

  it("200 の中に届いたエラーは、分け方へ渡せる形で持ち帰る", async () => {
    const result = await readUpstreamJson(
      bodyOf(
        JSON.stringify({
          error: { message: "rejected by the safety system", type: "shell_api_error", code: 400 },
        }),
      ),
    );
    expect(result.error?.detail).toBe("rejected by the safety system");
    expect(result.error?.code).toBe(400);
  });

  it("JSON でもない本文は、中身の先頭を理由に添える", async () => {
    /*
     * 手前のプロキシやゲートウェイが HTML のエラーページを返すことが
     * ある。「空の応答」として片付けると、何が起きたのか画面から
     * 分からない。
     */
    const result = await readUpstreamJson(bodyOf("<html>502 Bad Gateway</html>"));
    expect(result.content).toBe("");
    expect(result.interrupted).toContain("502 Bad Gateway");
  });

  it("本文が空でも例外にしない", async () => {
    const result = await readUpstreamJson(bodyOf(""));
    expect(result.content).toBe("");
    expect(result.usageJson).toBeNull();
  });
});

describe("readUpstreamResponse の見分け", () => {
  const sse =
    'data: {"choices":[{"delta":{"content":"流れて"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"きた"}}]}\n\n' +
    "data: [DONE]\n\n";

  it("JSON を返す上流は JSON として読む", async () => {
    const res = new Response(JSON.stringify(imageReply), {
      headers: { "content-type": "application/json" },
    });
    const result = await readUpstreamResponse(res);
    expect(result.content).toContain("https://cdn.example/x.png");
  });

  it("SSE を返す上流は今までどおりストリームとして読む", async () => {
    const res = new Response(sse, {
      headers: { "content-type": "text/event-stream" },
    });
    const result = await readUpstreamResponse(res);
    expect(result.content).toBe("流れてきた");
  });

  it("Content-Type が無ければストリームとして読む", async () => {
    /*
     * 既に通っている窓口の動きを変えないための既定。JSON 側へ倒すと、
     * Content-Type を付けない上流の応答が全部読めなくなる。
     */
    const res = new Response(sse);
    res.headers.delete("content-type");
    const result = await readUpstreamResponse(res);
    expect(result.content).toBe("流れてきた");
  });

  it("本文が無ければ、その旨を理由に残す", async () => {
    const res = new Response(null, { status: 204 });
    const result = await readUpstreamResponse(res);
    expect(result.interrupted).toBeTruthy();
    expect(result.content).toBe("");
  });
});
