/**
 * 宛先ボットの候補一覧（入力欄の `@` に対する変換予測）。
 *
 * 入力欄の**上**へ開く。入力欄は画面の下端に居るので、下に開くと
 * 画面の外へ出る（モデル選択と同じ事情）。
 *
 * ポータルで body 直下に描くのもモデル選択と同じ理由。入力欄は
 * ガラス面（backdrop-blur）で、その子孫に置いた backdrop-filter は
 * ブラウザ側で効かなくなる。
 */
import { useLayoutEffect, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { BotRow } from "../../lib/db.server";
import { GLASS_PANEL } from "../../lib/ui";
import { providerColor, shortModelName } from "../ModelPicker";
import type { ModelInfo } from "../../lib/openrouter.server";

/** 一覧の高さの上限（画面の比率）。 */
const PANEL_MAX_RATIO = 0.5;

export function MentionSuggest({
  anchorRef,
  panelRef,
  bots,
  models,
  activeIndex,
  onPick,
}: {
  /** 位置の基準（入力欄の枠）。この要素の上へ開く。 */
  anchorRef: RefObject<HTMLElement | null>;
  /** 外側を押したかの判定にも使う（Composer が持つ）。 */
  panelRef: RefObject<HTMLDivElement | null>;
  bots: BotRow[];
  models: ModelInfo[];
  /** ↑↓ で選んでいる位置。-1 はどれも選んでいない。 */
  activeIndex: number;
  onPick: (bot: BotRow) => void;
}) {
  /**
   * 位置は描画のたびに測り直し、DOM へ直接書く。
   *
   * 入力欄は本文の行数で伸び縮みするので、開いた瞬間に一度測るだけだと、
   * 改行したときに一覧が入力欄へかぶさる。測った値を state に置くと
   * 「測る→描く→また測る」の連鎖になるため、状態は持たない。
   * useLayoutEffect なので、ずれた位置が一度でも画面に出ることはない。
   */
  useLayoutEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    const panel = panelRef.current;
    if (!rect || !panel) return;
    const margin = 8;
    const above = rect.top - margin;
    panel.style.left = `${rect.left}px`;
    panel.style.width = `${rect.width}px`;
    panel.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    panel.style.maxHeight = `${Math.max(
      120,
      Math.min(window.innerHeight * PANEL_MAX_RATIO, above - 6),
    )}px`;
  });

  return createPortal(
    <div
      ref={panelRef}
      className={`fixed z-30 flex origin-bottom flex-col overflow-hidden rounded-xl animate-pop ${GLASS_PANEL}`}
    >
      <p className="border-b border-line px-3 py-1.5 text-[11px] font-medium text-ink-3">
        宛先のボット（↑↓ と Tab で選択）
      </p>
      <ul
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
        role="listbox"
        aria-label="宛先のボット"
      >
        {bots.map((b, i) => {
          const model = models.find((m) => m.id === b.model_id);
          return (
            <li key={b.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                /*
                  pointerdown で拾う。button の click は入力欄の blur より
                  後なので、blur で閉じる作りと組み合わせると押せなくなる
                */
                onPointerDown={(e) => {
                  e.preventDefault();
                  onPick(b);
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-hover ${
                  i === activeIndex ? "bg-neutral-100 dark:bg-white/10" : ""
                }`}
              >
                <span aria-hidden className="text-base leading-none">
                  {b.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
                    {b.name}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-2">
                    <span
                      aria-hidden
                      className="h-2 w-2 shrink-0 rounded-[2px]"
                      style={{ backgroundColor: providerColor(b.model_id) }}
                    />
                    <span className="truncate">
                      {shortModelName(model, b.model_id)}
                    </span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>,
    document.body,
  );
}
