/**
 * リトライ生成（成功するまで生成）の設定。サーバー/クライアント共用。
 *
 * 画像生成はセーフティ判定に揺らぎがあり、問題のない依頼でも弾かれる
 * ことがある。同じ依頼をそのまま投げ直せば通ることが多いため、
 * 成功が目標数に達するまで自動で投げ直し、上限試行回数で打ち切る。
 *
 * 方針:
 * - 成功の判定は「応答に画像が1枚以上あるか」だけ。拒否文の文言は見ない
 *   （言語や表現に依存して壊れるため）。
 * - プロンプトは書き換えない。同じ依頼をそのまま再送するだけ。
 * - レート制限（429）は待ってから再送し、試行回数を消費しない。
 *   ただし待ち直しの回数にも別の上限を設ける。
 * - 上限試行回数はアプリ全体の天井（設定画面）を超えられない。
 *
 * 設定値は会話の params に予約キーで持つ（生成パラメータではないため、
 * buildGenerationPayload からは読まれない）。
 */

import {
  RETRY_SMART_DEFAULT_PERCENT,
  RETRY_SMART_MAX_PERCENT,
  RETRY_SMART_MIN_PERCENT,
} from "./retry-slots";

export const RETRY_ENABLED_KEY = "retry";
export const RETRY_TARGET_KEY = "retryTarget";
export const RETRY_MAX_KEY = "retryMax";
export const RETRY_CONCURRENCY_KEY = "retryConcurrency";
export const RETRY_SMART_KEY = "retrySmart";
export const RETRY_SMART_PERCENT_KEY = "retrySmartPercent";

export interface RetryConfig {
  /** ほしい成功応答の数。 */
  target: number;
  /** あきらめるまでの試行回数。 */
  maxAttempts: number;
  /**
   * 同時に走らせる数。目標数を超えてもよい（超過分の成功も残す）。
   * スマート生成のときは上限で、実際の本数は実行中の成功率から決め直す
   * （`app/lib/retry-slots.ts`）。
   */
  concurrency: number;
  /**
   * スマート生成。枠の数を固定せず、その実行の成功率から決め直す。
   * 失敗続きに反応して枠を増やしたとたん成功が一斉に届き、超過分が
   * 課金されるのを抑えるため。値は「はずれ／あたりと見なす割合（%）」。
   * null なら固定の並列数。
   */
  smartPercent: number | null;
}

export const RETRY_DEFAULT_TARGET = 1;
export const RETRY_DEFAULT_MAX_ATTEMPTS = 5;


function toInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

/**
 * 会話の params からリトライ設定を読む。無効なら null。
 *
 * ceiling はアプリ全体の天井。クライアントの値を信用せず、
 * 送信のたびにサーバー側でも通す。
 *
 * 並列数が未入力のときの既定は、固定なら目標数、スマートなら上限の
 * 試行回数。スマートで目標数を既定にすると、目標1のとき枠が1本から
 * 増やせず、失敗が続いても何もしない「スマート」になる。並列の上限は
 * Cloudflare ではなく上流のレート制限と利用者の設定だけ（依頼1本ごとに
 * 別の実行へ渡すため。retry-run.server.ts の注記）。
 */
export function readRetryConfig(
  state: Record<string, number | string> | null | undefined,
  ceiling: number,
): RetryConfig | null {
  if (!state || state[RETRY_ENABLED_KEY] !== "on") return null;

  const target = Math.max(
    1,
    toInt(state[RETRY_TARGET_KEY], RETRY_DEFAULT_TARGET),
  );
  const smart = state[RETRY_SMART_KEY] === "on";
  const smartPercent = smart
    ? Math.min(
        Math.max(
          toInt(state[RETRY_SMART_PERCENT_KEY], RETRY_SMART_DEFAULT_PERCENT),
          RETRY_SMART_MIN_PERCENT,
        ),
        RETRY_SMART_MAX_PERCENT,
      )
    : null;
  // 試行回数は、未入力なら目標数と同じとみなす
  const maxAttempts = Math.min(
    Math.max(1, toInt(state[RETRY_MAX_KEY], target)),
    Math.max(1, Math.round(ceiling)),
  );
  const concurrency = Math.min(
    Math.max(
      1,
      toInt(state[RETRY_CONCURRENCY_KEY], smart ? maxAttempts : target),
    ),
    maxAttempts,
  );

  return { target, maxAttempts, concurrency, smartPercent };
}

/**
 * 進捗行の先頭。クライアントはこれを見て「リトライ生成の見出し」と判断し、
 * 経過秒を自分で刻む（サーバーは秒を書かない）。DO の中断判定と
 * ポーリングの差分判定もこの先頭文字列に懸かっている。
 */
export const RETRY_PROGRESS_PREFIX = "生成中…";

/**
 * 見出しに載せる進捗。サーバーが毎秒書き、クライアントが読んで描く。
 *
 * 文字列そのものが両者の取り決め（wire format）。素のまま読んでも
 * 意味が取れる1行にしておく——古い画面やコピーではこの文字列が
 * そのまま見える。
 */
export interface RetryProgress {
  target: number;
  successes: number;
  /** 消費した試行（成功＋拒否＋空＋エラー）。レート制限は含まない。 */
  attempts: number;
  maxAttempts: number;
  refusals: number;
  emptyResponses: number;
  /** 一時的な不調（混雑・時間切れ・上流の障害）。試行には数えない。 */
  transients: number;
  /** 上流へ投げて結果待ちの本数（取り込み中は含まない）。 */
  running: number;
  /** いま開けている枠の数。スマート生成では成功率から決め直した値。 */
  slots: number;
  /** レート制限で発射を控えている残り秒。0 なら控えていない。 */
  waitSeconds: number;
  /** 停止要求を受け、走っている分を待っている。 */
  stopping: boolean;
}

/**
 * 見出しメッセージに出す進捗の文言。
 *
 * 経過秒はここに入れない。秒をサーバーが書くと、毎秒表示するために
 * 1秒ごとのD1書き込みとポーリング取得が要る。数字が動くだけの行なので、
 * 開始時刻（メッセージのcreated_at）からクライアントが刻んだほうが
 * 正確で、しかも安い。レート制限の残り秒だけは例外で、見出しは
 * どのみち毎秒書き直されるのでサーバーが書く。
 *
 * 0 の内訳と、待機していないとき・停止していないときの項は省く
 * （素で読むときの見やすさのため。読む側は無い項を 0 / false と読む）。
 */
export function formatRetryProgress(p: RetryProgress): string {
  const parts = [
    `成功 ${p.successes}/${p.target}`,
    `投げた ${p.attempts}/${p.maxAttempts}`,
  ];
  if (p.refusals > 0) parts.push(`拒否 ${p.refusals}`);
  if (p.emptyResponses > 0) parts.push(`空 ${p.emptyResponses}`);
  if (p.transients > 0) parts.push(`不調 ${p.transients}`);
  parts.push(`待ち ${p.running}本`, `枠 ${p.slots}本`);
  if (p.waitSeconds > 0) parts.push(`レート制限で待機 あと${p.waitSeconds}秒`);
  if (p.stopping) parts.push("停止中");
  return `${RETRY_PROGRESS_PREFIX} ${parts.join("・")}`;
}

/**
 * 見出しの文言を進捗へ戻す。読めなければ null（素の1行を出す側へ倒す）。
 *
 * formatRetryProgress と対で、往復のテストで結んである。
 */
export function parseRetryProgress(content: string): RetryProgress | null {
  if (!isRetryProgress(content)) return null;
  const body = content.slice(RETRY_PROGRESS_PREFIX.length);
  const pair = (label: string) => {
    const m = body.match(new RegExp(`(?:^|・)\\s*${label} (\\d+)/(\\d+)`));
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const count = (label: string) => {
    const m = body.match(new RegExp(`(?:^|・)\\s*${label} (\\d+)`));
    return m ? Number(m[1]) : 0;
  };
  const successes = pair("成功");
  const attempts = pair("投げた");
  if (!successes || !attempts) return null;
  const wait = body.match(/レート制限で待機 あと(\d+)秒/);
  return {
    successes: successes[0],
    target: successes[1],
    attempts: attempts[0],
    maxAttempts: attempts[1],
    refusals: count("拒否"),
    emptyResponses: count("空"),
    transients: count("不調"),
    running: count("待ち"),
    slots: count("枠"),
    waitSeconds: wait ? Number(wait[1]) : 0,
    stopping: /(?:^|・)停止中(?:・|$)/.test(body),
  };
}

/** 進捗の見出しメッセージか（本文の見た目で判断する）。 */
export function isRetryProgress(content: string): boolean {
  return content.startsWith(RETRY_PROGRESS_PREFIX);
}

/**
 * 一時的な不調に当たったときの待ち時間（ミリ秒）。回を追うごとに伸ばし、
 * 最後の値で頭打ち。
 *
 * 不調が続いても打ち切らない（打ち切るのは直らないエラーだけ）。
 * その代わり、落ちている上流を短い間隔で叩き続けないよう、待ちを
 * 60秒まで伸ばす。終わりは、投げた本数の柵（retryRequestCap）か、
 * 利用者の停止。
 */
export const RATE_LIMIT_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000];

export interface RateLimitState {
  /** この時刻まで新しい発射を控える。 */
  pauseUntil: number;
  /** 続けて待ち直した回数。成功か拒否が返れば 0 に戻る。 */
  rounds: number;
}

/**
 * 一時的な不調（混雑・時間切れ・上流の障害）を1つ受けたときの、
 * 待ちと回数の更新。
 *
 * **並列で走っている本数ぶんの応答が、ほぼ同時に 429 で返る。**
 * 1つ受けるたびに回数を増やすと、並列4なら1回の制限で待ちが一気に
 * 長くなる。待っている最中に届いたものは同じ回の余波とみなし、回数は
 * 増やさない。待ち時間だけは長いほうへ伸ばす（上流が Retry-After で
 * 長めを指示してきた場合に、短いほうで先に投げ直さないため）。
 */
export function onTransientFailure(
  state: RateLimitState,
  opts: { now: number; waitMs?: number },
): RateLimitState {
  const { now, waitMs } = opts;
  const backoff =
    RATE_LIMIT_BACKOFF_MS[
      Math.min(state.rounds, RATE_LIMIT_BACKOFF_MS.length - 1)
    ];
  const wait = waitMs != null && waitMs > 0 ? waitMs : backoff;

  // 既に待っている最中なら、同じ回の余波
  if (now < state.pauseUntil) {
    return { ...state, pauseUntil: Math.max(state.pauseUntil, now + wait) };
  }
  return { pauseUntil: now + wait, rounds: state.rounds + 1 };
}

/**
 * 成功か拒否が1つ返ったときの、待ち直し回数の扱い。
 *
 * 回数は待ち時間の長さを決める。「待っても何も通らない」が続いた回数
 * なので、何か1つでも通ったら数え直し、待ちを短いところから始める。
 */
export function afterAttemptSettled(state: RateLimitState): RateLimitState {
  return { ...state, rounds: 0 };
}

/**
 * 結果は分かっているが、まだ数え上げに載っていない本数。
 *
 * 成功の数え上げ（state.successes++）は保存と画像の取り込みの後なので、
 * 上流の応答を読み切ってから1秒前後、その1本は「まだ結果の分からない
 * 1本」として枠に居座る。その窓で別の1本が決着すると、発射ループは
 * 古い成功数で枠を数え直し、必要より多く投げる——スマート生成が
 * 抑えたい超過そのもの。結果が届いた瞬間にここへ足し、数え上げが
 * 済んだら引く。
 */
export type AttemptKind = "success" | "refused" | "transient" | "fatal";

export interface PendingTally {
  /** 結果が届いた。試行に数えるのは成功と拒否だけ。 */
  known(kind: AttemptKind): void;
  /** 数え上げが済んだ。known と対で呼ぶ。 */
  counted(kind: AttemptKind): void;
  /** 届いているがまだ数えていない成功。 */
  successes(): number;
  /** 届いているがまだ数えていない試行（成功と拒否）。 */
  settled(): number;
}

export function createPendingTally(): PendingTally {
  let successes = 0;
  let settled = 0;
  return {
    known(kind) {
      if (kind === "transient" || kind === "fatal") return;
      settled++;
      if (kind === "success") successes++;
    },
    counted(kind) {
      if (kind === "transient" || kind === "fatal") return;
      settled--;
      if (kind === "success") successes--;
    },
    successes: () => successes,
    settled: () => settled,
  };
}

/**
 * 1回の実行で上流へ投げてよい本数の、いちばん外側の柵。
 *
 * 試行回数の上限は一時的な不調（429・5xx・切断）を数えず、不調は
 * 何回続いても打ち切らない。上流が落ちているあいだは待ちを伸ばし
 * ながら投げ続けるので、どんな経路でも越えられない数を1つ置く。
 * 不調を含めた上流への本数が「上限試行回数 × この倍率」に達したら
 * 打ち切る。
 */
export const RETRY_REQUEST_CAP_FACTOR = 3;

export function retryRequestCap(maxAttempts: number): number {
  return Math.max(1, maxAttempts) * RETRY_REQUEST_CAP_FACTOR;
}

/**
 * 進捗の無いチャンクをこの回数続けたら実行を終える。
 *
 * チャンクは「続きがある」と言えば 50ms 後にまた走る。生存確認が
 * D1 の失敗で書けないあいだは発射しないので、その状態が続くと何も
 * 進まないままアラームが回り続ける（Poe では途中経過の取得で外部
 * リクエストを1件ずつ使う）。進捗は試行・待ち直し・持ち越した画像の
 * 取り込みのどれかが動いたことで測る。
 */
export const RETRY_STALLED_CHUNK_LIMIT = 3;

/**
 * 実行（DO のアラーム1回）に許される時間。Cloudflare の文書に
 * 「Durable Object のアラームは最長15分」とある。ここを過ぎると実行
 * ごと止められ、返事待ちの上流の依頼は失われる（課金は済んでいる）。
 * 依頼1本ごとに実行を分けているので、1本の締め切りをこの手前に置けば
 * 壁には当たらない。司令役はこの手前で途中経過を保存して区切る。
 */
export const RETRY_ALARM_WALL_MS = 15 * 60_000;

/**
 * 1本の試行に許す総時間（ヘッダ待ちも本文の無音も含む）。
 *
 * 無音の見張り（上流から1バイトも来ない時間）だけでは足りない。
 * OpenRouter はプロバイダを待っているあいだ「処理中」のコメント行を
 * 送り続けるので、そのたびに無音の時計が戻り、プロバイダ側が固まって
 * いると永久に待つ。実際に「上流で待ち」のまま進まず、停止しても
 * その本を待ち続けて終われなかった。
 *
 * 切るのは、課金済みの結果を捨てることでもある。だから「明らかに
 * 固まっている」と言える長さまで待つ。上限は担当の実行の15分の壁で
 * 決まる: 結果を書く余白を残した残りが、1本に許せる最長になる。
 */
export const RETRY_ATTEMPT_DEADLINE_MS = 12 * 60_000;

