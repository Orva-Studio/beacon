import { useState } from "react";
import type { HabitInfo, MemoryChange, Sentence } from "@beacon/model";
import { Button, Check, Select, TextInput, TrashButton } from "./controls";
import { LearnedShortcuts } from "./learned";
import { useView } from "./store";

export interface MemoryHost {
  memoryChange(change: MemoryChange): void;
}

type Format = "short" | "long";
const FORMATS: { id: Format | ""; title: string }[] = [
  { id: "", title: "Every video" },
  { id: "short", title: "Shorts" },
  { id: "long", title: "Long videos" },
];

function FormatSelect({ value, onChange }: { value: Format | undefined; onChange: (format: Format | undefined) => void }) {
  // Selects fill their row: held to a width, so the sentence beside it gets the rest.
  return (
    <div className="w-32 shrink-0">
      <Select value={value ?? ""} onChange={(e) => onChange((e.target.value || undefined) as Format | undefined)} data-memory-format>
        {FORMATS.map((f) => (
          <option key={f.id} value={f.id}>
            {f.title}
          </option>
        ))}
      </Select>
    </div>
  );
}

function Heading({ children }: { children: string }) {
  return <div className="mt-2 mb-1 font-semibold text-text-strong">{children}</div>;
}

/** What Beacon learned for one format, each with what it learned it from and a reset. */
function Habits({ title, habits, host }: { title: string; habits: HabitInfo[]; host: MemoryHost }) {
  return (
    <div className="flex flex-col gap-1" data-memory-habits={title}>
      <div className="text-label text-text-faint">{title}</div>
      {!habits.length && <div className="text-text-muted">Nothing yet.</div>}
      {habits.map((h) => (
        <div key={h.id} className="flex items-center gap-2 rounded-md bg-groove px-3 py-1.5" data-memory-habit={h.id}>
          <div className="min-w-0 flex-1">
            <div className="text-text">{h.text}</div>
            <div className="text-caption text-text-faint">
              {h.agree} of your {h.of} choices{h.format ? "" : ", from every kind of video: too few of these yet"}
            </div>
          </div>
          <Button look="quiet" title="Forget the choices this was learned from" onClick={() => host.memoryChange({ forget: { rules: h.rules, ...(h.format ? { format: h.format } : {}) } })} data-memory-forget>
            Forget
          </Button>
        </div>
      ))}
    </div>
  );
}

/**
 * A sentence: its text edited in place, who it is for, and delete. Saved as one edit when the row loses the focus,
 * or with its new format: its id comes from its text and format, so the two saved apart would name it by an old id.
 */
function SentenceRow({ sentence, host }: { sentence: Sentence; host: MemoryHost }) {
  const [text, setText] = useState(sentence.text);
  const save = (format?: Format | null) => {
    const t = text.trim() || sentence.text;
    if (t !== text) setText(t);
    if (t !== sentence.text || format !== undefined) host.memoryChange({ edit: { id: sentence.id, text: t, ...(format === undefined ? {} : { format }) } });
  };
  return (
    <div className="flex items-center gap-2" data-memory-sentence={sentence.id} onBlur={(e) => e.currentTarget.contains(e.relatedTarget as Node | null) || save()}>
      <TextInput className="min-w-0 flex-1" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
      <FormatSelect value={sentence.format} onChange={(format) => save(format ?? null)} />
      <TrashButton label="Delete" onClick={() => host.memoryChange({ remove: sentence.id })} />
    </div>
  );
}

/**
 * Settings › Memory: how the user edits, in two kinds. What Beacon learned from their choices in the reviews (the
 * reviews open with it), and sentences in their own words, which agents read before editing; agents may propose
 * sentences, kept only once the user accepts them.
 */
export function MemorySettings({ host }: { host: MemoryHost }) {
  const memory = useView((v) => v.memory);
  const [text, setText] = useState("");
  const [format, setFormat] = useState<Format>();
  if (!memory) return null;
  const add = () => {
    if (!text.trim()) return;
    host.memoryChange({ add: { text: text.trim(), ...(format ? { format } : {}) } });
    setText("");
  };
  return (
    <div className="flex flex-col gap-3" data-memory>
      <div className="flex flex-col gap-1">
        <Check label="Learn from my reviews" checked={memory.learning} onChange={(learning) => host.memoryChange({ learning })} data-memory-learning />
        <div className="text-label text-text-faint">
          What you cut and keep in Remove Silences and Retakes, kept on this Mac. A review opens your way once you have made the same choice about 5 times over 2 projects, and says why.
        </div>
      </div>
      {memory.learning && (
        <>
          <Heading>Learned</Heading>
          <Habits title="Long videos" habits={memory.habits.long} host={host} />
          <Habits title="Shorts" habits={memory.habits.short} host={host} />
          <div className="flex items-center justify-between text-label text-text-faint">
            <span data-memory-decisions>
              {memory.decisions} {memory.decisions === 1 ? "choice" : "choices"} kept
            </span>
            {memory.decisions > 0 && (
              <Button look="quiet" onClick={() => host.memoryChange({ forget: "all" })} data-memory-forget-all>
                Forget All
              </Button>
            )}
          </div>
        </>
      )}
      <Heading>In your words</Heading>
      <div className="text-label text-text-faint" data-memory-file>
        How you like your videos edited, one habit a line. Agents read these before they edit for you. Kept in <span className="select-text text-text-muted">{memory.file.replace(/^\/Users\/[^/]+/, "~")}</span>, which you can also edit by hand.
      </div>
      {memory.sentences.map((s) => (
        <SentenceRow key={`${s.id}:${s.text}`} sentence={s} host={host} />
      ))}
      <div className="flex items-center gap-2" data-memory-add>
        <TextInput className="min-w-0 flex-1" placeholder="e.g. No B-roll in the intro" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <FormatSelect value={format} onChange={setFormat} />
        <Button disabled={!text.trim()} onClick={add}>
          Add
        </Button>
      </div>
      {memory.proposals.length > 0 && (
        <>
          <Heading>Proposed by agents</Heading>
          {memory.proposals.map((p) => (
            <div key={p.id} className="flex items-center gap-2 rounded-md border border-accent/40 px-3 py-1.5" data-memory-proposal={p.id}>
              <span className="min-w-0 flex-1 text-text">
                {p.text}
                {p.format && <span className="text-text-faint"> ({p.format === "short" ? "Shorts" : "long videos"})</span>}
              </span>
              <Button look="quiet" onClick={() => host.memoryChange({ dismiss: p.id })} data-memory-dismiss>
                Dismiss
              </Button>
              <Button look="primary" onClick={() => host.memoryChange({ accept: p.id })} data-memory-accept>
                Accept
              </Button>
            </div>
          ))}
        </>
      )}
      <Heading>Learned shortcuts</Heading>
      <LearnedShortcuts host={host} shortcuts={memory.shortcuts} />
    </div>
  );
}
