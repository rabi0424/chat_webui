/**
 * アプリ全体で使うアイコンセット。
 *
 * Heroicons (outline, 24px, MIT) のパスデータをストローク描画で統一する。
 * 以前は各所に手書きコピーした20px solidのパスが混在し、viewBoxぎりぎりの
 * 図形が欠けて見える問題があったため、検証済みのこのセットに一本化した。
 * 追加するときも必ず 24px outline 系から取ること。
 */

interface IconProps {
  className?: string;
}

function makeIcon(children: React.ReactNode) {
  return function Icon({ className = "h-5 w-5" }: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden
      >
        {children}
      </svg>
    );
  };
}

/** ハンバーガーメニュー (bars-3) */
export const IconMenu = makeIcon(
  <path d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />,
);

/** 生成パラメータ (adjustments-horizontal) */
export const IconSliders = makeIcon(
  <path d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75" />,
);

/** 追加・添付 (plus) */
export const IconPlus = makeIcon(<path d="M12 4.5v15m7.5-7.5h-15" />);

/** 送信 (arrow-up) */
export const IconArrowUp = makeIcon(
  <path d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />,
);

/** コピー (square-2-stack) */
export const IconCopy = makeIcon(
  <path d="M16.5 8.25V6a2.25 2.25 0 0 0-2.25-2.25H6A2.25 2.25 0 0 0 3.75 6v8.25A2.25 2.25 0 0 0 6 16.5h2.25m8.25-8.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-7.5A2.25 2.25 0 0 1 8.25 18v-7.5a2.25 2.25 0 0 1 2.25-2.25h6Z" />,
);

/** 完了チェック (check) */
export const IconCheck = makeIcon(<path d="m4.5 12.75 6 6 9-13.5" />);

/** 詳細情報 (information-circle) */
export const IconInfo = makeIcon(
  <path d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />,
);

/** 編集 (pencil) */
export const IconPencil = makeIcon(
  <path d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" />,
);

/** 削除 (trash) */
export const IconTrash = makeIcon(
  <path d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />,
);

/** 検索 (magnifying-glass) */
export const IconSearch = makeIcon(
  <path d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />,
);

/** 閉じる (x-mark) */
export const IconX = makeIcon(<path d="M6 18 18 6M6 6l12 12" />);

/** シェブロン (chevron-down / -right / -left) */
export const IconChevronDown = makeIcon(<path d="m19.5 8.25-7.5 7.5-7.5-7.5" />);
export const IconChevronRight = makeIcon(<path d="m8.25 4.5 7.5 7.5-7.5 7.5" />);

/** 戻る (arrow-left) */
export const IconArrowLeft = makeIcon(
  <path d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />,
);

/** Web検索 (globe-alt) */
export const IconGlobe = makeIcon(
  <path d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m-18.716-2.918A8.959 8.959 0 0 0 3 12c0 .778.099 1.533.284 2.253m0 0A17.919 17.919 0 0 0 12 16.5c3.162 0 6.133-.815 8.716-2.253" />,
);

/** テーマ: ライト (sun) */
export const IconSun = makeIcon(
  <path d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />,
);

/** テーマ: ダーク (moon) */
export const IconMoon = makeIcon(
  <path d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" />,
);

/** テーマ: 自動 (computer-desktop) */
export const IconAuto = makeIcon(
  <path d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25" />,
);

/** 行メニュー (ellipsis)。小さな点はストロークだと痩せるため塗りで描く。 */
export function IconEllipsis({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}
