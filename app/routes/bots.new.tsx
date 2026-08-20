import { useOutletContext } from "react-router";
import type { ShellContext } from "./shell";
import { BotForm } from "../components/BotForm";

export function meta() {
  return [{ title: "新しいボット - Chat WebUI" }];
}

export default function BotNew() {
  const { models, settings } = useOutletContext<ShellContext>();
  return (
    <div className="h-full overflow-y-auto">
      <BotForm
        models={models}
        retryCeiling={settings.retryAttemptCeiling}
        newModelDays={settings.newModelDays}
      />
    </div>
  );
}
