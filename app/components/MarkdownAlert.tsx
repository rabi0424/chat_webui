import type { ReactNode } from "react";
import type { AlertType } from "../lib/remark-alert";
import {
  IconExclamationCircle,
  IconInfo,
  IconLightBulb,
  IconMegaphone,
  IconWarningTriangle,
} from "./icons";

/**
 * 見出しの文言とアイコン。
 *
 * GitHub での強さは note < tip < important < warning < caution なので、
 * 黄色の warning を「注意」、赤の caution を「警告」に当てている。
 */
const ALERTS: Record<
  AlertType,
  { label: string; Icon: (props: { className?: string }) => ReactNode }
> = {
  note: { label: "メモ", Icon: IconInfo },
  tip: { label: "ヒント", Icon: IconLightBulb },
  important: { label: "重要", Icon: IconMegaphone },
  warning: { label: "注意", Icon: IconWarningTriangle },
  caution: { label: "警告", Icon: IconExclamationCircle },
};

/**
 * `> [!NOTE]` などの警告ブロック。
 *
 * 中身はふつうの本文なので prose の装飾はそのまま活かし、枠と配色だけを
 * app.css の `.md-alert` で付ける。
 */
export function MarkdownAlert({
  type,
  children,
}: {
  type: AlertType;
  children?: ReactNode;
}) {
  const { label, Icon } = ALERTS[type];
  return (
    <div className={`md-alert md-alert-${type}`}>
      <p className="md-alert-title">
        <Icon className="h-[1.1em] w-[1.1em] shrink-0" />
        {label}
      </p>
      {children}
    </div>
  );
}
