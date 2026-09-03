import { useCallback, useState } from "react";
import { Link, useNavigate, useOutletContext, useRevalidator } from "react-router";
import type { ShellContext } from "./shell";
import type { BotRow } from "../lib/db.server";
import { IconBot, IconEllipsis, IconMenu, IconPlus, IconTrash, IconCopy } from "../components/icons";
import { useConfirm } from "../components/ConfirmDialog";
import { EMPTY_ACTION, EmptyState } from "../components/EmptyState";
import { MENU_ITEM, MenuPanel } from "../components/sidebar/items";
import { useEscapeToClose } from "../lib/dismiss";
import { MAX_TITLE_LENGTH } from "../lib/constants";

export function meta() {
  return [{ title: "ボット管理 - Chat" }];
}

/**
 * ボットの1行（UI-9）。
 *
 * 行そのものを押すと編集へ。複製と削除は「…」の中——3つの文字ボタンを
 * 毎行に並べると、赤い「削除」が行の数だけ並んで、一覧が操作盤に見える。
 * 「…」の出し方はサイドバーの行と同じ部品（Mac はポップオーバー、
 * iPhone はシート）。
 */
function BotItem({
  bot,
  modelName,
  menuOpen,
  onOpenMenu,
  onCloseMenu,
  onDuplicate,
  onRemove,
}: {
  bot: BotRow;
  modelName: string;
  menuOpen: boolean;
  onOpenMenu: () => void;
  onCloseMenu: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="group relative">
      <Link
        to={`/bots/${bot.id}/edit`}
        prefetch="intent"
        className="flex items-center gap-3.5 px-4 py-3 transition-colors hover:bg-hover"
      >
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] bg-sunken text-[22px]"
          aria-hidden
        >
          {bot.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{bot.name}</span>
          <span className="mt-0.5 block truncate text-xs text-ink-2">{modelName}</span>
        </span>
        {/* 「…」の場所を空けておく（下のボタンが重なる） */}
        <span className="w-9 shrink-0" aria-hidden />
      </Link>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (menuOpen) onCloseMenu();
          else onOpenMenu();
        }}
        aria-label={`${bot.name} のメニュー`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="absolute right-3 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full text-ink-3 hover:bg-black/[0.06] hover:text-ink-2 dark:hover:bg-white/10"
      >
        <IconEllipsis className="h-5 w-5" />
      </button>
      {menuOpen && (
        <MenuPanel title={bot.name} onClose={onCloseMenu}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onCloseMenu();
              onDuplicate();
            }}
            className={MENU_ITEM}
          >
            <IconCopy className="h-4 w-4 text-ink-3" />
            複製
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onCloseMenu();
              onRemove();
            }}
            className={`${MENU_ITEM} text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/50`}
          >
            <IconTrash className="h-4 w-4" />
            削除
          </button>
        </MenuPanel>
      )}
    </li>
  );
}

export default function Bots() {
  const { bots, models, openSidebar } = useOutletContext<ShellContext>();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const confirm = useConfirm();
  /** 「…」を開いている行。 */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const closeMenu = useCallback(() => setMenuFor(null), []);
  useEscapeToClose(menuFor != null, closeMenu);

  async function remove(id: string, name: string) {
    const ok = await confirm({
      title: `ボット「${name}」を削除しますか？`,
      description: "このボットで始めた会話はそのまま残ります。",
      confirmLabel: "削除",
      destructive: true,
    });
    if (!ok) return;
    await fetch(`/api/bots/${id}`, { method: "DELETE" });
    revalidator.revalidate();
  }

  async function duplicate(id: string) {
    const bot = bots.find((b) => b.id === id);
    if (!bot) return;
    await fetch("/api/bots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `${bot.name}のコピー`.slice(0, MAX_TITLE_LENGTH),
        icon: bot.icon,
        modelId: bot.model_id,
        systemPrompt: bot.system_prompt,
        params: bot.params_json ? JSON.parse(bot.params_json) : null,
      }),
    });
    revalidator.revalidate();
  }

  return (
    <div className="flex h-full flex-col" onClick={() => menuFor && setMenuFor(null)}>
      <header className="flex shrink-0 items-center gap-1 border-b border-line px-3 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={openSidebar}
          aria-label="メニュー"
          className="rounded-lg p-2 text-ink-2 hover:bg-hover md:hidden"
        >
          <IconMenu className="h-5 w-5" />
        </button>
        <h1 className="font-display px-1 text-sm font-bold tracking-tight">ボット管理</h1>
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => void navigate("/bots/new")}
            className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent/85"
          >
            <IconPlus className="h-4 w-4" />
            新しいボット
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 pb-[max(env(safe-area-inset-bottom),1.5rem)] pt-6">
          {bots.length === 0 ? (
            <div className="py-14">
              <EmptyState
                icon={<IconBot />}
                title="ボットはまだありません"
                description="モデルとシステムプロンプトの組み合わせを登録すると、新規チャットから1タップで始められます。"
                action={
                  <Link to="/bots/new" className={EMPTY_ACTION}>
                    <IconPlus className="h-4 w-4" />
                    ボットを作る
                  </Link>
                }
              />
            </div>
          ) : (
            /*
              グループ化された一覧（設定画面と同じ形）。行は境界線で
              区切り、押せる面をカードの縁ではなく行そのものにする。
            */
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-raised">
              {bots.map((b) => (
                <BotItem
                  key={b.id}
                  bot={b}
                  modelName={models.find((m) => m.id === b.model_id)?.name ?? b.model_id}
                  menuOpen={menuFor === b.id}
                  onOpenMenu={() => setMenuFor(b.id)}
                  onCloseMenu={closeMenu}
                  onDuplicate={() => void duplicate(b.id)}
                  onRemove={() => void remove(b.id, b.name)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}


// 例外の受け皿はこのルートに置く。root に任せると文書ごと
// 差し替わり、サイドバーまで消えて戻る導線が無くなる
export { RouteError as ErrorBoundary } from "../components/RouteError";
