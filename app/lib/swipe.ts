/**
 * 画面の端からの払い（エッジスワイプ）の判定に使う小物。
 */

/** 横に流せる箱とみなす overflow の値。 */
const SCROLLABLE = new Set(["auto", "scroll"]);

/**
 * その指の位置が、**まだ左へ流せる**箱の中から始まっているか。
 *
 * 会話には横に長いものが載る——コードブロック、表、数式。左端から
 * 右へ払うとドロワーが開く仕掛けは、これらの上でも同じように効いて
 * いた。途中まで横に流して見ている最中に戻ろうとすると、内容ではなく
 * ドロワーが出てくる。
 *
 * まだ左に戻せる（scrollLeft > 0）箱の中なら、その払いは中身を戻す
 * ためのものとみなす。左端まで戻り切っていれば、右へ払っても中身は
 * 動かないので、ドロワーを開いてよい。
 */
export function insideScrollableX(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null;
  while (el) {
    if (el.scrollLeft > 0 && el.scrollWidth > el.clientWidth) {
      const overflow = getComputedStyle(el).overflowX;
      if (SCROLLABLE.has(overflow)) return true;
    }
    el = el.parentElement;
  }
  return false;
}
