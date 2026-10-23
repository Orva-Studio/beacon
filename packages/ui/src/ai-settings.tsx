import { useState } from "react";
import type { PreferenceInfo, SecretInfo } from "@beacon/core";
import { NumberBox, Select, SettingsRow as Row } from "./controls";
import { SecretRow, type TranscriptsHost } from "./transcripts-settings";

/** Every API key Beacon keeps, in the order shown: what it is for, what is sent, who charges. */
const KEYS: { id: string; label: string; sends: string; charges: string; placeholder: string }[] = [
  {
    id: "openai-api-key",
    label: "OpenAI API Key",
    sends: "Audio is uploaded to OpenAI when it transcribes; the words of retakes and of a B-roll range (not the audio) when it picks a take or plans B-roll",
    charges: "OpenAI",
    placeholder: "sk-…",
  },
  { id: "replicate-api-token", label: "Replicate API Token", sends: "Each B-roll shot's prompt and the region's shape are sent to Replicate", charges: "Replicate", placeholder: "r8_… from replicate.com › Account › API tokens" },
  { id: "auphonic-api-key", label: "Auphonic API Key", sends: "Audio you clean with Auphonic is uploaded to it", charges: "Auphonic", placeholder: "From auphonic.com › Account Settings" },
];

/** A choice made elsewhere in Settings that waits for a key: once the key is saved here, it is made and Settings goes back. */
export interface WaitingChoice {
  pref: string;
  value: string;
  /** The key it needs. */
  secret: string;
  back: () => void;
}

/**
 * Settings › AI: every API key Beacon keeps, and what B-roll is made with (the model, its resolution, a limit per
 * generation).
 */
export function AiSettings({ prefs, secrets, host, changed, keySet, waiting }: {
  prefs: PreferenceInfo[];
  secrets: SecretInfo[];
  host: TranscriptsHost;
  changed: (prefs: PreferenceInfo[]) => void;
  /** A key saved or removed here, for Settings to show it so on its other tabs and when this one opens again. */
  keySet: (id: string, set: boolean) => void;
  waiting?: WaitingChoice;
}) {
  const [error, setError] = useState<string>();
  const set = async (id: string, value: string) => {
    const r = await host.setPreference(id, value);
    if (r.ok && r.result) changed(r.result);
    setError(r.ok ? undefined : r.error);
  };
  const saved = (id: string) => async (on: boolean, now?: PreferenceInfo[]) => {
    keySet(id, on);
    if (now) changed(now);
    if (!on || waiting?.secret !== id) return;
    await set(waiting.pref, waiting.value);
    waiting.back();
  };
  const pick = (id: string, label: string) => {
    const pref = prefs.find((p) => p.id === id);
    if (!pref) return null;
    return (
      <Row label={label} hint={pref.options.find((o) => o.id === pref.value)?.description}>
        <div className="w-56">
          <Select data-preference={id} value={pref.value} onChange={(e) => void set(id, e.target.value)}>
            {pref.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
          </Select>
        </div>
      </Row>
    );
  };
  const limit = Number(prefs.find((p) => p.id === "brollLimit")?.value ?? 0);
  return (
    <div className="flex flex-col gap-3" data-ai-settings>
      <div className="text-label font-medium text-text-muted">API Keys</div>
      {KEYS.map((k) => {
        const secret = secrets.find((s) => s.id === k.id);
        return secret && <SecretRow key={k.id} secret={secret} label={k.label} sends={k.sends} charges={k.charges} placeholder={k.placeholder} host={host} saved={saved(k.id)} />;
      })}
      <div className="mt-2 text-label font-medium text-text-muted">B-roll</div>
      {pick("brollModel", "Model")}
      {pick("brollResolution", "Resolution")}
      <Row label="Limit" hint="What one generation may cost at most, by the estimate shown before it runs; 0 is no limit.">
        <div className="flex items-center gap-2" data-preference="brollLimit">
          <span className="text-text-muted">$</span>
          <NumberBox value={limit} digits={2} step={1} min={0} max={1000} width={70} onCommit={(v) => void set("brollLimit", String(Math.round(v * 100) / 100))} />
        </div>
      </Row>
      {error && <div className="text-danger">{error}</div>}
    </div>
  );
}
