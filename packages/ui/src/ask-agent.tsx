import { useEffect, useState } from "react";
import type { AgentAbout, AgentSession } from "@beacon/core";
import { agentName, assetName, clipEnd, ticksToSeconds, type Clip, type Section } from "@beacon/model";
import { Button, Modal, Select, TextArea, Toast } from "./controls";
import { replica, useView, type AgentRequest } from "./store";
import type { Host } from "./app";
import { clock } from "./time";

export { agentName };

/** Agents that take a request into their open session (Claude Code's channels); others can't be sent one yet. */
const TAKES_REQUESTS = new Set(["claude-code"]);

/** How to start a session that takes requests from Beacon, in the project's folder. */
export const START_COMMAND = "claude --dangerously-load-development-channels server:beacon";

/** Seconds a session has to acknowledge a request before Beacon says it may not take them. */
const ACK_SECONDS = 10;

const project = () => replica.get().opened?.path;

/** A request about a section: its name and span. */
export function aboutSection(s: Section): AgentAbout {
  const [from, to] = [ticksToSeconds(s.start), ticksToSeconds(s.end)];
  return { ...(project() ? { project: project()! } : {}), section: s.id, from, to, label: `Section “${s.name}”, ${clock(from)}–${clock(to)}` };
}

/** A request about a clip: what it is and where. */
export function aboutClip(c: Clip, kind: string): AgentAbout {
  const [from, to] = [ticksToSeconds(c.start), ticksToSeconds(clipEnd(c))];
  const asset = c.assetId ? replica.get().project?.assets[c.assetId] : undefined;
  return { ...(project() ? { project: project()! } : {}), clip: c.id, from, to, label: `${kind}${asset ? ` “${assetName(asset)}”` : ""}, ${clock(from)}–${clock(to)}` };
}

/** A request about what is selected now: the first selected clip, else the in/out range, else the whole project. */
export function aboutSelection(): AgentAbout {
  const { project: doc, session } = replica.get();
  const clip = session?.selection[0] ? doc?.tracks.flatMap((t) => t.clips).find((c) => c.id === session.selection[0]) : undefined;
  if (clip) return aboutClip(clip, "Clip");
  if (session?.range) return { ...(project() ? { project: project()! } : {}), from: session.range.in, to: session.range.out, label: `The range ${clock(session.range.in)}–${clock(session.range.out)}` };
  return { ...(project() ? { project: project()! } : {}), label: "The whole project" };
}

/** The request with what it is about, to paste into any agent. */
function withContext(prompt: string, about: AgentAbout): string {
  const where = [about.project && `project ${about.project}`, about.clip && `clip ${about.clip}`, about.section && `section ${about.section}`, about.from !== undefined && about.to !== undefined && `${about.from.toFixed(2)}–${about.to.toFixed(2)} s`].filter(Boolean);
  return `${prompt}\n\n(In Beacon${where.length ? `: ${where.join(", ")}` : ""}.)`;
}

/** "Ask an agent", while open: the request typed, sent to a Claude Code session working on this project. */
export function AskAgent({ host }: { host: Pick<Host, "agents" | "askAgent"> }) {
  const about = useView((v) => v.askAgent);
  return about ? <AskAgentUi host={host} about={about} /> : null;
}

function AskAgentUi({ host, about }: { host: Pick<Host, "agents" | "askAgent">; about: AgentAbout }) {
  const [sessions, setSessions] = useState<AgentSession[]>();
  const [socket, setSocket] = useState<string>();
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void host.agents().then((all) => {
      const usable = all.filter((a) => a.run || TAKES_REQUESTS.has(a.name));
      setSessions(usable);
      // The one with this project open, else the newest.
      setSocket((usable.find((a) => a.project === about.project) ?? usable[0])?.socket);
    });
  }, [host]);
  const close = () => replica.askAgent(undefined);
  const chosen = sessions?.find((s) => s.socket === socket);
  const send = async () => {
    if (!chosen || !prompt.trim()) return;
    const r = await host.askAgent(chosen.socket, prompt.trim(), about);
    if ("error" in r) return setError(r.error);
    replica.agentSent({ id: r.id, agent: agentName(chosen.name), prompt: prompt.trim(), copy: withContext(prompt.trim(), about), state: "sent", ...(chosen.run ? { run: true } : {}) });
    close();
    if (!chosen.run) setTimeout(() => replica.agentState(r.id, "silent"), ACK_SECONDS * 1000);
  };
  const copy = async () => {
    await navigator.clipboard.writeText(withContext(prompt.trim(), about)).catch(() => {});
    setCopied(true);
  };
  return (
    <Modal title="Ask an Agent" width={520} onClose={close} onEnter={() => void send()}>
      <div className="flex flex-col gap-3" data-ask-agent>
        {about.label && (
          <div className="text-label text-text-muted" data-ask-about>
            About: <span className="text-text-strong">{about.label}</span>
          </div>
        )}
        <TextArea
          autoFocus
          rows={4}
          placeholder="What should it do? (“Make this a counter from 0 to 10,000”, “Lay out this section”)"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            // ↩ sends, as the dialog's Enter does; ⇧↩ is a new line.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          data-ask-prompt
        />
        {sessions === undefined && <div className="text-text-muted">Looking for agents…</div>}
        {sessions && sessions.length > 0 && (
          <label className="flex items-center gap-2">
            <span className="shrink-0 text-label whitespace-nowrap text-text-muted">Send to</span>
            <Select value={socket ?? ""} onChange={(e) => setSocket(e.target.value)} data-ask-session>
              {sessions.map((s) => (
                <option key={s.socket} value={s.socket}>
                  {s.run
                    ? `New run with ${agentName(s.name)}`
                    : `${agentName(s.name)}${s.project ? ` · ${s.project.split("/").pop()}` : ""} · started ${new Date(s.started).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
                </option>
              ))}
            </Select>
          </label>
        )}
        {sessions && !sessions.length && (
          <div className="flex flex-col gap-2 rounded-md bg-groove px-3 py-2" data-ask-none>
            <span className="text-warning">No Claude Code session is connected to Beacon, and Codex isn't installed.</span>
            <span className="text-caption text-text-muted">Start one in the project's folder that takes requests from Beacon:</span>
            <code className="rounded-sm bg-chip px-2 py-1 text-caption text-text-strong select-text">{START_COMMAND}</code>
            <span className="text-caption text-text-faint">Or copy the request with what it's about, and paste it into any agent.</span>
          </div>
        )}
        {error && <div className="text-danger">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button onClick={() => void copy()} disabled={!prompt.trim()} data-ask-copy>
            {copied ? "Copied" : "Copy Prompt"}
          </Button>
          <Button onClick={close}>Cancel</Button>
          <Button look="primary" disabled={!chosen || !prompt.trim()} onClick={() => void send()} data-ask-send>
            Send
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Requests sent to agents: sent, then acknowledged, then what they did; one never acknowledged says why and offers its text. */
export function AgentToasts({ host }: { host: Pick<Host, "cancelJob"> }) {
  const requests = useView((v) => v.agentRequests);
  return requests.map((r) => <AgentToast key={r.id} request={r} host={host} />);
}

function AgentToast({ request: r, host }: { request: AgentRequest; host: Pick<Host, "cancelJob"> }) {
  const [copied, setCopied] = useState(false);
  // A run's job reports its cancelling as a reply whose text is "Cancelled" (LocalCore's #runAgent).
  const cancelled = !!r.run && r.state === "done" && r.text === "Cancelled";
  const title = cancelled ? `${r.agent}: cancelled` : r.state === "done" ? `${r.agent}: done` : r.state === "received" ? `${r.agent} is on it` : r.state === "silent" ? `${r.agent} didn't answer` : `Sent to ${r.agent}`;
  return (
    <Toast title={title} done={r.state === "done"} onDismiss={r.state === "sent" ? undefined : () => replica.dismissAgent(r.id)}>
      <div data-agent-request={r.id} data-agent-state={r.state}>
        {r.state === "done" && r.text && !cancelled ? <div className="text-label text-text">{r.text}</div> : <div className="truncate text-label text-text-muted">{r.prompt}</div>}
        {r.state === "received" && r.text && (
          <div className="mt-1 truncate text-caption text-text-faint" data-agent-step>
            {r.text}
          </div>
        )}
        {r.run && r.state !== "done" && (
          <Button className="mt-2" onClick={() => host.cancelJob(r.id)} data-agent-cancel>
            Cancel
          </Button>
        )}
        {r.state === "silent" && (
          <div className="mt-2 flex flex-col items-start gap-2">
            <span className="text-caption text-text-muted">Its session may not take requests from Beacon: start one with</span>
            <code className="rounded-sm bg-chip px-2 py-1 text-caption text-text-strong select-text">{START_COMMAND}</code>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(r.copy).catch(() => {});
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy Prompt"}
            </Button>
          </div>
        )}
      </div>
    </Toast>
  );
}
