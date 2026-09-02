/**
 * サイドバーの行が使う操作と状態。
 *
 * 会話やフォルダの行は、名前の変更・削除・ピン留めといった操作を
 * 呼ぶ。これらを props で1つずつ渡すと、行を1段ネストするたびに
 * 中継の記述が増える（フォルダの中の会話、お気に入りの中の会話）。
 * 行そのものは「サイドバーの中にしか置かない」ものなので、
 * まとめて文脈として配る。
 */
import { createContext, useContext } from "react";
import type { ConversationListRow, FolderRow } from "../../lib/db.server";

/** いま「…」メニューを開いている対象。名前の変更中の対象も同じ形。 */
export type MenuTarget =
  | { type: "conversation"; id: string }
  | { type: "folder"; id: string };

export interface SidebarActions {
  /** いま表示している会話とフォルダ（メニューの中身を組み立てるのに使う）。 */
  conversations: ConversationListRow[];
  folders: FolderRow[];

  /** 開いているメニュー（null なら閉じている）。 */
  menu: MenuTarget | null;
  setMenu: (target: MenuTarget | null) => void;

  /** その会話に未読の印を出すか。 */
  isUnread: (c: ConversationListRow) => boolean;
  /** その会話でいま生成が走っているか（タイトルを光らせる）。 */
  isGenerating: (c: ConversationListRow) => boolean;
  /** リンクを押したときに呼ぶ（スマホでドロワーを閉じる）。 */
  onNavigate?: () => void;

  /** 開いているフォルダ。 */
  expanded: Set<string>;
  /** そのフォルダの開閉を切り替える。 */
  toggleExpanded: (id: string) => void;
  /** フォルダの階層へ入る（null でルートへ戻る）。 */
  setView: (id: string | null) => void;

  /** そのフォルダに属する会話。 */
  conversationsIn: (folderId: string) => ConversationListRow[];
  /** お気に入りの会話。 */
  favorites: ConversationListRow[];

  /**
   * 名前をその場で書き換えている行。行はこれを見て、名前の代わりに
   * 入力欄を出す（Finder と同じ。ブラウザの prompt() は使わない）。
   */
  renaming: MenuTarget | null;
  startRename: (target: MenuTarget) => void;
  /** 確定（name）または取りやめ（null）。 */
  finishRename: (target: MenuTarget, name: string | null) => void;

  removeConversation: (c: ConversationListRow) => void;
  patchConversation: (id: string, body: Record<string, unknown>) => void;
  removeFolder: (f: FolderRow) => void;
  patchFolder: (id: string, body: Record<string, unknown>) => void;
  movePinned: (
    type: "conversation" | "folder",
    id: string,
    direction: "up" | "down",
  ) => void;
  /** フォルダ移動のモーダルを開く。 */
  openMoveDialog: (conversationId: string) => void;
}

const SidebarContext = createContext<SidebarActions | null>(null);

export const SidebarProvider = SidebarContext.Provider;

export function useSidebar(): SidebarActions {
  const value = useContext(SidebarContext);
  if (!value) {
    throw new Error("サイドバーの外で行を描こうとしています");
  }
  return value;
}
