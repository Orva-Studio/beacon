import { existsSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { ApplicationMenu, ContextMenu, Utils } from "electrobun/main";
import { chordOf, keyOfCode, keysLabel, LABEL_COLORS, locateTrack, menuKey, MODIFIERS, walkClips, type Keys, type ShortcutInfo } from "@beacon/core";
import { tileChoice, tileMenuItems, type TileMenu } from "@beacon/ui";
import { errorText, type App } from "./app";

export interface MenusApp extends App {
  /** Every action with its keys, the user's over the defaults. */
  shortcuts(): ShortcutInfo[];
  /** Open Recent's projects, newest first. */
  recent(): { path: string }[];
  openRecent(path: string): void;
  clearRecent(): void;
  /** The start screen's right-click: off the list, or to the Trash after asking. */
  removeRecent(path: string): void;
  trashProject(path: string): Promise<void>;
  /** The app's own actions ("app.export"), from menus, the palette or keys. */
  appAction(id: string): void;
  /** ⌘Q: close everything before Electrobun exits. */
  quit(): void;
}

type Item = { label: string; action?: string; accelerator?: string; enabled?: boolean; checked?: boolean; submenu?: MenuEntry[] };
type MenuEntry = Item | { type: "separator" } | { role: string; accelerator?: string };

const SEPARATOR = { type: "separator" as const };

/** A shortcut as a menu key equivalent ("shift+command+t"), for keys Electrobun's menus understand. */
function accelerator(keys: Keys): string | undefined {
  const chord = chordOf(keys);
  if (!chord) return undefined;
  // Electrobun's names for keys that aren't a character; ⇥ has none.
  const NAMES: Record<string, string> = { Backspace: "backspace", Delete: "delete", Enter: "enter", Escape: "escape", Space: "space", ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
  const typed = keyOfCode(chord.code);
  const key = NAMES[chord.code] ?? (typed?.length === 1 ? typed : undefined);
  if (!key) return undefined;
  const mods = chord.mods.split("+");
  return [...MODIFIERS.filter((m) => mods.includes(m)), key].join("+");
}

const capitalised = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** The application menu and the context menus (clip, canvas, Media Bin, track), and what their items do. */
export function createMenus(app: MenusApp) {
  const { core, message, status } = app;
  const fail = (err: unknown) => status(errorText(err));

  /**
   * A menu item for an action, showing its first key. With ⌘ or ⌃ the key is the item's key equivalent: the app's
   * own actions run here; commands hand the key back to the window, whose keymap runs them (so a text field that
   * has focus keeps its keys). Other keys would type into text fields, so they are written after the name instead.
   * A context menu's item runs its action whatever the key, on the selection it was opened for.
   */
  function item(id: string, opts: { label?: string; enabled?: boolean; context?: boolean } = {}): Item {
    const s = app.shortcuts().find((x) => x.id === id);
    const label = opts.label ?? s?.name ?? id;
    const keys = s?.keys[0];
    const accel = keys && menuKey(keys) ? accelerator(keys) : undefined;
    const chord = keys && chordOf(keys);
    const enabled = opts.enabled === undefined ? {} : { enabled: opts.enabled };
    if (accel && chord) return { label, accelerator: accel, action: id.startsWith("app.") || opts.context ? `act:${id}` : `key:${chord.mods}|${chord.code}`, ...enabled };
    return { label: keys ? `${label}  (${keysLabel(keys)})` : label, action: `act:${id}`, ...enabled };
  }
  const action = (id: string, opts: { label?: string; enabled?: boolean } = {}) => item(id, { ...opts, context: true });

  /** An action from a menu item: the app's own, or a command on the open project. */
  function runAction(id: string) {
    if (id.startsWith("app.")) return app.appAction(id);
    const current = app.current();
    if (!current) return;
    const h = current.path;
    const s = app.shortcuts().find((x) => x.id === id);
    if (id === "project.undo") core.undo(h).catch(fail);
    else if (id === "project.redo") core.redo(h).catch(fail);
    else if (s) core.run(h, s.command, s.args ?? {}).catch(fail);
  }

  /** The menu bar, for the focused project: the safe areas it shows are read from its session first. */
  function setMenu() {
    const current = app.current();
    if (!current) return buildMenu(undefined);
    core.session(current.path).then(
      (s) => buildMenu((s.features["safe-areas"] as { layout?: string } | undefined)?.layout),
      () => buildMenu(undefined),
    );
  }

  function buildMenu(safeArea: string | undefined) {
    const open = !!app.current();
    const recent = app.recent();
    ApplicationMenu.setApplicationMenu([
      {
        submenu: [
          { role: "about" },
          item("app.checkUpdates"),
          SEPARATOR,
          item("app.settings"),
          item("app.shortcuts"),
          SEPARATOR,
          { role: "hide" },
          { role: "hideOthers" },
          SEPARATOR,
          { label: "Quit Beacon", action: "quit", accelerator: "command+q" },
        ],
      },
      {
        label: "File",
        submenu: [
          item("app.new"),
          item("app.open"),
          {
            label: "Open Recent",
            submenu: [
              ...recent.map(({ path }) => ({ label: basename(path, ".beproj"), action: `recent:${path}` })),
              ...(recent.length ? [SEPARATOR] : []),
              { label: "Clear Menu", action: "recentClear", enabled: recent.length > 0 },
            ],
          },
          SEPARATOR,
          item("app.saveAs", { enabled: open }),
          item("app.reveal", { enabled: open }),
          SEPARATOR,
          item("app.import"),
          item("app.record"),
          SEPARATOR,
          item("app.export"),
          item("app.exportSelection"),
        ],
      },
      {
        label: "Edit",
        submenu: [
          item("project.undo"),
          item("project.redo"),
          SEPARATOR,
          // Cut, copy and paste stay roles: they reach the webview as clipboard events, which run the edit actions there and keep text fields working.
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          item("edit.delete"),
          item("edit.rippleCut"),
          // WKWebView swallows ⌘⌫ before the page sees it: the menu owns the key and hands it back to the window's keymap, as for every command.
          item("edit.rippleDelete"),
          item("edit.duplicate"),
          SEPARATOR,
          item("edit.silenceAudio"),
          item("edit.restoreAudio"),
          item("edit.addAudioPoint"),
          SEPARATOR,
          item("edit.split"),
          item("edit.splitAll"),
          item("edit.unlink"),
          SEPARATOR,
          item("edit.lockTrack"),
          item("edit.muteTrack"),
          SEPARATOR,
          { label: "Select", submenu: [item("selection.all"), item("selection.side:left", { label: "All Timeline to Left" }), item("selection.side:right", { label: "All Timeline to Right" })] },
          item("selection.clear"),
          { label: "Playhead", submenu: [item("edit.trimToPlayhead:start"), item("edit.trimToPlayhead:end")] },
          SEPARATOR,
          item("edit.addMarker"),
          SEPARATOR,
          item("app.projectSettings", { enabled: open }),
        ],
      },
      {
        label: "View",
        submenu: [
          item("timeline.snapping", { label: "Enable Timeline Snapping" }),
          item("canvas.snapping", { label: "Enable Canvas Snapping" }),
          SEPARATOR,
          {
            label: "Safe Areas",
            submenu: [
              { ...item("safeAreas.show:none", { label: "None", enabled: open }), checked: open && !safeArea },
              SEPARATOR,
              ...(
                [
                  ["tiktok", "TikTok"],
                  ["reels", "Instagram Reels"],
                  ["shorts", "YouTube Shorts"],
                  ["youtube", "YouTube (16:9)"],
                ] as const
              ).map(([id, label]) => ({ ...item(`safeAreas.show:${id}`, { label, enabled: open }), checked: safeArea === id })),
            ],
          },
          SEPARATOR,
          item("timeline.zoom:in"),
          item("timeline.zoom:out"),
          item("timeline.zoom:fit"),
        ],
      },
      { label: "Tools", submenu: [item("app.palette"), SEPARATOR, item("app.narration", { enabled: open })] },
      {
        label: "Window",
        submenu: [
          { role: "minimize", accelerator: "command+m" },
          { role: "zoom" },
          { role: "close", accelerator: "command+w" },
          SEPARATOR,
          { role: "toggleFullScreen", accelerator: "control+command+f" },
          { role: "bringAllToFront" },
        ],
      },
    ]);
  }

  ApplicationMenu.on("application-menu-clicked", (e) => {
    const action = (e as { data?: { action?: string } }).data?.action;
    if (action === "recentClear") return app.clearRecent();
    // Its own item rather than the Quit role, which ⌘Q did not reach (2026-10-12): close everything, then let Electrobun exit.
    if (action === "quit") {
      app.quit();
      return void Utils.quit();
    }
    if (action?.startsWith("key:")) {
      const [mods, code] = action.slice(4).split("|") as [string, string];
      const has = (m: string) => mods.split("+").includes(m);
      return message("key", { code, meta: has("command"), shift: has("shift"), alt: has("option"), ctrl: has("control") });
    }
    if (action?.startsWith("recent:")) return app.openRecent(action.slice(7));
    if (action?.startsWith("act:")) runAction(action.slice(4));
  });

  /** Whether a command or action would do anything now (the clicked clip is selected): the features decide, not a list of clip types. */
  const applies = (h: string, command: string, args: unknown = {}) => core.run(h, command, args, { dryRun: true }).then(() => true, () => false);

  /** Right-click on the canvas away from any clip. */
  async function canvasMenu() {
    const current = app.current();
    if (!current) return;
    const clipboard = !!(await core.session(current.path)).clipboard;
    ContextMenu.showContextMenu([action("app.projectSettings"), SEPARATOR, action("edit.paste", { enabled: clipboard }), action("canvas.zoom:fit", { label: "Zoom to Fit" })]);
  }

  /** The clip menu, acting on the selection (the clicked clip is selected first). */
  async function clipMenu({ clip, canvas }: { clip: string; canvas?: boolean }) {
    const current = app.current();
    if (!current) return;
    const h = current.path;
    const own = (label: string, op: string) => ({ label, action: `clip:${op}:${clip}` });
    // Inside an opened group the clicked clip is one of its own.
    const target = [...walkClips(core.doc(h).tracks, core.registry)].find((l) => l.clip.id === clip)?.clip;
    const labelled = (target?.props.label as { color?: string | null } | undefined)?.color ?? null;
    const colors = [...LABEL_COLORS, null].map((color) => ({ ...own(color ? capitalised(color) : "Default", `label=${color ?? "none"}`), checked: labelled === color }));
    const [open, ungroup, group, unstitch, stitch] = await Promise.all([
      applies(h, "group.open", { clip }),
      applies(h, "edit.ungroup"),
      applies(h, "edit.group"),
      applies(h, "edit.unstitch"),
      applies(h, "edit.stitch"),
    ]);
    ContextMenu.showContextMenu([
      action("edit.cut"),
      action("edit.copy"),
      SEPARATOR,
      action("edit.delete"),
      action("edit.rippleCut"),
      action("edit.rippleDelete"),
      ...(target?.linkId ? [SEPARATOR, action("edit.unlink")] : []),
      ...(target && core.registry.hasTrait(target.type, "visual") ? [SEPARATOR, action("edit.addAnimationAcross")] : []),
      SEPARATOR,
      own("Hide Properties", "hideProperties"),
      SEPARATOR,
      own("Select in Media Bin", "selectInBin"),
      SEPARATOR,
      action("edit.copyProperties"),
      action("edit.pasteProperties"),
      SEPARATOR,
      ...(open ? [action("group.open")] : []),
      ...(ungroup ? [action("edit.ungroup")] : group ? [action("edit.group")] : []),
      ...(unstitch ? [action("edit.unstitch")] : stitch ? [action("edit.stitch")] : []),
      SEPARATOR,
      { label: "Add Color Label", submenu: colors },
      SEPARATOR,
      own("Add Clip Speed", "clipSpeed"),
      SEPARATOR,
      action("edit.split", { label: "Split at Playhead" }),
      // From the canvas, where media usually covers it all, the canvas's own items too.
      ...(canvas ? [SEPARATOR, action("app.projectSettings"), action("canvas.zoom:fit", { label: "Zoom to Fit" })] : []),
    ]);
  }

  function binMenu({ asset }: { asset: string }) {
    const current = app.current();
    if (!current) return;
    const used = [...walkClips(core.doc(current.path).tracks, core.registry)].some((l) => l.clip.assetId === asset);
    const own = (label: string, op: string, enabled = true) => ({ label, action: `media:${op}:${asset}`, enabled });
    const a = core.doc(current.path).assets[asset];
    const proxyable = !!a && !!core.registry.jobAnalyzers.get("proxy")?.applies(a);
    const hasProxy = core.derived(current.path, asset, "proxy") !== undefined;
    const making = asset in current.bridge.proxies.queued || asset in current.bridge.proxies.jobs;
    const missing = !!a && !existsSync(a.path);
    ContextMenu.showContextMenu([
      ...(missing ? [own("Locate Media…", "locate"), SEPARATOR] : []),
      own("Add to Timeline at Playhead", "add"),
      own("Add to End of Timeline", "addEnd"),
      ...(proxyable ? [{ label: "Proxy Video", submenu: [own("Create Proxy Video", "proxyCreate", !hasProxy && !making), own("Delete Proxy Video", "proxyDelete", hasProxy || making)] }] : []),
      SEPARATOR,
      own("Delete", "delete"),
      own("Rename…", "rename"),
      // Only what was imported from elsewhere: a recording's streams are clips of their own.
      ...(a && a.kind !== "recording" ? [own("Replace Media…", "replace")] : []),
      SEPARATOR,
      own("Reveal in Finder", "reveal"),
      own("Select on Timeline", "select", used),
    ]);
  }

  /** A track on the timeline or inside a group, and whether it is a timeline one. */
  function trackAt(h: string, id: string) {
    const doc = core.doc(h);
    try {
      const { track, list } = locateTrack(doc, id, core.registry);
      return { track, top: list === doc.tracks, index: list.indexOf(track) };
    } catch {
      return undefined;
    }
  }

  function trackMenu({ track }: { track: string | null }) {
    const current = app.current();
    if (!current) return;
    if (track === null) {
      ContextMenu.showContextMenu([
        { label: "Insert Track", action: "track:insertTop:" },
        { label: "Remove All Empty Tracks", action: "track:removeEmpty:" },
        SEPARATOR,
        action("edit.lockTrack"),
        action("edit.muteTrack"),
        SEPARATOR,
        action("timeline.snapping", { label: "Enable Timeline Snapping" }),
      ]);
      return;
    }
    const found = trackAt(current.path, track);
    if (!found) return;
    const { track: t, top } = found;
    const own = (label: string, op: string) => ({ label, action: `track:${op}:${track}` });
    ContextMenu.showContextMenu([
      // A group's own tracks come with it; tracks are added on the main timeline.
      ...(top ? [own("Insert Track Above", "insertAbove"), own("Insert Track Below", "insertBelow"), SEPARATOR] : []),
      own("Rename…", "rename"),
      own(t.locked ? "Unlock Track" : "Lock Track", "lock"),
      own(t.magnetic ? "Disable Magnetic Track" : "Enable Magnetic Track", "magnetic"),
      own(t.hidden ? "Enable Track" : "Disable Track", "hidden"),
      SEPARATOR,
      own("Remove Track", "remove"),
      own("Remove All Empty Tracks", "removeEmpty"),
    ]);
  }

  /** Track menu items, as track commands. */
  function trackAction(h: string, op: string, track: string) {
    const found = track ? trackAt(h, track) : undefined;
    const t = found?.track;
    const index = found?.index ?? -1;
    const name = "";
    if (op === "insertTop") void core.run(h, "track.add", { name }, { label: "Insert Track" }).catch(fail);
    else if (op === "removeEmpty") void core.run(h, "track.removeEmpty", {}, { label: "Remove All Empty Tracks" }).catch(fail);
    else if (!t) return;
    else if ((op === "insertAbove" || op === "insertBelow") && !found?.top) return;
    else if (op === "insertAbove") void core.run(h, "track.add", { name, index: index + 1 }, { label: "Insert Track" }).catch(fail);
    else if (op === "insertBelow") void core.run(h, "track.add", { name, index }, { label: "Insert Track" }).catch(fail);
    else if (op === "rename") message("rename", { track });
    else if (op === "lock") void core.run(h, "track.set", { track, locked: !t.locked }, { label: t.locked ? "Unlock Track" : "Lock Track" }).catch(fail);
    else if (op === "magnetic") void core.run(h, "track.set", { track, magnetic: !t.magnetic }, { label: "Magnetic Track" }).catch(fail);
    else if (op === "hidden") void core.run(h, "track.set", { track, hidden: !t.hidden }, { label: t.hidden ? "Enable Track" : "Disable Track" }).catch(fail);
    else if (op === "remove") void core.run(h, "track.remove", { track }, { label: "Remove Track" }).catch(fail);
  }

  /** A file picked in Finder for the asset, starting where its file is (or was). */
  async function pickFor(path: string, types: string): Promise<string | undefined> {
    let start = dirname(path);
    while (!existsSync(start) && start !== "/") start = dirname(start);
    const [file] = await Utils.openFileDialog({ canChooseFiles: true, canChooseDirectory: false, allowsMultipleSelection: false, startingFolder: start, allowedFileTypes: types });
    return file || undefined;
  }

  /** Locate Media…: the moved file. */
  async function locateMedia(h: string, asset: string) {
    const a = core.doc(h).assets[asset];
    const file = a && (await pickFor(a.path, extname(a.path).slice(1)));
    if (!file) return;
    await core.relink(h, asset, file);
    status(`Found ${basename(file)}`);
  }

  /** Replace Media…: another file of the same kind. */
  async function replaceMedia(h: string, asset: string) {
    const a = core.doc(h).assets[asset];
    if (!a) return;
    const types = [...core.registry.importers.values()].filter((i) => i.kind === a.kind).flatMap((i) => i.extensions.map((e) => e.slice(1)));
    const file = await pickFor(a.path, types.join(","));
    if (!file) return;
    await core.replace(h, asset, file);
    status(`Replaced with ${basename(file)}`);
  }

  /** Media Bin menu items. */
  function mediaAction(h: string, op: string, asset: string) {
    const a = core.doc(h).assets[asset];
    if (!a) return;
    if (op === "add") void core.run(h, "edit.addMedia", { asset }).catch(fail);
    else if (op === "addEnd") void core.run(h, "edit.addMedia", { asset, end: true }).catch(fail);
    else if (op === "delete") void core.run(h, "edit.deleteMedia", { asset }).catch(fail);
    else if (op === "rename") message("renameMedia", { asset });
    else if (op === "reveal") Utils.showItemInFolder(a.path);
    else if (op === "select") void core.run(h, "edit.selectMedia", { asset }).catch(fail);
    else if (op === "proxyCreate") void core.analyze(h, "proxy", asset).catch(fail);
    else if (op === "proxyDelete") void core.forget(h, "proxy", asset).catch(fail);
    else if (op === "locate") void locateMedia(h, asset).catch(fail);
    else if (op === "replace") void replaceMedia(h, asset).catch(fail);
  }

  /** The clip menu's own items, on the clicked clip. */
  function clipAction(h: string, op: string, clip: string) {
    const run = (command: string, args: unknown = {}) => void core.run(h, command, args).catch(fail);
    if (op.startsWith("label=")) run("edit.label", { color: op === "label=none" ? null : op.slice(6) });
    // The clip's properties gain a Speed tab.
    else if (op === "clipSpeed") {
      message("showClipSpeed", { clip });
      run("panel.show", { properties: true });
      run("inspector.tab", { tab: "speed" });
    } else if (op === "hideProperties") run("panel.show", { properties: false });
    else if (op === "selectInBin") {
      const asset = core.doc(h).tracks.flatMap((t) => t.clips).find((c) => c.id === clip)?.assetId;
      run("panel.show", { tool: "media" });
      if (asset) message("media", { highlight: asset });
    }
  }

  /** The tile whose menu is shown: its item ids have colons, so the click names only the choice. */
  let tile: TileMenu | undefined;

  /** A tool panel tile's menu: add it as its double-click does, or star it. */
  async function tileMenu(t: TileMenu) {
    const current = app.current();
    if (!current) return;
    tile = t;
    const adds = await applies(current.path, t.command, t.args);
    ContextMenu.showContextMenu(tileMenuItems(t).map(([label, choice]) => ({ label, action: `tile:${choice}`, enabled: choice !== "add" || adds })));
  }

  /** The recent project whose menu is shown, kept here as a path may have colons. */
  let recentShown: string | undefined;

  /** A recent project's menu on the start screen, where no project is open. */
  function recentMenu(path: string) {
    recentShown = path;
    ContextMenu.showContextMenu([
      { label: "Open", action: "recent-menu:open" },
      { label: "Show in Finder", action: "recent-menu:reveal" },
      SEPARATOR,
      { label: "Remove from Recent Projects", action: "recent-menu:remove" },
      { label: "Move to Trash…", action: "recent-menu:trash" },
    ]);
  }

  ContextMenu.on("context-menu-clicked", (e) => {
    const chosen = String((e as { data?: { action?: string } }).data?.action ?? "");
    if (chosen.startsWith("act:")) return runAction(chosen.slice(4));
    if (chosen.startsWith("recent-menu:") && recentShown) {
      const path = recentShown;
      const op = chosen.slice(12);
      if (op === "open") return app.openRecent(path);
      if (op === "reveal") return Utils.showItemInFolder(path);
      if (op === "remove") return app.removeRecent(path);
      if (op === "trash") return void app.trashProject(path).catch(fail);
      return;
    }
    const current = app.current();
    if (!current) return;
    if (chosen.startsWith("tile:") && tile) return void tileChoice(core, current.path, tile, chosen.slice(5)).catch(fail);
    const [kind, op, id] = chosen.split(":") as [string, string, string];
    if (kind === "track") trackAction(current.path, op, id);
    else if (kind === "media") mediaAction(current.path, op, id);
    else if (kind === "clip") clipAction(current.path, op, id);
  });

  return { setMenu, canvasMenu, clipMenu, binMenu, trackMenu, tileMenu, recentMenu };
}
