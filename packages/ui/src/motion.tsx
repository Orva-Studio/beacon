import { useCallback, useState } from "react";
import type { Host } from "./app";
import { Button, Select, TextInput } from "./controls";
import { useQuery } from "./query";
import { replica, useView } from "./store";

/** A block as `motion.blocks` lists it: its fields as JSON Schema. */
interface Block {
  id: string;
  title: string;
  description: string;
  seconds: number;
  fields: { properties: Record<string, { description?: string; maxLength?: number }>; required?: string[] };
}

const labelOf = (key: string) => key[0]!.toUpperCase() + key.slice(1);

/** Under the AI panel's tiles: a block and its fields, added at the playhead (or over the range) with `motion.add`. */
export function MotionForm({ host }: { host: Host }) {
  const open = useView((v) => !!v.motionForm);
  const blocks = useQuery<Block[]>(host, open ? "motion.blocks" : "");
  const [picked, pick] = useState<string>();
  const [values, setValues] = useState<Record<string, string>>({});
  // Below the tiles it can open out of sight: brought into view once, as it appears.
  const shown = useCallback((el: HTMLDivElement | null) => el?.scrollIntoView({ block: "nearest" }), []);
  if (!open || !blocks?.length) return null;
  const block = blocks.find((b) => b.id === picked) ?? blocks[0]!;
  const keys = Object.keys(block.fields.properties);
  const required = block.fields.required ?? [];
  const ready = required.every((k) => values[k]?.trim());
  const close = () => {
    setValues({});
    replica.openMotion(false);
  };
  const add = () => {
    if (!ready) return;
    const fields = Object.fromEntries(keys.flatMap((k) => (values[k]?.trim() ? [[k, values[k]!.trim()]] : [])));
    host.run("motion.add", { block: block.id, fields });
    close();
  };
  return (
    <div className="mt-3 rounded-md bg-groove px-3 py-3 text-label text-text" ref={shown} data-motion-form>
      <Select className="mb-2 w-full" value={block.id} onChange={(e) => pick(e.target.value)} data-motion-block>
        {blocks.map((b) => (
          <option key={b.id} value={b.id}>
            {b.title}
          </option>
        ))}
      </Select>
      <div className="mb-3 text-caption text-text-faint">{block.description}</div>
      {keys.map((k, i) => (
        <label key={k} className="mb-2 block">
          <span className="mb-1 block text-text-muted">
            {labelOf(k)}
            {required.includes(k) ? "" : " (optional)"}
          </span>
          <TextInput
            className="w-full"
            autoFocus={i === 0}
            value={values[k] ?? ""}
            placeholder={block.fields.properties[k]!.description}
            maxLength={block.fields.properties[k]!.maxLength}
            data-motion-field={k}
            onChange={(e) => setValues({ ...values, [k]: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
              if (e.key === "Escape") close();
            }}
          />
        </label>
      ))}
      <div className="mt-3 flex justify-end gap-2">
        <Button look="quiet" onClick={close}>
          Cancel
        </Button>
        <Button disabled={!ready} onClick={add} data-motion-add>
          Apply
        </Button>
      </div>
    </div>
  );
}
