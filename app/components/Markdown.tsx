import { createContext, memo, useContext, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { useCopied } from "../lib/use-copied";
import type { PluggableList } from "unified";
import type { Element, ElementContent, Root, RootContent } from "hast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
// 化学式（`$\ce{H2O}$` `$\ce{2H2 + O2 -> 2H2O}$`）。KaTeX にマクロを足すだけ
// なので、読み込んだ時点で数式の描画に乗る。モデルは化学式をTeXで書くことが
// 多いので、独自記法を増やすよりこちらのほうが実際の出力に当たる。
import "katex/contrib/mhchem";
// 数式のコピーで元のTeXを渡す（ブラウザ専用・副作用のみ）
import "../lib/katex-copy-tex.client";
import { IconCheck, IconCopy } from "./icons";
import { prepareMarkdown } from "../lib/markdown";
import { ALERT_TYPES, alertTypeOf, remarkAlert } from "../lib/remark-alert";
import { remarkSup } from "../lib/remark-sup";
import { MarkdownAlert } from "./MarkdownAlert";
import { MarkdownTable } from "./MarkdownTable";
import { MermaidBlock } from "./MermaidBlock";
import { SvgBlock } from "./SvgBlock";

/** 言語表示に使う名前。hljs のクラス名から拾えなかったものはそのまま出す。 */
const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Bash",
  c: "C",
  cpp: "C++",
  cs: "C#",
  css: "CSS",
  diff: "Diff",
  go: "Go",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  jsx: "JSX",
  kotlin: "Kotlin",
  markdown: "Markdown",
  md: "Markdown",
  mermaid: "Mermaid",
  svg: "SVG",
  php: "PHP",
  plaintext: "Text",
  python: "Python",
  py: "Python",
  ruby: "Ruby",
  rust: "Rust",
  scss: "SCSS",
  sh: "Shell",
  shell: "Shell",
  sql: "SQL",
  swift: "Swift",
  toml: "TOML",
  ts: "TypeScript",
  tsx: "TSX",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
  zsh: "Zsh",
};

function nodeText(node: ElementContent | Element | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value;
  if ("children" in node) return node.children.map(nodeText).join("");
  return "";
}

/**
 * リンク先のドメイン（http/https の絶対URLのみ）。
 *
 * 相対リンク・ページ内リンク・`mailto:` などは対象外。ここで拾えたものだけ
 * 本文の脇に出して、`[公式サイト](https://例のよく似た別ドメイン)` のような
 * 行き先の食い違いに気づけるようにする。
 */
function externalHost(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, "https://relative.invalid");
    if (url.origin === "https://relative.invalid") return null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function CopyCodeButton({ text }: { text: string }) {
  const [copied, flashCopied] = useCopied();
  return (
    <button
      type="button"
      aria-label="コードをコピー"
      title="コードをコピー"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          flashCopied();
        } catch {
          // クリップボード不許可時は何もしない
        }
      }}
      className="rounded p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
    >
      {copied ? (
        <IconCheck className="h-3.5 w-3.5 text-green-500" />
      ) : (
        <IconCopy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

/**
 * コードブロックの奥から参照したい、描き方の設定。
 *
 * - streaming: 本文がまだ伸びている最中か。図（Mermaid）は書きかけの
 *   ソースを描いても意味が無いので、これを見て落ち着くまで待つ。
 * - diagrams: 図を描いてよい場所か。思考プロセスや入力の吹き出しでは、
 *   本文より目立ってしまうのでソースのまま見せる。
 */
type BlockConfig = {
  streaming: boolean;
  diagrams: boolean;
  /**
   * 本文の中の画像をタップしたとき（拡大表示を開く）。
   *
   * 会話の中でだけ渡す。渡されていなければ画像はただの画像のままで、
   * 押しどころにもならない（設定画面のヘルプなど、開く先が無い場所で
   * 押せるように見せない）。
   */
  onImageClick?: (src: string) => void;
};

const BlockContext = createContext<BlockConfig>({
  streaming: false,
  diagrams: true,
});

/** コードブロック。言語名とコピーボタンを付けた枠で囲む。 */
function CodeBlock({ node, children }: { node?: Element; children?: ReactNode }) {
  const code = node?.children.find(
    (c): c is Element => c.type === "element" && c.tagName === "code",
  );
  const className = Array.isArray(code?.properties?.className)
    ? code.properties.className.join(" ")
    : String(code?.properties?.className ?? "");
  const lang = /language-([\w+#-]+)/.exec(className)?.[1]?.toLowerCase();
  const text = nodeText(code);
  const { streaming, diagrams } = useContext(BlockContext);

  const frame = (
    <div className="not-prose my-4 overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3 py-1 dark:border-neutral-800">
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {lang ? (LANGUAGE_LABELS[lang] ?? lang) : ""}
        </span>
        <CopyCodeButton text={text} />
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[13px] leading-relaxed text-neutral-800 dark:text-neutral-200">
        {children}
      </pre>
    </div>
  );

  // 図にできるなら図で。できないうちは、そのままソースを見せておく。
  if (diagrams && lang === "mermaid") {
    return <MermaidBlock code={text} streaming={streaming} fallback={frame} />;
  }
  // `xml` は SVG 以外にも使われるので、中身を見て判断するのは SvgBlock 側
  if (diagrams && (lang === "svg" || lang === "xml")) {
    return <SvgBlock code={text} streaming={streaming} fallback={frame} />;
  }
  return frame;
}

/**
 * 本文の中の画像。
 *
 * 拡大表示の入口が渡っているときだけボタンにする。モデルが返した画像は
 * 本文のマークダウンとして届くので、添付（MessageImages）と違って
 * ここを通らないと開けない——「成功するまで生成」で積まれた画像は
 * タップしても何も起きなかった。
 */
const MarkdownImage: Components["img"] = ({ src, alt }) => {
  const { onImageClick } = useContext(BlockContext);
  const url = typeof src === "string" ? src : undefined;
  const image = (
    <img src={url} alt={alt ?? ""} loading="lazy" className="rounded-lg" />
  );
  if (!onImageClick || !url) return image;
  return (
    <button
      type="button"
      onClick={() => onImageClick(url)}
      title="タップで拡大"
      /* 画像の余白は prose が img に付けている。囲みは大きさを持たない */
      className="block cursor-zoom-in transition active:opacity-80"
    >
      {image}
    </button>
  );
};

const components: Components = {
  pre: CodeBlock,
  // remark-alert が印を付けた引用ブロックだけ、警告ブロックとして描く
  div: ({ node, children, ...props }) => {
    const type = alertTypeOf(node?.properties?.className);
    if (!type) return <div {...props}>{children}</div>;
    return <MarkdownAlert type={type}>{children}</MarkdownAlert>;
  },
  // 表は横スクロール・並べ替え・コピーを付けた専用の描き方にする
  table: MarkdownTable,
  // 外部リンクは別タブで開く（脚注などのページ内リンクはそのまま）。
  // 行き先が本文と違うことがあるので、表示に無いときはドメインを添える。
  a: ({ node, children, href }) => {
    const external = !!href && !href.startsWith("#");
    const host = externalHost(href);
    const shown = host && !nodeText(node).toLowerCase().includes(host);
    return (
      <a
        href={href}
        title={external ? href : undefined}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
      >
        {children}
        {shown && <span className="md-link-host">{host}</span>}
      </a>
    );
  },
  // 本文の中の画像。会話の中では押すと拡大表示に入る
  // （「成功するまで生成」で積まれた画像はここを通る）
  img: MarkdownImage,
};


const remarkPlugins: PluggableList = [
  remarkGfm,
  // `$100 と $200` のような通貨表記を数式にしないため、1個の `$` は数式扱いしない。
  // 数式にすべき `$x$` は前処理（normalizeMath）で `$$x$$` に寄せてある。
  [remarkMath, { singleDollarTextMath: false }],
  // `> [!NOTE]` の目印を消すのは改行の変換より先（目印の行を丸ごと落とすため）
  remarkAlert,
  // `^2^` を上付きに
  remarkSup,
  // 1行の改行をそのまま改行として見せる（チャットの表示としてはこちらが自然）
  remarkBreaks,
];

type PropertyDefinition = NonNullable<
  (typeof defaultSchema)["attributes"]
>[string][number];

/**
 * その要素の既定の許可から className の定義を外し、値を絞った定義に差し替える。
 *
 * 同じ属性の定義は**最初に見つかった1つ**しか使われないので、既定の
 * `['className', /^language-./]` を残したまま足しても、足したほうは
 * 見られない。必ず置き換える。
 *
 * 値を1つも渡さないと `['className']` になり、hast-util-sanitize は
 * それを「**どの値でも通す**」と読む（絞ったつもりが全開になる）。
 * 許可する値は必ず1つ以上渡すこと。
 */
function classNames(
  tag: string,
  ...values: Array<string | RegExp>
): PropertyDefinition[] {
  const kept = (defaultSchema.attributes?.[tag] ?? []).filter(
    (d) => (Array.isArray(d) ? d[0] : d) !== "className",
  );
  return [...kept, ["className", ...values]];
}

/**
 * モデルが混ぜてくる生HTML（`<br>` `<sub>` `<details>` `<ruby>` など）を通すための
 * 許可リスト。既定（GitHubのサニタイズ相当）に、描画で実際に使うクラスだけ足す。
 *
 * **クラス名は値まで絞る。** 以前は `"*": ["className"]` として全要素に
 * 好きなクラスを許していたが、この画面は Tailwind を使っているので
 * `fixed inset-0 z-50 bg-white` と書くだけで**会話の画面を全面が覆える**。
 * 本文はモデルの出力（＝間接的に外部由来）なので、偽の対話箱を描かれると
 * 利用者はそれをアプリの一部として読む。
 *
 * 通すのは次の4つだけ。ここに無いクラスは黙って落ちる。
 *  - `language-*` … コードブロックの言語（既定から引き継ぎ）
 *  - `math-inline` / `math-display` … remark-math の印。消えると後段の
 *    rehype-katex が数式を見つけられない
 *  - `md-alert` / `md-alert-*` … remark-alert が付ける警告ブロックの印
 *  - 既定にある GFM のもの（`contains-task-list` `task-list-item`
 *    `footnotes` `sr-only` `data-footnote-backref`）
 *
 * 描画のあとで付くクラス（KaTeX・hljs・`stream-token`）は、この消毒より
 * 後ろの段で足すのでここには要らない。
 */
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: classNames("code", /^language-./, "math-inline", "math-display"),
    pre: classNames("pre", "math-inline", "math-display"),
    span: classNames("span", "math-inline", "math-display"),
    div: classNames(
      "div",
      "md-alert",
      ...ALERT_TYPES.map((type) => `md-alert-${type}`),
    ),
  },
};

/**
 * ストリーミング中の本文を、語（日本語は2文字）ごとの <span> に包む。
 *
 * 新しく届いた分だけが新しい要素として現れるので、CSSアニメーションが
 * その語にだけ1回走り、ChatGPTアプリのように文字が少しずつ浮かび上がる。
 * 既に出ている語の要素は作り直されないため、再アニメーションは起きない。
 */
function rehypeStreamTokens() {
  return (tree: Root) => wrapTokens(tree);
}

/** 中の文字を触ってはいけない要素（コード・数式・生SVG）。 */
const OPAQUE_TAGS = new Set(["pre", "code", "script", "style", "svg", "math"]);

function isOpaque(node: Element): boolean {
  if (OPAQUE_TAGS.has(node.tagName)) return true;
  const cls = node.properties?.className;
  const names = Array.isArray(cls) ? cls.map(String) : [String(cls ?? "")];
  return names.some((c) => c.startsWith("katex") || c.startsWith("math"));
}

/** 日本語・中国語・韓国語の文字（語の区切りが無いので短く刻む）。 */
const CJK =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/;

/** 空白・CJKの2文字・それ以外の連なり（英単語など）に刻む。 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  let space = false;
  const flush = () => {
    if (buf) out.push(buf);
    buf = "";
  };
  for (const ch of text) {
    if (/\s/.test(ch)) {
      if (!space) flush();
      space = true;
      buf += ch;
      continue;
    }
    if (space) {
      flush();
      space = false;
    }
    if (CJK.test(ch)) {
      // 2文字ずつまとめる（1文字ごとだと要素が増えすぎて描き直しが重い）
      const last = out[out.length - 1];
      if (last && last.length === 1 && CJK.test(last) && !buf) {
        out[out.length - 1] = last + ch;
      } else {
        flush();
        out.push(ch);
      }
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}

function wrapTokens(node: Root | Element): void {
  const children: RootContent[] = [];
  let wrapped = false;
  for (const child of node.children) {
    if (child.type === "text") {
      for (const token of tokenize(child.value)) {
        children.push(
          token.trim()
            ? {
                type: "element",
                tagName: "span",
                properties: { className: ["stream-token"] },
                children: [{ type: "text", value: token }],
              }
            : { type: "text", value: token },
        );
      }
      wrapped = true;
      continue;
    }
    if (child.type === "element" && !isOpaque(child)) wrapTokens(child);
    children.push(child);
  }
  if (wrapped) node.children = children as typeof node.children;
}

const rehypePlugins: PluggableList = [
  // 生HTMLの解釈 → サニタイズ の順。数式とコードの装飾はこの後に付けるので、
  // ここで落とされることはない。
  rehypeRaw,
  [rehypeSanitize, sanitizeSchema],
  [
    rehypeKatex,
    {
      output: "htmlAndMathml",
      // 解釈できない式はエラーにせず元のTeXをそのまま出す。ストリーミング中は
      // 式が途中までしか届かないので、赤字にせず本文と同じ色で見せる。
      throwOnError: false,
      errorColor: "currentColor",
      strict: false,
    },
  ],
  // 言語指定のあるコードブロックだけ色を付ける（自動判定は誤りが目立つので使わない）
  [rehypeHighlight, { detect: false, ignoreMissing: true }],
];

/** 流入中の末尾用。語ごとの <span> を足して1語ずつ浮かび上がらせる。 */
const rehypeAnimatedPlugins: PluggableList = [
  ...rehypePlugins,
  rehypeStreamTokens,
];

/** 本文を囲む枠のクラス。塊に分けて描くときも同じ枠に入れる。 */
export function proseClassName(className?: string): string {
  return `prose prose-neutral dark:prose-invert max-w-none break-words prose-code:before:content-none prose-code:after:content-none${
    className ? ` ${className}` : ""
  }`;
}

type BodyProps = {
  children: string;
  /** 新しく現れた語をふわりと出す（生成中の末尾だけに使う）。 */
  animate?: boolean;
  /** 本文の中の画像をタップしたとき（会話の中でだけ渡す）。 */
  onImageClick?: (src: string) => void;
  /** 本文がまだ伸びている最中か（図を描くのを待たせるのに使う）。 */
  streaming?: boolean;
  /** ```mermaid を図にしてよいか。false ならソースのまま見せる。 */
  diagrams?: boolean;
  /** すでに prepareMarkdown を通してあるか（塊に分けて渡すときに使う）。 */
  prepared?: boolean;
};

/**
 * 枠を持たない本文。ReactMarkdown は要素をそのまま並べる（囲みを作らない）
 * ので、これを同じ枠の中に複数置いても、1つとして描いたときと同じ並びに
 * なる——余白も `:first-child` / `:last-child` も崩れない。
 *
 * memo必須: パースが重く、ストリーミング中は親が毎チャンク再描画される。
 * 本文が変わらない塊の再パースをここで止める。
 */
export const MarkdownBody = memo(function MarkdownBody({
  children,
  animate = false,
  streaming = false,
  diagrams = true,
  prepared = false,
  onImageClick,
}: BodyProps) {
  const source = useMemo(
    () => (prepared ? children : prepareMarkdown(children)),
    [children, prepared],
  );
  const config = useMemo<BlockConfig>(
    () => ({ streaming, diagrams, onImageClick }),
    [streaming, diagrams, onImageClick],
  );
  return (
    <BlockContext.Provider value={config}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={animate ? rehypeAnimatedPlugins : rehypePlugins}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </BlockContext.Provider>
  );
});

/** 本文ひとかたまり。 */
export const Markdown = memo(function Markdown({
  className,
  ...body
}: BodyProps & { className?: string }) {
  return (
    <div className={proseClassName(className)}>
      <MarkdownBody {...body} />
    </div>
  );
});
