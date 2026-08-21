/**
 * 「コピーしました」の一時表示。
 *
 * 同じ形が5箇所（本文・コード・表・使用量・設定）にあり、どれも
 * setTimeout を張りっぱなしにしていた。React 18 以降、外れたあとの
 * setState は黙って無視されるので害は出ないが、続けて押したときに
 * **前の時計が先に鳴って、印が早く消える**——2回目を押した0.1秒後に
 * チェックが消える、という挙動になっていた。
 *
 * 押すたびに前の時計を止め、外れるときにも止める。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export function useCopied(ms = 1500): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const flash = useCallback(() => {
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), ms);
  }, [ms]);

  return [copied, flash];
}
