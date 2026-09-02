import { useOutletContext } from "react-router";
import type { ShellContext } from "./shell";
import { BotForm } from "../components/BotForm";

export function meta() {
  return [{ title: "新しいボット - Chat" }];
}

export default function BotNew() {
  const { models, settings } = useOutletContext<ShellContext>();
  return (
    <div className="h-full">
      <BotForm
        models={models}
        retryCeiling={settings.retryAttemptCeiling}
        newModelDays={settings.newModelDays}
      />
    </div>
  );
}


// 例外の受け皿はこのルートに置く。root に任せると文書ごと
// 差し替わり、サイドバーまで消えて戻る導線が無くなる
export { RouteError as ErrorBoundary } from "../components/RouteError";
