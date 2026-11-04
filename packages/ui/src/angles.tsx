import { assetName, type Clip, type Project, type Session } from "@beacon/model";
import type { AngleProps, AngleState, AngleTakeInfo } from "@beacon/features";
import { Button, Check, Row, Section, Select, TextArea } from "./controls";
import { useOnline } from "./online";
import { useQuery } from "./query";
import { useDraft } from "./draft";
import type { Host } from "./app";

/** What `angle.estimate` answers. */
interface Estimate {
  seconds: number;
  cost: number;
  limit: number;
  crop: boolean;
  camera?: string;
}

const VIEWS: { id: AngleProps["view"]; title: string }[] = [
  { id: "profile-left", title: "Side profile, left" },
  { id: "profile-right", title: "Side profile, right" },
  { id: "wide", title: "Wide" },
  { id: "closeup", title: "Close-up" },
  { id: "detail", title: "Detail (hands, desk)" },
];

const dollars = (v: number) => `$${v.toFixed(2)}`;
export const angleStateOf = (s: Session | undefined) => (s?.features.angles as AngleState | undefined) ?? { making: [], errors: {} };

/**
 * An Angle clip's tab: the angle (view, handheld or locked, a few words), the room photos its track's angles use,
 * what generating costs, Generate (or a close-up by cropping, when the camera has the pixels) and the takes made.
 */
export function AngleTab({ clip, project, session, host }: { clip: Clip; project: Project; session: Session; host: Host }) {
  const a = clip.props.angle as AngleProps;
  const online = useOnline();
  const state = angleStateOf(session);
  const making = state.making.includes(clip.id);
  const error = state.errors[clip.id];
  const estimate = useQuery<Estimate>(host, "angle.estimate", { clip: clip.id }, project);
  const [note, setNote, saveNote] = useDraft(clip.id, a.note, (text) => host.run("clip.set", { clip: clip.id, props: { angle: { note: text } } }, "Angle Note", `angle-note-${clip.id}`));
  const set = (fields: Partial<AngleProps>, label: string) => host.run("clip.set", { clip: clip.id, props: { angle: fields } }, label);
  const track = project.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
  const photos = (track?.props?.angleRoom as { photos?: string[] } | undefined)?.photos ?? [];
  const images = Object.values(project.assets).filter((x) => x.kind === "image");
  const togglePhoto = (id: string, on: boolean) => track && host.run("angles.room", { track: track.id, photos: on ? [...photos, id].slice(0, 4) : photos.filter((p) => p !== id) }, "Room Photos");
  const takes = a.takes.map((t) => t.assetId).filter((id) => project.assets[id]);
  const info = (id: string) => project.assets[id]?.derived.angle as AngleTakeInfo | undefined;
  const over = !!estimate && estimate.limit > 0 && estimate.cost > estimate.limit;
  const ready = !!estimate?.camera && !making && online && !over;
  const crop = a.view === "closeup" && estimate?.crop;
  return (
    <>
      <Section>
        <Row label="Angle">
          <Select data-angle-view value={a.view} onChange={(e) => set({ view: e.target.value as AngleProps["view"] }, "Camera Angle")}>
            {VIEWS.map((v) => (
              <option key={v.id} value={v.id}>
                {v.title}
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Camera">
          <Select data-angle-move value={a.move} onChange={(e) => set({ move: e.target.value as AngleProps["move"] }, "Angle Camera")}>
            <option value="handheld">Handheld (a little drift)</option>
            <option value="locked">Locked off</option>
          </Select>
        </Row>
        <TextArea className="mt-2 h-14 w-full" placeholder="Anything else, in a few words (optional)" value={note} onChange={(e) => setNote(e.target.value)} onBlur={saveNote} data-angle-note />
      </Section>
      <Section>
        <div className="mb-1 text-label text-text-faint">Room photos</div>
        <div className="mb-2 text-caption text-text-faint" data-angle-room-hint>
          Add photos of the room from this side for a truer set (optional): taken with the lights you record with, from the new angle's side at seated eye level, the room as it is in the take. Import them into the Media Bin, then tick them here.
        </div>
        {images.length ? (
          <div className="flex flex-col gap-1" data-angle-photos>
            {images.map((img) => (
              <Check key={img.id} label={assetName(img)} checked={photos.includes(img.id)} onChange={(on) => togglePhoto(img.id, on)} data-angle-photo={img.id} />
            ))}
          </div>
        ) : (
          <div className="text-caption text-text-faint">No images in the Media Bin yet.</div>
        )}
      </Section>
      <Section>
        {!estimate?.camera ? (
          <div className="mb-2 text-label text-danger" data-angle-no-camera>
            An angle sits over one camera clip, all of it: move or trim it onto the camera.
          </div>
        ) : (
          <div className="mb-2 text-label text-text-muted" data-angle-cost>
            {crop
              ? "Your camera has the pixels for this close-up: it can be a crop of your own frames, free and in sync."
              : `Sends ${estimate.seconds} s of your camera and sound to Seedance 2.5, then ByteDance's upscaler to 1080p, on your Replicate account: about ${dollars(estimate.cost)} plus the upscaler.`}
            {over && <span className="text-danger"> Over your {dollars(estimate.limit)} limit per generation (Settings › AI).</span>}
          </div>
        )}
        {error && (
          <div className="mb-2 rounded-md bg-groove px-3 py-2 text-label text-danger" data-angle-error>
            {error}
          </div>
        )}
        {takes.length > 1 && (
          <Row label="Take">
            <Select value={clip.assetId ?? ""} onChange={(e) => host.run("angle.use", { clip: clip.id, asset: e.target.value }, "Pick Angle Take")} data-angle-pick>
              {takes.map((id) => (
                <option key={id} value={id}>
                  {assetName(project.assets[id]!)}
                  {info(id) ? ` · ${dollars(info(id)!.cost)}` : ""}
                </option>
              ))}
            </Select>
          </Row>
        )}
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          {crop && (
            <Button look="primary" onClick={() => host.run("angle.crop", { clip: clip.id }, "Close-up Crop")} data-angle-crop>
              Make Close-up (free)
            </Button>
          )}
          <Button look={crop ? "quiet" : "primary"} disabled={!ready} title={online ? undefined : "Generating needs the internet"} onClick={() => host.run("angle.generate", { clip: clip.id })} data-angle-generate>
            {making ? "Generating…" : crop ? "Generate Anyway" : takes.length ? "Generate Again" : "Generate"}
          </Button>
        </div>
      </Section>
    </>
  );
}
