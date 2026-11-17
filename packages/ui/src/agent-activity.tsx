import { useEffect, useState } from "react";
import { agentName } from "@beacon/model";
import { Toast } from "./controls";
import { replica, useView } from "./store";

export { agentName };

/** Seconds without word from an agent before its toast says it stopped, and goes. */
const IDLE_SECONDS = 15;

/** Agents working on the project from outside (a terminal): what each is doing now, until it goes quiet. */
export function AgentActivity() {
  const activity = useView((v) => v.agentActivity);
  return Object.entries(activity).map(([agent, a]) => <ActivityToast key={agent} agent={agent} text={a.text} at={a.at} />);
}

function ActivityToast({ agent, text, at }: { agent: string; text: string; at: number }) {
  const [quiet, setQuiet] = useState(false);
  useEffect(() => {
    setQuiet(false);
    const t = setTimeout(() => setQuiet(true), Math.max(0, at + IDLE_SECONDS * 1000 - Date.now()));
    return () => clearTimeout(t);
  }, [at]);
  return (
    <Toast title={quiet ? `${agent} stopped` : `${agent} is working`} done={quiet} onDismiss={() => replica.dismissActivity(agent)}>
      <div className="truncate text-label text-text-muted" data-agent-activity={agent} data-agent-quiet={quiet || undefined}>
        {text}
      </div>
    </Toast>
  );
}
