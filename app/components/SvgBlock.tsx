import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconCheck, IconCopy, IconDownload } from "./icons";

/**
 * ` ```svg ` / ` ```xml ` のコードブロックが SVG なら、図として描く。
 *
 * レーダーチャートのように Mermaid では描けない図を、モデルは SVG の
 * 生ソースで返してくる。そのままだと長いタグの羅列が本文に流れるだけ
 * なので、消毒したうえで図にする。
 *
 * 置き場所は shadow DOM。SVG の中の `<style>` は、ふつうに本文へ差し込むと
 * SVG の外——ページ全体にも効いてしまう（`<style>*{display:none}` だけで
 * 画面を白紙にできる）。shadow の中なら外へ出ない。消毒（svg-sanitize）と
 * 合わせて、実行・外部通信・描画への干渉の3つを塞ぐ。
 */

/** 図にする前に本文が落ち着くのを待つ時間（ms）。Mermaid と同じ考え方。 */
const SETTLE_MS = 400;

/** shadow の中だけに効く土台。枠に収め、中央に置く。 */
const SHADOW_STYLE =
  ":host{display:block}svg{max-width:100%;height:auto;display:block;margin:0 auto}";

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

export function SvgBlock({
  code,
  streaming,
  fallback,
}: {
  /** ブロックの中身。SVG でなければ図にしない。 */
  code: string;
  /** 本文がまだ流れてきている最中か。 */
  streaming: boolean;
  /** 図にできないときに見せるもの（ふつうのコードブロック）。 */
  fallback: ReactNode;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const shadow = useRef<ShadowRoot | null>(null);

  useEffect(() => {
    let alive = true;

    const draw = async () => {
      const { looksLikeSvg, sanitizeSvg } = await import(
        "../lib/svg-sanitize.client"
      );
      if (!alive) return;
      // 書きかけのうちは閉じていないので、まだ図にしない
      if (!looksLikeSvg(code) || !/<\/svg\s*>\s*$/i.test(code.trimEnd())) {
        setSvg(null);
        return;
      }
      const clean = sanitizeSvg(code);
      if (alive) setSvg(clean);
    };

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
  }, [code, streaming]);

  // 消毒済みの中身を shadow へ入れる。React には触らせない（中は素のDOM）。
  useEffect(() => {
    if (!svg || showSource || !host.current) return;
    shadow.current ??= host.current.attachShadow({ mode: "open" });
    shadow.current.innerHTML = `<style>${SHADOW_STYLE}</style>${svg}`;
  }, [svg, showSource]);

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // クリップボード不許可時は何もしない
    }
  };

  const download = () => {
    if (!svg) return;
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "figure.svg";
    a.click();
    // すぐ捨てるとダウンロードが始まる前に無効になる端末があるので少し待つ
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  if (!svg) return <>{fallback}</>;

  return (
    <div className="not-prose my-4 overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3 py-1 dark:border-neutral-800">
        <button
          type="button"
          onClick={() => setShowSource((v) => !v)}
          className="rounded px-1 text-xs text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          SVG{showSource ? "（ソース）" : ""}
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
        <pre className="max-h-[70vh] overflow-auto px-3 py-2.5 font-mono text-[13px] leading-relaxed text-neutral-800 dark:text-neutral-200">
          <code>{code}</code>
        </pre>
      ) : (
        /*
         * 明るい下地に置く。モデルの SVG は白い紙を前提に、黒い線と文字で
         * 描かれていることが多く、暗い地の上では読めなくなるため。
         */
        <div className="max-h-[70vh] overflow-auto bg-white p-3 dark:bg-neutral-200">
          <div ref={host} data-svg-figure />
        </div>
      )}
    </div>
  );
}
