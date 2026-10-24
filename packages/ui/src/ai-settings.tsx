import { useRef, useState } from "react";
import type { PreferenceInfo, SecretInfo } from "@beacon/core";
import { Button, NumberBox, Select, SettingsRow as Row, TextArea, TextInput } from "./controls";
import { styleFromFile, type CustomStyle } from "@beacon/features/src/broll/styles";
import { SecretRow, type TranscriptsHost } from "./transcripts-settings";

/** Every API key Beacon keeps, in the order shown, with what it is used for (and when audio leaves the Mac). */
const KEYS: { id: string; label: string; use: string; placeholder: string }[] = [
  { id: "openai-api-key", label: "OpenAI", use: "For B-roll planning, and OpenAI transcribing or Best Take if you pick them in Transcripts", placeholder: "sk-…" },
  { id: "replicate-api-token", label: "Replicate", use: "For B-roll footage", placeholder: "r8_…" },
  { id: "auphonic-api-key", label: "Auphonic", use: "For Clean with Auphonic", placeholder: "Auphonic API key" },
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
      <div className="-mt-2 text-caption text-text-faint">All optional: add one only for the features you use. Kept in this Mac's Keychain; each service charges your own account.</div>
      {KEYS.map((k) => {
        const secret = secrets.find((s) => s.id === k.id);
        return secret && <SecretRow key={k.id} secret={secret} label={k.label} use={k.use} placeholder={k.placeholder} host={host} saved={saved(k.id)} />;
      })}
      <div className="mt-2 text-label font-medium text-text-muted">B-roll</div>
      {pick("brollPlanner", "Planner")}
      {pick("brollModel", "Model")}
      {pick("brollResolution", "Resolution", false)}
      <Row label="Limit" hint="Per generation. 0 is no limit.">
        <div className="flex items-center gap-2" data-preference="brollLimit">
          <span className="text-text-muted">$</span>
          <NumberBox value={limit} digits={2} step={1} min={0} max={1000} width={70} onCommit={(v) => void set("brollLimit", String(Math.round(v * 100) / 100))} />
        </div>
      </Row>
      <StylesList value={prefs.find((p) => p.id === "brollStyles")?.value ?? "[]"} save={(list) => void set("brollStyles", JSON.stringify(list))} />
      {error && <div className="text-danger">{error}</div>}
    </div>
  );
}

/**
 * The user's own B-roll styles: each a name and the wording added to its prompts (and given to the planner as its
 * guide), typed here or read from a text file (a `.md` skill, a `.txt`); every project's Style menu lists them.
 */
function StylesList({ value, save }: { value: string; save: (list: CustomStyle[]) => void }) {
  const list = (() => {
    try {
      return JSON.parse(value) as CustomStyle[];
    } catch {
      return [];
    }
  })();
  const [editing, setEditing] = useState<CustomStyle>();
  const file = useRef<HTMLInputElement>(null);
  const put = (s: CustomStyle) => save(list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s]);
  const fresh = (name: string, text: string): CustomStyle => ({ id: `style-${Date.now().toString(36)}`, name, text });
  return (
    <div className="flex flex-col gap-2" data-broll-styles>
      <Row label="Your Styles" hint="Added to every prompt of a clip that picks it, and the planner's guide. A skill's front matter or title names it.">
        <div className="flex gap-2">
          <Button onClick={() => setEditing(fresh("", ""))} data-broll-style-new>
            New Style
          </Button>
          <Button onClick={() => file.current?.click()} data-broll-style-import>
            Import File…
          </Button>
          <input
            ref={file}
            type="file"
            accept=".md,.markdown,.txt"
            className="hidden"
            data-broll-style-file
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              const { name, text } = styleFromFile(f.name, await f.text());
              if (text) setEditing(fresh(name, text));
            }}
          />
        </div>
      </Row>
      {list.map((s) => (
        <Row key={s.id} label="" hint={s.text.length > 120 ? `${s.text.slice(0, 120)}…` : s.text}>
          <div className="flex min-w-0 flex-1 items-center gap-2" data-broll-style={s.id}>
            <span className="min-w-0 flex-1 truncate text-text-strong">{s.name}</span>
            <Button look="quiet" onClick={() => setEditing(s)}>
              Edit
            </Button>
            <Button look="quiet" onClick={() => save(list.filter((x) => x.id !== s.id))}>
              Delete
            </Button>
          </div>
        </Row>
      ))}
      {editing && (
        <div className="ml-[152px] flex flex-col gap-2 rounded-md bg-groove p-3" data-broll-style-editor>
          <TextInput placeholder="Name: Grainy 16mm" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} data-broll-style-name />
          <TextArea rows={5} placeholder="The look, in words: grainy 16mm, warm tones, handheld, shallow depth of field" value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} data-broll-style-text />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setEditing(undefined)}>Cancel</Button>
            <Button
              look="primary"
              disabled={!editing.name.trim() || !editing.text.trim()}
              onClick={() => {
                put({ ...editing, name: editing.name.trim(), text: editing.text.trim() });
                setEditing(undefined);
              }}
              data-broll-style-save
            >
              Save Style
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
