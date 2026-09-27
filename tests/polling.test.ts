import { describe, expect, it } from "vitest";
import {
  POLL_BACKOFF_MAX_MS,
  pollBackoffMs,
  applyContentPayload,
  applyReasoningPayload,
  contentPayload,
  reasoningPayload,
  parseSince,
  pathFingerprint,
  decodeRunProgress,
  encodeRunProgress,
  liveProgressOf,
  pathTagOf,
  rememberPathTag,
  reuseUnchangedRows,
} from "../app/lib/polling";
import { formatRetryProgress } from "../app/lib/retry";

/**
 * 生成中のポーリングで運ぶ量を減らす仕掛け。
 *
 * 壊れ方が静かなのが厄介なところ。差分の継ぎ足しを間違えると、本文が
 * 二重になる・欠ける形で画面に出るが、エラーにはならない。
 */

describe("since の読み取り", () => {
  it("数値を読む", () => {
    expect(parseSince("https://x/api?since=120")).toBe(120);
  });
  it("無指定・壊れた値・負数は 0（＝全文）に倒す", () => {
    for (const q of ["", "?since=", "?since=abc", "?since=-5", "?since=NaN"]) {
      expect(parseSince(`https://x/api${q}`)).toBe(0);
    }
  });
  it("小数は切り捨てる（slice の位置に使うため）", () => {
    expect(parseSince("https://x/api?since=10.9")).toBe(10);
  });
});

describe("返す本文を決める", () => {
  const TEXT = "あいうえおかきくけこ";

  it("伸びるだけの本文は、その先だけを返す", () => {
    const p = contentPayload(TEXT, 4, true);
    expect(p.contentDelta).toBe("おかきくけこ");
    expect(p.content).toBeUndefined();
    expect(p.contentLength).toBe(TEXT.length);
  });

  it("最初の1回（since=0）は全文", () => {
    const p = contentPayload(TEXT, 0, true);
    expect(p.content).toBe(TEXT);
    expect(p.contentDelta).toBeUndefined();
  });

  it("書き換わりうる本文は、差分にせず全文で返す", () => {
    // 進捗の見出し・確定後の要約がこれ。差分で返すと継ぎ足しが壊れる
    const p = contentPayload(TEXT, 4, false);
    expect(p.content).toBe(TEXT);
    expect(p.contentDelta).toBeUndefined();
  });

  it("手元のほうが長いと言われたら、追記は空", () => {
    const p = contentPayload(TEXT, 999, true);
    expect(p.contentDelta).toBe("");
    // 長さは正しく伝える。受け手はこれで食い違いに気づく
    expect(p.contentLength).toBe(TEXT.length);
  });
});

describe("受け取った本文の組み立て", () => {
  it("差分を継ぎ足す", () => {
    const full = applyContentPayload("あいうえ", {
      contentDelta: "おかきくけこ",
      contentLength: 10,
    });
    expect(full).toBe("あいうえおかきくけこ");
  });

  it("全文が来たらそれを使う（手元は捨てる）", () => {
    const full = applyContentPayload("古い本文", {
      content: "新しい本文",
      contentLength: 5,
    });
    expect(full).toBe("新しい本文");
  });

  it("長さが合わなければ null（取り直させる）", () => {
    // サーバー側で本文が縮んだ・書き直された場合。黙って継ぎ足すと壊れる
    expect(
      applyContentPayload("あいうえ", {
        contentDelta: "お",
        contentLength: 99,
      }),
    ).toBeNull();
    expect(
      applyContentPayload("あいうえ", { content: "短い", contentLength: 99 }),
    ).toBeNull();
  });

  it("サーバーと往復させても本文が一致する（伸びていく様子を再現）", () => {
    const source = "これは長い応答です。".repeat(50);
    let held = "";
    for (let n = 1; n <= source.length; n += 7) {
      const grown = source.slice(0, n);
      // 生成中なので差分で返る
      const payload = contentPayload(grown, held.length, true);
      const next = applyContentPayload(held, payload);
      expect(next).not.toBeNull();
      held = next!;
      expect(held).toBe(grown);
    }
    // 確定は全文で返る（要約に置き換わることがあるため）
    const finalPayload = contentPayload(source, held.length, false);
    expect(applyContentPayload(held, finalPayload)).toBe(source);
  });

  it("確定で本文が別物に置き換わっても追従できる", () => {
    let held = "途中まで書かれた本文";
    const replaced = "**完了** — 成功 3件";
    const payload = contentPayload(replaced, held.length, false);
    held = applyContentPayload(held, payload)!;
    expect(held).toBe(replaced);
  });
});

describe("思考（reasoning）の差分", () => {
  /*
   * 考えるモデルでは思考のほうが本文より長い。本文と同じ規則で差分にするが、
   * 思考には「無い（null）」がある。そこを本文と同じに扱うと壊れる。
   */
  const THOUGHT = "まず前提を確かめる。次に場合を分ける。";

  it("rsince は since とは別に読む", () => {
    const url = "https://x/api?since=5&rsince=12";
    expect(parseSince(url, "rsince")).toBe(12);
    expect(parseSince(url)).toBe(5);
    expect(parseSince("https://x/api?since=5", "rsince")).toBe(0);
  });

  it("伸びるだけの思考は、その先だけを返す", () => {
    const p = reasoningPayload(THOUGHT, 4, true);
    expect(p.reasoningDelta).toBe(THOUGHT.slice(4));
    expect("reasoning" in p).toBe(false);
    expect(p.reasoningLength).toBe(THOUGHT.length);
  });

  it("最初の1回・書き換わりうる状態は全文", () => {
    for (const p of [
      reasoningPayload(THOUGHT, 0, true),
      reasoningPayload(THOUGHT, 4, false),
    ]) {
      expect(p.reasoning).toBe(THOUGHT);
      expect(p.reasoningDelta).toBeUndefined();
    }
  });

  it("思考が無い（null）ことを全文で運ぶ（JSON を通っても null が残る）", () => {
    // キーごと消えると、受け手には差分と区別がつかない
    const p = JSON.parse(JSON.stringify(reasoningPayload(null, 30, false)));
    expect(p).toHaveProperty("reasoning", null);
    expect(p.reasoningLength).toBe(0);
    expect(applyReasoningPayload(THOUGHT, p)).toEqual({ reasoning: null });
  });

  it("差分を継ぎ足す・全文は置き換える", () => {
    expect(
      applyReasoningPayload("まず", {
        reasoningDelta: "前提を",
        reasoningLength: 5,
      }),
    ).toEqual({ reasoning: "まず前提を" });
    expect(
      applyReasoningPayload("古い思考", {
        reasoning: "新しい",
        reasoningLength: 3,
      }),
    ).toEqual({ reasoning: "新しい" });
  });

  it("長さが合わなければ null（取り直させる）", () => {
    expect(
      applyReasoningPayload("まず", { reasoningDelta: "前", reasoningLength: 99 }),
    ).toBeNull();
    // 手元より縮んだ（サーバーの思考が 2 文字しかない）のに差分で来た
    expect(
      applyReasoningPayload("まず前提を", {
        reasoningDelta: "",
        reasoningLength: 2,
      }),
    ).toBeNull();
  });

  it("サーバーと往復させても思考が一致し、確定で消えても追従する", () => {
    const source = "これは長い思考です。".repeat(40);
    let held = "";
    for (let n = 1; n <= source.length; n += 11) {
      const grown = source.slice(0, n);
      const got = applyReasoningPayload(
        held,
        JSON.parse(JSON.stringify(reasoningPayload(grown, held.length, true))),
      );
      expect(got).not.toBeNull();
      held = got!.reasoning ?? "";
      expect(held).toBe(grown);
    }
    // 確定で思考が無くなった（エラーで null を書いた）
    const last = applyReasoningPayload(
      held,
      JSON.parse(JSON.stringify(reasoningPayload(null, held.length, false))),
    );
    expect(last).toEqual({ reasoning: null });
  });
});

describe("パスの指紋", () => {
  const row = (
    id: string,
    status: string | null = null,
    flushed: number | null = null,
  ) => ({ id, status, flushed_at: flushed });

  it("同じ内容なら同じ札", () => {
    const a = [row("m1", "done", 100), row("m2", "streaming", 200)];
    const b = [row("m1", "done", 100), row("m2", "streaming", 200)];
    expect(pathFingerprint(a)).toBe(pathFingerprint(b));
  });

  it("本文が伸びる（書き込み時刻が動く）と変わる", () => {
    const before = [row("m1", "streaming", 200)];
    const after = [row("m1", "streaming", 201)];
    expect(pathFingerprint(after)).not.toBe(pathFingerprint(before));
  });

  it("確定した瞬間に変わる（時刻が同じでも）", () => {
    const before = [row("m1", "streaming", 200)];
    const after = [row("m1", "done", 200)];
    expect(pathFingerprint(after)).not.toBe(pathFingerprint(before));
  });

  it("枝を切り替えると変わる（件数が同じでも）", () => {
    const before = [row("m1", "done", 1), row("m2", "done", 2)];
    const after = [row("m1", "done", 1), row("m3", "done", 2)];
    expect(pathFingerprint(after)).not.toBe(pathFingerprint(before));
  });

  it("応答が積まれると変わる", () => {
    const before = [row("m1", "streaming", 1)];
    const after = [row("m1", "streaming", 1), row("m2", "done", 1)];
    expect(pathFingerprint(after)).not.toBe(pathFingerprint(before));
  });

  it("並びが入れ替わっただけでも変わる", () => {
    const a = [row("m1", "done", 1), row("m2", "done", 2)];
    const b = [row("m2", "done", 2), row("m1", "done", 1)];
    expect(pathFingerprint(a)).not.toBe(pathFingerprint(b));
  });

  const HEADING = formatRetryProgress({
    target: 3,
    successes: 1,
    attempts: 2,
    maxAttempts: 10,
    refusals: 1,
    emptyResponses: 0,
    transients: 0,
    running: 1,
    slots: 2,
    waitSeconds: 0,
    stopping: false,
  });

  it("生成中の見出しは、書き込み時刻が動いても・進捗が変わっても同じ札", () => {
    /*
     * 司令役は見出しを毎秒書き直す（数字が同じでも時刻は動く）。札に
     * 入れると最初の2分はほぼ一度も 304 にならなかった。進捗は 304 に
     * 添えて別に届けるので、札には入れない。
     */
    const at = (flushed: number, content: string) => [
      { id: "h1", status: "streaming", flushed_at: flushed, content },
      row("s1", "done", 5),
    ];
    const before = pathFingerprint(at(100, HEADING));
    expect(pathFingerprint(at(101, HEADING))).toBe(before);
    expect(
      pathFingerprint(at(102, HEADING.replace("成功 1/3", "成功 2/3"))),
    ).toBe(before);
  });

  it("見出しでも、確定した瞬間には変わる", () => {
    const heading = { id: "h1", status: "streaming", flushed_at: 1, content: HEADING };
    const after = { ...heading, status: "done", content: "**完了**" };
    expect(pathFingerprint([after])).not.toBe(pathFingerprint([heading]));
  });

  it("区切り線・兄弟・添付・縮小版の有無で変わる", () => {
    const base = {
      id: "m1",
      status: "done",
      flushed_at: 1,
      context_boundary: 0,
      sibling_ids: ["m1"],
      attachments: [{ id: "f1", thumb_at: null as number | null }],
    };
    const tag = pathFingerprint([base]);
    expect(pathFingerprint([{ ...base, context_boundary: 1 }])).not.toBe(tag);
    expect(pathFingerprint([{ ...base, sibling_ids: ["m1", "m2"] }])).not.toBe(tag);
    expect(
      pathFingerprint([{ ...base, attachments: [...base.attachments, { id: "f2", thumb_at: null }] }]),
    ).not.toBe(tag);
    expect(pathFingerprint([{ ...base, attachments: [{ id: "f1", thumb_at: 5 }] }])).not.toBe(tag);
  });

  it("ETag の形をしている", () => {
    expect(pathFingerprint([row("m1")])).toMatch(/^W\/"[\w-]+"$/);
  });
});

describe("失敗が続くときの待ち", () => {
  it("失敗のたびに倍にし、上限で頭打ちにする", () => {
    expect(pollBackoffMs(0, 400)).toBe(400);
    expect(pollBackoffMs(1, 400)).toBe(400);
    expect(pollBackoffMs(2, 400)).toBe(800);
    expect(pollBackoffMs(3, 400)).toBe(1600);
    expect(pollBackoffMs(6, 400)).toBe(POLL_BACKOFF_MAX_MS);
    // 桁が大きくても伸び続けない（2**n が Infinity になっても上限）
    expect(pollBackoffMs(2000, 400)).toBe(POLL_BACKOFF_MAX_MS);
  });
});

describe("304 に添える見出しの進捗", () => {
  it("日本語の1行をヘッダーに載せて、読み戻せる", () => {
    const p = { id: "h1", content: "生成中… 成功 1/3・待ち 2本" };
    const raw = encodeRunProgress(p);
    // ヘッダーは ASCII しか通らない
    expect(raw).toMatch(/^[\x21-\x7e]+$/);
    expect(decodeRunProgress(raw)).toEqual(p);
  });

  it("壊れた値・無い値は null（画面を壊れた値で上書きしない）", () => {
    expect(decodeRunProgress(null)).toBeNull();
    expect(decodeRunProgress("%E0%A4%A")).toBeNull();
    expect(decodeRunProgress(encodeURIComponent("{\"id\":1}"))).toBeNull();
  });

  it("パスの中の生成中の見出しを拾う（確定した見出し・ふつうの生成中は拾わない）", () => {
    const heading = "生成中… 成功 0/1・投げた 0/5";
    expect(
      liveProgressOf([
        { id: "n1", status: "streaming", content: null },
        { id: "h1", status: "streaming", content: heading },
      ]),
    ).toEqual({ id: "h1", content: heading });
    expect(liveProgressOf([{ id: "h1", status: "done", content: heading }])).toBeNull();
    expect(liveProgressOf([{ id: "n1", status: "streaming", content: "ふつうの本文" }])).toBeNull();
  });
});

describe("変わっていない行を使い回す", () => {
  const a = { id: "a", content: "一", status: undefined as string | undefined };
  const b = { id: "b", content: "二", attachments: [{ id: "f1" }] };

  it("中身が同じ行は前の物をそのまま使い、全部同じなら配列ごと前の物を返す", () => {
    const prev = [a, b];
    // JSON から作り直した行（中身は同じでも別の物）
    const fresh = JSON.parse(JSON.stringify(prev)) as typeof prev;
    expect(fresh[0]).not.toBe(a);
    const next = reuseUnchangedRows(prev, fresh);
    expect(next).toBe(prev);
  });

  it("変わった行だけ新しい物になる", () => {
    const prev = [a, b];
    const fresh = [
      { id: "a", content: "一" },
      { id: "b", content: "二", attachments: [{ id: "f1" }, { id: "f2" }] },
      { id: "c", content: "三" },
    ];
    const next = reuseUnchangedRows(prev, fresh);
    expect(next).not.toBe(prev);
    expect(next[0]).toBe(a);
    expect(next[1]).toBe(fresh[1]);
    expect(next[2]).toBe(fresh[2]);
  });

  it("入れ子の中身まで比べる（添付が入れ替わったら新しい物）", () => {
    const fresh = [a, { id: "b", content: "二", attachments: [{ id: "f9" }] }];
    const next = reuseUnchangedRows([a, b], fresh);
    expect(next[1]).toBe(fresh[1]);
  });

  it("並びが変わったら、行が同じでも配列は新しくする", () => {
    const next = reuseUnchangedRows([a, b], [b, a]);
    expect(next).toEqual([b, a]);
    expect(next[0]).toBe(b);
  });

  it("行が減ったら配列は新しくする", () => {
    const next = reuseUnchangedRows([a, b], [a]);
    expect(next).toEqual([a]);
  });
});

describe("並びに結んだ札", () => {
  it("札で受け取った並びそのものにだけ札が付く", () => {
    const list = [{ id: "a" }];
    rememberPathTag(list, 'W/"1-x"');
    expect(pathTagOf(list)).toBe('W/"1-x"');
    // 中身が同じでも別の並び（手元で作り直した）には付かない
    expect(pathTagOf([...list])).toBeNull();
    // 札が無い応答では何も結ばない
    const other = [{ id: "b" }];
    rememberPathTag(other, null);
    expect(pathTagOf(other)).toBeNull();
  });
});
