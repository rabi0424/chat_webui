import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createRoutesStub,
  useLoaderData,
  useOutletContext,
} from "react-router";
import Shell, { shouldRevalidate, type ShellContext } from "../../app/routes/shell";
import Settings from "../../app/routes/settings";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../../app/lib/settings";

/**
 * 設定の保存は、シェルのローダーを取り直さずに会話画面へ届ける。
 *
 * 以前は保存のたびに revalidate していた。シェルのローダーは会話200件・
 * ボット・フォルダ・設定をまとめて返す（約100KB）ので、システム
 * プロンプトを打っていると手を止めるたび（300ms）に一覧を丸ごと取り直し、
 * サイドバーの全行まで描き直していた。
 *
 * 本物のシェルの下に設定画面と「文脈を読むだけの部品」（会話画面の
 * 代わり）を並べ、シェルのローダーが何回走ったかを数える。
 */
let shellLoads: number;
let serverSettings: AppSettings;
let latest: number;
/** 立てておくと、設定の PATCH の返事をここへ止める。 */
let holdPatch: (() => void)[] | null;

function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (path.includes("/api/settings") && init?.method === "PATCH") {
      serverSettings = {
        ...serverSettings,
        ...(JSON.parse(String(init.body)) as Partial<AppSettings>),
      };
      const reply = json({ settings: serverSettings });
      if (holdPatch) {
        const queue = holdPatch;
        return new Promise<Response>((resolve) =>
          queue.push(() => resolve(reply)),
        );
      }
      return reply;
    }
    if (path.includes("/api/models")) return json({ models: [] });
    if (path.includes("/api/fx")) return json({ usdJpy: 150 });
    if (path.includes("/api/conversations/unread")) {
      return json({ ids: [], generating: [], latest });
    }
    return json({ ok: true });
  }) as typeof fetch;
}

/** 会話画面の代わり。シェルの文脈の設定を出すだけ。 */
function Probe() {
  const { settings } = useOutletContext<ShellContext>();
  return <output data-testid="probe">{settings.defaultSystemPrompt}</output>;
}

function ShellRoute() {
  const loaderData = useLoaderData();
  return <Shell {...({ loaderData } as never)} />;
}

function renderApp() {
  const Stub = createRoutesStub([
    {
      id: "routes/shell",
      path: "/",
      Component: ShellRoute,
      HydrateFallback: () => null,
      loader: () => {
        shellLoads++;
        return {
          conversations: [],
          bots: [],
          folders: [],
          settings: serverSettings,
          now: 1_700_000_000_000,
        };
      },
      shouldRevalidate,
      children: [
        {
          path: "settings",
          Component: () => (
            <>
              <Settings
                {...({
                  loaderData: { settings: serverSettings, now: 1_700_000_000_000 },
                } as never)}
              />
              <Probe />
            </>
          ),
        },
      ],
    },
  ]);
  render(<Stub initialEntries={["/settings"]} />);
  return userEvent.setup();
}

/** 未読の引き直しを1回起こす（一覧が動いていれば、シェルを取り直す）。 */
async function poll() {
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  localStorage.clear();
  shellLoads = 0;
  serverSettings = DEFAULT_APP_SETTINGS;
  latest = 100;
  holdPatch = null;
  installFetch();
});

describe("設定の保存とシェル", () => {
  it("保存してもシェルは取り直さず、会話画面は新しい値を見る", async () => {
    const user = renderApp();
    const box = await screen.findByLabelText("既定のシステムプロンプト");
    await poll();
    const loadsBefore = shellLoads;
    expect(loadsBefore).toBeGreaterThan(0);

    await user.type(box, "結論から");
    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent("結論から"),
    );
    // 保存は済んでいる（サーバーに届いた値が出ている）
    expect(serverSettings.defaultSystemPrompt).toBe("結論から");
    await waitFor(() =>
      expect(screen.getAllByText("保存しました").length).toBeGreaterThan(0),
    );
    // 一度もシェルを取り直していない
    expect(shellLoads).toBe(loadsBefore);
  });

  it("シェルを取り直したら、その値を正とする（別の端末で変えた設定が届く）", async () => {
    const user = renderApp();
    const box = await screen.findByLabelText("既定のシステムプロンプト");
    await poll();
    await user.type(box, "手元");
    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent("手元"),
    );

    // 別の端末で変わり、一覧も動いた
    serverSettings = { ...serverSettings, defaultSystemPrompt: "別の端末" };
    latest = 200;
    const loadsBefore = shellLoads;
    await poll();
    await waitFor(() => expect(shellLoads).toBe(loadsBefore + 1));
    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent("別の端末"),
    );
  });

  /**
   * 返事を待っているあいだにシェルが取り直されても、差し替えが効くこと。
   * 設定画面は送る前に掴んだ手続きを返事の後で呼ぶので、手続きが
   * 「そのときのローダーの値」を抱えていると、取り直し後は別の値の上に
   * 貼ったことになり、黙って無視される。
   */
  it("返事を待つあいだにシェルが取り直されても、会話画面に届く", async () => {
    const user = renderApp();
    const box = await screen.findByLabelText("既定のシステムプロンプト");
    await poll();
    holdPatch = [];
    await user.type(box, "待つあいだ");
    await waitFor(() => expect(holdPatch).toHaveLength(1));

    // 返事の前に、一覧が動いてシェルが取り直された（まだ古い設定の時点の値）
    const loadsBefore = shellLoads;
    serverSettings = { ...serverSettings, defaultSystemPrompt: "" };
    latest = 300;
    await poll();
    await waitFor(() => expect(shellLoads).toBe(loadsBefore + 1));
    expect(screen.getByTestId("probe")).toHaveTextContent("");

    serverSettings = { ...serverSettings, defaultSystemPrompt: "待つあいだ" };
    await act(async () => {
      holdPatch![0]();
    });
    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent("待つあいだ"),
    );
  });
});
