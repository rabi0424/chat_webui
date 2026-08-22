/**
 * 生成の開始・完了・失敗を読み上げへ流す領域。
 *
 * 目に見えないが、常に DOM に居ることが要る。支援技術は「もともと
 * あった live region の中身が変わった」ことで読み上げるので、文言と
 * 一緒に領域そのものを出し入れすると、初回が読まれないことがある。
 *
 * 領域が2つあるのは、同じ文言が続くときのため。生成を2回続けて
 * 終えると「生成が完了しました」を2度書くことになるが、textContent が
 * 同じままでは変化と見なされず、2度目は読まれない。交互に使い、
 * 書く前にもう片方を空にする（空にした側の変化は読み上げない）。
 *
 * React の state ではなく ref で直接書いているのは、この文言が
 * 画面に何も描かないため。state にすると、読み上げのためだけに
 * チャット全体が再レンダーされる。
 */
import { useEffect, useRef } from "react";
import { generationAnnouncement, type GenerationPhase } from "../../lib/announce";

export function LiveRegion({ isStreaming, error }: GenerationPhase) {
  const slotA = useRef<HTMLParagraphElement>(null);
  const slotB = useRef<HTMLParagraphElement>(null);
  const prev = useRef<GenerationPhase>({ isStreaming: false, error: null });
  const useB = useRef(false);

  useEffect(() => {
    const next: GenerationPhase = { isStreaming, error };
    const text = generationAnnouncement(prev.current, next);
    prev.current = next;
    if (text === null) return;

    const [target, other] = useB.current
      ? [slotB.current, slotA.current]
      : [slotA.current, slotB.current];
    useB.current = !useB.current;
    if (other) other.textContent = "";
    if (target) target.textContent = text;
  }, [isStreaming, error]);

  return (
    <div className="sr-only">
      <p ref={slotA} role="status" aria-live="polite" aria-atomic="true" />
      <p ref={slotB} role="status" aria-live="polite" aria-atomic="true" />
    </div>
  );
}
