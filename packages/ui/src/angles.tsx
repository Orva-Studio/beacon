import { assetName, type Clip, type Project, type Session } from "@beacon/model";
import type { AngleProps, AngleState, AngleTakeInfo } from "@beacon/features";
import { useState } from "react";
import { Button, Icon, ListSelect, Row, Section, Select, TextArea, Toggle } from "./controls";
import { ANGLE_ART } from "./angle-art";
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
  { id: "three-quarter-left", title: "Three-quarter, left" },
  { id: "three-quarter-right", title: "Three-quarter, right" },
  { id: "high", title: "High angle" },
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
  const setPhotos = (next: string[]) => track && host.run("angles.room", { track: track.id, photos: next }, "Room Photos");
  const [photoError, setPhotoError] = useState<string>();
  // Photos chosen from anywhere on the Mac (never picked from the project's media), up to four.
  const addPhoto = async () => {
    const path = await host.chooseFile(["jpg", "jpeg", "png", "heic", "webp"]);
    if (!path) return;
    const r = await host.importFile(path);
    setPhotoError(r.ok ? undefined : (r.error ?? `${path.split("/").pop()} couldn't be read`));
    if (r.ok && r.result && !photos.includes(r.result)) setPhotos([...photos, r.result].slice(0, 4));
  };
  const takes = a.takes.map((t) => t.assetId).filter((id) => project.assets[id]);
  const info = (id: string) => project.assets[id]?.derived.angle as AngleTakeInfo | undefined;
  const over = !!estimate && estimate.limit > 0 && estimate.cost > estimate.limit;
  const ready = !!estimate?.camera && !making && online && !over;
  const crop = a.view === "closeup" && estimate?.crop;
  return (
    <>
      <Section>
        <Row label="Angle">
          <ListSelect
            value={a.view}
            options={VIEWS.map((v) => ({ id: v.id, label: v.title, art: ANGLE_ART[v.id] }))}
            onChange={(id) => id !== a.view && set({ view: id as AngleProps["view"] }, "Camera Angle")}
            data-angle-view
          />
        </Row>
        <Row label="Camera">
          <Toggle
            value={a.move}
            options={[
              { value: "handheld", label: "Handheld", title: "A little drift" },
              { value: "locked", label: "Locked", title: "No movement" },
            ]}
            onChange={(move) => set({ move }, "Angle Camera")}
            data-angle-move
          />
        </Row>
        <TextArea className="mt-2 h-14 w-full" placeholder="Anything else (optional)" value={note} onChange={(e) => setNote(e.target.value)} onBlur={saveNote} data-angle-note />
      </Section>
      <Section>
        <div className="mb-1 text-label text-text-faint">Room photos</div>
        <div className="mb-2 text-caption text-text-faint" data-angle-room-hint>
          Optional: up to four photos of your room from this angle's side, in the light you record with.
        </div>
        {photos.length > 0 && (
          <ul className="mb-2 flex flex-col gap-1" data-angle-photos>
            {photos.map((id) => (
              <li key={id} className="flex items-center gap-2 text-label text-text" data-angle-photo={id}>
                <span className="text-text-faint">•</span>
                <span className="min-w-0 flex-1 truncate">{project.assets[id] ? assetName(project.assets[id]!) : "A photo no longer in the project"}</span>
                <Button look="quiet" title="Don't use this photo" onClick={() => setPhotos(photos.filter((p) => p !== id))} data-angle-photo-remove={id}>
                  <Icon name="x" size={12} />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Button disabled={photos.length >= 4} title={photos.length >= 4 ? "Four photos at most" : "Choose a photo of your room"} onClick={() => void addPhoto()} data-angle-photo-add>
          Add Photos…
        </Button>
        {photoError && <div className="mt-2 text-caption text-danger">{photoError}</div>}
      </Section>
      <Section>
        {!estimate?.camera ? (
          <div className="mb-2 text-label text-danger" data-angle-no-camera>
            An angle sits over one camera clip, all of it: move or trim it onto the camera.
          </div>
        ) : (
          (crop || over) && (
            <div className="mb-2 text-label text-text-muted" data-angle-cost>
              {crop && "Your camera is sharp enough to crop this close-up: free and in sync."}
              {over && <span className="text-danger">About {dollars(estimate.cost)}: over your {dollars(estimate.limit)} limit per generation (Settings › AI).</span>}
            </div>
          )
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
          <Button
            look={crop ? "quiet" : "primary"}
            disabled={!ready}
            title={online ? "Charged to your Replicate account" : "You're offline"}
            onClick={() => host.run("angle.generate", { clip: clip.id })}
            data-angle-generate
          >
            {making ? "Generating…" : `${crop ? "Generate Anyway" : takes.length ? "Generate Again" : "Generate"}${estimate?.camera ? ` · ~${dollars(estimate.cost)}` : ""}`}
          </Button>
        </div>
      </Section>
    </>
  );
}
