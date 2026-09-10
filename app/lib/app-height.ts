/**
 * アプリ全体の高さ（CSS 変数 --app-height の値）を決める。
 *
 * Safari では visualViewport の実測値を使う——読み込み直後に 100dvh が
 * 実際の表示領域より小さいままになることがあり、実測値なら初期表示から
 * 正しく、ツールバーの伸縮にも追従する。
 *
 * ホーム画面から開いた全画面表示（standalone）では実測値を**使わない**。
 * 起動直後は 100dvh・innerHeight・visualViewport.height のどれも
 * 初期化されておらず、ステータスバーぶん（Dynamic Island 機で 59pt）
 * 短い値を返し、端末を回すなど表示領域が変わるまで直らない。短い値で
 * 高さを決めると箱が画面の下端より上で終わり、入力欄が浮いて見えた。
 * この表示ではツールバーが無いので 100vh がそのまま画面の高さで、
 * 起動直後から正しい唯一の値。「実測値と大きいほう」では両方とも
 * 短いので効かない（実際に効かなかった）。
 */
export function appHeightValue(opts: {
  standalone: boolean;
  /** visualViewport.height（CSS px）。 */
  measured: number;
}): string {
  if (opts.standalone) return "100vh";
  return `${opts.measured}px`;
}

/** ホーム画面から開いた全画面表示か。 */
export function isStandaloneDisplay(win: Window): boolean {
  const nav = win.navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    (typeof win.matchMedia === "function" &&
      win.matchMedia("(display-mode: standalone)").matches)
  );
}
