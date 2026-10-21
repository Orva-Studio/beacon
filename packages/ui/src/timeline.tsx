import { useEffect, useRef } from "react";
import {
  planMove,
  rationalToNumber,
  secondsToTicks,
  snapOffset,
  snapTargets,
  ticksToSeconds,
  TRACK_HEIGHT,
  trackName,
  trimBounds,
  type Clip,
  type Track,
  type Project,
  type Session,
} from "@beacon/model";
import { acceptFiles, addDropTarget, droppedFiles, takes, type DropTarget, type PanelItem } from "./drop";
import type { DroppedFile } from "./rpc";
import { RenameField } from "./controls";
import { arrowHalfHeight, clipBox, shownSpan, cornerButtonAt, EDGE, EDGE_ZONE, GRAB, headerIcons, headerWidth, HEIGHT_SLIDER, rangeEdgeAt, rowAt, rowTop, RULER, SNAP, volumeY } from "./timeline-layout";
import { replica, useView } from "./store";
import { arrows, clipLabel, drawTimeline, keepImages, timelineView, volumeAt, volumePoints, type Drag, type MoveDrag, type PressDrag, type TimelineMark } from "./timeline-draw";
import { propsOf } from "./props";

const status = (text: string) => replica.status(text);

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
  /** Files dragged in from Finder, dropped at a time (and on a track). */
  dropFiles: (files: DroppedFile[], at: { time: number; track?: string }) => void;
  /** Spans marked across the tracks while something is reviewed (Remove Silences: red to cut, grey to keep). */
  marks?: TimelineMark[];
  /** A click on a mark (not by the playhead): Remove Silences flips it, or with ⌥ goes to it. */
  markClick?: (mark: TimelineMark, alt: boolean) => void;
}

export function Timeline({ project: full, session, waveforms, thumbs, clipTypes, nested, run, menu, trackMenu, dropFiles, marks, markClick }: Props) {
  const { project } = timelineView(full, session, nested);
  const HEADER = headerWidth(project.tracks);
  const label = (clip: Clip) => clipLabel(project, clip, nested, clipTypes[clip.type]);
  const renaming = useView((s) => s.renaming);
  const dragging = useView((s) => s.dragging);
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const dragState = useRef<Drag | null>(null);
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
  const latest = useRef({ project, session, waveforms, thumbs, dragging, marks });
  useEffect(() => keepImages(full, thumbs), [full, thumbs]);
  const staticLayer = useRef<{ canvas?: HTMLCanvasElement; key: unknown[] }>({ key: [] });
  /** Counts thumbnails decoded, so the cached layer is redrawn with them. */
  const loaded = useRef(0);
  /** When each clip last had an effect added, for its badge's flash. */
  const flashes = useRef(new Map<string, number>());
  const effectCounts = useRef<Map<string, number> | null>(null);
  latest.current = { project, session, waveforms, thumbs, dragging, marks };

  const tracks = [...project.tracks].reverse();
  const TRACK = session.timeline.trackHeight;

  const draw = () =>
    drawTimeline({ canvas, latest, size, staticLayer, dragState, settling, snapLine, pickedDiamond, loaded, flashes, HEADER, nested, clipTypes, label, redraw: () => drawRef.current(), dropHit, mediaHit });

  useEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      size.current = { w: r.width, h: r.height };
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

  // Escape drops a drag that has only drawn a ghost so far: nothing is sent.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = dragState.current;
      if (e.key !== "Escape" || !d || !["press", "move", "trim", "space", "track"].includes(d.kind)) return;
      e.preventDefault();
      e.stopPropagation();
      dragState.current = null;
      snapLine.current = undefined;
      drawRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const timeAt = (clientX: number) => {
    const r = canvas.current!.getBoundingClientRect();
    const { start, end } = latest.current.session.timeline;
    return Math.max(0, start + ((clientX - r.left - HEADER) / Math.max(1, r.width - HEADER)) * (end - start));
  };

  /** Empty time just before `at` (seconds) on the tracks a Shift-drag moves: `track`, or every unlocked one. */
  const roomBefore = (at: number, track?: string) => {
    let last = 0;
    for (const t of latest.current.project.tracks) {
      if (track ? t.id !== track : t.locked) continue;
      for (const c of t.clips) if (ticksToSeconds(c.start) < at) last = Math.max(last, Math.min(at, ticksToSeconds(c.start + c.duration)));
    }
    return Math.max(0, at - last);
  };

  /** Seconds per screen point. */
  const spp = () => {
    const { start, end } = latest.current.session.timeline;
    return (end - start) / Math.max(1, size.current.w - HEADER);
  };

  const xOf = (t: number) => {
    const { start } = latest.current.session.timeline;
    return HEADER + (t - start) / spp();
  };

  /** Where `clip` on `t` is drawn, in seconds: at least `MIN_CLIP` wide where there is room. */
  const shown = (t: Track, clip: Clip) =>
    shownSpan(ticksToSeconds(clip.start), ticksToSeconds(clip.start + clip.duration), t.clips.filter((c) => c !== clip).map((c) => [ticksToSeconds(c.start), ticksToSeconds(c.start + c.duration)] as const), spp());

  const clipAt = (clientX: number, clientY: number): Clip | undefined => {
    const r = canvas.current!.getBoundingClientRect();
    const i = rowAt(clientY - r.top, TRACK, tracks.length);
    const t = i === undefined ? undefined : tracks[i];
    if (!t) return undefined;
    const time = timeAt(clientX);
    return t.clips.find((c) => {
      const [a, b] = shown(t, c);
      return a <= time && time < b;
    });
  };

  /** The clip a panel item dropped at a point would go on: one that takes it, on an unlocked track. */
  const dropHit = (clientX: number, clientY: number, item: PanelItem) => {
    const r = canvas.current?.getBoundingClientRect();
    if (!r || clientX < r.left + HEADER || clientX > r.right || clientY > r.bottom) return undefined;
    const row = rowUnder(clientY - r.top);
    const clip = row === undefined || tracks[row]!.locked ? undefined : clipAt(clientX, clientY);
    return clip && takes(item, clipTypes[clip.type]) ? { clip, row: row!, time: timeAt(clientX) } : undefined;
  };
  /** Where Media Bin media dropped at a point would go: its start at the pointer on that track (none: new tracks), refused over other media. */
  const mediaHit = (clientX: number, clientY: number, seconds: number) => {
    const r = canvas.current?.getBoundingClientRect();
    if (!r || latest.current.session.group || clientX < r.left + HEADER || clientX > r.right || clientY < r.top + RULER || clientY > r.bottom) return undefined;
    const row = rowUnder(clientY - r.top);
    const time = timeAt(clientX);
    const t = row === undefined ? undefined : tracks[row]!;
    const [a, b] = [secondsToTicks(time), secondsToTicks(time + seconds)];
    const bad = !!t && (t.locked || (!t.magnetic && t.clips.some((c) => c.start < b && c.start + c.duration > a)));
    return { row, track: t?.id, time, bad };
  };
  const dropRef = useRef<DropTarget>(undefined);
  dropRef.current = (cx, cy, item) => {
    if (item.media) return ((h) => (h && !h.bad ? { time: h.time, ...(h.track ? { track: h.track } : {}) } : undefined))(mediaHit(cx, cy, item.media.seconds));
    return ((h) => h && { clip: h.clip.id, time: h.time })(dropHit(cx, cy, item));
  };
  useEffect(() => addDropTarget((...a) => dropRef.current!(...a)), []);

  /** The track row under a point (display order: top first), if any. */
  const rowUnder = (y: number) => rowAt(y, TRACK, tracks.length);

  /** The header icon under a point: mute, lock and eye, and on tall tracks the magnet (see the drawing). */
  const headerIcon = (x: number, y: number, i: number): "eye" | "magnet" | "lock" | "mute" | undefined => {
    const icons = headerIcons(i, TRACK, HEADER);
    const near = ([ix, iy]: [number, number]) => Math.abs(x - ix) <= 9 && Math.abs(y - iy) <= 8;
    if (near(icons.eye)) return "eye";
    if (near(icons.lock)) return "lock";
    if (near(icons.mute)) return "mute";
    if (icons.magnet && near(icons.magnet)) return "magnet";
    return undefined;
  };

  /** An animation arrow under the pointer (anywhere across its head's height), and which part: its start or end (to change its length) or its body (to move it). */
  const arrowAt = (clientX: number, clientY: number) => {
    const r = canvas.current!.getBoundingClientRect();
    const [px, py] = [clientX - r.left, clientY - r.top];
    const i = rowUnder(py);
    if (i === undefined) return undefined;
    const box = clipBox(i, TRACK);
    const ay = box.y + box.h / 2;
    for (const clip of tracks[i]!.clips) {
      // Only the part of an arrow inside its clip is drawn, so only that part is grabbed.
      const [cx0, cx1] = [xOf(ticksToSeconds(clip.start)), xOf(ticksToSeconds(clip.start + clip.duration))];
      if (px < cx0 || px > cx1) continue;
      for (const { anim, a, b } of arrows(clip)) {
        const [xa, xb] = [xOf(a), xOf(b)];
        if (px < xa - 6 || px > xb + 6) continue;
        if (Math.abs(py - ay) > Math.max(6, arrowHalfHeight(xa, xb, px, TRACK - 6) + 2)) continue;
        const grab = Math.max(6, arrowHalfHeight(xa, xb, px, TRACK - 6));
        const part: "start" | "end" | "body" = Math.abs(px - xa) <= grab ? "start" : Math.abs(px - xb) <= grab ? "end" : "body";
        return { clip, anim, a, b, part };
      }
    }
    return undefined;
  };

  /** On a selected audio clip: the volume point under the pointer (its index), or the line itself. */
  const volumeHit = (clip: Clip, clientX: number, clientY: number): { index: number | null } | undefined => {
    const { session } = latest.current;
    if (!session.selection.includes(clip.id) || !clipTypes[clip.type]?.includes("audio")) return undefined;
    const r = canvas.current!.getBoundingClientRect();
    const [px, py] = [clientX - r.left, clientY - r.top];
    const i = rowUnder(py)!;
    const vy = (v: number) => volumeY(i, TRACK, v);
    // Points beyond the clip's edges aren't drawn, so they aren't grabbed either.
    const [cs, ce] = [ticksToSeconds(clip.start), ticksToSeconds(clip.start + clip.duration)];
    const pts = volumePoints(clip);
    const index = pts.findIndex((p) => p.time >= cs && p.time <= ce && Math.hypot(xOf(p.time) - px, vy(p.value) - py) <= 6);
    if (index >= 0) return { index };
    return Math.abs(vy(volumeAt(clip, timeAt(clientX))) - py) <= 4 ? { index: null } : undefined;
  };

  /** The edge of `clip` under the pointer, if it is wide enough to have grabbable edges. */
  const edgeAt = (clip: Clip, clientX: number): "start" | "end" | undefined => {
    const r = canvas.current!.getBoundingClientRect();
    const px = clientX - r.left;
    const a = xOf(ticksToSeconds(clip.start));
    const b = xOf(ticksToSeconds(clip.start + clip.duration));
    if (b - a < 3 * EDGE) return undefined;
    if (px - a <= EDGE) return "start";
    if (b - px <= EDGE) return "end";
    return undefined;
  };

  /** Snaps `edges` (seconds) by the smallest shift onto a snap target, unless snapping is off or Control is held. */
  const snapped = (edges: number[], exclude: Set<string>, ctrl: boolean): number => {
    const { project, session } = latest.current;
    snapLine.current = undefined;
    if (!session.snapping || ctrl) return 0;
    const targets = snapTargets(project, {
      playhead: secondsToTicks(session.playhead),
      range: session.range ? [secondsToTicks(session.range.in), secondsToTicks(session.range.out)] : undefined,
      exclude,
    }).map(ticksToSeconds);
    const by = snapOffset(edges, targets, SNAP * spp());
    if (by !== undefined) snapLine.current = targets.find((t) => edges.some((e) => Math.abs(e + by - t) < 1e-9));
    return by ?? 0;
  };

  const setHeight = (clientY: number) => {
    const r = canvas.current!.getBoundingClientRect();
    const f = (HEIGHT_SLIDER.bottom - (clientY - r.top)) / (HEIGHT_SLIDER.bottom - HEIGHT_SLIDER.top);
    run("timeline.trackHeight", { height: Math.min(TRACK_HEIGHT.max, Math.max(TRACK_HEIGHT.min, TRACK_HEIGHT.min + f * (TRACK_HEIGHT.max - TRACK_HEIGHT.min))) });
  };

  /** Session commands while dragging go out at most once a frame. */
  const throttled = (command: string, args: unknown, label?: string, key?: string) => {
    cancelAnimationFrame(pending.current);
    pending.current = requestAnimationFrame(() => run(command, args, label, key));
  };

  const scrub = (clientX: number) => throttled("playhead.set", { time: timeAt(clientX) });

  /** Points into the edge zone a dragged playhead is in where the view can scroll: positive on the right, negative on the left, else 0. */
  const intoEdge = (clientX: number) => {
    const r = canvas.current!.getBoundingClientRect();
    const x = clientX - r.left;
    if (x > r.width - EDGE_ZONE) return x - (r.width - EDGE_ZONE);
    return x < HEADER + EDGE_ZONE && latest.current.session.timeline.start > 0 ? x - (HEADER + EDGE_ZONE) : 0;
  };
  /** A playhead dragged into an edge takes the view with it a frame at a time, as far as it goes, past the end too. */
  const follow = (clientX: number) => {
    cancelAnimationFrame(pending.current);
    edge.current.x = clientX;
    if (edge.current.raf) return;
    const step = () => {
      edge.current.raf = 0;
      const over = intoEdge(edge.current.x);
      const { start, end } = latest.current.session.timeline;
      if (dragState.current?.kind !== "playhead" || !over) return;
      const dt = Math.sign(over) * Math.min(40, 2 + Math.abs(over) / 2) * spp();
      const from = Math.max(0, start + dt);
      // The playhead first: the view may only reach past the end as far as it.
      run("playhead.set", { time: over > 0 ? end + dt : from });
      run("timeline.scroll", { start: from });
      edge.current.raf = requestAnimationFrame(step);
    };
    edge.current.raf = requestAnimationFrame(step);
  };

  const pointer = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** A move of `ids` by `by` seconds and `rows` tracks up, checked as the command will check it. */
  const planned = (ids: string[], by: number, rows: number, ripple: boolean): MoveDrag => {
    const { project } = latest.current;
    const moves = new Map(ids.map((id) => [id, ripple ? 0 : rows]));
    if (ripple) {
      for (const t of project.tracks) {
        const mine = t.clips.filter((c) => moves.has(c.id));
        if (!mine.length) continue;
        const from = Math.min(...mine.map((c) => c.start));
        for (const c of t.clips) if (c.start >= from) moves.set(c.id, 0);
      }
    }
    const plan = planMove(project.tracks, moves, secondsToTicks(by));
    return { kind: "move", ids, moves, by, rows: ripple ? 0 : rows, ripple, error: plan.error, x0: 0, y0: 0 };
  };

  const startMove = (press: PressDrag, e: React.PointerEvent) => {
    const { session } = latest.current;
    const ids = session.selection.includes(press.clip) ? session.selection : press.ripple ? [...session.selection, press.clip] : [press.clip];
    dragState.current = { ...planned(ids, 0, 0, press.ripple), x0: press.x0, y0: press.y0 };
    updateMove(e);
  };

  const updateMove = (e: React.PointerEvent) => {
    const d = dragState.current;
    if (d?.kind !== "move") return;
    const { project } = latest.current;
    const { x, y } = pointer(e);
    const moving = project.tracks.flatMap((t) => t.clips).filter((c) => d.moves.has(c.id));
    // Inside an opened group, clips can't go before the group's own start.
    const earliest = Math.min(...moving.map((c) => ticksToSeconds(c.start)));
    let by = Math.max(-earliest, (x - d.x0) * spp());
    const edges = moving.flatMap((c) => [ticksToSeconds(c.start) + by, ticksToSeconds(c.start + c.duration) + by]);
    by = Math.max(-earliest, by + snapped(edges, new Set(d.moves.keys()), e.ctrlKey));
    // Whole frames, as the command moves, so the ghost checks what will happen.
    const frame = 1 / rationalToNumber(project.settings.fps);
    by = Math.sign(by) * Math.round(Math.abs(by) / frame) * frame;
    const rows = -Math.round((y - d.y0) / TRACK);
    dragState.current = { ...planned(d.ids, by, rows, d.ripple), x0: d.x0, y0: d.y0 };
    draw();
  };

  /** Keeps a released edit drawn until its patch arrives; a refused one (no patch) is dropped after a second. */
  const settle = (drag: Drag) => {
    if (settling.current) clearTimeout(settling.current.timer);
    const timer = setTimeout(() => {
      if (settling.current?.drag !== drag) return;
      settling.current = null;
      drawRef.current();
    }, 1000);
    settling.current = { drag, timer };
  };

  const finish = (e: React.PointerEvent) => {
    const d = dragState.current;
    dragState.current = null;
    snapLine.current = undefined;
    if (canvas.current!.hasPointerCapture(e.pointerId)) canvas.current!.releasePointerCapture(e.pointerId);
    if (!d) return;
    const { session } = latest.current;
    if (d.kind === "track") {
      // Display rows run top to bottom; tracks are stored bottom to top.
      if (d.to !== d.from) run("track.move", { track: d.track, index: tracks.length - 1 - d.to }, "Move Track");
    } else if (d.kind === "press") {
      run("selection.set", d.toggle ? { clips: [d.clip], toggle: true, linked: true } : { clips: [d.clip], linked: true });
    } else if (d.kind === "move") {
      if (d.error) return void (draw(), status(`Can't move there: ${d.error}`));
      if (Math.abs(d.by) > 1e-9 || d.rows) {
        settle(d);
        run("clip.move", { clips: d.ids, by: d.by, tracks: d.rows, linked: true, ripple: d.ripple }, "Move Media");
      }
    } else if (d.kind === "trim") {
      const clip = latest.current.project.tracks.flatMap((t) => t.clips).find((c) => c.id === d.clip)!;
      const end = ticksToSeconds(clip.start + clip.duration);
      if (d.extend) {
        if (d.t > end) {
          settle(d);
          run("clip.extendFrame", { clip: d.clip, duration: d.t - end, ripple: d.ripple }, "Extend Frame");
        }
      } else if (Math.abs(d.t - (d.edge === "start" ? ticksToSeconds(clip.start) : end)) > 1e-9) {
        settle(d);
        run("clip.trim", { clip: d.clip, [d.edge]: d.t, linked: true, ripple: d.ripple }, "Trim Media");
      }
    } else if (d.kind === "space") {
      const track = d.track ? { track: d.track } : {};
      if (d.d > 0) run("timeline.insertSpace", { at: d.at, duration: d.d, ...track }, "Ripple Split");
      else if (d.d < 0) run("timeline.removeSpace", { at: d.at, duration: -d.d, ...track }, "Close Space");
    } else if (d.kind === "range" || d.kind === "rangeEdge") {
      if (!session.range) run("range.clear");
    }
    draw();
  };

  return (
    <div ref={box} className="relative min-h-0 flex-1 overflow-hidden">
      <canvas
        ref={canvas}
        data-timeline
        className="absolute inset-0"
        onDragOver={acceptFiles}
        onDrop={(e) => {
          const files = droppedFiles(e.dataTransfer);
          if (!files.length || latest.current.session.group) return;
          e.preventDefault();
          e.stopPropagation();
          const r = canvas.current!.getBoundingClientRect();
          const row = rowUnder(e.clientY - r.top);
          const t = row === undefined ? undefined : tracks[row];
          dropFiles(files, { time: timeAt(Math.max(e.clientX, r.left + HEADER)), ...(t && !t.locked ? { track: t.id } : {}) });
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const { x, y } = pointer(e);
          const { session } = latest.current;
          const capture = () => canvas.current!.setPointerCapture(e.pointerId);
          if (x < HEIGHT_SLIDER.hit && y < RULER) {
            dragState.current = { kind: "height" };
            capture();
            return setHeight(e.clientY);
          }
          if (x < HEADER) {
            if (y < RULER) {
              const button = cornerButtonAt(HEADER, x, y);
              if (button === "add") {
                if (latest.current.session.group) status("Close the group (⌃⇧U) to add a track");
                else run("track.add", { name: "" }, "Add Track");
              } else if (button === "menu") trackMenu(null);
              return;
            }
            const i = rowUnder(y);
            if (i === undefined) return;
            const t = tracks[i]!;
            const icon = headerIcon(x, y, i);
            if (icon === "eye") return run("track.set", { track: t.id, hidden: !t.hidden }, t.hidden ? "Enable Track" : "Disable Track");
            if (icon === "magnet") return run("track.set", { track: t.id, magnetic: !t.magnetic }, "Magnetic Track");
            if (icon === "lock") return run("track.set", { track: t.id, locked: !t.locked }, t.locked ? "Unlock Track" : "Lock Track");
            if (icon === "mute") return run("track.set", { track: t.id, muted: !t.muted }, t.muted ? "Unmute Track" : "Mute Track");
            dragState.current = { kind: "track", track: t.id, from: i, to: i };
            return capture();
          }
          const ph = xOf(session.playhead);
          // A range's edges are dragged on the ruler.
          if (session.range && y < RULER) {
            const edge = rangeEdgeAt(x, xOf(session.range.in), xOf(session.range.out));
            if (edge) {
              dragState.current = { kind: "rangeEdge", edge, other: edge === "in" ? session.range.out : session.range.in };
              return capture();
            }
          }
          // On the tracks, an arrow or volume point under the playhead line wins over grabbing the line.
          const overMark =
            y >= RULER &&
            (arrowAt(e.clientX, e.clientY) || ((c) => c && volumeHit(c, e.clientX, e.clientY))(clipAt(e.clientX, e.clientY)));
          if (y < RULER || (Math.abs(x - ph) <= GRAB && !overMark)) {
            capture();
            if (e.metaKey) dragState.current = { kind: "range", anchor: session.playhead };
            else if (e.shiftKey && session.group) status("Close the group (⌃⇧U) to insert space");
            else if (e.shiftKey) dragState.current = { kind: "space", at: session.playhead, d: 0, room: roomBefore(session.playhead) };
            else {
              dragState.current = { kind: "playhead" };
              scrub(e.clientX);
            }
            return;
          }
          const t = timeAt(e.clientX);
          const mark = y >= RULER && markClick ? latest.current.marks?.find((m) => t >= m.start && t <= m.end) : undefined;
          if (mark) return markClick!(mark, e.altKey);
          capture();
          const arrow = arrowAt(e.clientX, e.clientY);
          if (arrow) {
            pickedDiamond.current = arrow.part === "body" ? undefined : { anim: arrow.anim.id, part: arrow.part };
            run("animation.select", { clip: arrow.clip.id, animation: arrow.anim.id });
            dragState.current = { kind: "anim", clip: arrow.clip.id, anim: arrow.anim.id, part: arrow.part, x0: x, a: arrow.a, b: arrow.b, key: `anim-${Date.now()}` };
            return;
          }
          const clip = clipAt(e.clientX, e.clientY);
          const vol = clip && volumeHit(clip, e.clientX, e.clientY);
          if (clip && vol) {
            const base = propsOf<{ volume: number }>(clip, "audio").volume;
            dragState.current = { kind: "volume", clip: clip.id, index: vol.index, x0: x, y0: y, points: volumePoints(clip), base, key: `volume-${Date.now()}` };
            return;
          }
          if (session.animation) run("animation.select", {});
          if (session.effects.length) run("effect.select", { effects: [] });
          const edge = clip && edgeAt(clip, e.clientX);
          if (clip && edge) {
            if (!session.selection.includes(clip.id)) run("selection.set", { clips: [clip.id], linked: true });
            const t = ticksToSeconds(edge === "start" ? clip.start : clip.start + clip.duration);
            dragState.current = { kind: "trim", clip: clip.id, edge, x0: x, t, ripple: e.shiftKey, extend: false };
          } else if (clip) {
            const toggle = e.metaKey || e.shiftKey;
            if (!toggle && !session.selection.includes(clip.id)) run("selection.set", { clips: [clip.id], linked: true });
            dragState.current = { kind: "press", clip: clip.id, x0: x, y0: y, toggle, ripple: e.shiftKey };
          } else if (e.shiftKey && !e.metaKey && rowUnder(y) !== undefined) {
            // Shift on a gap moves what comes after it, as Shift on the playhead does; ⌥ only this track.
            if (session.group) return status("Close the group (⌃⇧U) to insert space");
            const row = rowUnder(y)!;
            let at = timeAt(e.clientX);
            at += snapped([at], new Set(), e.ctrlKey);
            const track = e.altKey ? tracks[row]!.id : undefined;
            dragState.current = { kind: "space", at, d: 0, room: roomBefore(at, track), ...(track ? { track, row } : {}) };
          } else {
            const base = e.metaKey ? session.selection : [];
            if (!base.length && session.selection.length) run("selection.clear");
            dragState.current = { kind: "marquee", x0: x, y0: y, x1: x, y1: y, base };
          }
        }}
        onPointerMove={(e) => {
          const d = dragState.current;
          const { x, y } = pointer(e);
          const { project, session } = latest.current;
          if (!d) {
            const clip = y > RULER && x > HEADER ? clipAt(e.clientX, e.clientY) : undefined;
            const onPlayhead = x > HEADER && (y < RULER || Math.abs(x - xOf(session.playhead)) <= GRAB);
            canvas.current!.style.cursor = onPlayhead || (clip && edgeAt(clip, e.clientX)) ? "ew-resize" : "default";
            return;
          }
          if (d.kind === "playhead") {
            // Every move, so a pointer back out of the edge stops the scrolling.
            edge.current.x = e.clientX;
            return intoEdge(e.clientX) ? follow(e.clientX) : scrub(e.clientX);
          }
          if (d.kind === "anim") {
            let dt = (x - d.x0) * spp();
            const edges = d.part === "start" ? [d.a + dt] : d.part === "end" ? [d.b + dt] : [d.a + dt, d.b + dt];
            dt += snapped(edges, new Set(), e.ctrlKey);
            const frame = 1 / rationalToNumber(project.settings.fps);
            const a = d.part === "end" ? d.a : Math.min(d.a + dt, d.part === "start" ? d.b - frame : Infinity);
            const b = d.part === "start" ? d.b : Math.max(d.b + dt, d.part === "end" ? d.a + frame : -Infinity);
            const args = d.part === "body" ? { end: Math.max(0, d.b + dt) } : { end: Math.max(0, b), duration: b - a };
            throttled("animation.set", { clip: d.clip, animation: d.anim, ...args }, d.part === "body" ? "Move Animation" : "Change Animation Duration", d.key);
            return;
          }
          if (d.kind === "volume") {
            d.at = [x, y];
            draw();
            // Up to 100% by dragging, but points already above it aren't pulled down.
            const v = (val: number, was = 0) => Math.min(Math.max(1, was), Math.max(0, val));
            const dv = -(y - d.y0) / (TRACK - 12);
            if (d.index === null) {
              if (d.points.length) throttled("volume.setPoints", { clip: d.clip, points: d.points.map((p) => ({ time: p.time, value: v(p.value + dv, p.value) })) }, "Volume", d.key);
              else throttled("clip.set", { clip: d.clip, props: { audio: { volume: v(d.base + dv) } } }, "Volume", d.key);
              return;
            }
            const p = d.points[d.index]!;
            const lo = d.points[d.index - 1]?.time ?? -Infinity;
            const hi = d.points[d.index + 1]?.time ?? Infinity;
            // A frame apart at least: points are snapped to frames, and two on one frame would merge.
            const frame = 1 / rationalToNumber(latest.current.project.settings.fps);
            const t = Math.min(hi - frame, Math.max(lo + frame, p.time + (x - d.x0) * spp()));
            const points = d.points.map((q, j) => (j === d.index ? { time: t, value: v(p.value + dv, p.value) } : q));
            throttled("volume.setPoints", { clip: d.clip, points }, "Move Audio Point", d.key);
            return;
          }
          if (d.kind === "track") {
            dragState.current = { ...d, to: Math.min(tracks.length - 1, Math.max(0, Math.floor((y - RULER) / TRACK))) };
            return draw();
          }
          if (d.kind === "height") return setHeight(e.clientY);
          if (d.kind === "press") {
            if (Math.hypot(x - d.x0, y - d.y0) > 3) startMove(d, e);
            return;
          }
          if (d.kind === "move") return updateMove(e);
          if (d.kind === "trim") {
            const clip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === d.clip)!;
            const a = ticksToSeconds(clip.start);
            const b = ticksToSeconds(clip.start + clip.duration);
            let t = timeAt(e.clientX);
            t += snapped([t], new Set([clip.id]), e.ctrlKey);
            // Edges stop at the clips beside them, as the command does; Shift (ripple) pushes them instead.
            if (!e.shiftKey) {
              const [lo, hi] = trimBounds(project.tracks.find((tr) => tr.clips.includes(clip))!, clip);
              t = Math.min(Math.max(t, ticksToSeconds(lo)), ticksToSeconds(hi));
            }
            const frame = 1 / rationalToNumber(project.settings.fps);
            t = d.edge === "start" ? Math.min(t, b - frame) : Math.max(t, a + frame);
            const video = clipTypes[clip.type]?.includes("video") ?? false;
            dragState.current = { ...d, t, ripple: e.shiftKey, extend: video && d.edge === "end" && e.altKey && t > b };
            return draw();
          }
          if (d.kind === "marquee") {
            dragState.current = { ...d, x1: x, y1: y };
            const [x0, x1] = [Math.min(d.x0, x), Math.max(d.x0, x)];
            const [y0, y1] = [Math.min(d.y0, y), Math.max(d.y0, y)];
            const hit = tracks.flatMap((t, i) => {
              const ty = rowTop(i, TRACK);
              if (ty + TRACK < y0 || ty > y1) return [];
              return t.clips.filter((c) => xOf(shown(t, c)[0]) < x1 && xOf(shown(t, c)[1]) > x0).map((c) => c.id);
            });
            const next = [...new Set([...d.base, ...hit])];
            if (next.join() !== session.selection.join()) throttled("selection.set", { clips: next, linked: true });
            return draw();
          }
          let t = timeAt(e.clientX);
          t += snapped([t], new Set(), e.ctrlKey);
          if (d.kind === "range") return throttled("range.set", { in: d.anchor, out: t, playhead: t });
          if (d.kind === "rangeEdge") return throttled("range.set", { in: d.other, out: t });
          if (d.kind === "space") {
            dragState.current = { ...d, d: Math.max(-d.room, t - d.at) };
            return draw();
          }
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={(e) => dragState.current && finish(e)}
        onDoubleClick={(e) => {
          const { x, y } = pointer(e as unknown as React.PointerEvent);
          const i = rowUnder(y);
          if (x < HEADER && i !== undefined && !headerIcon(x, y, i)) replica.rename(tracks[i]!.id);
          if (x < HEADER || i === undefined) return;
          // On a selected audio clip's volume line: add a point there, or remove the one double-clicked.
          const clip = clipAt(e.clientX, e.clientY);
          if (clip && clipTypes[clip.type]?.includes("group") && !latest.current.session.group) return run("group.open", { clip: clip.id });
          const vol = clip && volumeHit(clip, e.clientX, e.clientY);
          if (!clip || !vol) return;
          const pts = volumePoints(clip);
          if (vol.index !== null) run("volume.setPoints", { clip: clip.id, points: pts.filter((_, j) => j !== vol.index) }, "Delete Audio Point");
          else {
            const t = timeAt(e.clientX);
            run("volume.setPoints", { clip: clip.id, points: [...pts, { time: t, value: volumeAt(clip, t) }].sort((p, q) => p.time - q.time) }, "Add Audio Point");
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const { x, y } = pointer(e as unknown as React.PointerEvent);
          if (x < HEADER) {
            const i = rowUnder(y);
            if (i !== undefined) trackMenu(tracks[i]!.id);
            return;
          }
          const clip = clipAt(e.clientX, e.clientY);
          if (!clip) return;
          if (!latest.current.session.selection.includes(clip.id)) run("selection.set", { clips: [clip.id], linked: true });
          menu(clip.id);
        }}
        onWheel={(e) => {
          const { start, end } = latest.current.session.timeline;
          const span = end - start;
          if (e.metaKey || e.ctrlKey) {
            const at = timeAt(e.clientX);
            const f = Math.exp(e.deltaY * 0.01);
            run("timeline.view", { start: Math.max(0, at - (at - start) * f), end: at + (end - at) * f });
          } else {
            const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * (span / Math.max(1, size.current.w - HEADER));
            run("timeline.scroll", { start: Math.max(0, start + d) });
          }
        }}
      />
      {renaming && tracks.some((t) => t.id === renaming) && (
        <RenameField
          key={renaming}
          value={((i) => trackName(tracks[i]!, tracks.length - 1 - i))(tracks.findIndex((t) => t.id === renaming))}
          className="absolute text-body font-semibold"
          style={{ left: 8, top: rowTop(tracks.findIndex((t) => t.id === renaming), TRACK) + TRACK / 2 - 11, width: HEADER - 40, height: 22 }}
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
