/**
 * メッセージ1件を組み立てる表示部品。
 *
 * 会話全体の状態には触らず、渡されたものを描くだけのものをここに集める。
 * Chat 本体は送信・編集・分岐・削除といった「操作」に集中させたいので、
 * 見た目の都合だけで育つ部分を外に出しておく。
 */
import { useEffect, useRef, useState } from "react";
import { useCopied } from "../../lib/use-copied";
import type { UiAttachment, UiCitation, UiMessage } from "../../lib/types";
import { GLASS_PANEL } from "../../lib/ui";
import { IconCheck, IconCopy, IconInfo } from "../icons";
import { Markdown } from "../Markdown";


/** 円建てコストの表示。額の大きさに応じて桁数を変える。 */
export function formatJpy(jpy: number): string {
  if (jpy >= 100) return `¥${Math.round(jpy).toLocaleString()}`;
  if (jpy >= 1) return `¥${jpy.toFixed(2)}`;
  return `¥${jpy.toFixed(4)}`;
}

/** メッセージに添付された画像の表示（タップで原寸表示）。 */
export function MessageImages({
  attachments,
  onOpen,
  onLoad,
}: {
  attachments: UiAttachment[];
  onOpen: (id: string) => void;
  /**
   * 画像が1枚表示し終わったとき。
   *
   * 大きさが分かるのは読み込みが終わってからで、それまでこの枠は
   * ほぼ高さを持たない。あとから高さが増えるぶん下の内容が押し下がり、
   * 最下部に居たはずが少し上に取り残される（読んでいる途中なら
   * 読み位置が跳ぶ）。追従していたなら、ここで貼り直す。
   */
  onLoad?: () => void;
}) {
  return (
    <div className="mb-1.5 flex flex-wrap items-end justify-end gap-1.5">
      {attachments.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onOpen(a.id)}
          title={a.name ?? "画像"}
          /*
            読み込みが終わるまでの下敷き。高さゼロから一気に伸びるのを
            防ぐぶん、跳ぶ量が小さくなる（縦横は分からないので、
            正方形に近い最小の箱だけ置く）
          */
          className="grid min-h-24 min-w-24 place-items-center overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50 transition hover:opacity-90 active:scale-[0.98] dark:border-neutral-700 dark:bg-neutral-900"
        >
          <img
            src={`/api/files/${a.id}`}
            alt={a.name ?? "添付画像"}
            loading="lazy"
            onLoad={onLoad}
            className="max-h-56 max-w-[min(16rem,60vw)] object-contain"
          />
        </button>
      ))}
    </div>
  );
}

/**
 * 生成中の見出し（本文 + 経過秒）。
 *
 * 経過秒はここで刻む。サーバーに秒を書かせると、毎秒表示するのに
 * 毎秒のD1書き込みと取得が要るうえ、ポーリングの間隔しだいで数字が
 * 飛ぶ。開始時刻から引けば、通信を増やさずにちょうど毎秒進む。
 *
 * 「成功するまで生成」の進捗（成功数・試行数）も、1枚だけの画像生成も
 * これで出す。画像生成は本文が流れてこないぶん、待っているあいだ
 * 手がかりが秒数しかない。
 */
export function GenerationProgress({
  text,
  startedAt,
}: {
  text: string;
  /** 生成開始時刻。未保存の場合は表示した時刻から数える。 */
  startedAt: number | undefined;
}) {
  /**
   * null = まだ数え始めていない（サーバー描画と最初の描画）。
   *
   * 秒をいきなり描くと、サーバーが書いた数字とブラウザが数えた数字が
   * 食い違ってハイドレーションが失敗する。失敗すると React は文書ごと
   * 描き直し、<html> に載せたテーマ・アクセント・文字サイズまで消える
   * （lib/appearance.ts 参照）。最初は秒を出さず、マウント後に足す。
   */
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    const start = startedAt ?? Date.now();
    const tick = () =>
      setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    // 秒の変わり目とずれても取りこぼさないよう、短めに見て値が
    // 変わったときだけ描き直す（同じ値のsetStateはReactが捨てる）
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [startedAt]);

  return (
    <p className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
      <span
        aria-hidden
        className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-neutral-300 border-t-accent dark:border-neutral-700 dark:border-t-accent"
      />
      <span>
        {text}
        {elapsed != null && `（${elapsed}秒）`}
      </span>
    </p>
  );
}

/** thinking対応モデルの思考内容の折りたたみ表示。 */
export function ReasoningBlock({
  reasoning,
  streaming,
}: {
  reasoning: string;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(streaming);
  const show = open || streaming;
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
      >
        <span aria-hidden>💭</span>
        {streaming ? "思考中…" : show ? "思考プロセスを隠す" : "思考プロセスを表示"}
      </button>
      {show && (
        // 思考プロセスにも数式やコードが混ざるので、本文と同じ描き方をする。
        // 図まで描くと本文より目立ってしまうので、ここはソースのまま。
        <div className="mt-1 max-h-64 overflow-y-auto rounded-xl border border-neutral-100 bg-neutral-50 px-3 py-2 text-xs leading-relaxed text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
          <Markdown
            streaming={streaming}
            diagrams={false}
            className="chat-bubble"
          >
            {reasoning}
          </Markdown>
        </div>
      )}
    </div>
  );
}

/** URLの見出しに使うホスト名。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * 参照元の一覧。
 *
 * 本文とは別に返ってきたデータをそのまま並べるだけで、本文には一切
 * 手を入れない（コピーしても、次のターンでモデルへ送り返す履歴にも
 * 出典は混ざらない）。使わなかった応答には何も出ない。
 */
export function CitationList({ citations }: { citations: UiCitation[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
      >
        <span aria-hidden>🔗</span>
        {open ? "参照元を隠す" : `参照元 ${citations.length}件`}
      </button>
      {open && (
        <ol className="mt-1 space-y-1 rounded-xl border border-neutral-100 bg-neutral-50 px-3 py-2 text-xs leading-relaxed dark:border-neutral-800 dark:bg-neutral-900">
          {citations.map((c, n) => (
            <li key={c.url} className="flex gap-2">
              <span className="shrink-0 text-neutral-500 dark:text-neutral-400">
                {n + 1}.
              </span>
              <a
                href={c.url}
                target="_blank"
                rel="noreferrer"
                title={c.url}
                className="min-w-0 text-accent-ink hover:underline"
              >
                <span className="line-clamp-2 break-all">
                  {c.title || hostOf(c.url)}
                </span>
                {c.title && (
                  <span className="block text-neutral-500 dark:text-neutral-400">
                    {hostOf(c.url)}
                  </span>
                )}
              </a>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** ワンタップコピー（1.5秒だけ✓を表示）。 */
export function CopyButton({ text }: { text: string }) {
  const [copied, flashCopied] = useCopied();
  return (
    <button
      type="button"
      aria-label="コピー"
      title="コピー"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          flashCopied();
        } catch {
          // クリップボード不許可時は何もしない
        }
      }}
      className="rounded p-1 text-neutral-300 hover:bg-neutral-100 hover:text-neutral-600 group-hover/msg:text-neutral-400 dark:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-300 dark:group-hover/msg:text-neutral-500"
    >
      {copied ? (
        <IconCheck className="h-3.5 w-3.5 text-green-500" />
      ) : (
        <IconCopy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

/** 応答の詳細情報（トークン・金額・時刻・所要時間・速度）のポップオーバー。 */
export function MessageDetails({
  message,
  usdJpy,
}: {
  message: UiMessage;
  usdJpy: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const u = message.usage;
  const durationMs =
    message.finishedAt && message.createdAt
      ? message.finishedAt - message.createdAt
      : null;
  const tokensPerSec =
    durationMs && durationMs > 0 && u && u.completionTokens != null
      ? (u.completionTokens / (durationMs / 1000)).toFixed(1)
      : null;

  const rows: [string, string][] = [];
  if (message.modelId) rows.push(["モデル", message.modelId]);
  if (u) {
    if (u.promptTokens != null) {
      rows.push(["入力トークン", u.promptTokens.toLocaleString()]);
    }
    if (u.cachedTokens != null && u.cachedTokens > 0) {
      rows.push([
        "うちキャッシュ読取",
        `${u.cachedTokens.toLocaleString()}（割引適用）`,
      ]);
    }
    if (u.completionTokens != null) {
      rows.push(["出力トークン", u.completionTokens.toLocaleString()]);
    }
    if (u.reasoningTokens != null && u.reasoningTokens > 0) {
      rows.push(["うち思考トークン", u.reasoningTokens.toLocaleString()]);
    }
    if (u.points != null) {
      rows.push(["消費ポイント", `${u.points.toLocaleString()} pt`]);
    }
    if (u.cost != null) {
      // 一覧は円建てのみ、詳細では円とドルを併記する
      rows.push([
        "コスト",
        usdJpy != null
          ? `${formatJpy(u.cost * usdJpy)}（$${u.cost.toFixed(6)}）`
          : `$${u.cost.toFixed(6)}`,
      ]);
    }
  }
  if (message.createdAt) {
    rows.push(["時刻", new Date(message.createdAt).toLocaleString("ja-JP")]);
  }
  if (durationMs != null) {
    rows.push(["所要時間", `${(durationMs / 1000).toFixed(1)}秒`]);
  }
  if (tokensPerSec) rows.push(["速度", `${tokensPerSec} tok/秒`]);
  if (rows.length === 0) return null;

  /**
   * パネルはボタン上に fixed 配置し、左端を画面内へクランプする。
   * メッセージ列内の absolute 配置だと、スマホでボタンが右寄りのとき
   * パネルが画面外へはみ出し、ページ全体が横スクロール可能になっていた。
   */
  const PANEL_WIDTH = 256; // w-64
  const openPanel = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const margin = 8;
      setPos({
        left: Math.max(
          margin,
          Math.min(rect.left, window.innerWidth - PANEL_WIDTH - margin),
        ),
        bottom: window.innerHeight - rect.top + 6,
      });
    }
    setOpen(true);
  };

  return (
    <span className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openPanel())}
        aria-label="詳細"
        title="この応答の詳細"
        className="rounded p-1 text-neutral-300 hover:bg-neutral-100 hover:text-neutral-600 group-hover/msg:text-neutral-400 dark:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-300 dark:group-hover/msg:text-neutral-500"
      >
        <IconInfo className="h-3.5 w-3.5" />
      </button>
      {open && pos && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <span
            style={{ left: pos.left, bottom: pos.bottom }}
            className={`fixed z-40 block w-64 origin-bottom rounded-xl p-3 text-xs animate-pop ${GLASS_PANEL}`}
          >
            {rows.map(([k, v]) => (
              <span key={k} className="flex justify-between gap-3 py-0.5">
                <span className="shrink-0 text-neutral-400 dark:text-neutral-500">{k}</span>
                <span className="break-all text-right text-neutral-700 dark:text-neutral-200">{v}</span>
              </span>
            ))}
          </span>
        </>
      )}
    </span>
  );
}

/**
 * コンテキストクリアの区切り線。
 *
 * ここまでの発言は以後モデルへ送らない、という目印。履歴そのものには
 * 手を触れていないので、消せば元どおり全部が文脈に戻る。
 * 消し方はメッセージと同じで、削除選択モードで選んで削除ボタンを押す。
 */
export function ContextBoundaryLine({
  selecting,
  selected,
  onToggle,
}: {
  /** 削除選択モードか。 */
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const line = <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />;
  const body = (
    <>
      {line}
      <span className="whitespace-nowrap rounded-full border border-dashed border-neutral-300 px-2.5 py-1 dark:border-neutral-700">
        コンテキストクリア
      </span>
      {line}
    </>
  );
  if (!selecting) {
    return (
      <div className="flex items-center gap-2 text-xs text-neutral-400 dark:text-neutral-500">
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      title="選択して削除するとコンテキストクリアが外れ、すべてが文脈に戻ります"
      className={`-mx-2 flex w-[calc(100%+1rem)] touch-manipulation items-center gap-2 rounded-xl px-2 py-1 text-xs text-neutral-400 dark:text-neutral-500 ${
        selected
          ? "bg-accent/10 ring-1 ring-accent/50"
          : "hover:bg-neutral-50 dark:hover:bg-neutral-900"
      }`}
    >
      {body}
    </button>
  );
}

/**
 * 分岐点に表示する ‹ 2/3 › 型の控えめなページャ。
 *
 * 見た目は控えめでも、当たり判定は指で押せる大きさを確保する
 * （文字ぶんの幅しかないと、狙ったつもりで隣を叩くか外れる）。
 * touch-manipulation はダブルタップ拡大の待ち時間を外し、
 * タップしてから切り替わるまでの間を詰めるため。
 */
export function BranchPager({
  message,
  disabled,
  onSwitch,
}: {
  message: UiMessage;
  disabled: boolean;
  onSwitch: (targetId: string) => void;
}) {
  const { siblingIds, siblingIndex } = message;
  if (!siblingIds || siblingIds.length < 2 || siblingIndex == null) return null;
  const arrowClass =
    "grid h-8 w-8 touch-manipulation place-items-center rounded-md text-base leading-none " +
    "hover:bg-neutral-100 hover:text-neutral-600 active:scale-90 disabled:opacity-30 " +
    "dark:hover:bg-neutral-800 dark:hover:text-neutral-300";
  return (
    // -my-1: 当たり判定を広げても、操作の行そのものは高くしない
    <span className="-my-1 inline-flex items-center text-xs text-neutral-400 dark:text-neutral-500">
      <button
        type="button"
        disabled={disabled || siblingIndex === 0}
        onClick={() => onSwitch(siblingIds[siblingIndex - 1])}
        className={arrowClass}
        aria-label="前のブランチ"
        title="前のブランチ"
      >
        ‹
      </button>
      <span className="tabular-nums" title="この位置の分岐">
        {siblingIndex + 1}/{siblingIds.length}
      </span>
      <button
        type="button"
        disabled={disabled || siblingIndex === siblingIds.length - 1}
        onClick={() => onSwitch(siblingIds[siblingIndex + 1])}
        className={arrowClass}
        aria-label="次のブランチ"
        title="次のブランチ"
      >
        ›
      </button>
    </span>
  );
}
