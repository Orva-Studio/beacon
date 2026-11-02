import { useState } from "react";
import { CanvasSettings } from "./canvas-settings";
import { DEFAULT_CANVAS, type CanvasValues } from "./canvas-values";
import { Button, Check, Modal, RenameField, SettingsRow, TextInput } from "./controls";
import { replica, useView } from "./store";

export interface ProjectHost {
  /** A new project of that name in `folder`, with these canvas settings, opened. */
  newProject(name: string, settings: CanvasValues, standalone: boolean, folder: string): Promise<{ ok: boolean; error?: string }>;
  /** Renames the open project's folder. */
  renameProject(name: string): Promise<{ ok: boolean; error?: string }>;
  /** A copy of the open project, `name`.beproj in `folder`, opened in its place. */
  saveAs(params: { name: string; folder: string; standalone: boolean }): Promise<{ ok: boolean; error?: string }>;
  chooseFolder(start: string): Promise<string | null>;
}

/** File > Save As…: what the dialog starts with. */
export interface SaveAsSheet {
  name: string;
  folder: string;
  standalone: boolean;
}

const STANDALONE_HINT = "Copies media into the project's folder, so it can be moved or shared whole";

function StandaloneCheck({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <SettingsRow label="" hint={<div className="mt-1 text-caption text-text-faint">{STANDALONE_HINT}</div>}>
      <Check label="Standalone project" checked={checked} onChange={onChange} />
    </SettingsRow>
  );
}


/** The folder a project goes in, with Choose… for another. */
function WhereRow({ folder, host, onChange }: { folder: string; host: ProjectHost; onChange: (folder: string) => void }) {
  return (
    <SettingsRow label="Where">
      <div className="flex min-w-0 flex-1 items-center gap-2" data-project-where>
        <span className="min-w-0 flex-1 truncate text-text-strong" title={folder}>
          {folder.replace(/^\/Users\/[^/]+/, "~")}
        </span>
        <Button onClick={async () => void (await host.chooseFolder(folder).then((f) => f && onChange(f)))}>Choose…</Button>
      </div>
    </SettingsRow>
  );
}

/** File > New Project (⌘N): its name and canvas (Project Settings), in the window as the Export dialog. */
function NewProjectDialog({ sheet, host }: { sheet: { name: string; folder: string }; host: ProjectHost }) {
  const [name, setName] = useState(sheet.name);
  const [folder, setFolder] = useState(sheet.folder);
  const [canvas, setCanvas] = useState(DEFAULT_CANVAS);
  const [standalone, setStandalone] = useState(false);
  const [error, setError] = useState<string>();
  const close = () => replica.newProject(undefined);
  const create = async () => {
    const r = await host.newProject(name.trim(), canvas, standalone, folder);
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
      <WhereRow folder={folder} host={host} onChange={(f) => (setFolder(f), setError(undefined))} />
      <CanvasSettings value={canvas} onChange={(patch) => setCanvas({ ...canvas, ...patch })} />
      <StandaloneCheck checked={standalone} onChange={setStandalone} />
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
  return sheet ? <NewProjectDialog sheet={sheet} host={host} /> : null;
}

/** File > Save As… (⇧⌘S): a copy under a new name and folder, opened in place of this one. */
function SaveAsDialog({ sheet, host }: { sheet: SaveAsSheet; host: ProjectHost }) {
  const [name, setName] = useState(sheet.name);
  const [folder, setFolder] = useState(sheet.folder);
  const [standalone, setStandalone] = useState(sheet.standalone);
  const [error, setError] = useState<string>();
  const close = () => replica.saveAs(undefined);
  const save = async () => {
    const r = await host.saveAs({ name: name.trim(), folder, standalone });
    if (r.ok) close();
    else setError(r.error);
  };
  return (
    <Modal title="Save As" width={540} onClose={close} onEnter={() => void save()}>
      <SettingsRow label="Name" hint={<div className="mb-2 h-4 text-danger">{error}</div>}>
        <TextInput
          autoFocus
          className="flex-1"
          value={name}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => (setName(e.target.value), setError(undefined))}
        />
      </SettingsRow>
      <WhereRow folder={folder} host={host} onChange={(f) => (setFolder(f), setError(undefined))} />
      <StandaloneCheck checked={standalone} onChange={setStandalone} />
      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={close}>Cancel</Button>
        <Button look="primary" disabled={!name.trim()} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </Modal>
  );
}

export function SaveAsUi({ host }: { host: ProjectHost }) {
  const sheet = useView((v) => v.saveAs);
  return sheet ? <SaveAsDialog sheet={sheet} host={host} /> : null;
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
  const done = async (next: string | null) => {
    setEditing(false);
    if (!next || next === name) return;
    const r = await host.renameProject(next);
    if (!r.ok && r.error) replica.status(r.error);
  };
  return <RenameField value={name} className="w-56 font-medium" onDone={(next) => void done(next)} />;
}
