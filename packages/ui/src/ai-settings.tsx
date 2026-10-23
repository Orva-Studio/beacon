import { useState } from "react";
import type { PreferenceInfo, SecretInfo } from "@beacon/core";
import { NumberBox, Select, SettingsRow as Row } from "./controls";
import { SecretRow, type TranscriptsHost } from "./transcripts-settings";

/** Every API key Beacon keeps, in the order shown, with what it is used for (and when audio leaves the Mac). */
const KEYS: { id: string; label: string; use: string; placeholder: string }[] = [
  { id: "openai-api-key", label: "OpenAI", use: "Transcribing (uploads audio), Best Take, planning B-roll", placeholder: "sk-…" },
  { id: "replicate-api-token", label: "Replicate", use: "Making B-roll footage", placeholder: "r8_…" },
  { id: "auphonic-api-key", label: "Auphonic", use: "Clean with Auphonic (uploads audio)", placeholder: "Auphonic API key" },
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
  const pick = (id: string, label: string, hint = true) => {
    const pref = prefs.find((p) => p.id === id);
    if (!pref) return null;
    return (
      <Row label={label} hint={hint ? pref.options.find((o) => o.id === pref.value)?.description : undefined}>
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
      <div className="-mt-2 text-caption text-text-faint">Kept in this Mac's Keychain. Each service charges your own account.</div>
      {KEYS.map((k) => {
        const secret = secrets.find((s) => s.id === k.id);
        return secret && <SecretRow key={k.id} secret={secret} label={k.label} use={k.use} placeholder={k.placeholder} host={host} saved={saved(k.id)} />;
      })}
      <div className="mt-2 text-label font-medium text-text-muted">B-roll</div>
      {pick("brollModel", "Model")}
      {pick("brollResolution", "Resolution", false)}
      <Row label="Limit" hint="Per generation. 0 is no limit.">
        <div className="flex items-center gap-2" data-preference="brollLimit">
          <span className="text-text-muted">$</span>
          <NumberBox value={limit} digits={2} step={1} min={0} max={1000} width={70} onCommit={(v) => void set("brollLimit", String(Math.round(v * 100) / 100))} />
        </div>
      </Row>
      {error && <div className="text-danger">{error}</div>}
    </div>
  );
}
