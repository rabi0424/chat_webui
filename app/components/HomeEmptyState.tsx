import { useEffect, useState } from "react";
import { Link } from "react-router";
import { IconBot, IconChevronRight, IconCog, IconPlus } from "./icons";
import { useHomeStyle } from "../lib/home-style";

/**
 * ホーム（新規チャット）の空状態。ボットのランチャーを兼ねる。
 *
 * 見た目は2様式あり、設定画面の「外観」で切り替える（lib/home-style.ts）。
 * - glass:   淡い環境光の上にすりガラスのカードを並べる
 * - minimal: 大きな挨拶タイポグラフィ + 罫線区切りのリスト
 *
 * ボットが1つも無いときも、この画面が出る。以前は素の「モデルを選んで
 * メッセージを送信」に落ちていて、ボットを作る入口が無かった。
 */

/** 表示に必要な分だけの構造的な型（DB行やモデル情報の部分集合）。 */
export interface HomeBot {
  id: string;
  name: string;
  icon: string;
  model_id: string;
}

export function HomeEmptyState({
  bots,
  modelNames,
  onSelect,
}: {
  bots: HomeBot[];
  /** model_id → 表示名。見つからないボットはIDをそのまま出す。 */
  modelNames: Map<string, string>;
  onSelect: (bot: HomeBot) => void;
}) {
  /*
   * 様式は保存値を購読する（設定画面で変えるとその場で切り替わる）。
   * サーバーでは既定（glass）で描かれ、マウント後に保存値へ揃う。
   */
  const style = useHomeStyle();
  // 挨拶はローカル時刻依存なので、SSRとずれないようマウント後に確定させる
  const [hour, setHour] = useState<number | null>(null);

  useEffect(() => {
    setHour(new Date().getHours());
  }, []);

  const greeting =
    hour == null || (hour >= 11 && hour < 18)
      ? "こんにちは"
      : hour >= 5 && hour < 11
        ? "おはようございます"
        : "こんばんは";

  const subtitleOf = (b: HomeBot) => modelNames.get(b.model_id) ?? b.model_id;

  return (
    <div className="w-full">
      {style === "glass" && (
        <div
          aria-hidden
          className="home-ambient pointer-events-none absolute inset-0"
        />
      )}
      <div className="relative mx-auto max-w-md">
        {style === "glass" ? (
          <>
            <div className="mb-7 text-center">
              {/*
                挨拶はアクセント色から本文の色へ流すグラデーション。
                以前は紫〜青緑の固定色で、アクセントを変えても動かなかった。
              */}
              <h1 className="font-display bg-gradient-to-r from-accent-ink via-neutral-800 to-accent-ink bg-clip-text text-[26px] font-bold tracking-tight text-transparent dark:from-accent dark:via-white dark:to-accent">
                {greeting}
              </h1>
              <p className="mt-2 text-[13.5px] text-neutral-500 dark:text-neutral-400">
                {bots.length > 0
                  ? "ボットを選ぶか、そのままメッセージを送信"
                  : "そのままメッセージを送るか、ボットを作って始める"}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {bots.map((b, i) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => onSelect(b)}
                  style={{ animationDelay: `${i * 45}ms` }}
                  className="animate-pop rounded-[22px] border border-black/[0.06] bg-white/55 px-3 pb-4 pt-[18px] text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_12px_32px_-16px_rgba(0,0,0,0.25)] backdrop-blur-xl transition hover:bg-white/75 active:scale-[0.97] dark:border-white/10 dark:bg-white/[0.055] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_12px_32px_-16px_rgba(0,0,0,0.7)] dark:hover:bg-white/[0.09]"
                >
                  <span className="relative mx-auto flex h-[54px] w-[54px] items-center justify-center">
                    <span
                      aria-hidden
                      className="absolute inset-1 rounded-full blur-[14px]"
                      style={{
                        background: `hsl(${hueAt(i)} 70% 60% / 0.5)`,
                      }}
                    />
                    <span className="relative text-[31px]" aria-hidden>
                      {b.icon}
                    </span>
                  </span>
                  <span className="mt-2.5 block truncate text-sm font-semibold tracking-tight">
                    {b.name}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-neutral-500 dark:text-white/60">
                    {subtitleOf(b)}
                  </span>
                </button>
              ))}
              <Link
                to="/bots/new"
                style={{ animationDelay: `${bots.length * 45}ms` }}
                className="animate-pop flex min-h-[120px] flex-col items-center justify-center gap-1.5 rounded-[22px] border border-dashed border-black/[0.14] bg-white/25 text-[13px] text-neutral-500 backdrop-blur-xl transition hover:bg-white/50 active:scale-[0.97] dark:border-white/[0.16] dark:bg-white/[0.025] dark:text-neutral-400 dark:hover:bg-white/[0.06]"
              >
                {bots.length === 0 ? (
                  <IconBot className="h-6 w-6" />
                ) : (
                  <IconPlus className="h-5 w-5" />
                )}
                {bots.length === 0 ? "最初のボットを作る" : "新しいボット"}
              </Link>
            </div>
            {bots.length > 0 && (
              <div className="mt-6 flex justify-center">
                <Link
                  to="/bots"
                  className="flex items-center gap-1.5 rounded-full border border-black/[0.06] bg-white/40 px-3.5 py-1.5 text-xs text-neutral-600 backdrop-blur-md transition hover:bg-white/70 dark:border-white/[0.09] dark:bg-white/[0.03] dark:text-neutral-300 dark:hover:bg-white/[0.07]"
                >
                  <IconCog className="h-3.5 w-3.5" />
                  ボットを管理
                </Link>
              </div>
            )}
          </>
        ) : (
          <>
            <h1 className="font-display mb-8 px-1 text-[28px] font-bold leading-[1.3] tracking-tight">
              <span className="text-neutral-500 dark:text-neutral-400">
                {greeting}。
              </span>
              <br />
              今日は何を話しますか？
            </h1>
            <div className="border-t border-neutral-900/[0.08] dark:border-white/[0.08]">
              {bots.map((b, i) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => onSelect(b)}
                  style={{ animationDelay: `${i * 45}ms` }}
                  className="animate-pop flex w-full items-center gap-3.5 border-b border-neutral-900/[0.08] px-1 py-[15px] text-left transition hover:bg-neutral-50 active:bg-neutral-100 dark:border-white/[0.08] dark:hover:bg-white/[0.03] dark:active:bg-white/[0.06]"
                >
                  <span
                    aria-hidden
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] bg-neutral-100 text-[23px] shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:bg-[#1c1c1e] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]"
                  >
                    {b.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold tracking-tight">
                      {b.name}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-neutral-500 dark:text-neutral-400">
                      {subtitleOf(b)}
                    </span>
                  </span>
                  <IconChevronRight className="h-4 w-4 shrink-0 text-neutral-400 dark:text-neutral-500" />
                </button>
              ))}
              <div className="flex items-center justify-between border-b border-neutral-900/[0.08] px-1 py-3 dark:border-white/[0.08]">
                <Link
                  to="/bots/new"
                  className="flex items-center gap-3.5 py-1 text-[14px] font-medium text-neutral-500 transition hover:text-neutral-700 dark:text-neutral-300 dark:hover:text-white"
                >
                  <span
                    aria-hidden
                    className="flex h-8 w-8 items-center justify-center rounded-[10px] border border-dashed border-neutral-900/[0.15] dark:border-white/[0.15]"
                  >
                    <IconPlus className="h-4 w-4" />
                  </span>
                  {bots.length === 0 ? "最初のボットを作る" : "新しいボットを作成"}
                </Link>
                {bots.length > 0 && (
                  <Link
                    to="/bots"
                    className="py-1 text-xs text-neutral-500 underline-offset-2 transition hover:underline dark:text-neutral-400"
                  >
                    管理
                  </Link>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 並び順から色相を得る（アイコン背後の光の色に使う）。
 * 黄金角で回すと、隣り合うボットの色が必ず離れる。
 */
function hueAt(index: number): number {
  return (260 + index * 137.5) % 360;
}
