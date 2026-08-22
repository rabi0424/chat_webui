import { THEME_INIT_SCRIPT } from "./theme";
import { ACCENT_INIT_SCRIPT } from "./accent";
import { CHAT_FONT_INIT_SCRIPT } from "./chat-font";

/**
 * ハイドレーション前にテーマ・アクセント・文字サイズを当てるスクリプト。
 *
 * **CSP のハッシュはこの文字列から計算する。** root.tsx が別々に連結すると、
 * 片方だけ足したときにハッシュが黙って合わなくなり、スクリプトが実行されない
 * ——つまり毎回テーマがちらつく。埋め込む側と数える側で同じ定数を使う。
 */
export const APPEARANCE_INIT_SCRIPT =
  THEME_INIT_SCRIPT + ACCENT_INIT_SCRIPT + CHAT_FONT_INIT_SCRIPT;
