import { useCallback, useEffect, useRef, useState } from "react";
import { rationalToNumber, ticksToSeconds, trackName, type Project, type Session } from "@beacon/model";
import { match, menuKey, runAction, useKeymap, useShortcutTip, type ActionHost } from "./keymap";
import { Palette } from "./palette";
import { acceptFiles, BEACON_CLIPS, droppedFiles, pastedImage } from "./drop";
import type { DroppedFile, Narrating } from "./rpc";
import { replica, useView } from "./store";
import { Properties } from "./properties";
import { ToolPanel, ToolRail } from "./sidebar";
import { Timeline } from "./timeline";
import { NO_NESTED } from "./timeline-draw";
import { CanvasOverlay } from "./canvas";
import type { CanvasMark } from "./canvas-marks";
import { NoticeUi } from "./notice";
import { MediaPreviewUi, type PreviewHost } from "./media-preview";
import { NewProjectUi, ProjectName, SaveAsUi, type ProjectHost } from "./project-name";
import { ResourceUi, type ResourceHost } from "./resource";
import { followResizes, MASK, nativeViewStyle, syncNativeView } from "./native-view";
import { rgba } from "./theme";
import { ExportToast, ExportUi, SnapshotSaved, type ExportHost } from "./export";
import { ImportProgress } from "./import-progress";
import { RecordUi, type RecordHost } from "./record";
import { clock } from "./time";
import { reviewOf, SilenceReviewPanel, useSilences } from "./remove-silences";
import { goTo } from "./review";
import { FillerReviewPanel, fillerReviewOf, useFillers } from "./remove-fillers";
import { RetakeReviewPanel, retakeMarks, retakeReviewOf, useRetakes } from "./remove-retakes";
import { SafeAreaPicker, useSafeAreas } from "./safe-areas";
import { ProjectSettingsUi } from "./project-settings";
import { useCaptionsPending } from "./captions";
import { SettingsUi, type SettingsHost } from "./settings";
import { StartScreen, type StartHost } from "./start-screen";
import { Button, EyedropperContext, Icon, isFormField, isTextField, NativeView, Select, Timecode, Toasts, type Eyedropper, type IconName, type NativeTag } from "./controls";

export interface Host extends ActionHost, ExportHost, RecordHost, SettingsHost, ProjectHost, PreviewHost, ResourceHost, StartHost {
  /** `label` names the undo step ("Move Media"). */
  run(command: string, args?: unknown, label?: string, coalesce?: string): void;
  /** A read-only query of the open project (`callout.textLayout`, `callout.fonts`…), as agents run them. */
  query(name: string, args?: unknown): Promise<unknown>;
  undo(): void;
  redo(): void;
  canvasView(id: number, rect: { x: number; y: number; width: number; height: number }, scale: number, surround: [number, number, number]): void;
  /** Draws the selection and guides in the native preview: positions in canvas pixels, sizes in points; without it the overlay draws them itself. */
  canvasMarks?(marks: CanvasMark[]): void;
  clipMenu(clip: string, from?: "canvas"): void;
  /** The canvas's menu where no clip is under the pointer: Project Settings…, Paste, Zoom to Fit. */
  canvasMenu(): void;
  trackMenu(track: string | null): void;
  binMenu(asset: string): void;
  importMedia(): void;
  dropFiles(files: DroppedFile[], at?: { time: number; track?: string }): void;
  /** The toolbar's Snapshot: the canvas at the playhead into the Media Bin. */
  captureFrame(): void;
  /** The canvas at the playhead as a PNG data URL, at the canvas size (the eyedropper samples it). */
  frameImage(): Promise<string | null>;
  binFrame(asset: string, time: number): Promise<string | null>;
  /** A file picked in Finder, of these extensions ("hlook"); null if cancelled. */
  chooseFile(extensions: string[]): Promise<string | null>;
  /** Starts a media item's background analysis (`transcript`…) unless it is running; its result arrives as derived data. */
  analyze(key: string, asset: string): void;
  /** Stars an item for the Favorites panel (at `index`, else at the end), un-stars it, or moves a favourite to `index`. */
  favoriteAdd(item: string, index?: number): void;
  favoriteRemove(item: string): void;
  favoriteMove(item: string, index: number): void;
}

/** Points around the canvas preview, where handles on its edges can still be grabbed. */
const CANVAS_MARGIN = 12;

const CANVAS_ZOOMS = [25, 33, 50, 66, 75, 100, 150, 200, 400];

/** Bound in the keymap, but run from clipboard events (see `onClipboard`). */
const CLIPBOARD: Record<string, boolean> = { "edit.cut": true, "edit.copy": true, "edit.paste": true };

/** The colour controls' eyedropper: the canvas takes the next click while it picks. */
const EYEDROPPER: Eyedropper = { start: (done) => replica.pick(done), stop: () => replica.pick(undefined), active: () => !!replica.get().picking };

export function App({ host }: { host: Host }) {
  useWindowGuards();
  const init = useView((s) => s.init);
  const opened = useView((s) => s.opened);
  const project = useView((s) => s.project);
  const session = useView((s) => s.session);
  const silences = useSilences(host, session, project);
  const fillers = useFillers(host, session, project);
  const retakes = useRetakes(host, session, project);
  useCaptionsPending(host);
  const status = useView((s) => s.status);
  const saved = useView((s) => s.saved);
  const making = useView((s) => Object.keys(s.preparing).length);
  const prepared = useView((s) => s.prepared);
  const waveforms = useView((s) => s.waveforms);
  const mutedAudio = (project?.tracks ?? []).flatMap((t, i) => (t.muted && t.clips.some((c) => init?.clipTypes[c.type]?.includes("audio")) ? [{ t, i }] : []));
  const thumbs = useView((s) => s.thumbs);
  const dragging = useView((s) => s.dragging);
  useEffect(syncNativeView, [dragging]);
  // Files dragged in from Finder: dropped on the timeline they go where dropped (its own handler), elsewhere after the last clip.
  // Without this the webview would open the file in place of the editor.
  useEffect(() => {
    const over = (e: DragEvent) => acceptFiles(e);
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      if (e.dataTransfer.files.length) void droppedFiles(e.dataTransfer).then((files) => host.dropFiles(files));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [host]);
  const keymap = useKeymap();

  // A click anywhere but a text field ends typing in one, so the shortcuts (arrows nudge, , and . step) work again.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const el = document.activeElement;
      if (isFormField(el) && el !== e.target && !isFormField(e.target)) el.blur();
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const field = isFormField(e.target);
      const b = match(keymap, e);
      if (!b?.command || CLIPBOARD[b.command]) return;
      // In a text field keys type, except the app's own with ⌘ or ⌃ (Export…, the palette), as their menu items would take them.
      if (field && !(b.command.startsWith("app.") && menuKey(b.keys))) return;
      e.preventDefault();
      runAction(host, b);
    };
    // ⌘X/⌘C/⌘V arrive as clipboard events, from the keys or the Edit menu's roles alike; text fields keep theirs.
    const onClipboard = (e: ClipboardEvent) => {
      if (isTextField(e.target)) return;
      e.preventDefault();
      if (e.type === "paste" && pastedImage(e.clipboardData)) {
        const at = replica.get().session?.playhead;
        return void droppedFiles(e.clipboardData!).then((files) => host.dropFiles(files.filter((f) => f.data !== undefined), at === undefined ? undefined : { time: at }));
      }
      if (e.type !== "paste") e.clipboardData?.setData(BEACON_CLIPS, "1");
      host.run(`edit.${e.type}`);
    };
    window.addEventListener("keydown", onKey);
    for (const t of ["cut", "copy", "paste"] as const) document.addEventListener(t, onClipboard);
    return () => {
      window.removeEventListener("keydown", onKey);
      for (const t of ["cut", "copy", "paste"] as const) document.removeEventListener(t, onClipboard);
    };
  }, [keymap, host]);

  return (
    <EyedropperContext.Provider value={EYEDROPPER}>
      <div className="flex h-screen flex-col gap-gutter bg-app px-gutter pb-gutter text-body text-text select-none">
        <TopBar name={opened?.name} project={project} session={session} host={host} status={status} saved={saved} preparing={making ? { done: prepared, total: prepared + making } : undefined} />
        <div className="flex min-h-0 flex-1 gap-gutter">
          <ToolRail session={session} host={host} />
          {session?.panels.tool && project && <ToolPanel tool={session.panels.tool} project={project} init={init} thumbs={thumbs} waveforms={waveforms} host={host} />}
          <div className="panel-card flex min-w-0 flex-1 flex-col overflow-hidden">
            <CanvasArea host={host} project={project} session={session} clipTypes={init?.clipTypes ?? {}} />
            {project && session && <Transport project={project} session={session} host={host} />}
          </div>
          {session?.panels.properties &&
            project &&
            (reviewOf(session) ? (
              <SilenceReviewPanel project={project} session={session} host={host} found={silences} />
            ) : fillerReviewOf(session) ? (
              <FillerReviewPanel project={project} host={host} found={fillers} />
            ) : retakeReviewOf(session) ? (
              <RetakeReviewPanel project={project} session={session} host={host} found={retakes} />
            ) : (
              <Properties project={project} session={session} host={host} init={init} />
            ))}
        </div>
        {project && session ? (
          <div className="panel-card flex h-[38%] min-h-[180px] flex-col overflow-hidden">
            <Toolbar session={session} host={host} />
            <Timeline
              project={project}
              session={session}
              waveforms={waveforms}
              thumbs={thumbs}
              clipTypes={init?.clipTypes ?? {}}
              nested={init?.nested ?? NO_NESTED}
              run={host.run}
              menu={host.clipMenu}
              trackMenu={host.trackMenu}
              dropFiles={host.dropFiles}
              marks={retakes ? retakeMarks(retakes) : (silences?.silences ?? fillers?.fillers)?.map((s, i) => ({ start: s.start, end: s.end, tone: s.cut ? "cut" : "keep", current: i === (silences ?? fillers)?.current }))}
              markClick={(m, alt) =>
                retakes
                  ? // A click picks the line to look at; a click on one of its takes then keeps that one.
                    alt || !m.current
                    ? goTo(host, "retakes", m)
                    : host.run("retakes.keep", { at: (m.start + m.end) / 2 })
                  : alt
                    ? goTo(host, silences ? "silences" : "fillers", m)
                    : host.run(silences ? "silences.flip" : "fillers.flip", { at: m.start })
              }
            />
          </div>
        ) : (
          <div className="panel-card h-[30%]" />
        )}
        <ExportUi
          host={host}
          muted={mutedAudio.map(({ t, i }) => trackName(t, project!.tracks.length - 1 - i))}
          unmute={() => {
            // One undo step for them all.
            const step = `unmute-${Date.now()}`;
            for (const { t } of mutedAudio) host.run("track.set", { track: t.id, muted: false }, "Unmute Tracks", step);
          }}
        />
        <RecordUi host={host} />
        <Toasts>
          <ExportToast host={host} />
          <SnapshotSaved host={host} />
          <ImportProgress project={project} />
        </Toasts>
        <SettingsUi host={host} />
        <ProjectSettingsUi host={host} />
        <StartScreen host={host} />
        <NewProjectUi host={host} />
        <SaveAsUi host={host} />
        <ResourceUi host={host} />
        <MediaPreviewUi host={host} />
        <NoticeUi />
        <Palette host={host} />
        {/* The dragged panel item; a mask so it shows over the native canvas too. */}
        {dragging && (
          <div
            className={`${MASK} pointer-events-none fixed z-50 rounded-md bg-tile-hover px-2 py-1 text-label text-text-strong shadow-lg ring-1 ring-accent`}
            style={{ left: dragging.x + 10, top: dragging.y + 10 }}
          >
            {dragging.item.label}
          </div>
        )}
      </div>
    </EyedropperContext.Provider>
  );
}

/** What the window does whatever is open: it never scrolls, and keeps the webview's menu from the page. */
function useWindowGuards() {
  // The window never scrolls; WebKit scrolls it anyway to bring a focused element into view (a dialog's panel),
  // which shifted the page under the native canvas. Panels' own scrolling is left alone.
  useEffect(() => {
    const pin = (e: Event) => {
      const page = [document.scrollingElement, document.body, document.documentElement, document.getElementById("root")];
      if (e.target !== document && !page.includes(e.target as Element)) return;
      for (const el of page) if (el && (el.scrollTop || el.scrollLeft)) el.scrollTop = el.scrollLeft = 0;
    };
    window.addEventListener("scroll", pin, true);
    return () => window.removeEventListener("scroll", pin, true);
  }, []);
  // The webview's own menu (Reload, Inspect Element) is for developers; text fields keep theirs.
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      if (!isTextField(e.target)) e.preventDefault();
    };
    window.addEventListener("contextmenu", onMenu);
    return () => window.removeEventListener("contextmenu", onMenu);
  }, []);
}

/** The red dot at the window's top left, as Camtasia has: the Record dialog, as File › Record… (⌘R) opens it. */
function RecordButton({ host }: { host: Host }) {
  return (
    <button type="button" title="Record (⌘R)" onClick={() => host.openRecord()} className="flex items-center gap-1.5 rounded-md bg-control px-2.5 py-1 text-text-strong hover:bg-tile-hover" data-record-button>
      <i className="block h-2.5 w-2.5 rounded-full bg-danger" />
      Record
    </button>
  );
}


/** While a narration records over the playing timeline: its time, Stop (it goes on the timeline) and Discard. */
function NarrationBar({ narrating, host }: { narrating: Narrating; host: Host }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex items-center gap-2 rounded-md bg-danger/15 py-0.5 pl-2.5 pr-1 text-xs" data-narrating>
      <span className="h-2 w-2 animate-pulse rounded-full bg-danger" />
      <span className="tabular-nums text-text-strong">Narrating {clock((now - narrating.started) / 1000, { floor: true })}</span>
      <Button look="danger" onClick={() => host.stopNarration()} title="Stop and put the narration on the timeline (⌘⇧2)" data-narration-stop>
        Stop
      </Button>
      <Button look="quiet" onClick={() => host.stopNarration(true)} title="Stop and throw the narration away" data-narration-discard>
        Discard
      </Button>
    </div>
  );
}

function TopBar({ name, project, session, host, status, saved, preparing }: { name?: string; project?: Project; session?: Session; host: Host; status: string; saved?: boolean; preparing?: { done: number; total: number } }) {
  const zoom = session?.canvas.zoom ?? "fit";
  const { layouts } = useSafeAreas(host, project, session);
  const narrating = useView((v) => v.narrating);
  // ⌘S out of habit (`app.save`): no dialog, the label confirms the project is already saved.
  const asked = useView((v) => v.confirmSaved);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!asked) return;
    setConfirm(true);
    const timer = setTimeout(() => setConfirm(false), 1500);
    return () => clearTimeout(timer);
  }, [asked]);
  return (
    <div className="-mx-gutter flex h-10 shrink-0 items-center gap-3 bg-app px-3 pl-20 electrobun-webkit-app-region-drag" data-titlebar>
      {name && !narrating && <RecordButton host={host} />}
      <ProjectName name={name} host={host} />
      {/* Every change is written as it is made, so there is no Save: ⌘S says so for a moment, and a failed save stays. */}
      {name && (saved === false ? <span className="text-xs text-danger" title={status}>Not saved</span> : confirm && <span className="text-xs text-accent" data-saved title="Every change is saved as you make it">✓ Saved automatically</span>)}
      <Button onClick={() => host.openDialog()}>Open…</Button>
      <div className="flex flex-1 justify-center">{narrating && <NarrationBar narrating={narrating} host={host} />}</div>
      {preparing && (
        <span className="text-xs text-text-faint" data-preparing title="Making proxies: copies of the media that seek quickly; each item's progress is on its Media Bin tile">
          Preparing media for scrubbing {preparing.done + 1} of {preparing.total}
        </span>
      )}
      <span className="truncate text-xs text-text-faint">{status}</span>
      {project && session && <SafeAreaPicker host={host} project={project} session={session} layouts={layouts} />}
      {session && (
        <Select
          look="bar"
          value={String(zoom)}
          onChange={(e) => host.run("canvas.zoom", { zoom: e.target.value === "fit" ? "fit" : Number(e.target.value) })}
        >
          <option value="fit">Fit</option>
          {CANVAS_ZOOMS.map((z) => (
            <option key={z} value={z}>
              {z}%
            </option>
          ))}
          {typeof zoom === "number" && !CANVAS_ZOOMS.includes(zoom) && <option value={zoom}>{zoom}%</option>}
        </Select>
      )}
    </div>
  );
}

/** Hosts the native GPU view the main process renders the canvas into. */
function CanvasArea({ host, project, session, clipTypes }: { host: Host; project?: Project; session?: Session; clipTypes: Record<string, string[]> }) {
  const hasProject = !!project;
  const ref = useRef<NativeTag>(null);
  const area = useRef<HTMLDivElement>(null);
  /** Where the native view is, in the area: the overlay is placed from it rather than from the inset it is meant to have. */
  const [view, setView] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const report = useCallback(
    (id: number, rect: { x: number; y: number; width: number; height: number }, scale: number) => {
      const [sr, sg, sb] = rgba("stage");
      host.canvasView(id, rect, scale, [sr, sg, sb]);
    },
    [host],
  );
  useEffect(() => {
    const el = ref.current;
    const box = area.current;
    if (!el || !box) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const a = box.getBoundingClientRect();
      setView({ x: r.x - a.x, y: r.y - a.y, width: r.width, height: r.height });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(box);
    measure();
    const unfollow = followResizes(el, box);
    return () => {
      ro.disconnect();
      unfollow();
    };
  }, [hasProject]);
  return (
    <div ref={area} className="relative min-h-0 flex-1 overflow-hidden bg-stage">
      {hasProject ? (
        <>
          {/* Clicks pass through the native view to the overlay's grab areas; inset so handles at the canvas's edges stay inside the area. */}
          <NativeView tagRef={ref} onReport={report} passthrough masks={`.${MASK}`} style={nativeViewStyle(CANVAS_MARGIN)} />
          {session && view.width > 0 && <CanvasOverlay project={project} session={session} host={host} view={view} clipTypes={clipTypes} />}
        </>
      ) : (
        <div className="flex h-full items-center justify-center text-text-off">Open a project (⌘O), or start a new one (⌘N) and import media (⌘I)</div>
      )}
    </div>
  );
}

const TOOL_ICONS: Record<string, IconName> = {
  undo: "arrow-counter-clockwise",
  redo: "arrow-clockwise",
  cut: "scissors",
  copy: "copy",
  paste: "clipboard-text",
  split: "split-horizontal",
  snapshot: "camera",
};

/** The toolbar above the timeline: undo, redo, cut, copy, paste, split, snapshot, then the timeline zoom. */
function Toolbar({ session, host }: { session: Session; host: Host }) {
  const tip = useShortcutTip();
  const some = session.selection.length > 0 || !!session.range;
  const tool = (name: string, title: string, onClick: () => void, enabled = true) => (
    <Button look="icon" title={title} disabled={!enabled} onClick={onClick}>
      <Icon name={TOOL_ICONS[name]!} />
    </Button>
  );
  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-divider bg-bar px-3">
      {session.group && (
        <div className="mr-3 flex items-center gap-1 text-label">
          <Button look="crumb" title={`Close the group${tip("group.close")}`} onClick={() => host.run("group.close")}>
            Main Timeline
          </Button>
          <span className="text-text-disabled">›</span>
          <span className="rounded-sm bg-control px-2 py-0.5 font-semibold text-text-strong">Group</span>
        </div>
      )}
      {tool("undo", `Undo${tip("project.undo")}`, () => host.undo())}
      {tool("redo", `Redo${tip("project.redo")}`, () => host.redo())}
      <div className="mx-1.5 h-4 w-px bg-divider" />
      {tool("cut", `Cut${tip("edit.cut")}`, () => host.run("edit.cut"), some)}
      {tool("copy", `Copy${tip("edit.copy")}`, () => host.run("edit.copy"), some)}
      {tool("paste", `Paste${tip("edit.paste")}`, () => host.run("edit.paste"), !!session.clipboard)}
      {tool("split", `Split${tip("edit.split")}`, () => host.run("edit.split"))}
      {tool("snapshot", "Snapshot: add the frame at the playhead to the Media Bin", () => host.captureFrame())}
      <div className="flex-1" />
      <Button look="icon" title={`Zoom out${tip("timeline.zoom", { to: "out" })}`} onClick={() => host.run("timeline.zoom", { to: "out" })}>
        <Icon name="minus" />
      </Button>
      <Button look="icon" title={`Zoom to fit${tip("timeline.zoom", { to: "fit" })}`} onClick={() => host.run("timeline.zoom", { to: "fit" })}>
        <Icon name="arrows-out-line-horizontal" />
      </Button>
      <Button look="icon" title={`Zoom in${tip("timeline.zoom", { to: "in" })}`} onClick={() => host.run("timeline.zoom", { to: "in" })}>
        <Icon name="plus" />
      </Button>
    </div>
  );
}

function Transport({ project, session, host }: { project: Project; session: Session; host: Host }) {
  const fps = rationalToNumber(project.settings.fps);
  const end = Math.max(0, ...project.tracks.flatMap((t) => t.clips.map((c) => ticksToSeconds(c.start + c.duration))));
  const tip = useShortcutTip();
  return (
    <div className="flex h-9 shrink-0 items-center justify-center gap-1 border-b border-divider bg-bar px-3">
      <Button look="icon" title={`Previous media${tip("playhead.jump", { to: "previousEdit" })}`} onClick={() => host.run("playhead.jump", { to: "previousEdit" })}>
        <Icon name="skip-back" filled />
      </Button>
      <Button look="icon" title={`Step back${tip("playhead.step", { frames: -1 })}`} onClick={() => host.run("playhead.step", { frames: -1 })}>
        <Icon name="caret-left" filled />
      </Button>
      <Button look="icon" title={`Play/pause${tip("playback.toggle")}`} onClick={() => host.run("playback.toggle")}>
        <Icon name={session.playing ? "pause" : "play"} size={20} filled />
      </Button>
      <Button look="icon" title={`Step forward${tip("playhead.step", { frames: 1 })}`} onClick={() => host.run("playhead.step", { frames: 1 })}>
        <Icon name="caret-right" filled />
      </Button>
      <Button look="icon" title={`Next media${tip("playhead.jump", { to: "nextEdit" })}`} onClick={() => host.run("playhead.jump", { to: "nextEdit" })}>
        <Icon name="skip-forward" filled />
      </Button>
      <span className="ml-3">
        <Timecode time={session.playhead} end={end} fps={fps} />
        {session.playing && session.rate !== 1 && <span className="ml-2 font-mono text-xs text-accent">{session.rate < 0 ? "◀ " : ""}{Math.abs(session.rate)}x</span>}
      </span>
    </div>
  );
}
