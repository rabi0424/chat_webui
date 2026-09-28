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
 *
 * Safari の実測値は、逆に**ページのスクロールできる範囲より大きい**ことも
 * ある。そのままだと箱が表示領域からはみ出し、アプリの部品ではなく画面
 * ごと少しスクロールできてしまう——下まで送ると上端が数十pxステータス
 * バーの裏へ隠れた（実際に起きた）。どの値が食い違うのかは Safari の版で
 * 変わるので、推測で別の値に乗り換えず、「実測値を当てた結果、文書が
 * 何px スクロールできたか」（overflow）をそのまま差し引く。はみ出して
 * いなければ 0 で、実測値は変わらない——短すぎた起動直後の問題を
 * 「小さいほう」で呼び戻すことが無い。
 */
export function appHeightValue(opts: {
  standalone: boolean;
  /** visualViewport.height（CSS px）。 */
  measured: number;
  /**
   * 実測値を当てたとき、**アプリの箱が**文書の表示範囲からはみ出した量
   * （CSS px）。文書全体のはみ出し（scrollHeight − clientHeight）ではない
   * ——箱の外の要素が文書を伸ばしていると、箱をいくら縮めても減らない。
   */
  overflow?: number;
}): string {
  if (opts.standalone) return "100vh";
  const over = Math.max(0, opts.overflow ?? 0);
  /*
   * はみ出しが実測値以上なら、それは箱の高さのせいではない（箱が
   * 0px でも文書がはみ出したまま）。差し引くと 0 以下になり、CSS では
   * 負の height は無効なので箱が中身の高さまで伸びきる——文書がさらに
   * はみ出して、戻る手立てが無くなる（設定画面で実際に起きた。ドロワーも
   * 高さ0で背景の無い部品だけが本文に重なった）。そのときは実測値のまま
   */
  if (over >= opts.measured) return `${opts.measured}px`;
  return `${opts.measured - over}px`;
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
