import { useState } from "react";
import { DEFAULT_SETTINGS } from "@beacon/model";
import { CanvasSettings, type CanvasValues } from "./canvas-settings";
import { Button, Modal, SettingsRow, TextInput } from "./controls";
import { replica, useView } from "./store";

export interface ProjectHost {
  /** A new project of that name in the projects folder, with these canvas settings, opened. */
  newProject(name: string, settings: CanvasValues): Promise<{ ok: boolean; error?: string }>;
  /** Renames the open project's folder. */
  renameProject(name: string): Promise<{ ok: boolean; error?: string }>;
}

const DEFAULTS: CanvasValues = {
  width: DEFAULT_SETTINGS.width,
  height: DEFAULT_SETTINGS.height,
  fps: DEFAULT_SETTINGS.fps.num / DEFAULT_SETTINGS.fps.den,
  background: DEFAULT_SETTINGS.background,
  normalize: DEFAULT_SETTINGS.loudnessTarget !== undefined,
};

/** File > New Project (⌘N): its name and canvas (Project Settings), in the window as the Export dialog. */
function NewProjectDialog({ name: initial, host }: { name: string; host: ProjectHost }) {
  const [name, setName] = useState(initial);
  const [canvas, setCanvas] = useState(DEFAULTS);
  const [error, setError] = useState<string>();
  const close = () => replica.newProject(undefined);
  const create = async () => {
    const r = await host.newProject(name.trim(), canvas);
    if (r.ok) close();
    else setError(r.error);
  };
  return (
    <Modal title="New Project" width={540} onClose={close} onEnter={() => void create()}>
      <SettingsRow label="Name" hint={<div className="mb-2 h-4 text-danger">{error}</div>}>
        <TextInput
          autoFocus
          className="flex-1"
          value={name}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => (setName(e.target.value), setError(undefined))}
        />
      </SettingsRow>
      <CanvasSettings value={canvas} onChange={(patch) => setCanvas({ ...canvas, ...patch })} />
      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={close}>Cancel</Button>
        <Button look="primary" disabled={!name.trim()} onClick={() => void create()}>
          Create
        </Button>
      </div>
    </Modal>
  );
}

export function NewProjectUi({ host }: { host: ProjectHost }) {
  const sheet = useView((v) => v.newProject);
  return sheet ? <NewProjectDialog name={sheet.name} host={host} /> : null;
}

/** The project's name in the top bar; click it to rename the project (its .beproj folder). */
export function ProjectName({ name, host }: { name?: string; host: ProjectHost }) {
  const [editing, setEditing] = useState(false);
  if (!name) return <span className="font-medium">Beacon</span>;
  if (!editing) {
    return (
      // A button: the top bar drags the window, and buttons in it still take clicks.
      <button className="cursor-text rounded-sm px-1 font-medium hover:bg-control" title="Rename the project" onClick={() => setEditing(true)}>
        {name}
      </button>
    );
  }
  const done = async (el: HTMLInputElement, apply: boolean) => {
    setEditing(false);
    const next = el.value.trim();
    if (!apply || !next || next === name) return;
    const r = await host.renameProject(next);
    if (!r.ok && r.error) replica.status(r.error);
  };
  return (
    <input
      autoFocus
      className="w-56 rounded-sm border border-accent bg-well px-1 font-medium text-text-strong outline-none"
      defaultValue={name}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") void done(e.currentTarget, true);
        if (e.key === "Escape") void done(e.currentTarget, false);
      }}
      onBlur={(e) => void done(e.currentTarget, true)}
    />
  );
}
