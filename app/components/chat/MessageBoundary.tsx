/**
 * 1件ぶんの受け皿。DOM の作り替えで落ちたときだけ、その1件を作り直す。
 *
 * ブラウザの画面翻訳（Safari・Chrome）や一部の拡張は、訳した文を
 * **元の節点と差し替える**形で本文に入れてくる。React は自分が置いた
 * つもりの節点を消しに行くので、そこが差し替えられていると
 * `NotFoundError` で落ちる。受け皿がルート側にしか無いと、そのとき
 * 画面が丸ごと「読み込めませんでした」に差し替わる——本文も、サイドバーの
 * 隣にある会話も、書きかけの入力欄も一緒に消える。
 *
 * 衝突そのものは、伸びている塊を翻訳の対象から外して避けてある
 * （`Markdown.tsx` の TRANSLATE_WHILE_GROWING）。ここはその後ろの網で、
 * 断りを無視する翻訳や、訳し終えた本文をあとから描き直す操作
 * （枝の切り替え・編集のやり直し）で落ちたときに、**落ちた1件だけを
 * 作り直して画面を保つ**。
 *
 * 作り直しなので、その1件の図は描き直しになり、並べ替えた表は元の順に
 * 戻る（監査 E-7 で避けたはずのこと）。それでも、画面ごと失うよりは軽い。
 *
 * **DOM の衝突以外は素通しする。** 受け皿が何でも飲み込むと、こちらの
 * 作りの誤りが「一瞬ちらついて直る」形になって隠れてしまう。素通しすれば
 * これまで通りルート側の受け皿（RouteError）まで上がる。
 */
import { Component, Fragment, type ReactNode } from "react";

/**
 * DOM の作り替えの衝突か。
 *
 * 名前で見る。例外は jsdom・ブラウザ・iframe など別の実行環境から
 * 来ることがあり、`instanceof DOMException` は環境をまたぐと外れる。
 */
const DOM_CONFLICT = new Set([
  // 消そう・入れようとした節点が、そこに居ない
  "NotFoundError",
  // 入れようとした先が、もう別の親の下にある
  "HierarchyRequestError",
]);

export function isDomConflict(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.some(isDomConflict);
  if (typeof error !== "object" || error === null) return false;
  return DOM_CONFLICT.has((error as { name?: string }).name ?? "");
}

/**
 * 作り直す回数の上限。
 *
 * 作り直した先で同じところが落ち続けるなら、それは翻訳との行き違いでは
 * なく、こちらの作りの誤り。いつまでも作り直すと、画面が点滅したまま
 * 止まらなくなるので、ここで諦めて上へ渡す。
 */
const MAX_REBUILD = 3;

type Props = { children: ReactNode };
type State = { crashed: boolean; generation: number };

export class MessageBoundary extends Component<Props, State> {
  state: State = { crashed: false, generation: 0 };

  static getDerivedStateFromError(): Partial<State> {
    // いったん空にする（壊れた節点を React に手放させる）
    return { crashed: true };
  }

  componentDidCatch(error: unknown): void {
    if (!isDomConflict(error) || this.state.generation >= MAX_REBUILD) {
      // 上の受け皿へ。componentDidCatch から投げると、そのまま外へ渡る
      throw error;
    }
    this.setState((s) => ({ crashed: false, generation: s.generation + 1 }));
  }

  render(): ReactNode {
    if (this.state.crashed) return null;
    // key を変えることで、作り直し＝まっさらな節点から描き直しになる
    return <Fragment key={this.state.generation}>{this.props.children}</Fragment>;
  }
}
