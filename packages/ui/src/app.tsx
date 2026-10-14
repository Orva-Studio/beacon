import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rationalToNumber, ticksToSeconds, trackName, type Project, type Session } from "@beacon/model";
import { compileKeymap, label, match } from "./keymap";
import { droppedFiles } from "./drop";
import type { DroppedFile, Init } from "./rpc";
import { useView } from "./store";
import { Properties } from "./properties";
import { ToolPanel, ToolRail } from "./sidebar";
import { Timeline } from "./timeline";
import { CanvasOverlay, type CanvasMark } from "./canvas";
import { NoticeUi } from "./notice";
import { MediaPreviewUi, type PreviewHost } from "./media-preview";
import { NewProjectUi, ProjectName, type ProjectHost } from "./project-name";
import { followResizes, MASK, nativeViewStyle, syncNativeView } from "./native-view";
import { rgba } from "./theme";
import { ExportUi, SnapshotSaved, type ExportHost } from "./export";
import { RecordUi, type RecordHost } from "./record";
import { SettingsUi, type SettingsHost } from "./settings";
import { Button, Icon, NativeView, Select, Timecode, type IconName, type NativeTag } from "./controls";

export interface Host extends ExportHost, RecordHost, SettingsHost, ProjectHost, PreviewHost {
  /** `label` names the undo step ("Move Media"). */
  run(command: string, args?: unknown, label?: string, coalesce?: string): void;
  /** A read-only query of the open project (`callout.textLayout`, `callout.fonts`…), as agents run them. */
  query(name: string, args?: unknown): Promise<unknown>;
  undo(): void;
  redo(): void;
  openDialog(): void;
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
  /** Starts a media item's background analysis (`transcript`…) unless it is running; its result arrives as derived data. */
  analyze(key: string, asset: string): void;
}

/** Points around the canvas preview, where handles on its edges can still be grabbed. */
const CANVAS_MARGIN = 12;

const CANVAS_ZOOMS = [25, 33, 50, 66, 75, 100, 150, 200, 400];

/** Bound in the keymap, but run from clipboard events (see `onClipboard`). */
const CLIPBOARD: Record<string, boolean> = { "edit.cut": true, "edit.copy": true, "edit.paste": true };

export function App({ host }: { host: Host }) {
  useWindowGuards();
  const init = useView((s) => s.init);
  const opened = useView((s) => s.opened);
  const project = useView((s) => s.project);
  const session = useView((s) => s.session);
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
    const over = (e: DragEvent) => e.dataTransfer?.types.includes("Files") && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      const files = droppedFiles(e.dataTransfer);
      if (files.length) host.dropFiles(files);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [host]);
  const keymap = useMemo(() => compileKeymap(init?.keymap ?? []), [init]);

  // A click anywhere but a text field ends typing in one, so the shortcuts (arrows nudge, , and . step) work again.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const el = document.activeElement;
      const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
      if (field && el !== e.target && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) el.blur();
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.metaKey && e.code === "KeyO") {
        e.preventDefault();
        return host.openDialog();
      }
      const b = match(keymap, e);
      if (!b?.command || CLIPBOARD[b.command]) return;
      e.preventDefault();
      if (b.command === "project.undo") host.undo();
      else if (b.command === "project.redo") host.redo();
      else host.run(b.command, b.args ?? {});
    };
    // ⌘X/⌘C/⌘V arrive as clipboard events, from the keys or the Edit menu's roles alike; text fields keep theirs.
    const onClipboard = (e: ClipboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
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
    <div className="flex h-screen flex-col gap-gutter bg-app px-gutter pb-gutter text-body text-text select-none">
      <TopBar name={opened?.name} session={session} host={host} status={status} saved={saved} preparing={making ? { done: prepared, total: prepared + making } : undefined} />
      <div className="flex min-h-0 flex-1 gap-gutter">
        <ToolRail session={session} host={host} />
        {session?.panels.tool && project && <ToolPanel tool={session.panels.tool} project={project} init={init} thumbs={thumbs} waveforms={waveforms} host={host} />}
        <div className="panel-card flex min-w-0 flex-1 flex-col overflow-hidden">
          <CanvasArea host={host} project={project} session={session} clipTypes={init?.clipTypes ?? {}} />
          {project && session && <Transport project={project} session={session} host={host} init={init} />}
        </div>
        {session?.panels.properties && project && <Properties project={project} session={session} host={host} init={init} />}
      </div>
      {project && session ? (
        <div className="panel-card flex h-[38%] min-h-[180px] flex-col overflow-hidden">
          <Toolbar session={session} host={host} init={init} />
          <Timeline
            project={project}
            session={session}
            waveforms={waveforms}
            thumbs={thumbs}
            clipTypes={init?.clipTypes ?? {}}
            nested={init?.nested ?? {}}
            run={host.run}
            menu={host.clipMenu}
            trackMenu={host.trackMenu}
            dropFiles={host.dropFiles}
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
      <SnapshotSaved host={host} />
      <SettingsUi host={host} />
      <NewProjectUi host={host} />
      <MediaPreviewUi host={host} />
      <NoticeUi />
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
      if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) e.preventDefault();
    };
    window.addEventListener("contextmenu", onMenu);
    return () => window.removeEventListener("contextmenu", onMenu);
  }, []);
}

function TopBar({ name, session, host, status, saved, preparing }: { name?: string; session?: Session; host: Host; status: string; saved?: boolean; preparing?: { done: number; total: number } }) {
  const zoom = session?.canvas.zoom ?? "fit";
  // ⌘S out of habit: no dialog, the label confirms the project is already saved.
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      setConfirm(true);
      clearTimeout(timer);
      timer = setTimeout(() => setConfirm(false), 1500);
    };
    window.addEventListener("keydown", onKey);
    return () => (window.removeEventListener("keydown", onKey), clearTimeout(timer));
  }, []);
  return (
    <div className="-mx-gutter flex h-10 shrink-0 items-center gap-3 bg-app px-3 pl-20" data-electrobun-drag-region>
      <ProjectName name={name} host={host} />
      {/* Every change is written as it is made, so there is no Save; say so, and say when it fails. */}
      {name && (saved === false ? <span className="text-xs text-danger" title={status}>Not saved</span> : <span className={`text-xs transition-colors ${confirm ? "text-accent" : "text-text-faint"}`} data-saved title="Every change is saved as you make it">{confirm ? "✓ " : ""}Saved automatically</span>)}
      <Button onClick={() => host.openDialog()}>Open…</Button>
      <div className="flex-1" />
      {preparing && (
        <span className="text-xs text-text-faint" data-preparing title="Making proxies: copies of the media that seek quickly; each item's progress is on its Media Bin tile">
          Preparing media for scrubbing {preparing.done + 1} of {preparing.total}
        </span>
      )}
      <span className="truncate text-xs text-text-faint">{status}</span>
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
function Toolbar({ session, host, init }: { session: Session; host: Host; init?: Init }) {
  const tip = (command: string, args?: object) => {
    const b = init?.keymap.find((k) => k.command === command && JSON.stringify(k.args ?? {}) === JSON.stringify(args ?? {}));
    return b ? ` (${label(b.keys)})` : "";
  };
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

function Transport({ project, session, host, init }: { project: Project; session: Session; host: Host; init?: Init }) {
  const fps = rationalToNumber(project.settings.fps);
  const end = Math.max(0, ...project.tracks.flatMap((t) => t.clips.map((c) => ticksToSeconds(c.start + c.duration))));
  const tip = (command: string, args?: object) => {
    const b = init?.keymap.find((k) => k.command === command && JSON.stringify(k.args ?? {}) === JSON.stringify(args ?? {}));
    return b ? ` (${label(b.keys)})` : "";
  };
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
