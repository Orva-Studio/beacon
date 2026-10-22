import { useEffect, useRef, useState } from "react";
import { Button, PLAIN_TEXT, Select, SettingsRow as Row } from "./controls";
import type { ResourceInfo } from "./resource";
import { replica } from "./store";
import { useOnline } from "./online";

import type { PreferenceInfo } from "@beacon/core";

export type { PreferenceInfo };

type Reply = { ok: boolean; error?: string; result?: PreferenceInfo[] };

export interface TranscriptsHost {
  setPreference(id: string, value: string): Promise<Reply>;
  /** Saves a secret (an API key) in the Keychain, or removes it (null); replies with the preferences as they now are. */
  setSecret(id: string, value: string | null): Promise<Reply>;
}

/**
 * A preference in Settings › Transcripts, with the API key its online option needs (kept in the Keychain): who
 * transcribes (Whisper on this Mac, Apple's transcriber, or Whisper through OpenAI's API), with Whisper's model when
 * it is the one chosen; who picks the best take. `changed` gets every preference after a change, as a key is shared.
 */
export function TranscriptsSettings({ pref, label = "Transcripts", sends = "Your audio is uploaded to OpenAI to be transcribed", charges = "OpenAI", placeholder = "sk-…", offline, model, close, host, changed }: {
  pref: PreferenceInfo;
  label?: string;
  /** What the online option sends, in the key's hint. */
  sends?: string;
  /** Who bills the user for it. */
  charges?: string;
  placeholder?: string;
  /** What works while offline, after "You're offline: X can't … until you're back online.". */
  offline?: string;
  model?: ResourceInfo;
  close: () => void;
  host: TranscriptsHost;
  changed: (prefs: PreferenceInfo[]) => void;
}) {
  /** Shown, not yet applied: an option whose key isn't set waits for it. */
  const [choice, setChoice] = useState(pref.value);
  // Changed from elsewhere (the shared key removed in another row): shown. Its own changes' replies would undo a newer choice.
  const applied = useRef(pref.value);
  useEffect(() => {
    if (pref.value !== applied.current) setChoice((applied.current = pref.value));
  }, [pref.value]);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string>();
  const option = pref.options.find((o) => o.id === choice)!;
  const online = useOnline();
  const apply = async (value: string) => {
    applied.current = value;
    const r = await host.setPreference(pref.id, value);
    if (r.ok && r.result) changed(r.result);
    setError(r.ok ? undefined : r.error);
  };
  const choose = (value: string) => {
    setChoice(value);
    setError(undefined);
    const o = pref.options.find((x) => x.id === value)!;
    if (!o.secret || o.secret.set) void apply(value);
  };
  const saveKey = async (value: string | null) => {
    const r = await host.setSecret(option.secret!.id, value);
    if (!r.ok) return setError(r.error);
    setKey("");
    const now = r.result!.find((p) => p.id === pref.id)!;
    if (value === null) applied.current = now.value;
    changed(r.result!);
    if (value !== null) await apply(choice);
    else {
      setChoice(now.value);
      setError(undefined);
    }
  };
  return (
    <div className="contents" data-preference-row={pref.id}>
      <Row label={label} hint={option.description}>
        <div className="w-56">
          <Select data-preference={pref.id} {...(pref.id === "transcriber" ? { "data-transcriber": true } : {})} value={choice} onChange={(e) => choose(e.target.value)}>
            {pref.options.map((o) => (
              <option key={o.id} value={o.id} disabled={!online && !!o.online && o.id !== choice}>
                {o.title}
                {!online && o.online ? " (needs the internet)" : ""}
              </option>
            ))}
          </Select>
        </div>
      </Row>
      {!online && option.online && (
        <Row label="" hint="">
          <span className="text-caption text-warning" data-offline>
            You're offline: {option.title} can't {pref.id === "transcriber" ? "transcribe" : "be asked"} until you're back online.{offline ? ` ${offline}` : ""}
          </span>
        </Row>
      )}
      {option.secret && (
        <Row
          label="API Key"
          hint={
            <div className="mt-1 text-caption text-text-faint">
              <span className="text-warning">{sends}</span>, and {charges} charges your account. The key is kept in this Mac's Keychain, never in a
              file.
              {error && <div className="mt-1 text-danger">{error}</div>}
            </div>
          }
        >
          {option.secret.set ? (
            <div className="flex items-center gap-3" data-api-key="set">
              <span className="text-text-muted">Saved in the Keychain</span>
              <Button look="quiet" onClick={() => void saveKey(null)}>
                Remove
              </Button>
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-2" data-api-key="unset">
              <input
                {...PLAIN_TEXT}
                type="password"
                autoComplete="new-password"
                placeholder={placeholder}
                className="min-w-0 flex-1 rounded-md border border-transparent bg-chip px-2 py-1.5 text-text-strong outline-none focus:border-accent"
                value={key}
                onChange={(e) => (setKey(e.target.value), setError(undefined))}
                onKeyDown={(e) => e.key === "Enter" && key.trim() && (e.stopPropagation(), void saveKey(key.trim()))}
              />
              <Button look="primary" disabled={!key.trim()} onClick={() => void saveKey(key.trim())}>
                Save and Use
              </Button>
            </div>
          )}
        </Row>
      )}
      {!option.secret && error && <div className="text-danger">{error}</div>}
      {choice === "whisper" && model && (
        <Row label="" hint={`Made on this Mac with the ${model.title}${model.present ? "." : `, a one-time download of about ${Math.round(model.bytes / 1e6)} MB.`}`}>
          <div className="flex items-center gap-3" data-resource-row={model.id}>
            {model.present ? (
              <span className="text-text-muted">Speech model downloaded</span>
            ) : (
              <Button disabled={!online} title={online ? undefined : "Needs the internet: you're offline"} onClick={() => (close(), replica.resource(model))}>
                Download Speech Model…
              </Button>
            )}
          </div>
        </Row>
      )}
    </div>
  );
}
