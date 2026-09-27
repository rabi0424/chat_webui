import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb, makeD1, type D1Trace } from "../stubs/d1-sqlite";
import {
  APIYI_PREFIX,
  POE_PREFIX,
  RUNWARE_PREFIX,
} from "../../app/lib/constants";
import type { ChatMessage } from "../../app/lib/openrouter.server";

/**
 * 添付画像の展開（上流へ投げる直前に R2 から読んで data: URL にする）。
 *
 * 以前は画像のある発言ごとに D1 を1往復し、そのあと1枚ずつ R2 を
 * 待っていた。画像の多い会話ほど、送信してから上流へ投げるまでが
 * 直列に延びる。ここで見るのは:
 *   - 添付の行は全発言ぶんを1往復で引く（100個を超えるバインドは流さない）
 *   - R2 は並べて読むが、同時に読む本数は抑える
 *   - 読み終わった順ではなく、発言と添付の順のまま並ぶ
 *   - 画像だけの窓口では、直近の発言より前の画像を読みもしない——
 *     そしてそれが、上流へ送る中身を変えていないこと
 *
 * D1 は node:sqlite を包んだもの（流れる SQL は本番のもの）、R2 は
 * 読み出しの遅さを決められる入れ物。
 */

const box = vi.hoisted(() => ({
  d1: null as unknown,
  files: null as unknown,
  /** 上流へ渡った中身（窓口ごとの組み立ての引数）。 */
  sent: [] as unknown[],
}));

vi.mock("cloudflare:workers", () => ({
  env: new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "DB") return box.d1;
        if (prop === "FILES") return box.files;
        throw new Error(`env.${String(prop)} はこのテストでは用意していません`);
      },
    },
  ),
  DurableObject: class {},
}));

const ok = () => new Response("ok", { status: 200 });
vi.mock("../../app/lib/openrouter.server", async (orig) => ({
  ...(await orig<typeof import("../../app/lib/openrouter.server")>()),
  openRouterChatRequest: async (body: unknown) => (box.sent.push(body), ok()),
  poeChatRequest: async (body: unknown) => (box.sent.push(body), ok()),
}));
vi.mock("../../app/lib/apiyi.server", async (orig) => ({
  ...(await orig<typeof import("../../app/lib/apiyi.server")>()),
  apiyiChatRequest: async (body: unknown) => (box.sent.push(body), ok()),
  apiyiImageRequest: async (body: unknown) => (box.sent.push(body), ok()),
}));
vi.mock("../../app/lib/runware.server", async (orig) => ({
  ...(await orig<typeof import("../../app/lib/runware.server")>()),
  runwareImageRequest: async (body: unknown) => (box.sent.push(body), ok()),
}));

const {
  expandAttachments,
  expandAttachmentsFor,
  requestUpstream,
  R2_READ_CONCURRENCY,
} = await import("../../app/lib/generation.server");
const { usesLatestUserImagesOnly } = await import("../../app/lib/upstream-shape");

let sqlite: DatabaseSync;
let trace: D1Trace;

/** R2 の入れ物。読んだキー、同時に読んでいた本数の最大、読む遅さ。 */
const r2 = {
  reads: [] as string[],
  inflight: 0,
  maxInflight: 0,
  /** キーごとの遅さ（ms）。無ければ 0。 */
  delay: new Map<string, number>(),
  missing: new Set<string>(),
};

function makeFiles() {
  return {
    async get(key: string) {
      r2.reads.push(key);
      r2.inflight++;
      r2.maxInflight = Math.max(r2.maxInflight, r2.inflight);
      await new Promise((resolve) => setTimeout(resolve, r2.delay.get(key) ?? 0));
      if (r2.missing.has(key)) {
        r2.inflight--;
        return null;
      }
      return {
        async arrayBuffer() {
          // 本文を読み終えるまでが1本（接続を握っているあいだ）
          r2.inflight--;
          return new TextEncoder().encode(`body:${key}`).buffer;
        },
      };
    },
  };
}

/** 添付を1件置く。キーは `k/<id>`。 */
function addAttachment(id: string): void {
  sqlite
    .prepare(
      "INSERT INTO attachments (id, message_id, conversation_id, r2_key, mime_type, name, size, created_at) VALUES (?, NULL, NULL, ?, 'image/png', ?, 1, 1)",
    )
    .run(id, `k/${id}`, `${id}.png`);
}

/** data: URL から、どのキーの中身かを読み戻す。 */
function keyOf(url: string): string {
  const b64 = url.replace(/^data:image\/png;base64,/, "");
  return Buffer.from(b64, "base64").toString("utf8").replace(/^body:/, "");
}

/** 展開後の各発言に載った画像（キーの並び）。文字だけの発言は null。 */
function imagesOf(out: Awaited<ReturnType<typeof expandAttachments>>) {
  return out.map((m) =>
    typeof m.content === "string"
      ? null
      : m.content
          .filter((p) => p.type === "image_url")
          .map((p) => keyOf((p as { image_url: { url: string } }).image_url.url)),
  );
}

beforeEach(async () => {
  sqlite = freshDb();
  trace = { roundTrips: 0, statements: [] };
  box.d1 = makeD1(sqlite, () => trace);
  box.files = makeFiles();
  box.sent = [];
  r2.reads = [];
  r2.inflight = 0;
  r2.maxInflight = 0;
  r2.delay = new Map();
  r2.missing = new Set();
  // db.server は最初の1回だけスキーマを確かめる。その往復を数えないよう
  // 先に1回通しておく
  addAttachment("warm");
  await expandAttachments([
    { role: "user", content: "", attachmentIds: ["warm"] },
  ]);
  trace = { roundTrips: 0, statements: [] };
  r2.reads = [];
  r2.maxInflight = 0;
});

/** 3つのユーザー発言にまたがる会話。前の2つにも画像がある。 */
function history(): ChatMessage[] {
  for (const id of ["a1", "a2", "b1", "c1", "c2"]) addAttachment(id);
  return [
    { role: "system", content: "前置き" },
    { role: "user", content: "1枚目と2枚目", attachmentIds: ["a1", "a2"] },
    { role: "assistant", content: "はい" },
    { role: "user", content: "もう1枚", attachmentIds: ["b1"] },
    { role: "assistant", content: "どうぞ" },
    { role: "user", content: "この2枚で", attachmentIds: ["c1", "c2"] },
  ];
}

describe("添付の行を引く往復", () => {
  it("画像のある発言がいくつあっても、行は1往復で引く", async () => {
    const out = await expandAttachments(history());
    expect(trace.roundTrips).toBe(1);
    expect(imagesOf(out)).toEqual([
      null,
      ["k/a1", "k/a2"],
      null,
      ["k/b1"],
      null,
      ["k/c1", "k/c2"],
    ]);
  });

  it("100個を超える添付でも、バインドを上限の内に分けて1往復で引く", async () => {
    const messages: ChatMessage[] = [];
    for (let m = 0; m < 25; m++) {
      const ids = Array.from({ length: 8 }, (_, i) => `m${m}-${i}`);
      ids.forEach(addAttachment);
      messages.push({ role: "user", content: `発言${m}`, attachmentIds: ids });
    }
    const out = await expandAttachments(messages);
    expect(trace.roundTrips).toBe(1);
    const binds = trace.statements.map((s) => s.binds);
    expect(Math.max(...binds)).toBeLessThanOrEqual(90);
    expect(binds.reduce((a, b) => a + b, 0)).toBe(200);
    expect(imagesOf(out)).toEqual(
      messages.map((m) => m.attachmentIds!.map((id) => `k/${id}`)),
    );
  });

  it("添付の無い会話では D1 にも R2 にも触らない", async () => {
    const out = await expandAttachments([
      { role: "user", content: "やあ" },
      { role: "assistant", content: "どうも" },
    ]);
    expect(trace.roundTrips).toBe(0);
    expect(r2.reads).toEqual([]);
    expect(out).toEqual([
      { role: "user", content: "やあ" },
      { role: "assistant", content: "どうも" },
    ]);
  });
});

describe("R2 の読み出し", () => {
  it("読み終わった順ではなく、発言と添付の順のまま並ぶ", async () => {
    const messages = history();
    // 先の画像ほど遅く返す（読み終わる順は並びの逆になる）
    ["a1", "a2", "b1", "c1", "c2"].forEach((id, i) =>
      r2.delay.set(`k/${id}`, (5 - i) * 8),
    );
    const out = await expandAttachments(messages);
    expect(imagesOf(out)).toEqual([
      null,
      ["a1", "a2"].map((id) => `k/${id}`),
      null,
      ["k/b1"],
      null,
      ["c1", "c2"].map((id) => `k/${id}`),
    ]);
    // 画像 → 文字の順も保つ
    const last = out[5].content as { type: string }[];
    expect(last.map((p) => p.type)).toEqual(["image_url", "image_url", "text"]);
  });

  it("並べて読むが、同時に読む本数は上限までに抑える", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `p${i}`);
    ids.forEach(addAttachment);
    ids.forEach((id) => r2.delay.set(`k/${id}`, 10));
    const out = await expandAttachments([
      { role: "user", content: "", attachmentIds: ids.slice(0, 6) },
      { role: "user", content: "", attachmentIds: ids.slice(6) },
    ]);
    expect(imagesOf(out).flat()).toHaveLength(12);
    expect(r2.maxInflight).toBeGreaterThan(1);
    expect(r2.maxInflight).toBeLessThanOrEqual(R2_READ_CONCURRENCY);
    // 抑えた上限いっぱいまでは使っている（直列に戻っていない）
    expect(r2.maxInflight).toBe(R2_READ_CONCURRENCY);
  });

  it("同じ添付を2つの発言が指していても、実体は1度だけ読む", async () => {
    addAttachment("dup");
    const out = await expandAttachments([
      { role: "user", content: "前", attachmentIds: ["dup"] },
      { role: "user", content: "後", attachmentIds: ["dup"] },
    ]);
    expect(r2.reads).toEqual(["k/dup"]);
    expect(imagesOf(out)).toEqual([["k/dup"], ["k/dup"]]);
  });

  it("読めなかった1枚だけを落とし、残りの並びは崩さない", async () => {
    const messages = history();
    r2.missing.add("k/a1");
    const out = await expandAttachments(messages);
    expect(imagesOf(out)[1]).toEqual(["k/a2"]);
    expect(imagesOf(out)[5]).toEqual(["k/c1", "k/c2"]);
  });
});

describe("画像だけの窓口", () => {
  it("直近のユーザー発言より前の画像は、行も実体も読まない", async () => {
    // 末尾がユーザー以外でも、見るのは「直近のユーザー発言」
    // （imageRequestOf と同じ選び方。末尾の1件ではない）
    const out = await expandAttachments(
      [...history(), { role: "assistant", content: "書きかけ" }],
      { latestUserOnly: true },
    );
    expect(r2.reads.sort()).toEqual(["k/c1", "k/c2"]);
    const asked = trace.statements
      .filter((s) => /FROM attachments/.test(s.sql))
      .reduce((n, s) => n + s.binds, 0);
    expect(asked).toBe(2);
    // 前の発言は文字だけで残す（並びは崩さない）
    expect(out[1]).toEqual({ role: "user", content: "1枚目と2枚目" });
    expect(imagesOf(out)[5]).toEqual(["k/c1", "k/c2"]);
  });

  it("ジョブの窓口に合わせて読むものを決める", async () => {
    const job = (model: string, imageOutput: boolean) => ({
      model,
      imageOutput,
      messages: history(),
    });
    const readsFor = async (model: string, imageOutput: boolean) => {
      sqlite.exec("DELETE FROM attachments");
      r2.reads = [];
      await expandAttachmentsFor(job(model, imageOutput));
      return r2.reads.length;
    };
    expect(await readsFor(`${RUNWARE_PREFIX}m`, true)).toBe(2);
    expect(await readsFor(`${APIYI_PREFIX}m`, true)).toBe(2);
    expect(await readsFor(`${APIYI_PREFIX}m`, false)).toBe(5);
    expect(await readsFor("vendor/m", true)).toBe(5);
    expect(await readsFor(`${POE_PREFIX}m`, true)).toBe(5);
  });

  /**
   * 結び付きの見張り。「前の画像を読まない」と決める条件
   * （usesLatestUserImagesOnly）と、上流への組み立て（requestUpstream）が
   * 食い違うと、会話を送る窓口に履歴の画像が黙って届かなくなる。
   * 画面にはエラーが出ない壊れ方なので、全部の窓口で確かめる:
   * 読まないと決めた窓口では、全部読んだときと送る中身が1バイトも違わない。
   */
  it("読まないと決めた窓口だけが、送る中身を変えない", async () => {
    const models = [
      "vendor/m",
      `${POE_PREFIX}m`,
      `${APIYI_PREFIX}m`,
      `${RUNWARE_PREFIX}m`,
    ];
    const encode = (v: unknown) =>
      JSON.stringify(v, (_k, x: unknown) =>
        x instanceof ArrayBuffer ? Buffer.from(x).toString("base64") : x,
      );
    const messages = history();
    const full = await expandAttachments(messages);
    const latest = await expandAttachments(messages, { latestUserOnly: true });
    let skipping = 0;
    for (const model of models) {
      for (const imageOutput of [false, true]) {
        const job = {
          conversationId: "c",
          assistantMessageId: "a",
          model,
          web: false,
          webTools: false,
          imageOutput,
          paramsState: null,
          messages,
        } as unknown as Parameters<typeof requestUpstream>[0];
        box.sent = [];
        await requestUpstream(job, full, () => {});
        await requestUpstream(job, latest, () => {});
        const same = encode(box.sent[0]) === encode(box.sent[1]);
        const skips = usesLatestUserImagesOnly({ model, imageOutput });
        expect({ model, imageOutput, same }).toEqual({
          model,
          imageOutput,
          same: skips,
        });
        if (skips) skipping++;
      }
    }
    // 見張りが空振りしていない（読まない窓口が実際にある）
    expect(skipping).toBeGreaterThan(0);
  });
});
