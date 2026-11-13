import { useEffect, useRef, useState } from "react";
import { ticksToSeconds, trackName, type Clip, type Project, type Session } from "@beacon/model";
import { acceptFiles, addDropTarget, type DropTarget } from "./drop";
import type { DroppedFile } from "./rpc";
import { RenameField } from "./controls";
import { headerWidth, maxTop, rowTop, RULER, TRACKS_TOP } from "./timeline-layout";
import { SectionNamer } from "./section-namer";
import { replica, useView } from "./store";
import { clipLabel, drawTimeline, keepImages, timelineView, type Drag, type TimelineMark } from "./timeline-draw";
import { timelineClicks } from "./timeline/clicks";
import type { TimelineContext } from "./timeline/context";
import { timelineDrag } from "./timeline/drag";
import { timelineHits } from "./timeline/hit-test";
import { useTimelineKeys } from "./timeline/use-timeline-keys";

interface Props {
  project: Project;
  session: Session;
  waveforms: Record<string, Record<number, number[]>>;
  thumbs: Record<string, string>;
  clipTypes: Record<string, string[]>;
  /** Clip type → the prop group holding its own tracks. */
  nested: Record<string, string>;
  run: (command: string, args?: unknown, label?: string, coalesce?: string) => void;
  /** The right-click menu for a clip, shown natively by the main process. */
  menu: (clip: string) => void;
  /** A track's menu (Insert Track, Rename…, Lock…), or with null the track options under ⌄. */
  trackMenu: (track: string | null) => void;
  sectionMenu: (section: string) => void;
  markerMenu: (marker: string) => void;
  /** Files dragged in from Finder, dropped at a time (and on a track). */
  dropFiles: (files: DroppedFile[], at: { time: number; track?: string }) => void;
  /** Spans marked across the tracks while something is reviewed (Remove Silences: every one red, the selected outlined). */
  marks?: TimelineMark[];
  /** A click on a mark (not by the playhead): Remove Silences flips it, or with ⌥ goes to it. */
  markClick?: (mark: TimelineMark, alt: boolean, shift: boolean, meta: boolean) => void;
}

export function Timeline({ project: full, session, waveforms, thumbs, clipTypes, nested, run, menu, trackMenu, sectionMenu, markerMenu, dropFiles, marks, markClick }: Props) {
  const { project } = timelineView(full, session, nested);
  const HEADER = headerWidth(project.tracks);
  const label = (clip: Clip) => clipLabel(project, clip, nested, clipTypes[clip.type]);
  const renaming = useView((s) => s.renaming);
  const dragging = useView((s) => s.dragging);
  const pickedSection = useView((s) => s.section);
  const namingSection = useView((s) => s.namingSection);
  const pickedMarker = useView((s) => s.marker);
  const namingMarker = useView((s) => s.namingMarker);
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const dragState = useRef<Drag | null>(null);
  /** The clip clicked last (not ⇧-clicked): a ⇧-click selects the run from it. */
  const anchor = useRef<string | null>(null);
  /**
   * A move or trim just released, drawn as it was dropped until the edit's patch arrives: drawing the document as
   * it still is showed the clip back where it started for a few frames.
   */
  const settling = useRef<{ drag: Drag; timer: ReturnType<typeof setTimeout> } | null>(null);
  /** Where the dragged edge last snapped (seconds), drawn as a line while the drag lasts. */
  const snapLine = useRef<number | undefined>(undefined);
  /** The animation diamond last clicked (drawn red while its animation is selected). */
  const pickedDiamond = useRef<{ anim: string; part: "start" | "end" } | undefined>(undefined);
  // Selecting another animation, or none, from anywhere (Properties, undo) forgets it.
  useEffect(() => {
    if (pickedDiamond.current?.anim !== session.animation?.id) pickedDiamond.current = undefined;
  }, [session.animation?.id]);
  const pending = useRef(0);
  const edge = useRef({ x: 0, raf: 0 });
  const latest = useRef({ project, session, waveforms, thumbs, dragging, marks, section: pickedSection, naming: namingSection, marker: pickedMarker });
  useEffect(() => keepImages(full, thumbs), [full, thumbs]);
  const staticLayer = useRef<{ canvas?: HTMLCanvasElement; key: unknown[] }>({ key: [] });
  /** Counts thumbnails decoded, so the cached layer is redrawn with them. */
  const loaded = useRef(0);
  /** When each clip last had an effect added, for its badge's flash. */
  const flashes = useRef(new Map<string, number>());
  const effectCounts = useRef<Map<string, number> | null>(null);
  latest.current = { project, session, waveforms, thumbs, dragging, marks, section: pickedSection, naming: namingSection, marker: pickedMarker };

  const tracks = [...project.tracks].reverse();
  const TRACK = session.timeline.trackHeight;
  // Rendered again on a resize, so hit testing reads the same clamped offset as drawing.
  const [, setBoxHeight] = useState(0);
  const TOP = Math.min(session.timeline.top ?? 0, maxTop(tracks.length, TRACK, size.current.h));
  // An offset past the tracks (some removed, the window grown) is let go, so tracks added later don't scroll to it.
  useEffect(() => {
    if (size.current.h && (session.timeline.top ?? 0) > TOP) run("timeline.scroll", { top: TOP });
  }, [session.timeline.top, TOP]);

  const draw = () =>
    drawTimeline({ canvas, latest, size, staticLayer, dragState, settling, snapLine, pickedDiamond, loaded, flashes, HEADER, nested, clipTypes, label, redraw: () => drawRef.current(), dropHit: hits.dropHit, mediaHit: hits.mediaHit });

  useEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      size.current = { w: r.width, h: r.height };
      setBoxHeight(r.height);
      const c = canvas.current!;
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      c.style.width = `${r.width}px`;
      c.style.height = `${r.height}px`;
      drawRef.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Before the draw below: the document now has the released edit (or another change), so its preview goes.
  useEffect(() => {
    if (!settling.current) return;
    clearTimeout(settling.current.timer);
    settling.current = null;
  }, [project]);
  useEffect(draw);
  // Callbacks registered once (the resize observer, thumbnail loads) must draw with the latest render's data.
  const drawRef = useRef(draw);
  drawRef.current = draw;

  // An effect added to a clip flashes its fx badge, redrawn each frame until it fades.
  useEffect(() => {
    const counts = new Map(project.tracks.flatMap((t) => t.clips.map((c) => [c.id, c.effects.length] as const)));
    const before = effectCounts.current;
    effectCounts.current = counts;
    if (!before) return;
    const grew = [...counts].filter(([id, n]) => n > (before.get(id) ?? 0)).map(([id]) => id);
    if (!grew.length) return;
    for (const id of grew) flashes.current.set(id, performance.now());
    let frame = 0;
    const tick = () => {
      drawRef.current();
      if (flashes.current.size) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [project]);

  useTimelineKeys(dragState, snapLine, drawRef);

  // A press anywhere off the timeline (the canvas, a panel) lets a picked section or marker go, so ⌫ is for what was pressed.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (e.target === canvas.current) return;
      replica.section(undefined);
      replica.marker(undefined);
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, []);

  const context: TimelineContext = { canvas, latest, size, dragState, settling, snapLine, pickedDiamond, anchor, pending, edge, drawRef, HEADER, TRACK, TOP, tracks, clipTypes, run };
  const hits = timelineHits(context);
  const dropRef = useRef<DropTarget>(undefined);
  dropRef.current = (cx, cy, item) => {
    if (item.media) return ((h) => (h && !h.bad ? { time: h.time, ...(h.track ? { track: h.track } : {}) } : undefined))(hits.mediaHit(cx, cy, item.media.seconds));
    return ((h) => h && { clip: h.clip.id, time: h.time })(hits.dropHit(cx, cy, item));
  };
  useEffect(() => addDropTarget((...a) => dropRef.current!(...a)), []);

  const [marker, setMarker] = useState<{ id: string; name: string; x: number }>();
  const hoverMarker = (m: typeof marker) => setMarker((was) => (was?.id === m?.id && was?.x === m?.x && was?.name === m?.name ? was : m));
  const { onPointerDown, onPointerMove, finish } = timelineDrag({ ...context, draw }, hits, { trackMenu, markClick, markerHover: hoverMarker });
  const clicks = timelineClicks(context, hits, { menu, trackMenu, sectionMenu, markerMenu, dropFiles });

  return (
    <div ref={box} className="relative min-h-0 flex-1 overflow-hidden">
      <canvas
        ref={canvas}
        data-timeline
        className="absolute inset-0"
        onDragOver={acceptFiles}
        onDrop={clicks.onDrop}
        onPointerDown={(e) => (setMarker(undefined), onPointerDown(e))}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setMarker(undefined)}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={(e) => dragState.current && finish(e)}
        onDoubleClick={clicks.onDoubleClick}
        onContextMenu={clicks.onContextMenu}
        onWheel={clicks.onWheel}
      />
      {marker && (
        <div
          className="pointer-events-none absolute z-20 max-w-80 rounded-md border border-divider bg-panel px-2 py-1 text-label break-words text-text-strong shadow-xl"
          style={{ left: Math.max(4, Math.min(marker.x - 8, size.current.w - 330)), top: RULER + 2 }}
          data-marker-tip
        >
          {marker.name}
        </div>
      )}
      {namingMarker &&
        ((m) =>
          m && (
            <RenameField
              key={m.id}
              value={m.name}
              className="absolute z-20 text-label"
              style={{ left: Math.max(HEADER, Math.min(hits.xOf(ticksToSeconds(m.time)) - 8, size.current.w - 248)), top: RULER + 2, width: 240, height: 22 }}
              onDone={(name) => {
                replica.nameMarker(undefined);
                if (name !== null && name !== m.name) run("marker.set", { marker: m.id, name }, "Rename Marker");
              }}
            />
          ))(project.markers.find((x) => x.id === namingMarker))}
      {namingSection && (
        <SectionNamer
          key={namingSection.id ?? `${namingSection.start}`}
          value={project.sections.find((s) => s.id === namingSection.id) ?? { name: "" }}
          style={{ left: Math.min(Math.max(HEADER, hits.xOf(namingSection.start)), Math.max(HEADER, size.current.w - 264)), top: TRACKS_TOP + 2, maxHeight: Math.max(120, size.current.h - TRACKS_TOP - 8) }}
          onDone={(text) => {
            replica.nameSection(undefined);
            if (text === null || (!namingSection.id && !text.name && !text.comment)) return draw();
            if (!namingSection.id) return run("section.add", { start: namingSection.start, end: namingSection.end, ...(text.name ? { name: text.name } : {}), ...(text.comment ? { comment: text.comment } : {}) }, "Add Section");
            if (!text.name && !text.comment) return run("section.remove", { section: namingSection.id }, "Remove Section");
            run("section.set", { section: namingSection.id, name: text.name, comment: text.comment, ...(text.clearReply ? { reply: null } : {}) }, "Edit Section");
          }}
        />
      )}
      {renaming && tracks.some((t) => t.id === renaming) && (
        <RenameField
          key={renaming}
          value={((i) => trackName(tracks[i]!, tracks.length - 1 - i))(tracks.findIndex((t) => t.id === renaming))}
          className="absolute text-body font-semibold"
          style={{ left: 8, top: rowTop(tracks.findIndex((t) => t.id === renaming), TRACK, TOP) + TRACK / 2 - 11, width: HEADER - 40, height: 22 }}
          onDone={(name) => {
            const t = tracks.find((x) => x.id === renaming);
            if (t && name !== null && name !== t.name && name !== trackName(t, tracks.length - 1 - tracks.indexOf(t))) run("track.set", { track: t.id, name }, "Rename Track");
            replica.rename(undefined);
          }}
        />
      )}
    </div>
  );
}
