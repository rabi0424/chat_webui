import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Markdown の描画の本体（KaTeX・化学式・強調表示・生HTMLの解釈）が、
 * **最初の読み込みとサーバーに入っていないか**をビルド結果で見る。
 *
 * 本体は `components/MarkdownRenderer.tsx` にあり、900KB（gzip 270KB）ほど
 * ある。静的に import していたころは会話の画面のチャンクに入り、本文を
 * 1件も描かないホーム（PWA の起動先）でも最初に全部落として評価していた
 * （最初の読み込みの JS 1.3MB の7割）。サーバーのバンドルにも入り、API の
 * ポーリングを含む全部の呼び出しで、冷えた起動のたびに評価されていた。
 *
 * どこか1箇所で `MarkdownRenderer` やその依存を静的に import し直すだけで
 * 元に戻るが、**画面は何も変わらない**（重くなるだけ）。型もテストも通る。
 * 出力を読まないと分からないので、ここで読む。
 */
const CLIENT = "build/client";
const SERVER = "build/server";

/**
 * 本体の依存にだけ現れる文字列。ライブラリを上げて文言が変わると見つから
 * なくなり、検査が空振りする——そうならないよう、下で「クライアントの
 * どこかには入っている」ことも確かめる。
 */
const MARKERS = {
  KaTeX: "KaTeX parse error",
  化学式: "mhchem",
  強調表示: "hljs-",
  生HTMLの解釈: "unexpected-question-mark-instead-of-tag-name",
};

type Manifest = {
  entry: { module: string; imports: string[] };
  routes: Record<string, { module: string; imports?: string[] }>;
};

function readManifest(): Manifest | null {
  let files: string[];
  try {
    files = readdirSync(`${CLIENT}/assets`);
  } catch {
    return null;
  }
  const name = files.find((f) => /^manifest-[\w-]+\.js$/.test(f));
  if (!name) return null;
  const text = readFileSync(`${CLIENT}/assets/${name}`, "utf-8");
  return JSON.parse(
    text.replace(/^window\.__reactRouterManifest=/, "").replace(/;\s*$/, ""),
  ) as Manifest;
}

const manifest = readManifest();

/**
 * 1本のチャンクが**静的に**読み込むチャンク（`import … from "./x.js"`
 * と `import "./x.js"`）。`import("./x.js")` は読まれたときに初めて
 * 取りに行くので含めない——本体はそちらで読む。
 */
function staticImports(path: string): string[] {
  const code = readFileSync(`${CLIENT}${path}`, "utf-8");
  const dir = path.slice(0, path.lastIndexOf("/") + 1);
  return [...code.matchAll(/(?:\bfrom|\bimport)\s*["'`]\.\/([^"'`]+)["'`]/g)].map(
    (m) => dir + m[1],
  );
}

/**
 * そのページを開いたときに、動的 import を待たずに読まれるチャンクの全部。
 *
 * マニフェストの一覧（ブラウザが先読みするもの）に加えて、チャンクの中の
 * 静的 import も自分で辿る。一覧だけを信じると、一覧に載らない経路で
 * 入ったものを見落とす。
 */
function initialChunks(routeIds: string[]): Set<string> {
  const m = manifest!;
  const seeds = [m.entry.module, ...m.entry.imports];
  for (const id of routeIds) {
    const route = m.routes[id];
    // ルートの名前が変わったら、黙って空を検査しないよう落とす
    expect(route, `ルート ${id} がマニフェストに無い`).toBeDefined();
    seeds.push(route.module, ...(route.imports ?? []));
  }
  const seen = new Set<string>();
  const queue = [...seeds];
  while (queue.length) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    queue.push(...staticImports(path));
  }
  return seen;
}

function markersIn(code: string): string[] {
  return Object.entries(MARKERS)
    .filter(([, marker]) => code.includes(marker))
    .map(([name]) => name);
}

function jsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (statSync(path).isDirectory()) return jsFiles(path);
    return /\.m?js$/.test(name) ? [path] : [];
  });
}

// ビルドしていない環境（テストだけ流す場合）では飛ばす。CI は build を先に流す
describe.skipIf(manifest == null)("Markdown の本体はあとから読む", () => {
  it("本体の依存はクライアントのどこかには入っている（目印が生きている）", () => {
    const all = jsFiles(`${CLIENT}/assets`)
      .map((f) => readFileSync(f, "utf-8"))
      .join("\n");
    expect(markersIn(all)).toEqual(Object.keys(MARKERS));
  });

  it.each([
    ["ホーム（/）", ["root", "routes/shell", "routes/home"]],
    ["会話（/chat/:id）", ["root", "routes/shell", "routes/chat.$id"]],
  ])("%s を開いた時点で読むチャンクに入っていない", (_, routeIds) => {
    const chunks = initialChunks(routeIds);
    // 辿れていること自体も見る（辿り損ねて空なら何でも通ってしまう）
    expect(chunks.size).toBeGreaterThan(5);
    const found = [...chunks].flatMap((path) =>
      markersIn(readFileSync(`${CLIENT}${path}`, "utf-8")).map(
        (name) => `${path}: ${name}`,
      ),
    );
    expect(found).toEqual([]);
  });

  it("サーバーのバンドルに入っていない", () => {
    const files = jsFiles(SERVER);
    expect(files.length).toBeGreaterThan(0);
    const found = files.flatMap((path) =>
      markersIn(readFileSync(path, "utf-8")).map((name) => `${path}: ${name}`),
    );
    expect(found).toEqual([]);
  });
});
