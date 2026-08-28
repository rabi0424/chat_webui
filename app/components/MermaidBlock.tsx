import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useIsDark } from "../lib/appearance";
import { useCopied } from "../lib/use-copied";
import { loadMermaid } from "../lib/mermaid.client";
import { IconCheck, IconCopy, IconDownload } from "./icons";

/**
 * ```mermaid のコードブロックを図として描く。
 *
 * 図にするのはブラウザに出てからで、サーバー側では常に fallback
 * （ふつうのコードブロック）のまま返す。mermaid はDOMが要るうえ重いので、
 * 読み込みは lib/mermaid.client.ts に切り出してある。
 */

/**
 * 図にする前に本文が落ち着くのを待つ時間（ms）。
 *
 * 生成中は数十msおきに本文が伸びるので、届くたびに描くと重いうえ、
 * 途中までの図が何度も描き変わってちらつく。「増えなくなってから」
 * 描くことで、閉じたブロックだけが図になる。
 */
const SETTLE_MS = 400;

/**
 * 描画のたびに違う要素IDを配る。
 *
 * mermaid は渡されたIDの要素を文書から探して片付けてから描き直すので、
 * 同じIDを使い回すと「いま画面に出ているSVG」を消してしまう
 * （テーマ切替や生成完了で描き直したとき、図が消えて枠だけ残る）。
 * IDはSVG内のstyleの絞り込みにも使われるため、毎回別にしておけば
 * 複数の図が同時にあっても互いのスタイルを侵さない。
 */
let renderSeq = 0;

function nextRenderId(base: string): string {
  return `mermaid-${base.replace(/[^a-zA-Z0-9]/g, "")}-${++renderSeq}`;
}

function ToolbarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
    >
      {children}
    </button>
  );
}

export function MermaidBlock({
  code,
  streaming,
  fallback,
}: {
  /** ブロックの中身（mermaid のソース）。 */
  code: string;
  /** 本文がまだ流れてきている最中か。 */
  streaming: boolean;
  /** 図にできないときに見せるもの（ふつうのコードブロック）。 */
  fallback: ReactNode;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  // 印の出し入れは共通のフックに任せる（自前の setTimeout は、外れたあとに
  // 鳴るぶんと、続けて押したときに前の時計が先に鳴るぶんが残る）
  const [copied, flashCopied] = useCopied();
  const dark = useIsDark();
  const baseId = useId();
  /**
   * 保存のあとに解放を待っている blob URL。
   *
   * すぐ捨てるとダウンロードが始まる前に無効になる端末があるので少し
   * 待つのだが、その間に画面を離れると時計だけが残る。外れるときは
   * 待たずに解放する（監査 C-10）。
   */
  const revokes = useRef(new Map<ReturnType<typeof setTimeout>, string>());
  useEffect(
    () => () => {
      for (const [timer, url] of revokes.current) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      revokes.current.clear();
    },
    [],
  );

  useEffect(() => {
    let alive = true;

    const draw = async () => {
      try {
        const mermaid = await loadMermaid();
        if (!alive) return;
        mermaid.initialize({
          startOnLoad: false,
          // ラベルに混ざる生HTMLを通さない（本文はモデルの出力なので）
          securityLevel: "strict",
          theme: dark ? "dark" : "default",
          fontFamily: "var(--font-sans)",
          // 矢印のラベルの下敷きは、既定だと枠の色から浮くので枠に合わせる
          themeVariables: { edgeLabelBackground: dark ? "#171717" : "#fafafa" },
        });
        // 先に構文だけ確かめる。描画まで進んでから失敗すると、mermaid が
        // 本文に置いたエラー図の後始末が要るため。
        await mermaid.parse(code);
        const rendered = await mermaid.render(nextRenderId(baseId), code);
        if (!alive) return;
        setSvg(rendered.svg);
        setError(null);
      } catch (e) {
        if (!alive) return;
        // 生成中はまだ書きかけなのが普通なので、失敗しても黙って待つ。
        // 書き終わっているなら本当の構文エラーとして知らせる。
        if (streaming) return;
        setSvg(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    };

    // 生成中は本文が落ち着くまで待つ。書き終わっていれば待たずに描く。
    if (!streaming) {
      void draw();
      return () => {
        alive = false;
      };
    }
    const timer = setTimeout(() => void draw(), SETTLE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [code, dark, streaming, baseId]);

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(code);
      flashCopied();
    } catch {
      // クリップボード不許可時は何もしない
    }
  };

  const download = () => {
    if (!svg) return;
    // 描いたSVGの文字列をそのまま保存する。DOMから読み直さないのは、
    // ソース表示に切り替えている間は図が画面に無いため。
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "diagram.svg";
    a.click();
    // すぐ捨てるとダウンロードが始まる前に無効になる端末があるので少し待つ
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      revokes.current.delete(timer);
    }, 10_000);
    revokes.current.set(timer, url);
  };

  // まだ図にできていない間は、ふつうのコードブロックとして見せる。
  // 構文エラーのときだけ、なぜ図にならないのかを添える。
  if (!svg) {
    return (
      <>
        {fallback}
        {error && (
          <p className="not-prose -mt-2 mb-4 text-xs text-neutral-400 dark:text-neutral-500">
            図として解釈できませんでした（{error.split("\n")[0]}）
          </p>
        )}
      </>
    );
  }

  return (
    <div className="not-prose my-4 overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3 py-1 dark:border-neutral-800">
        <button
          type="button"
          onClick={() => setShowSource((v) => !v)}
          className="rounded px-1 text-xs text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          Mermaid{showSource ? "（ソース）" : ""}
        </button>
        <div className="flex items-center gap-0.5">
          <ToolbarButton label="ソースをコピー" onClick={copySource}>
            {copied ? (
              <IconCheck className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <IconCopy className="h-3.5 w-3.5" />
            )}
          </ToolbarButton>
          <ToolbarButton label="SVGとして保存" onClick={download}>
            <IconDownload className="h-3.5 w-3.5" />
          </ToolbarButton>
        </div>
      </div>
      {showSource ? (
        <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[13px] leading-relaxed text-neutral-800 dark:text-neutral-200">
          <code>{code}</code>
        </pre>
      ) : (
        <div
          className="mermaid-figure overflow-x-auto px-3 py-3"
          /*
           * mermaid の出力をそのまま入れる。securityLevel: "strict" のとき
           * mermaid は内部の DOMPurify でラベルを消毒してから返すので、
           * 本文に混ざったスクリプトはここまで届かない。
           */
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </div>
  );
}
