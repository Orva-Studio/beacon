import { type Project, type RGBA, type Session } from "@beacon/model";
import { Select } from "./controls";
import { COLOR, line, type CanvasMark } from "./canvas-marks";
import type { Line } from "./canvas-snap";
import { useQuery } from "./query";
import { clock } from "./time";

type Rect = [number, number, number, number];

/** What `safeAreas.layouts` answers for one platform, in canvas pixels. */
export interface SafeLayout {
  id: string;
  title: string;
  source: string;
  fits: boolean;
  zones: { id: string; label: string; rect: Rect }[];
  titleSafe?: Rect;
  endScreen?: number;
  headroom: [number, number];
  eyeLine: number;
}

interface SafeCheck {
  layout: string;
  clean: boolean;
  issues: { clip: string; text: string; zone: string; label: string; from: number; to: number }[];
}

interface QueryHost {
  query(name: string, args?: unknown): Promise<unknown>;
  run(command: string, args?: unknown): void;
}

export type SafePart = "zones" | "headroom" | "eyeLine";

const safeState = (session: Session | undefined) => session?.features["safe-areas"] as { layout?: string; hidden?: SafePart[] } | undefined;
export const shownSafeArea = (session: Session | undefined) => safeState(session)?.layout;
/** The parts of the shown layout the key hid. */
export const hiddenSafeParts = (session: Session | undefined): SafePart[] => safeState(session)?.hidden ?? [];

/** The safe-area layouts for the project's canvas (asked again when its size changes), and the one shown. */
export function useSafeAreas(host: QueryHost, project: Project | undefined, session: Session | undefined) {
  const size = project ? `${project.settings.width}x${project.settings.height}` : "";
  const layouts = useQuery<SafeLayout[]>(host, project ? "safeAreas.layouts" : "", {}, size);
  const id = shownSafeArea(session);
  return { layouts: layouts ?? [], shown: layouts?.find((l) => l.id === id), hidden: hiddenSafeParts(session) };
}

/** A filled band: a square-ended line `width` points thick. */
const band = (from: [number, number], to: [number, number], color: RGBA, width: number): CanvasMark => ({ kind: "line", from, to, width, color, butt: true });

/** The canvas's safe-area marks: each zone a red band with an edge, the title-safe frame, the blue headroom band and a dashed eye line. */
export function safeAreaMarks(l: SafeLayout, at: (x: number, y: number) => [number, number], k: number, width: number, hidden: SafePart[] = []): CanvasMark[] {
  const out: CanvasMark[] = [];
  const off = new Set(hidden);
  const box = ([x0, y0, x1, y1]: Rect, color: RGBA) => [
    line(at(x0, y0), at(x1, y0), color),
    line(at(x1, y0), at(x1, y1), color),
    line(at(x1, y1), at(x0, y1), color),
    line(at(x0, y1), at(x0, y0), color),
  ];
  for (const z of off.has("zones") ? [] : l.zones) {
    const [x0, y0, x1, y1] = z.rect;
    // A band as wide as the zone is tall, in points.
    out.push(band(at(x0, (y0 + y1) / 2), at(x1, (y0 + y1) / 2), COLOR.safeZone, (y1 - y0) * k));
    out.push(...box(z.rect, COLOR.safeEdge));
  }
  if (l.titleSafe && !off.has("zones")) out.push(...box(l.titleSafe, COLOR.safeGuide));
  const [h0, h1] = l.headroom;
  if (!off.has("headroom")) {
    out.push(band(at(0, (h0 + h1) / 2), at(width, (h0 + h1) / 2), COLOR.safeHeadroom, (h1 - h0) * k));
    out.push(...box([0, h0, width, h1], COLOR.safeHeadroomEdge));
  }
  const dash = 24;
  if (!off.has("eyeLine")) for (let x = 0; x < width; x += dash * 2) out.push(line(at(x, l.eyeLine), at(Math.min(width, x + dash), l.eyeLine), COLOR.safeGuide, 1.5));
  return out;
}

/** The zones' edges, which a box dragged on the canvas snaps to: x (vertical lines) and y (horizontal). */
export function safeAreaLines(l: SafeLayout): { x: Line[]; y: Line[] } {
  const x: Line[] = [];
  const y: Line[] = [];
  for (const [x0, y0, x1, y1] of [...l.zones.map((z) => z.rect), ...(l.titleSafe ? [l.titleSafe] : [])]) {
    x.push({ at: x0, span: [y0, y1] }, { at: x1, span: [y0, y1] });
    y.push({ at: y0, span: [x0, x1] }, { at: y1, span: [x0, x1] });
  }
  return { x, y };
}

/**
 * The top bar's Safe Areas: the platforms for the canvas's shape (View › Safe Areas does the same), and once one is
 * shown, how many captions and callouts its UI would cover; a click goes to the first, selected.
 */
export function SafeAreaPicker({ host, project, session, layouts }: { host: QueryHost; project: Project; session: Session; layouts: SafeLayout[] }) {
  const id = shownSafeArea(session);
  const check = useQuery<SafeCheck>(host, id ? "safeAreas.check" : "", { layout: id }, project);
  const fitting = layouts.filter((l) => l.fits);
  if (!fitting.length && !id) return null;
  const issues = check?.issues ?? [];
  const first = issues[0];
  // A caption under the band and beside the rail is one thing to move.
  const clips = new Set(issues.map((i) => i.clip)).size;
  return (
    <div className="flex items-center gap-2" data-safe-areas>
      {!!issues.length && first && (
        <button
          className="cursor-pointer rounded-md bg-chip px-2 py-0.5 text-xs text-warning hover:bg-control"
          title={issues.map((i) => `${clock(i.from)} “${i.text}”: ${i.label}`).join("\n")}
          onClick={() => {
            host.run("playhead.set", { time: first.from });
            host.run("selection.set", { clips: [first.clip] });
          }}
          data-safe-issues={clips}
        >
          ⚠ {clips} under {fitting.find((l) => l.id === id)?.title}'s UI
        </button>
      )}
      {id && <SafeAreaKey host={host} hidden={hiddenSafeParts(session)} />}
      <Select look="bar" value={id ?? ""} title="Safe areas: where the platform's own UI sits over the video" onChange={(e) => host.run("safeAreas.show", { layout: e.target.value || null })} data-safe-area-select>
        <option value="">No Safe Areas</option>
        {fitting.map((l) => (
          <option key={l.id} value={l.id} title={l.source}>
            {l.title}
          </option>
        ))}
      </Select>
    </div>
  );
}

/** What the colours on the canvas mean, beside the picker while a layout is shown; a click hides or shows one. */
function SafeAreaKey({ host, hidden }: { host: QueryHost; hidden: SafePart[] }) {
  const item = (part: SafePart, swatch: string, label: string, title: string) => {
    const off = hidden.includes(part);
    return (
      <button className={`flex cursor-pointer items-center gap-1 rounded-sm px-1 hover:bg-chip hover:text-text-strong ${off ? "opacity-40" : ""}`} title={`${title} (click to ${off ? "show" : "hide"} it)`} onClick={() => host.run("safeAreas.toggle", { part })} aria-pressed={!off} data-safe-key-part={part}>
        <span className={swatch} />
        {label}
      </button>
    );
  };
  return (
    <span className="flex items-center gap-1.5 text-xs text-text-faint" data-safe-key>
      {item("zones", "size-2.5 rounded-[2px] border border-safe-edge bg-safe-zone", "Platform UI", "Where the app draws its own buttons, captions and tabs over the video: keep text and faces out")}
      {item("headroom", "size-2.5 rounded-[2px] border border-safe-headroom-edge bg-safe-headroom", "Headroom", "Where the top of a head sits in a well-framed shot")}
      {item("eyeLine", "w-3 border-t-2 border-dashed border-safe-guide", "Eye line", "Where the eyes sit in a well-framed shot")}
    </span>
  );
}
