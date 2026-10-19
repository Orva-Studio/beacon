import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Utils } from "electrobun/main";
import { findDropped, projectName, summarizeReport, type DroppedFile } from "@beacon/core";
import { projectDuration, ticksToSeconds } from "@beacon/model";
import { canvasChange, type CanvasValues, type ProjectBridge } from "@beacon/ui";
import { errorText, type App, type Current } from "./app";

export interface ProjectsApp extends App {
  setCurrent(c: Current): void;
  /** The project's events told to the window, from now on. */
  watch(h: string): ProjectBridge;
  /** The window shows the project just opened; `canvas` is the native view the last one was drawn in. */
  shown(h: string, canvas: Current["view"]): Promise<void>;
  /** Before the open project is let go. */
  leaving(): void;
  /** Open Recent changed: the menu and the start screen follow. */
  recentChanged(): void;
}

/** File > Open Recent and the start screen: the last projects opened, newest first, with when (ms since 1970). */
type Recent = { path: string; opened: number };

/** Where new projects (and copies of Camtasia projects) go. */
const PROJECTS = join(homedir(), "Movies/Beacon");

/** `name`.beproj in the projects folder, numbered if taken. */
function freshProject(name: string): string {
  mkdirSync(PROJECTS, { recursive: true });
  for (let n = 1; ; n++) {
    const path = join(PROJECTS, `${name}${n > 1 ? ` ${n}` : ""}.beproj`);
    if (!existsSync(path)) return path;
  }
}

const isProject = (path: string) => /\.(cmproj|beproj)\/?$/.test(path);

/** The projects the window opens, one at a time: open, switch, create, Save As and rename, and the recent ones. */
export function createProjects(app: ProjectsApp) {
  const { core, message, status } = app;

  let recent: Recent[] = (() => {
    try {
      // Before 0.5 the file held paths alone: their folders' modification times stand in.
      return ((core.readConfig("recent.json") ?? []) as (string | Recent)[])
        .map((r) => (typeof r === "string" ? { path: r, opened: existsSync(r) ? statSync(r).mtimeMs : 0 } : r))
        .filter((r) => existsSync(r.path));
    } catch {
      return [];
    }
  })();

  /** The start screen's pictures: each recent project's frame at its playhead, as it was last left. */
  const PROJECT_THUMBS = join(core.configDir, "project-thumbs");
  const projectThumbFile = (path: string) => join(PROJECT_THUMBS, `${Bun.hash(path).toString(16)}.png`);

  function setRecent(list: Recent[]) {
    recent = list.slice(0, 10);
    try {
      core.writeConfig("recent.json", recent);
    } catch (e) {
      status(`could not remember recent projects: ${errorText(e)}`);
    }
    app.recentChanged();
    try {
      const kept = new Set(recent.map((r) => basename(projectThumbFile(r.path))));
      for (const f of readdirSync(PROJECT_THUMBS)) if (!kept.has(f)) rmSync(join(PROJECT_THUMBS, f), { force: true });
    } catch {}
  }

  function projectThumb(path: string): string | undefined {
    try {
      return `data:image/png;base64,${readFileSync(projectThumbFile(path)).toString("base64")}`;
    } catch {
      return undefined;
    }
  }
  const recentProjects = () => recent.map((r) => ({ ...r, name: basename(r.path, ".beproj"), thumb: projectThumb(r.path) }));

  async function saveProjectThumb(h: string) {
    try {
      const end = ticksToSeconds(projectDuration(core.doc(h)));
      if (!end) return;
      const { playhead } = await core.session(h);
      const img = await core.frame(h, playhead < end ? playhead : 0, { width: 480 });
      mkdirSync(PROJECT_THUMBS, { recursive: true });
      writeFileSync(projectThumbFile(h), img.png);
    } catch {}
  }
  // Quitting can't wait for a render, so the picture follows edits, a while after they stop.
  let thumbTimer: ReturnType<typeof setTimeout> | undefined;
  function saveProjectThumbSoon(h: string) {
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => void saveProjectThumb(h), 5000);
  }

  function openRecent(path: string) {
    if (existsSync(path)) return void open(path).catch((err: unknown) => status(errorText(err)));
    setRecent(recent.filter((r) => r.path !== path));
    status(`${path} no longer exists`);
  }

  /** Opens, Save As and renames run one at a time: two at once would both pass the "already open" check and interleave the switch. */
  let opening: Promise<unknown> = Promise.resolve();
  function queued(fn: () => Promise<void>): Promise<void> {
    const next = opening.then(fn);
    opening = next.catch(() => {});
    return next;
  }
  const open = (path: string) => queued(() => switchTo(path));

  async function switchTo(path: string) {
    const dir = resolve(path);
    const current = app.current();
    if (current?.path === dir && !current.closed) return;
    const h = await core.open(dir);
    // The webview keeps its canvas element across projects, so it won't report it again.
    const canvas = current?.view;
    if (current) {
      clearTimeout(thumbTimer);
      if (!current.closed) await saveProjectThumb(current.path);
      current.bridge.unwatch();
      app.leaving();
      // A failed final save still releases the old project; say so and finish switching.
      if (!current.closed) await core.close(current.path).catch((e: unknown) => status(errorText(e)));
    }
    app.setCurrent({ path: h, bridge: app.watch(h) });
    setRecent([{ path: h, opened: Date.now() }, ...recent.filter((r) => r.path !== h)]);
    await app.shown(h, canvas);
    if (!existsSync(projectThumbFile(h))) saveProjectThumbSoon(h);
  }

  /** Opens a .beproj, or a Camtasia .cmproj as a new Beacon project beside the others (the .cmproj is only read). */
  async function openDialog() {
    const [path] = await Utils.openFileDialog({ canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false, startingFolder: "~/" });
    if (path) await openProject(path);
  }

  async function openProject(path: string) {
    if (path.endsWith(".cmproj")) {
      const to = freshProject(basename(path, ".cmproj"));
      status(`Importing ${basename(path)}…`);
      await core.create({ path: to, cmproj: path });
      await open(to);
      const left = summarizeReport(core.importReport(to));
      if (left.length) message("notice", { title: `Opened "${basename(path, ".cmproj")}"`, message: "Some of the Camtasia project isn't supported yet and was left out or changed:", lines: left.map((l) => (l.count > 1 ? `${l.message} (×${l.count})` : l.message)) });
      return status(`Opened ${basename(path)} as ${to}; the Camtasia project is unchanged`);
    }
    if (!path.endsWith(".beproj")) throw new Error(`${path} is neither a Beacon project (.beproj) nor a Camtasia project (.cmproj)`);
    await open(path);
  }

  /** Media into the open project; a project among them (Import or a Finder drop of a .cmproj) is opened instead. */
  async function importPaths(paths: string[], at: { time?: number; track?: string } = {}) {
    const media = paths.filter((p) => !isProject(p));
    const project = paths.find(isProject);
    if (media.length) {
      const current = app.current();
      if (!current) throw new Error("Open or create a project first");
      const r = await core.import(current.path, media, { ...(at.time !== undefined ? { at: at.time } : {}), ...(at.track ? { track: at.track } : {}) });
      status(`Imported ${r.assets.length} file${r.assets.length === 1 ? "" : "s"}`);
    }
    if (project) await openProject(project.replace(/\/$/, ""));
  }

  /** Import Media (⌘I): recordings, video, audio and images onto the timeline, after what is there. */
  async function importMedia() {
    const files = await Utils.openFileDialog({ canChooseFiles: true, canChooseDirectory: false, allowsMultipleSelection: true, startingFolder: "~/" });
    if (files.filter(Boolean).length) await importPaths(files.filter(Boolean));
  }

  /** Files dropped on the window, as Finder gave them. */
  const dropFiles = async (files: DroppedFile[], at: { time?: number; track?: string }) => importPaths(await findDropped(files), at);

  /** File > New Project: the window asks for the name, then `createProject`. */
  function newProject() {
    message("newProjectSheet", { name: "Untitled Project" });
  }

  async function createProject(name: string, canvas?: CanvasValues, standalone = false) {
    const to = freshProject(projectName(name));
    await core.create({ path: to, ...(canvas ? { settings: canvasChange(canvas) } : {}), ...(standalone ? { standalone } : {}) });
    await open(to);
    status(`New project: ${to}`);
  }

  /** File > Save As…: the window asks for the copy's name, folder and whether it is standalone, then `saveAs`. */
  function saveAsDialog() {
    const current = app.current();
    if (!current) return status("Open a project first");
    message("saveAsSheet", { name: `${basename(current.path, ".beproj")} copy`, folder: dirname(current.path), standalone: !!core.doc(current.path).settings.standalone });
  }

  /** The copy is opened in place of the project, which stays as last saved. */
  const saveAs = ({ name, folder, standalone }: { name: string; folder: string; standalone: boolean }) =>
    queued(async () => {
      const current = app.current();
      if (!current) throw new Error("Open a project first");
      const clean = projectName(name);
      if (standalone) status("Copying media into the project…");
      const to = await core.saveAs(current.path, join(folder, `${clean}.beproj`), { standalone });
      await switchTo(to);
      status(`Saved as ${to}`);
    });

  /** Clicking the project's name: its folder takes the new name, and Open Recent follows. */
  const renameProject = (name: string) =>
    queued(async () => {
      const current = app.current();
      if (!current) throw new Error("Open a project first");
      const from = current.path;
      const to = await core.rename(from, name);
      if (to === from) return;
      current.closed = true;
      await switchTo(to);
      setRecent(recent.filter((r) => r.path !== from));
    });

  return {
    recent: () => recent,
    recentProjects,
    clearRecent: () => setRecent([]),
    openRecent,
    open,
    openDialog,
    importMedia,
    dropFiles,
    newProject,
    createProject,
    saveAsDialog,
    saveAs,
    renameProject,
    saveProjectThumbSoon,
  };
}
