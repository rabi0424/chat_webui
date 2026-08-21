/**
 * localStorage に置く「この端末だけの設定」の土台。
 *
 * 同じ形（キーを決める・try/catch で読む・try/catch で書く・DOMへ当てる）が
 * テーマ・アクセント色・文字サイズ・下書き…と8系統で繰り返されていた。
 * 繰り返し自体より、**変更を知る手立てが無かった**ことが問題で、設定画面で
 * テーマを変えてもサイドバーのトグルは古い値を持ったままだった
 * （次に押すと一手ずれる）。
 *
 * 読み書きに購読を足して、同じ値を見ている場所が揃って動くようにする。
 * 別のタブでの変更（storage イベント）も同じ経路で拾う。
 */
import { useMemo, useSyncExternalStore } from "react";

/** 読めなければ null（プライベートモードや容量超過でも投げない）。 */
export function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 書けなくても投げない。この画面のあいだの反映は呼ぶ側が続ける。 */
export function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 容量超過・プライベートモード。設定が保存できないだけで、
    // アプリが止まる理由にはならない
  }
}

export function removeRaw(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 同上
  }
}

/**
 * JSON として読む。壊れていたら既定値へ落とす。
 *
 * localStorage の中身は前のバージョンのアプリが書いたものかもしれず、
 * 手で書き換えることもできる。形が変わっていた場合に落ちないよう、
 * 呼ぶ側が渡す検証を通してから返す。
 */
export function readJson<T>(
  key: string,
  fallback: T,
  validate: (v: unknown) => v is T,
): T {
  const raw = readRaw(key);
  if (raw == null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return validate(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    writeRaw(key, JSON.stringify(value));
  } catch {
    // 循環参照など。書けないものは保存しない
  }
}

// --- 変更の購読 ---------------------------------------------------------

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

/** そのキーが変わったことを知らせる（同じタブの中）。 */
export function notifyChanged(key: string): void {
  for (const fn of listeners.get(key) ?? []) fn();
}

/**
 * そのキーの変更を購読する。
 *
 * 同じタブでの変更は notifyChanged 経由、別のタブでの変更は storage
 * イベント経由で届く（storage は自分のタブには飛ばない仕様なので、
 * 両方を見る必要がある）。
 */
export function subscribeKey(key: string, fn: Listener): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(fn);

  const onStorage = (e: StorageEvent) => {
    // key が null なのは clear()。まとめて消えたので知らせる
    if (e.key === null || e.key === key) fn();
  };
  window.addEventListener("storage", onStorage);

  return () => {
    set.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * 保存値を読み、変わったら描き直すフック。
 *
 * サーバー側では localStorage が無いので、既定値を返す（描画後に
 * useSyncExternalStore が本物を読み直す）。
 *
 * read は**同じ値なら同じものを返す**必要がある。毎回新しいオブジェクトを
 * 作って返すと、React が「変わった」と判断し続けて描画が止まらなくなる。
 * 文字列や数値のような素の値を返すこと。
 */
export function usePersisted<T>(
  key: string,
  read: () => T,
  serverValue: T,
): T {
  return useSyncExternalStore(
    (fn) => subscribeKey(key, fn),
    read,
    () => serverValue,
  );
}

// --- 開いているフォルダ -------------------------------------------------

const EXPANDED_KEY = "chat-webui:expanded-folders";

/**
 * サイドバーで開いているフォルダ。
 *
 * これを持ち回るのは、スマホのドロワーが**閉じるたびに外される**ため。
 * 中の状態も一緒に消えるので、開き直すたびにフォルダが畳まれていた。
 * 保存しておけば、外されても・再読み込みしても、開いたままになる。
 * 画面の中に一覧が2つある（デスクトップ用と、ドロワー用）ので、
 * どちらで開いても揃う。
 */
export function readExpandedFolders(): string[] {
  return readJson<string[]>(EXPANDED_KEY, [], (v): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string"),
  );
}

export function writeExpandedFolders(ids: string[]): void {
  writeJson(EXPANDED_KEY, ids);
  notifyChanged(EXPANDED_KEY);
}

/** 開いているフォルダを購読する。 */
export function useExpandedFolders(): Set<string> {
  // useSyncExternalStore は同じ値なら同じものを返す必要があるので、
  // 素の文字列を挟んでから集合に変える
  const raw = usePersisted(EXPANDED_KEY, () => readRaw(EXPANDED_KEY) ?? "", "");
  return useMemo(() => new Set(readExpandedFolders()), [raw]);
}
