import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb, makeD1, type D1Trace } from "../stubs/d1-sqlite";
import { FILE_OPEN } from "../../app/lib/paste";

/**
 * ボットの添付ファイルを、本物の db.server と本物の SQLite で通しで動かす。
 *
 * ファイルの中身は画面に無く、サーバーが写し取り・足す。どこか1か所で
 * 列を落とすと、画面には何も出ないまま「ボットが資料を読んでいない」
 * 状態になる。見るのは:
 * - ボットの作成・更新・複製で中身が保存されること（更新で省いたら消さない）
 * - 会話を作る・担当を替える・分岐するときに写し取られること
 * - 生成の入口で、申告どおりのボットのファイルが system に足されること
 *   （担当なら会話の写し、宛先ならいまの定義）と、往復が増えないこと
 */

const box = vi.hoisted(() => ({ d1: null as unknown }));

vi.mock("cloudflare:workers", () => ({
  env: new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "DB") return box.d1;
        throw new Error(`env.${String(prop)} はこのテストでは用意していません`);
      },
    },
  ),
  DurableObject: class {},
}));

vi.mock("../../app/lib/fx.server", () => ({ fetchUsdJpy: async () => 150 }));

const bots = await import("../../app/routes/api.bots");
const bot = await import("../../app/routes/api.bots.$id");
const conversations = await import("../../app/routes/api.conversations");
const conversation = await import("../../app/routes/api.conversations.$id");
const fork = await import("../../app/routes/api.conversations.$id.fork");
const generate = await import("../../app/routes/api.conversations.$id.generate");
const shell = await import("../../app/lib/db.server");

let sqlite: DatabaseSync;
let trace: D1Trace;
/** 実行体に渡したジョブ。 */
let started: { messages: { role: string; content: string }[] }[];

const context = {
  get: () => ({
    env: {
      GENERATOR: {
        idFromName: () => "id",
        get: () => ({
          fetch: async (_url: string, init: RequestInit) => {
            started.push(JSON.parse(String(init.body)) as never);
            return new Response("ok", { status: 202 });
          },
        }),
      },
    },
  }),
};

const call = (
  route: { action: (args: never) => unknown },
  method: string,
  body: unknown,
  params: Record<string, string> = {},
) =>
  route.action({
    request: new Request("https://x/api", {
      method,
      body: JSON.stringify(body),
    }),
    params,
    context,
  } as never) as Promise<Response>;

const botRow = (id: string) =>
  sqlite.prepare("SELECT * FROM bots WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;
const convRow = (id: string) =>
  sqlite.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;

const files = (...names: string[]) =>
  names.map((name) => ({ name, content: `${name}の中身` }));

async function createBot(body: Record<string, unknown>): Promise<string> {
  const res = await call(bots, "POST", {
    name: "翻訳",
    modelId: "m/x",
    systemPrompt: "あなたは翻訳者です。",
    ...body,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { bot: { id: string } }).bot.id;
}

async function createConversation(botId?: string): Promise<string> {
  const res = await call(conversations, "POST", { modelId: "m/x", botId });
  return ((await res.json()) as { id: string }).id;
}

/** 生成を始め、実行体へ渡った system の中身を返す（無ければ null）。 */
async function systemSent(
  convId: string,
  botFiles: unknown,
  system: string | null = "画面が組んだプロンプト",
  parentId: string | null = null,
): Promise<string | null> {
  started = [];
  trace = { roundTrips: 0, statements: [] };
  const res = await call(
    generate,
    "POST",
    {
      model: "m/x",
      userContent: "質問",
      botFiles,
      parentId,
      messages: [
        ...(system != null ? [{ role: "system", content: system }] : []),
        { role: "user", content: "質問" },
      ],
    },
    { id: convId },
  );
  expect(res.status).toBe(200);
  const sys = started[0].messages.find((m) => m.role === "system");
  return sys?.content ?? null;
}

beforeEach(() => {
  sqlite = freshDb();
  trace = { roundTrips: 0, statements: [] };
  box.d1 = makeD1(sqlite, () => trace);
  started = [];
});

describe("ボットの保存", () => {
  it("作成でファイルを保存し、一覧（シェル）には中身を載せない", async () => {
    const id = await createBot({ files: files("用語集.md") });
    expect(JSON.parse(String(botRow(id).files_json))).toEqual(files("用語集.md"));
    const [listed] = await shell.listBots();
    expect(listed.id).toBe(id);
    expect(listed).not.toHaveProperty("files_json");
  });

  it("ファイルが無ければ NULL（空の配列を書かない）", async () => {
    const id = await createBot({ files: [] });
    expect(botRow(id).files_json).toBeNull();
  });

  it("更新で files を省いたら今のまま、空の配列なら外す", async () => {
    const id = await createBot({ files: files("a.txt") });
    const patch = (extra: Record<string, unknown>) =>
      call(bot, "PATCH", { name: "翻訳", modelId: "m/x", ...extra }, { id });
    await patch({ systemPrompt: "変えた" });
    expect(botRow(id)).toMatchObject({ system_prompt: "変えた" });
    expect(JSON.parse(String(botRow(id).files_json))).toEqual(files("a.txt"));
    await patch({ files: files("b.txt") });
    expect(JSON.parse(String(botRow(id).files_json))).toEqual(files("b.txt"));
    await patch({ files: [] });
    expect(botRow(id).files_json).toBeNull();
  });

  it("複製は元のボットのファイルを写す（一覧は中身を持たないので画面からは送れない）", async () => {
    const src = await createBot({ files: files("a.txt", "b.txt") });
    const copy = await createBot({ name: "翻訳のコピー", filesFrom: src });
    expect(botRow(copy).files_json).toBe(botRow(src).files_json);
  });

  it("中身を送ってきたら、写す元より送られたものを使う", async () => {
    const src = await createBot({ files: files("a.txt") });
    const copy = await createBot({ files: files("z.txt"), filesFrom: src });
    expect(JSON.parse(String(botRow(copy).files_json))).toEqual(files("z.txt"));
  });
});

describe("会話への写し", () => {
  it("ボットで会話を作るとファイルを写し、あとでボットを編集しても会話は変わらない", async () => {
    const b = await createBot({ files: files("始め.txt") });
    const c = await createConversation(b);
    const before = convRow(c).bot_files_json;
    expect(JSON.parse(String(before))).toEqual(files("始め.txt"));
    await call(bot, "PATCH", { name: "翻訳", modelId: "m/x", files: files("後.txt") }, { id: b });
    expect(convRow(c).bot_files_json).toBe(before);
  });

  it("担当を替えると新しいボットのファイルを写し、外すと消す", async () => {
    const b1 = await createBot({ files: files("一.txt") });
    const b2 = await createBot({ files: files("二.txt") });
    const c = await createConversation(b1);
    await call(conversation, "PATCH", { botId: b2 }, { id: c });
    expect(JSON.parse(String(convRow(c).bot_files_json))).toEqual(files("二.txt"));
    await call(conversation, "PATCH", { botId: null }, { id: c });
    expect(convRow(c).bot_files_json).toBeNull();
  });

  it("分岐した会話にも写しが付いていく", async () => {
    const b = await createBot({ files: files("資料.txt") });
    const c = await createConversation(b);
    sqlite
      .prepare(
        "INSERT INTO messages (id, conversation_id, parent_id, role, content, created_at) VALUES ('u', ?, NULL, 'user', 'q', 1)",
      )
      .run(c);
    const res = await call(fork, "POST", { messageId: "u" }, { id: c });
    const forked = ((await res.json()) as { id: string }).id;
    expect(convRow(forked).bot_files_json).toBe(convRow(c).bot_files_json);
  });

  it("会話を開くときの行には写しを載せない", async () => {
    const b = await createBot({ files: files("資料.txt") });
    const c = await createConversation(b);
    const found = await shell.getConversationWithPath(c);
    expect(found?.conversation.id).toBe(c);
    expect(found?.conversation).not.toHaveProperty("bot_files_json");
  });
});

describe("生成の入口", () => {
  it("担当なら会話の写しを、画面が組んだプロンプトの後ろに足す", async () => {
    const b = await createBot({ files: files("写し.txt") });
    const c = await createConversation(b);
    // 写したあとでボットを編集しても、会話の資料は始めたときのまま
    await call(bot, "PATCH", { name: "翻訳", modelId: "m/x", files: files("いま.txt") }, { id: b });
    const sys = await systemSent(c, { botId: b, fromConversation: true });
    expect(sys?.startsWith("画面が組んだプロンプト\n\n")).toBe(true);
    expect(sys).toContain(`${FILE_OPEN}写し.txt\n写し.txtの中身`);
    expect(sys).not.toContain("いま.txt");
    // 読む1回＋書く1回のまま（ファイルの読み出しは同じ batch）
    expect(trace.roundTrips).toBe(2);
  });

  it("宛先なら、そのボットのいまのファイル", async () => {
    const owner = await createBot({ files: files("担当.txt") });
    const other = await createBot({ files: files("宛先.txt") });
    const c = await createConversation(owner);
    const sys = await systemSent(c, { botId: other, fromConversation: false });
    expect(sys).toContain("宛先.txt");
    expect(sys).not.toContain("担当.txt");
    expect(trace.roundTrips).toBe(2);
  });

  it("担当の切り替えより先に届いた送信は、新しい担当のいまのファイル", async () => {
    const b1 = await createBot({ files: files("前.txt") });
    const b2 = await createBot({ files: files("新.txt") });
    const c = await createConversation(b1);
    // 画面は b2 に切り替えたが、切り替えの PATCH はまだ書けていない
    const sys = await systemSent(c, { botId: b2, fromConversation: true });
    expect(sys).toContain("新.txt");
    expect(sys).not.toContain("前.txt");
  });

  it("繋ぎ先（親）と一緒に読んでも、読み出しの結果を取り違えない", async () => {
    // 同じ batch の何番目に何があるかがずれると、親が「見つからない」
    // （400）になるか、ファイルの代わりに親の行を読む
    const owner = await createBot({ files: files("担当.txt") });
    const other = await createBot({ files: files("宛先.txt") });
    const c = await createConversation(owner);
    sqlite
      .prepare(
        "INSERT INTO messages (id, conversation_id, parent_id, role, content, created_at) VALUES ('a0', ?, NULL, 'assistant', '前', 1)",
      )
      .run(c);
    const sys = await systemSent(
      c,
      { botId: other, fromConversation: false },
      "画面が組んだプロンプト",
      "a0",
    );
    expect(sys).toContain("宛先.txt");
    expect(trace.roundTrips).toBe(2);
  });

  it("写しを使う（ボットの行が0行の）ときも、親を取り違えない", async () => {
    const b = await createBot({ files: files("写し.txt") });
    const c = await createConversation(b);
    sqlite
      .prepare(
        "INSERT INTO messages (id, conversation_id, parent_id, role, content, created_at) VALUES ('a0', ?, NULL, 'assistant', '前', 1)",
      )
      .run(c);
    const sys = await systemSent(
      c,
      { botId: b, fromConversation: true },
      "画面が組んだプロンプト",
      "a0",
    );
    expect(sys).toContain("写し.txt");
  });

  it("親が無ければ、ボットの行を親と取り違えずに 400", async () => {
    const owner = await createBot({ files: files("担当.txt") });
    const other = await createBot({ files: files("宛先.txt") });
    const c = await createConversation(owner);
    const res = await call(
      generate,
      "POST",
      {
        model: "m/x",
        userContent: "質問",
        parentId: "gone",
        botFiles: { botId: other, fromConversation: false },
        messages: [{ role: "user", content: "質問" }],
      },
      { id: c },
    );
    expect(res.status).toBe(400);
    expect(started).toEqual([]);
  });

  it("プロンプトが空のボット（system を送らない）でも、system を立てて足す", async () => {
    const b = await createBot({ systemPrompt: "", files: files("だけ.txt") });
    const c = await createConversation(b);
    const sys = await systemSent(c, { botId: b, fromConversation: true }, null);
    expect(sys).toContain("だけ.txt");
  });

  it("申告が無ければ、会話にボットの写しがあっても足さない（担当を外した直後）", async () => {
    const b = await createBot({ files: files("資料.txt") });
    const c = await createConversation(b);
    expect(await systemSent(c, null)).toBe("画面が組んだプロンプト");
  });
});
