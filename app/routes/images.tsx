import { useState } from "react";
import { Link, useOutletContext } from "react-router";
import type { Route } from "./+types/images";
import type { ShellContext } from "./shell";
import { listGeneratedImages } from "../lib/db.server";
import { Lightbox } from "../components/Lightbox";
import { IconMenu } from "../components/icons";

export function meta({}: Route.MetaArgs) {
  return [{ title: "画像 - Chat WebUI" }];
}

/** 一度に読む枚数。続きは「もっと見る」で足す。 */
const PAGE_SIZE = 60;

export async function loader() {
  return { images: await listGeneratedImages({ limit: PAGE_SIZE }) };
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export default function Images({ loaderData }: Route.ComponentProps) {
  const { openSidebar } = useOutletContext<ShellContext>();
  const [images, setImages] = useState(loaderData.images);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // 最後のページより少なければ、続きは無い
  const [exhausted, setExhausted] = useState(
    loaderData.images.length < PAGE_SIZE,
  );

  async function loadMore() {
    const last = images[images.length - 1];
    if (!last || loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/images?before=${last.created_at}`);
      const body = (await res.json()) as { images: typeof images };
      setImages([...images, ...body.images]);
      if (body.images.length < PAGE_SIZE) setExhausted(true);
    } catch {
      // 失敗しても既に出ている分はそのまま
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-1 border-b border-neutral-100 px-3 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] dark:border-neutral-800">
        <button
          type="button"
          onClick={openSidebar}
          aria-label="メニュー"
          className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100 md:hidden dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          <IconMenu className="h-5 w-5" />
        </button>
        <h1 className="px-1 text-sm font-semibold tracking-tight">画像</h1>
        {images.length > 0 && (
          <span className="ml-2 text-xs text-neutral-400 dark:text-neutral-500">
            {images.length}枚
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {images.length === 0 ? (
          <p className="mt-16 text-center text-sm text-neutral-400 dark:text-neutral-500">
            生成された画像がここに並びます
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {images.map((img) => (
                <div key={img.id} className="group/img">
                  <button
                    type="button"
                    onClick={() => setLightbox(img.id)}
                    className="block w-full overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900"
                  >
                    <img
                      src={`/api/files/${img.id}`}
                      alt="生成画像"
                      loading="lazy"
                      className="aspect-square w-full object-cover transition-transform group-hover/img:scale-[1.02]"
                    />
                  </button>
                  <div className="mt-1 flex items-baseline gap-2 px-0.5 text-[11px] text-neutral-400 dark:text-neutral-500">
                    <span className="shrink-0">
                      {formatDate(img.created_at)}
                    </span>
                    {img.conversation_id && (
                      <Link
                        to={`/chat/${img.conversation_id}`}
                        className="min-w-0 truncate hover:text-accent"
                        title={img.title ?? undefined}
                      >
                        {img.title ?? "会話を開く"}
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {!exhausted && (
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loading}
                  className="rounded-xl border border-neutral-200 px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
                >
                  {loading ? "読み込み中…" : "もっと見る"}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {lightbox && (
        <Lightbox id={lightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}
