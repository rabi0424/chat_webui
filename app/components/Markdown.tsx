import { useMemo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import type { PluggableList } from "unified";
import type { Element, ElementContent } from "hast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { IconCheck, IconCopy } from "./icons";
import { prepareMarkdown } from "../lib/markdown";

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

function CopyCodeButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="コードをコピー"
      title="コードをコピー"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
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

  return (
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
}

const components: Components = {
  pre: CodeBlock,
  // 表は横に長くなりがちなので、はみ出す分だけ横スクロールさせる
  table: ({ children }) => (
    <div className="-mx-1 overflow-x-auto px-1">
      <table>{children}</table>
    </div>
  ),
  // 外部リンクは別タブで開く（脚注などのページ内リンクはそのまま）
  a: ({ children, href }) => {
    const external = !!href && !href.startsWith("#");
    return (
      <a
        href={href}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
      >
        {children}
      </a>
    );
  },
  img: ({ src, alt }) => (
    <img
      src={typeof src === "string" ? src : undefined}
      alt={alt ?? ""}
      loading="lazy"
      className="rounded-lg"
    />
  ),
};

const remarkPlugins: PluggableList = [
  remarkGfm,
  // `$100 と $200` のような通貨表記を数式にしないため、1個の `$` は数式扱いしない。
  // 数式にすべき `$x$` は前処理（normalizeMath）で `$$x$$` に寄せてある。
  [remarkMath, { singleDollarTextMath: false }],
  // 1行の改行をそのまま改行として見せる（チャットの表示としてはこちらが自然）
  remarkBreaks,
];

/**
 * モデルが混ぜてくる生HTML（`<br>` `<sub>` `<details>` `<ruby>` など）を通すための
 * 許可リスト。既定（GitHubのサニタイズ相当）に class だけ足す。
 * remark-math が付ける `math-inline` / `math-display` クラスが消えると
 * 後段の rehype-katex が数式を見つけられなくなるため。
 */
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className"],
  },
};

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

export function Markdown({ children }: { children: string }) {
  const source = useMemo(() => prepareMarkdown(children), [children]);
  return (
    <div className="prose prose-sm prose-neutral sm:prose-base dark:prose-invert max-w-none break-words prose-code:before:content-none prose-code:after:content-none">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
