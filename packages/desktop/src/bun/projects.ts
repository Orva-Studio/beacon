import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { askOwner, findDropped, LOCK_FILE, lockOwner, ProjectLockedError, projectDuration, projectName, summarizeReport, ticksToSeconds, type DroppedFile } from "@beacon/core";
import { canvasChange, type CanvasValues, type ProjectBridge } from "@beacon/ui";
import type { LocalCore } from "@beacon/core";
import { errorText, type ProjectWindow, type Current } from "./app";

export interface ProjectsApp {
  core: LocalCore;
  /** The window menus and keys act on, if any. */
  focused(): ProjectWindow | undefined;
  /** Every editor window. */
  windows(): Iterable<ProjectWindow>;
  /** A new editor window, showing the start screen. */
  newWindow(): ProjectWindow;
  /** The project's events told to `w`, from now on. */
  watch(w: ProjectWindow, h: string): ProjectBridge;
  /** `w` shows the project just opened; `canvas` is the native view the last one was drawn in. */
  shown(w: ProjectWindow, h: string, canvas: Current["view"]): Promise<void>;
  /** Before `w`'s project is let go. */
  leaving(w: ProjectWindow): void;
  /** Open Recent changed: the menu and the start screens follow. */
  recentChanged(): void;
  /** Finder's open dialog (Electrobun's `Utils.openFileDialog`): the paths picked, none if cancelled. */
  openFileDialog(opts: { canChooseFiles: boolean; canChooseDirectory: boolean; allowsMultipleSelection: boolean; startingFolder: string; allowedFileTypes?: string }): Promise<string[]>;
  /** Asks before a project goes to the Trash: whether the user agreed. */
  confirmTrash(name: string): Promise<boolean>;
  /** Moves a file or folder to the Trash (Electrobun's `Utils.moveToTrash`): whether it went. */
  moveToTrash(path: string): boolean;
  /** A project another process holds: what the user chose. `refused`: why it didn't let go when asked last time. */
  lockedDialog(opts: { project: string; holder: string; can: "show" | "letGo" | undefined; refused?: string }): Promise<"show" | "letGo" | "copy" | "cancel">;
}

/** File > Open Recent and the start screen: the last projects opened, newest first, with when (ms since 1970). */
type Recent = { path: string; opened: number };

/** Where new projects (and copies of Camtasia projects) go, unless New Project was given another folder. */
const PROJECTS = join(homedir(), "Movies/Beacon");

/** `name`.beproj in `folder`, numbered if taken. */
function freshProject(name: string, folder = PROJECTS): string {
  mkdirSync(folder, { recursive: true });
  for (let n = 1; ; n++) {
    const path = join(folder, `${name}${n > 1 ? ` ${n}` : ""}.beproj`);
    if (!existsSync(path)) return path;
  }
}

const isProject = (path: string) => /\.(cmproj|beproj)\/?$/.test(path);

/**
 * The projects the windows show, one each: open (in a window of its own once the focused one has a project),
 * switch, create, Save As and rename, close, and the recent ones.
 */
export function createProjects(app: ProjectsApp) {
  const { core } = app;
  /** Said in the focused window's status line, for what concerns the app rather than one window. */
  const status = (text: string) => app.focused()?.status(text);

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
  const thumbTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function saveProjectThumbSoon(h: string) {
    clearTimeout(thumbTimers.get(h));
    thumbTimers.set(h, setTimeout(() => (thumbTimers.delete(h), void saveProjectThumb(h)), 5000));
  }

  function openRecent(path: string) {
    if (existsSync(path)) return void open(path).catch((err: unknown) => status(errorText(err)));
    setRecent(recent.filter((r) => r.path !== path));
    status(`${path} no longer exists`);
  }

  /** The start screen's right-click: off the list, the project left where it is. */
  function removeRecent(path: string) {
    setRecent(recent.filter((r) => r.path !== path));
  }

  /**
   * The start screen's right-click: the project folder to the Trash, after asking, and off the list. Refused while it
   * is open, in a window or by an agent (this app's core or an MCP server's, by the project's lock), checked again after
   * asking as one may open it meanwhile. Only a .beproj on the list: the path comes from the page.
   */
  async function trashProject(path: string) {
    const name = basename(path, extname(path));
    if (!path.endsWith(".beproj") || !recent.some((r) => r.path === path)) throw new Error(`${path} isn't a recent Beacon project`);
    const open = () => [...app.windows()].some((w) => w.current?.path === path && !w.current.closed) || !!lockOwner(path);
    const refuse = () => new Error(`“${name}” is open: close it before moving it to the Trash`);
    if (open()) throw refuse();
    if (!existsSync(path)) return removeRecent(path);
    if (!(await app.confirmTrash(name))) return;
    if (open()) throw refuse();
    if (!app.moveToTrash(path)) throw new Error(`“${name}” couldn't be moved to the Trash`);
    removeRecent(path);
    status(`Moved “${name}” to the Trash`);
  }

  /** Opens, Save As and renames run one at a time: two at once would both pass the "already open" check and interleave the switch. */
  let opening: Promise<unknown> = Promise.resolve();
  function queued(fn: () => Promise<void>): Promise<void> {
    const next = opening.then(fn);
    opening = next.catch(() => {});
    return next;
  }
  /** Where `path` opens: the window already showing it, the focused one while it shows none, else a new window. */
  function windowFor(path: string): ProjectWindow {
    const dir = resolve(path);
    const showing = [...app.windows()].find((w) => w.current?.path === dir && !w.current.closed);
    if (showing) return showing;
    const focused = app.focused();
    return focused && !focused.current ? focused : app.newWindow();
  }

  /** Opens `path` where `windowFor` says, or in `w` (Save As and renaming keep their window). */
  const open = (path: string, w?: ProjectWindow): Promise<void> =>
    queued(() => switchTo(w ?? windowFor(path), path)).catch((e: unknown) => (e instanceof ProjectLockedError ? whenLocked(e) : Promise.reject(e)));

  /**
   * Another live process holds the project: the user picks. An app (it has a window) can be asked to show it; a
   * windowless one (an agent's MCP server) to let go, after which the agent works through this app.
   */
  async function whenLocked(e: ProjectLockedError, refused?: string): Promise<void> {
    const { dir, owner } = e;
    const name = basename(dir, extname(dir));
    const can = owner.socket ? "show" : owner.control ? "letGo" : undefined;
    const choice = await app.lockedDialog({ project: name, holder: owner.name ?? "another process", can, ...(refused ? { refused } : {}) });
    if (choice === "show") return askOwner(owner.socket!, "show", dir).catch((err: unknown) => status(`${owner.name ?? "It"} couldn't show “${name}”: ${errorText(err)}`));
    if (choice === "letGo") {
      try {
        await askOwner(owner.control!, "letGo", dir);
      } catch (err) {
        return whenLocked(e, errorText(err));
      }
      return open(dir);
    }
    if (choice === "copy") {
      const to = copyBeside(dir);
      await open(to);
      status(`Opened a copy, ${basename(to)}; “${name}” is unchanged`);
    }
  }

  /** `dir` copied beside itself as "Name copy.beproj" ("copy 2"…), without its lock. */
  function copyBeside(dir: string): string {
    const name = basename(dir, extname(dir));
    let to = "";
    for (let n = 1; !to || existsSync(to); n++) to = join(dirname(dir), `${name} copy${n > 1 ? ` ${n}` : ""}${extname(dir)}`);
    cpSync(dir, to, { recursive: true, filter: (src) => src !== join(dir, LOCK_FILE) });
    return to;
  }

  async function switchTo(w: ProjectWindow, path: string) {
    const dir = resolve(path);
    const current = w.current;
    if (current?.path === dir && !current.closed) return void w.activate();
    const h = await core.open(dir);
    // The webview keeps its canvas element across projects, so it won't report it again.
    const canvas = current?.view;
    if (current) await letGo(w);
    w.current = { path: h, bridge: app.watch(w, h) };
    setRecent([{ path: h, opened: Date.now() }, ...recent.filter((r) => r.path !== h)]);
    await app.shown(w, h, canvas);
    if (!existsSync(projectThumbFile(h))) saveProjectThumbSoon(h);
  }

  /** `w`'s project saved, its picture kept for the start screen, and released by core. */
  async function letGo(w: ProjectWindow) {
    const current = w.current;
    if (!current) return;
    clearTimeout(thumbTimers.get(current.path));
    thumbTimers.delete(current.path);
    if (!current.closed) await saveProjectThumb(current.path);
    current.bridge.unwatch();
    app.leaving(w);
    // A failed final save still releases the old project; say so and carry on.
    if (!current.closed) await core.close(current.path).catch((e: unknown) => w.status(errorText(e)));
    w.current = undefined;
  }

  /**
   * A window closed: its project is saved and released. If it can't be saved (a full disk), it stays open in core,
   * edits and all, and another window says so: opened again, it comes back as it was.
   */
  const closeWindow = (w: ProjectWindow) =>
    queued(async () => {
      const current = w.current;
      // Gone from the screen already: its last save has no page to tell.
      current?.bridge.unwatch();
      if (current && !current.closed) {
        try {
          await core.save(current.path);
        } catch (e) {
          app.leaving(w);
          w.current = undefined;
          const name = basename(current.path, ".beproj");
          const other = [app.focused(), ...app.windows()].find((x) => x && x !== w);
          other?.message("notice", { title: `“${name}” couldn't be saved`, message: `${errorText(e)}. Its edits are kept while Beacon is open: open it again (File › Open Recent) and save it somewhere with room.`, lines: [] });
          return;
        }
      }
      await letGo(w);
    });

  /** `w` started playing: the other windows stop, so one plays at a time. */
  async function playing(w: ProjectWindow) {
    for (const other of app.windows()) {
      if (other !== w && other.current && !other.current.closed) await core.run(other.current.path, "playback.pause", {}).catch(() => {});
    }
  }

  /** Opens a .beproj, or a Camtasia .cmproj as a new Beacon project beside the others (the .cmproj is only read). */
  async function openDialog() {
    // Projects are packages, which the panel takes as files: a folder not yet seen as one is still a directory.
    const [path] = await app.openFileDialog({ canChooseFiles: true, canChooseDirectory: true, allowsMultipleSelection: false, startingFolder: "~/", allowedFileTypes: "beproj,cmproj" });
    if (path) await openProject(path);
  }

  async function openProject(path: string) {
    if (path.endsWith(".cmproj")) {
      const to = freshProject(basename(path, ".cmproj"));
      status(`Importing ${basename(path)}…`);
      await core.create({ path: to, cmproj: path });
      await open(to);
      const w = windowFor(to);
      const left = summarizeReport(core.importReport(to));
      if (left.length) w.message("notice", { title: `Opened "${basename(path, ".cmproj")}"`, message: "Some of the Camtasia project isn't supported yet and was left out or changed:", lines: left.map((l) => (l.count > 1 ? `${l.message} (×${l.count})` : l.message)) });
      return w.status(`Opened ${basename(path)} as ${to}; the Camtasia project is unchanged`);
    }
    if (!path.endsWith(".beproj")) throw new Error(`${path} is neither a Beacon project (.beproj) nor a Camtasia project (.cmproj)`);
    await open(path);
  }

  /** Media into `w`'s project; a project among them (Import or a Finder drop of a .cmproj) is opened instead. */
  async function importPaths(w: ProjectWindow, paths: string[], at: { time?: number; track?: string } = {}) {
    const media = paths.filter((p) => !isProject(p));
    const project = paths.find(isProject);
    if (media.length) {
      if (!w.current) throw new Error("Open or create a project first");
      const r = await core.import(w.current.path, media, { ...(at.time !== undefined ? { at: at.time } : {}), ...(at.track ? { track: at.track } : {}) });
      w.status(`Imported ${r.assets.length} file${r.assets.length === 1 ? "" : "s"}`);
    }
    if (project) await openProject(project.replace(/\/$/, ""));
  }

  /** Import Media (⌘I): recordings, video, audio and images onto `w`'s timeline, after what is there. */
  async function importMedia(w: ProjectWindow) {
    const files = await app.openFileDialog({ canChooseFiles: true, canChooseDirectory: false, allowsMultipleSelection: true, startingFolder: "~/" });
    if (files.filter(Boolean).length) await importPaths(w, files.filter(Boolean));
  }

  /** A file an effect reads (a LUT), picked in its inspector: imported into `w`'s project, its asset id. */
  async function importFile(w: ProjectWindow, path: string) {
    if (!w.current) throw new Error("Open or create a project first");
    return (await core.import(w.current.path, [path])).assets[0];
  }

  /** Files dropped or pasted on `w`, as Finder or the clipboard gave them; those with only their bytes saved into its project. */
  const dropFiles = async (w: ProjectWindow, files: DroppedFile[], at: { time?: number; track?: string }, timing: { over?: number; drop?: number; read?: number } = {}) => {
    const got = Date.now();
    const paths = await findDropped(files, w.current ? { folder: join(w.current.path, "media") } : {});
    const found = Date.now();
    const result = await importPaths(w, paths, at);
    // Where a drop's time goes, from the drag's last move over the window to the clip on the timeline: always when it was slow.
    if (process.env.BEACON_PROFILE || Date.now() - (timing.over ?? got) > 1000) {
      const ms = (a?: number, b?: number) => (a === undefined || b === undefined ? "?" : `${b - a}`);
      console.log(`[drop] ${files.map((f) => `${f.name} ${f.size} B${f.data === undefined ? "" : " +bytes"}`).join(", ")}: last over→drop ${ms(timing.over, timing.drop)} ms, read ${ms(timing.drop, timing.read)} ms, to main ${ms(timing.read, got)} ms, find ${found - got} ms, import ${Date.now() - found} ms`);
    }
    return result;
  };

  /** Where New Project offers to put a project: the folder chosen for the last one, while it is there. */
  function projectsFolder(): string {
    const folder = (core.readConfig("new-project.json") as { folder?: string } | undefined)?.folder;
    return folder && existsSync(folder) ? folder : PROJECTS;
  }

  /** File > New Project: `w` asks for the name and where, then `createProject`. */
  function newProject(w: ProjectWindow) {
    w.message("newProjectSheet", { name: "Untitled Project", folder: projectsFolder() });
  }

  async function createProject(name: string, canvas?: CanvasValues, standalone = false, folder?: string) {
    if (folder && !existsSync(folder)) throw new Error(`${folder} doesn't exist`);
    const to = freshProject(projectName(name), folder ?? projectsFolder());
    if (folder) core.writeConfig("new-project.json", { folder });
    await core.create({ path: to, ...(canvas ? { settings: canvasChange(canvas) } : {}), ...(standalone ? { standalone } : {}) });
    await open(to);
    windowFor(to).status(`New project: ${to}`);
  }

  /** File > Save As…: `w` asks for the copy's name, folder and whether it is standalone, then `saveAs`. */
  function saveAsDialog(w: ProjectWindow) {
    const current = w.current;
    if (!current) return w.status("Open a project first");
    w.message("saveAsSheet", { name: `${basename(current.path, ".beproj")} copy`, folder: dirname(current.path), standalone: !!core.doc(current.path).settings.standalone });
  }

  /** The copy is opened in place of `w`'s project, which stays as last saved. */
  const saveAs = (w: ProjectWindow, { name, folder, standalone }: { name: string; folder: string; standalone: boolean }) =>
    queued(async () => {
      const current = w.current;
      if (!current) throw new Error("Open a project first");
      const clean = projectName(name);
      if (standalone) w.status("Copying media into the project…");
      const to = await core.saveAs(current.path, join(folder, `${clean}.beproj`), { standalone });
      await switchTo(w, to);
      w.status(`Saved as ${to}`);
    });

  /** Clicking the project's name: its folder takes the new name, and Open Recent follows. */
  const renameProject = (w: ProjectWindow, name: string) =>
    queued(async () => {
      const current = w.current;
      if (!current) throw new Error("Open a project first");
      const from = current.path;
      const to = await core.rename(from, name);
      if (to === from) return;
      current.closed = true;
      await switchTo(w, to);
      setRecent(recent.filter((r) => r.path !== from));
    });

  return {
    recent: () => recent,
    recentProjects,
    clearRecent: () => setRecent([]),
    removeRecent,
    trashProject,
    openRecent,
    open,
    openDialog,
    closeWindow,
    playing,
    importMedia,
    dropFiles,
    importFile,
    newProject,
    createProject,
    projectsFolder,
    saveAsDialog,
    saveAs,
    renameProject,
    saveProjectThumbSoon,
  };
}
