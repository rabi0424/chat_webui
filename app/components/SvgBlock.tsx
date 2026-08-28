import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useIsDark } from "../lib/appearance";
import { useCopied } from "../lib/use-copied";
import { IconCheck, IconCopy, IconDownload, IconSwatch } from "./icons";

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
 *
 * 暗いときは配色を作り直して出す（svg-dark）。自動の置き換えなので必ず
 * 当たるとは限らず、ツールバーから元の配色にも戻せるようにしてある。
 */

/** 図にする前に本文が落ち着くのを待つ時間（ms）。Mermaid と同じ考え方。 */
const SETTLE_MS = 400;

/** shadow の中だけに効く土台。枠に収め、中央に置く。 */
const SHADOW_STYLE =
  ":host{display:block}svg{max-width:100%;height:auto;display:block;margin:0 auto}";

function ToolbarButton({
  label,
  onClick,
  active = false,
  children,
}: {
  label: string;
  onClick: () => void;
  /** 押しっぱなしの状態（切替ボタン用）。 */
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      className={`rounded p-1 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-200 ${
        active
          ? "text-neutral-700 dark:text-neutral-200"
          : "text-neutral-400 dark:text-neutral-500"
      }`}
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
  const [variants, setVariants] = useState<{
    light: string;
    dark: string;
  } | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [asAuthored, setAsAuthored] = useState(false);
  // 印の出し入れは共通のフックに任せる（自前の setTimeout は、外れたあとに
  // 鳴るぶんと、続けて押したときに前の時計が先に鳴るぶんが残る）
  const [copied, flashCopied] = useCopied();
  const isDark = useIsDark();
  const host = useRef<HTMLDivElement | null>(null);
  const shadow = useRef<ShadowRoot | null>(null);
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

  /**
   * 図の入れ物が張り替わったら、shadow も作り直す。
   *
   * ソース表示との切り替えでは <div> と <pre> を行き来するので、React は
   * この要素を使い回さず作り直す。にもかかわらず shadow を一度しか作らな
   * いと、切り離された古い ShadowRoot に書き続けることになり、図に戻した
   * ときに何も出なくなる。要素の差し替わりを ref のコールバックで捉える。
   */
  const attachHost = useCallback((el: HTMLDivElement | null) => {
    if (el === host.current) return;
    host.current = el;
    // 同じ要素に二度 attachShadow はできないので、既にあればそれを使う
    shadow.current = el
      ? (el.shadowRoot ?? el.attachShadow({ mode: "open" }))
      : null;
  }, []);

  // 暗いときだけ配色を置き換える。切替を待たせないよう両方を先に作っておく
  const darkened = isDark && !asAuthored;
  const svg = variants && (darkened ? variants.dark : variants.light);

  useEffect(() => {
    let alive = true;

    const draw = async () => {
      const [{ looksLikeSvg, sanitizeSvg }, { recolorForDark }] =
        await Promise.all([
          import("../lib/svg-sanitize.client"),
          import("../lib/svg-dark.client"),
        ]);
      if (!alive) return;
      // 書きかけのうちは閉じていないので、まだ図にしない
      if (!looksLikeSvg(code) || !/<\/svg\s*>\s*$/i.test(code.trimEnd())) {
        setVariants(null);
        return;
      }
      const clean = sanitizeSvg(code);
      if (alive) {
        setVariants(clean ? { light: clean, dark: recolorForDark(clean) } : null);
      }
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
    const root = shadow.current;
    if (!svg || showSource || !root) return;
    root.innerHTML = `<style>${SHADOW_STYLE}</style>${svg}`;
  }, [svg, showSource]);

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
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "figure.svg";
    a.click();
    // すぐ捨てるとダウンロードが始まる前に無効になる端末があるので少し待つ
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      revokes.current.delete(timer);
    }, 10_000);
    revokes.current.set(timer, url);
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
          {/* 自動の置き換えが外れることもあるので、元の配色にも戻せるようにする */}
          {isDark && (
            <ToolbarButton
              label={asAuthored ? "暗い画面に合わせる" : "元の配色で見る"}
              onClick={() => setAsAuthored((v) => !v)}
              active={asAuthored}
            >
              <IconSwatch className="h-3.5 w-3.5" />
            </ToolbarButton>
          )}
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
         * 下地は出している配色に合わせる。置き換え後は暗い面（配色の変換も
         * この色を基準に contrast を見ている）、元の配色のままなら明るい面
         * ——モデルの SVG は白い紙を前提に描かれていることが多いため。
         */
        <div
          className={`max-h-[70vh] overflow-auto p-3 ${
            darkened ? "bg-neutral-900" : "bg-white dark:bg-neutral-200"
          }`}
        >
          <div
            ref={attachHost}
            data-svg-figure
            data-palette={darkened ? "dark" : "authored"}
          />
        </div>
      )}
    </div>
  );
}
