import { useState } from "react";
import { NumberBox, Select, SettingsRow as Row } from "./controls";
import { SecretRow, type TranscriptsHost } from "./transcripts-settings";
import type { PreferenceInfo, SecretInfo } from "@beacon/core";

/**
 * Settings › AI: what B-roll is made with (the Replicate token, the model, its resolution, a limit per generation)
 * and the OpenAI key its planning uses (the one Transcripts' OpenAI options use).
 */
export function AiSettings({ prefs, secrets, host, changed }: { prefs: PreferenceInfo[]; secrets: SecretInfo[]; host: TranscriptsHost; changed: (prefs: PreferenceInfo[]) => void }) {
  const token = secrets.find((s) => s.id === "replicate-api-token");
  const openai = secrets.find((s) => s.id === "openai-api-key");
  const [error, setError] = useState<string>();
  const set = async (id: string, value: string) => {
    const r = await host.setPreference(id, value);
    if (r.ok && r.result) changed(r.result);
    setError(r.ok ? undefined : r.error);
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
      <div className="text-label font-medium text-text-muted">B-roll</div>
      {token && <SecretRow secret={token} label="Replicate API Token" sends="Each shot's prompt and the region's shape are sent to Replicate" charges="Replicate" placeholder="r8_… from replicate.com › Account › API tokens" host={host} />}
      {pick("brollModel", "Model")}
      {pick("brollResolution", "Resolution")}
      <Row label="Limit" hint="What one generation may cost at most, by the estimate shown before it runs; 0 is no limit.">
        <div className="flex items-center gap-2" data-preference="brollLimit">
          <span className="text-text-muted">$</span>
          <NumberBox value={limit} digits={2} step={1} min={0} max={1000} width={70} onCommit={(v) => void set("brollLimit", String(Math.round(v * 100) / 100))} />
        </div>
      </Row>
      {openai && <SecretRow secret={openai} label="OpenAI API Key" sends="The words over the range and your guide are sent to OpenAI (not the audio) to plan the shots; the same key as Transcripts'" charges="OpenAI" placeholder="sk-…" host={host} />}
      {error && <div className="text-danger">{error}</div>}
    </div>
  );
}
