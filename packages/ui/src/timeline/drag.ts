import { rationalToNumber, ticksToSeconds, TRACK_HEIGHT } from "@beacon/model";
import { replica } from "../store";
import { cornerButtonAt, EDGE_ZONE, GRAB, HEIGHT_SLIDER, rangeEdgeAt, rowTop, RULER, TRACKS_TOP } from "../timeline-layout";
import { volumePoints, type Drag, type PressDrag, type TimelineMark } from "../timeline-draw";
import { propsOf } from "../props";
import type { DrawingContext } from "./context";
import { animationTimes, partEdges, plannedMove, volumeEdit } from "./drag-state";
import type { TimelineHits } from "./hit-test";
import { sectionDrag } from "./section-drag";
import { trimDrag } from "./trim";

const status = (text: string) => replica.status(text);

export interface DragOptions {
  /** A track's menu (Insert Track, Rename…, Lock…), or with null the track options under ⌄. */
  trackMenu: (track: string | null) => void;
  /** A click on a mark (not by the playhead): Remove Silences flips it, or with ⌥ goes to it. */
  markClick?: (mark: TimelineMark, alt: boolean, shift: boolean, meta: boolean) => void;
  /** The marker under the pointer (its diamond on the ruler), or none: its name shows beside it. */
  markerHover?: (marker: { id: string; name: string; x: number } | undefined) => void;
}

/**
 * The timeline's presses and drags: a press decides what is dragged (the playhead, a range, a track, a section, an
 * arrow, a volume point, a clip's edge or the clip, space, a marquee), moves draw its ghost, and the release sends it.
 */
export function timelineDrag(c: DrawingContext, hits: TimelineHits, { trackMenu, markClick, markerHover }: DragOptions) {
  const { canvas, latest, dragState, settling, snapLine, pickedDiamond, anchor, pending, edge, drawRef, draw, run, HEADER, TRACK, TOP, tracks } = c;
  const { timeAt, roomBefore, gapEnd, spp, xOf, shown, clipAt, rowUnder, headerIcon, arrowAt, volumeHit, edgeAt, sectionAt, markerAt, snapped, pointer } = hits;

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

  /** A ⇧-drag from `at`: what it may close before it, or, with no room there, the gap after it. */
  const spaceDrag = (at: number, more: { playhead?: boolean; track?: string; row?: number }): Drag => {
    const room = roomBefore(at, more.track);
    // A few milliseconds is no room: the playhead, kept to the millisecond, can sit just past a clip's end.
    const end = room > 0.005 ? undefined : gapEnd(at, more.track);
    return { kind: "space", at, d: 0, room, ...more, ...(end !== undefined ? { from: at, gapEnd: end } : {}) };
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

  const section = sectionDrag(c, hits, settle);
  const trim = trimDrag(c, hits, settle);

  const startMove = (press: PressDrag, e: React.PointerEvent) => {
    const { session } = latest.current;
    const picked = session.selection.includes(press.clip);
    // ⌘ (or ⇧) on a clip not picked yet adds it, and the drag takes it with the others.
    if (!picked && press.toggle) run("selection.set", { clips: [press.clip], toggle: true, linked: true });
    const ids = picked ? session.selection : press.ripple || press.toggle ? [...session.selection, press.clip] : [press.clip];
    dragState.current = { ...plannedMove(latest.current.project, ids, 0, 0, press.ripple), x0: press.x0, y0: press.y0 };
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
    dragState.current = { ...plannedMove(latest.current.project, d.ids, by, rows, d.ripple), x0: d.x0, y0: d.y0 };
    draw();
  };

  const finish = (e: { pointerId: number }) => {
    const d = dragState.current;
    dragState.current = null;
    snapLine.current = undefined;
    if (canvas.current!.hasPointerCapture(e.pointerId)) canvas.current!.releasePointerCapture(e.pointerId);
    if (!d) return;
    const { session } = latest.current;
    if (d.kind === "sectionNew" || d.kind === "section") section.finish(d);
    else if (d.kind === "track") {
      // Display rows run top to bottom; tracks are stored bottom to top.
      if (d.to !== d.from) run("track.move", { track: d.track, index: tracks.length - 1 - d.to }, "Move Track");
    } else if (d.kind === "press") {
      const known = d.range && latest.current.project.tracks.some((t) => t.clips.some((c) => c.id === anchor.current));
      if (known) run("selection.range", { from: anchor.current!, to: d.clip });
      else {
        anchor.current = d.clip;
        run("selection.set", d.toggle ? { clips: [d.clip], toggle: true, linked: true } : { clips: [d.clip], linked: true });
      }
    } else if (d.kind === "move") {
      if (d.error) return void (draw(), status(`Can't move there: ${d.error}`));
      if (Math.abs(d.by) > 1e-9 || d.rows) {
        settle(d);
        run("clip.move", { clips: d.ids, by: d.by, tracks: d.rows, linked: true, ripple: d.ripple }, "Move Media");
      }
    } else if (d.kind === "trim") trim.finish(d);
    else if (d.kind === "space") {
      const track = d.track ? { track: d.track } : {};
      // Drawn as released until the edit is back, as a moved clip is: for a moment it jumped back where it was.
      if (d.d) settle(d);
      if (d.d > 0) run("timeline.insertSpace", { at: d.at, duration: d.d, ...track }, "Ripple Split");
      else if (d.d < 0) run("timeline.removeSpace", { at: d.at, duration: -d.d, ...track }, "Close Space");
      // Closing the gap after it, the playhead stays where it started: where the clips before it end.
      if (d.playhead && d.d) run("playhead.set", { time: d.from !== undefined && d.at !== d.from ? d.from : d.at + d.d });
    } else if (d.kind === "range" || d.kind === "rangeEdge") {
      if (!session.range) run("range.clear");
    }
    draw();
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
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
      if (session.track !== t.id) run("track.focus", { track: t.id });
      const icon = headerIcon(x, y, i);
      if (icon === "eye") return run("track.set", { track: t.id, hidden: !t.hidden }, t.hidden ? "Enable Track" : "Disable Track");
      if (icon === "magnet") return run("track.set", { track: t.id, magnetic: !t.magnetic }, "Magnetic Track");
      if (icon === "lock") return run("track.set", { track: t.id, locked: !t.locked }, t.locked ? "Unlock Track" : "Lock Track");
      if (icon === "mute") return run("track.set", { track: t.id, muted: !t.muted }, t.muted ? "Unmute Track" : "Mute Track");
      dragState.current = { kind: "track", track: t.id, from: i, to: i };
      return capture();
    }
    // A marker's diamond picks it (⌫ removes it) and takes the playhead there; the rest of the ruler scrubs.
    const marker = markerAt(x, y);
    replica.marker(marker?.id);
    if (marker) return run("playhead.set", { time: ticksToSeconds(marker.time) });
    if (y >= RULER && y < TRACKS_TOP && section.press(e, x)) return;
    if (latest.current.section) replica.section(undefined);
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
    const overMark = y >= RULER && (arrowAt(e.clientX, e.clientY) || ((c) => c && volumeHit(c, e.clientX, e.clientY))(clipAt(e.clientX, e.clientY)));
    // The Sections band's empty time scrubs as the ruler does (a section is drawn there after a double-click or with ⌥).
    if (y < TRACKS_TOP || (Math.abs(x - ph) <= GRAB && !overMark)) {
      capture();
      if (e.metaKey) dragState.current = { kind: "range", anchor: session.playhead };
      else if (e.shiftKey && session.group) status("Close the group (⌃⇧U) to insert space");
      else if (e.shiftKey) dragState.current = spaceDrag(session.playhead, { playhead: true });
      else {
        dragState.current = { kind: "playhead" };
        scrub(e.clientX);
      }
      return;
    }
    const t = timeAt(e.clientX);
    const mark = y >= RULER && markClick ? latest.current.marks?.find((m) => t >= m.start && t <= m.end) : undefined;
    if (mark) return markClick!(mark, e.altKey, e.shiftKey, e.metaKey);
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
    if (clip && edge) trim.press(session, clip, edge, e, x);
    else if (clip) {
      const toggle = e.metaKey || e.shiftKey;
      const range = e.shiftKey && !e.metaKey && !!anchor.current && anchor.current !== clip.id;
      if (!range) anchor.current = clip.id;
      if (!toggle && !session.selection.includes(clip.id)) run("selection.set", { clips: [clip.id], linked: true });
      dragState.current = { kind: "press", clip: clip.id, x0: x, y0: y, toggle, ripple: e.shiftKey, range };
    } else if (e.shiftKey && !e.metaKey && rowUnder(y) !== undefined) {
      // Shift on a gap moves what comes after it, as Shift on the playhead does; ⌥ only this track.
      if (session.group) return status("Close the group (⌃⇧U) to insert space");
      const row = rowUnder(y)!;
      let at = timeAt(e.clientX);
      at += snapped([at], new Set(), e.ctrlKey);
      const track = e.altKey ? tracks[row]!.id : undefined;
      dragState.current = spaceDrag(at, track ? { track, row } : {});
    } else {
      const base = e.metaKey ? session.selection : [];
      if (!base.length && session.selection.length) run("selection.clear");
      dragState.current = { kind: "marquee", x0: x, y0: y, x1: x, y1: y, base };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragState.current;
    const { x, y } = pointer(e);
    const { project, session } = latest.current;
    if (!d) {
      const marker = markerAt(x, y);
      markerHover?.(marker && marker.name ? { id: marker.id, name: marker.name, x: xOf(ticksToSeconds(marker.time)) } : undefined);
      if (x > HEADER && y >= RULER && y < TRACKS_TOP) {
        const part = sectionAt(x)?.part;
        canvas.current!.style.cursor = part === "start" || part === "end" ? "ew-resize" : "default";
        return;
      }
      const clip = y > RULER && x > HEADER ? clipAt(e.clientX, e.clientY) : undefined;
      const onPlayhead = x > HEADER && (y < RULER || Math.abs(x - xOf(session.playhead)) <= GRAB);
      canvas.current!.style.cursor = onPlayhead || (clip && edgeAt(clip, e.clientX)) ? "ew-resize" : "default";
      return;
    }
    if (d.kind === "sectionNew" || d.kind === "section") return section.move(d, e, x);
    if (d.kind === "playhead") {
      // Every move, so a pointer back out of the edge stops the scrolling.
      edge.current.x = e.clientX;
      return intoEdge(e.clientX) ? follow(e.clientX) : scrub(e.clientX);
    }
    if (d.kind === "anim") {
      let dt = (x - d.x0) * spp();
      dt += snapped(partEdges(d.part, d.a, d.b, dt), new Set(), e.ctrlKey);
      const frame = 1 / rationalToNumber(project.settings.fps);
      throttled("animation.set", { clip: d.clip, animation: d.anim, ...animationTimes(d, dt, frame) }, d.part === "body" ? "Move Animation" : "Change Animation Duration", d.key);
      return;
    }
    if (d.kind === "volume") {
      d.at = [x, y];
      draw();
      const dv = -(y - d.y0) / (TRACK - 12);
      const frame = 1 / rationalToNumber(latest.current.project.settings.fps);
      const { command, args, label } = volumeEdit(d, dv, (x - d.x0) * spp(), frame);
      throttled(command, args, label, d.key);
      return;
    }
    if (d.kind === "track") {
      dragState.current = { ...d, to: Math.min(tracks.length - 1, Math.max(0, Math.floor((y - TRACKS_TOP + TOP) / TRACK))) };
      return draw();
    }
    if (d.kind === "height") return setHeight(e.clientY);
    if (d.kind === "press") {
      if (Math.hypot(x - d.x0, y - d.y0) > 3) startMove(d, e);
      return;
    }
    if (d.kind === "move") return updateMove(e);
    if (d.kind === "trim") return trim.move(d, e);
    if (d.kind === "marquee") {
      dragState.current = { ...d, x1: x, y1: y };
      const [x0, x1] = [Math.min(d.x0, x), Math.max(d.x0, x)];
      const [y0, y1] = [Math.min(d.y0, y), Math.max(d.y0, y)];
      const hit = tracks.flatMap((t, i) => {
        const ty = rowTop(i, TRACK, TOP);
        if (t.locked || ty + TRACK < y0 || ty > y1) return [];
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
      // No room before where it started but a gap after: dragged left, it closes that gap (the clips after it slide
      // back to touch the ones before), as if dragged from where they start; right, it opens space where it started.
      if (d.gapEnd !== undefined && d.from !== undefined) {
        const left = t < d.from;
        const at = left ? d.gapEnd : d.from;
        const room = left ? d.gapEnd - d.from : 0;
        // As far as it is dragged from where it started, the gap's end the point that moves.
        dragState.current = { ...d, at, room, d: left ? Math.max(-room, t - d.from) : t - at };
      } else dragState.current = { ...d, d: Math.max(-d.room, t - d.at) };
      return draw();
    }
  };

  return { onPointerDown, onPointerMove, finish };
}
