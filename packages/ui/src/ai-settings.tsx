import { useRef, useState } from "react";
import type { PreferenceInfo, SecretInfo } from "@beacon/core";
import { Button, NumberBox, Select, SettingsRow as Row, TextArea, TextInput } from "./controls";
import { styleFromFile, type CustomStyle } from "@beacon/features/src/broll/styles";
import { SecretRow, type TranscriptsHost } from "./transcripts-settings";

/** Every API key Beacon keeps, in the order shown, with what it is used for (and when audio leaves the Mac). */
const KEYS: { id: string; label: string; use: string; placeholder: string }[] = [
  { id: "openai-api-key", label: "OpenAI", use: "For B-roll planning, motion graphics made by OpenAI, and OpenAI transcribing or Best Take if you pick them in Transcripts", placeholder: "sk-…" },
  { id: "anthropic-api-key", label: "Anthropic", use: "For motion graphics made by Claude", placeholder: "sk-ant-…" },
  { id: "firecrawl-api-key", label: "Firecrawl", use: "Optional: motion graphics search the web (real logos, icons) keyless, about 1,000 lookups a month; a free key gives more", placeholder: "fc-…" },
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
      <div className="mt-2 text-label font-medium text-text-muted">Motion Graphics</div>
      {pick("motionPlanner", "Made by")}
      <StylesList
        kind="motion"
        label="Your Skills"
        hint="The Skill menu on the Motion tab lists them, in every project; Make and Revise follow the one picked. A skill's front matter or title names it."
        placeholder={{ name: "Name: Paper cutout", text: "The design and rules: dark ground, cream torn-paper cards, orange accents, labels not sentences" }}
        newLabel="New Skill"
        saveLabel="Save Skill"
        value={prefs.find((p) => p.id === "motionSkills")?.value ?? "[]"}
        save={(list) => void set("motionSkills", JSON.stringify(list))}
      />
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
      <StylesList
        kind="broll"
        label="Your Styles"
        hint="Added to every prompt of a clip that picks it, and the planner's guide. A skill's front matter or title names it."
        placeholder={{ name: "Name: Grainy 16mm", text: "The look, in words: grainy 16mm, warm tones, handheld, shallow depth of field" }}
        newLabel="New Style"
        saveLabel="Save Style"
        value={prefs.find((p) => p.id === "brollStyles")?.value ?? "[]"}
        save={(list) => void set("brollStyles", JSON.stringify(list))}
      />
      {error && <div className="text-danger">{error}</div>}
    </div>
  );
}

/**
 * The user's own B-roll styles (each a name and the wording added to its prompts, and given to the planner as its
 * guide) or motion graphics skills, typed here or read from a text file (a `.md` skill, a `.txt`); every project's
 * Style or Skill menu lists them.
 */
function StylesList({ kind, label, hint, placeholder, newLabel, saveLabel, value, save }: {
  /** Names its data attributes (`data-broll-style…`, `data-motion-style…`). */
  kind: "broll" | "motion";
  label: string;
  hint: string;
  placeholder: { name: string; text: string };
  newLabel: string;
  saveLabel: string;
  value: string;
  save: (list: CustomStyle[]) => void;
}) {
  const d = (k: string, v: string | boolean = true) => ({ [`data-${kind}-${k}`]: v });
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
    <div className="flex flex-col gap-2" {...d("styles")}>
      <Row label={label} hint={hint}>
        <div className="flex gap-2">
          <Button onClick={() => setEditing(fresh("", ""))} {...d("style-new")}>
            {newLabel}
          </Button>
          <Button onClick={() => file.current?.click()} {...d("style-import")}>
            Import File…
          </Button>
          <input
            ref={file}
            type="file"
            accept=".md,.markdown,.txt"
            className="hidden"
            {...d("style-file")}
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
          <div className="flex min-w-0 flex-1 items-center gap-2" {...d("style", s.id)}>
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
        <div className="ml-[152px] flex flex-col gap-2 rounded-md bg-groove p-3" {...d("style-editor")}>
          <TextInput placeholder={placeholder.name} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} {...d("style-name")} />
          <TextArea rows={5} placeholder={placeholder.text} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} {...d("style-text")} />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setEditing(undefined)}>Cancel</Button>
            <Button
              look="primary"
              disabled={!editing.name.trim() || !editing.text.trim()}
              onClick={() => {
                put({ ...editing, name: editing.name.trim(), text: editing.text.trim() });
                setEditing(undefined);
              }}
              {...d("style-save")}
            >
              {saveLabel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
