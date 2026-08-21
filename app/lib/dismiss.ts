/**
 * 「開いているものを閉じる」の共通の作法。
 *
 * 重ねて出すもの——メニュー、⚙のパネル、確認、フォルダ移動、拡大表示——は
 * どれも Escape で閉じられるべきだが、対応していたのはモデル選択と拡大表示
 * だけだった。キーボードで操作していると、開いたものを閉じる手立てが
 * マウスにしか無い状態になる。
 *
 * 外側を押して閉じる仕掛けは、それぞれの事情で形が違う（背景の板を敷く／
 * 親の onClick で拾う／ポインタの位置で判定する）ので、無理に1つへ寄せない。
 * ここで面倒を見るのは Escape と、その「どれを閉じるか」の順序だけにする。
 */
import { useEffect } from "react";

/**
 * いま開いているものの重なり順。後ろほど手前（あとから開いたもの）。
 *
 * listener の登録順に頼れないのが理由。listener が付くのは「開いた瞬間」
 * なので、順番は開いた順で決まってしまう。奥にあるものを先に開いていれば
 * そちらが先に反応し、手前のものが残る——Escape を押したのに一番上が
 * 閉じない、という形になる。開いているものを自分で並べて、末尾から閉じる。
 */
const openLayers: { close: () => void }[] = [];

let listening = false;

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  const top = openLayers[openLayers.length - 1];
  if (!top) return;
  // 一度の Escape で閉じるのは1枚だけ。まとめて閉じると、
  // メニューを閉じるつもりが下のモーダルまで消える
  e.preventDefault();
  top.close();
}

function listen(): void {
  if (listening) return;
  document.addEventListener("keydown", onKeyDown);
  listening = true;
}

function unlisten(): void {
  if (!listening || openLayers.length > 0) return;
  document.removeEventListener("keydown", onKeyDown);
  listening = false;
}

/** 開いているあいだ、Escape で閉じられるようにする。 */
export function useEscapeToClose(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const layer = { close: onClose };
    openLayers.push(layer);
    listen();
    return () => {
      const i = openLayers.indexOf(layer);
      if (i >= 0) openLayers.splice(i, 1);
      unlisten();
    };
  }, [open, onClose]);
}

/**
 * 開いているあいだ、外側を押したら閉じる。
 *
 * pointerdown で見るのは click より早く、押した時点で閉じたいため
 * （タッチで開いたメニューは、指を離すまで閉じないと重く感じる）。
 */
export function useOutsideToClose(
  open: boolean,
  onClose: () => void,
  ...refs: React.RefObject<HTMLElement | null>[]
): void {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (refs.some((r) => r.current?.contains(t))) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
    // refs は配列リテラルで毎回作られるが、中身の ref は不変
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose]);
}
