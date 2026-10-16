import { useEffect, useState, type ReactNode } from "react";
import { projectDuration, rationalToNumber, ticksToSeconds } from "@beacon/model";
import { Button, Icon, LevelMeter, Modal, Select, SettingsRow as Row, TextInput, type IconName } from "./controls";
import { previewListeners, useRecordFrames } from "./record-preview";
import { syncKey, type AudioLevel, type CameraSync, type RecordedSheet, type RecordFrames, type RecordPreview, type RecordSheet, type RecordSources } from "./rpc";
import { CameraSyncControl, type SyncCheckHost } from "./sync-check";
import { replica, useView } from "./store";

export interface RecordHost extends SyncCheckHost {
  startRecording(sources: RecordSources): Promise<{ ok: boolean; error?: string }>;
  /** Opens the Record dialog, as File › Record… does. */
  openRecord(): void;
  /** Records `microphone` while the timeline plays from the playhead or through the range; `hear`: with its sound. */
  startNarration(microphone: { id?: string }, hear: boolean): Promise<{ ok: boolean; error?: string }>;
  /** Ends the narration and places it on the timeline, or throws it away. */
  stopNarration(discard?: boolean): void;
  /** Shows the sources (`recordPreviewEvent` gets their levels, `recordFrames` their frames); with none, stops. */
  recordPreview(sources: RecordSources): void;
  recordFrames(after: number): Promise<RecordFrames>;
  run(command: string, args?: unknown, label?: string): void;
}


const COUNTDOWN = 3;

/** Where a permission that isn't granted is given. */
const SETTINGS: Record<"screen" | "camera" | "microphone", string> = {
  screen: "Screen & System Audio Recording",
  camera: "Camera",
  microphone: "Microphone",
};

/** Where to give a permission that was refused, under its source. */
function permission(kind: keyof typeof SETTINGS, status: string): ReactNode {
  if (status === "granted" || status === "not asked") return undefined;
  return (
    <span className="text-warning" data-permission={kind}>
      Allow Beacon in System Settings › Privacy & Security › {SETTINGS[kind]}
    </span>
  );
}

/** A source's live picture, or what it would show and why it doesn't; `size`: what a take records it at. */
function Monitor({ label, icon, jpeg, mirrored, why, size, className }: { label: string; icon: IconName; jpeg?: string; mirrored?: boolean; why?: string; size?: string; className: string }) {
  return (
    <figure className={`flex flex-col gap-1 ${className}`}>
      <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-md bg-groove ring-1 ring-white/5">
        {jpeg && !why ? (
          // Mirrored, as a self-view is; the take isn't.
          <img src={`data:image/jpeg;base64,${jpeg}`} alt={`${label} preview`} className={`h-full w-full object-contain ${mirrored ? "-scale-x-100" : ""}`} data-preview={label} />
        ) : (
          <span className="flex flex-col items-center gap-1 text-caption text-text-faint">
            <Icon name={icon} size={18} />
            {why}
          </span>
        )}
      </div>
      <figcaption className="flex justify-between gap-2 text-caption text-text-muted">
        <span>{label}</span>
        {size && !why && (
          <span className="text-text tabular-nums" data-record-size={label}>
            {size}
          </span>
        )}
      </figcaption>
    </figure>
  );
}

/** A source's row: its name, a checkbox, and what to record from. */
function Source({ label, on, setOn, hint, children }: { label: string; on: boolean; setOn: (on: boolean) => void; hint?: ReactNode; children?: ReactNode }) {
  return (
    <Row label={label} hint={on ? hint : undefined}>
      <input type="checkbox" aria-label={label} checked={on} onChange={(e) => setOn(e.target.checked)} data-source={label} />
      {on && children}
    </Row>
  );
}

/** The sources last used, each moved to the first device there is when its own was unplugged since. */
function present(sources: RecordSources, sheet: RecordSheet): RecordSources {
  const { screen, camera, microphone } = sources;
  const has = <T extends { id: unknown }>(list: T[], id: unknown) => list.some((d) => d.id === id);
  return {
    ...sources,
    ...(screen && !has(sheet.displays, screen.display) ? { screen: { ...screen, display: sheet.displays[0]?.id } } : {}),
    ...(camera && !has(sheet.cameras, camera.id) ? { camera: { id: sheet.cameras[0]?.id } } : {}),
    ...(microphone && !has(sheet.microphones, microphone.id) ? { microphone: { id: sheet.microphones[0]?.id } } : {}),
  };
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** What a narration plays: the in/out range, or from the playhead to the end. */
function useNarrationSpan(): { from: number; until: number; ranged: boolean; still: boolean } {
  const range = useView((v) => v.session?.range);
  const playhead = useView((v) => v.session?.playhead ?? 0);
  const project = useView((v) => v.project);
  const end = project ? ticksToSeconds(projectDuration(project)) : 0;
  const frame = project ? rationalToNumber(project.settings.fps) ** -1 : 0;
  const [from, until] = range ? [range.in, range.out] : [playhead, end];
  // As core decides: a frame or less left (the playhead on the last one) is nothing to play.
  return { from, until, ranged: !!range, still: from >= until - frame * 1.5 };
}

/** Tools › Voice Narration…: the microphone last used (or the first) and nothing else. */
function narrationSources(sources: RecordSources, sheet: RecordSheet): RecordSources {
  return { microphone: sources.microphone?.id ? sources.microphone : { id: sheet.microphones[0]?.id } };
}

/**
 * File > Record…: what to record, then a countdown; Beacon then hides and its menu-bar item stops the take.
 * The microphone alone is voice narration: Beacon stays open and plays the timeline while it records.
 */
export function RecordDialog({ sheet, host }: { sheet: RecordSheet; host: RecordHost }) {
  const [hear, setHear] = useState(!!sheet.hear);
  const span = useNarrationSpan();
  const [s, setS] = useState<RecordSources>(() => present(sheet.mode === "narration" ? narrationSources(sheet.sources, sheet) : sheet.sources, sheet));
  const narration = !!s.microphone && !s.screen && !s.camera && !s.systemAudio;
  // Nothing after the playhead to play: the narration records there until Stop.
  const still = span.still;
  const [counting, setCounting] = useState<number>();
  const [error, setError] = useState<string>();
  const close = () => replica.recordSheet(undefined);
  const nothing = !s.screen && !s.systemAudio && !s.camera && !s.microphone;
  const [levels, setLevels] = useState<{ microphone?: AudioLevel; systemAudio?: AudioLevel }>({});
  const [cameraSync, setCameraSync] = useState<Record<string, CameraSync>>(sheet.cameraSync ?? {});
  // A sync check records the same devices: the preview lets go of them while it runs.
  const [checking, setChecking] = useState(false);
  useEffect(() => setS((s) => present(s, sheet)), [sheet.displays, sheet.cameras, sheet.microphones]);

  // Only what Beacon may already use: asking for a permission waits for Record.
  const granted = (k: keyof RecordSheet["permissions"]) => sheet.permissions[k] === "granted";
  const screen = granted("screen") ? s.screen : undefined;
  const systemAudio = granted("screen") ? s.systemAudio : undefined;
  const camera = granted("camera") ? s.camera : undefined;
  const microphone = granted("microphone") ? s.microphone : undefined;
  const previewing = !!(screen || camera) && !checking;
  const frames = useRecordFrames(host.recordFrames, previewing && counting === undefined);
  useEffect(() => {
    setLevels({});
    if (checking) return;
    const listen = (e: RecordPreview) => !("jpeg" in e) && setLevels(e);
    previewListeners.add(listen);
    host.recordPreview({
      ...(screen ? { screen: { display: screen.display } } : {}),
      ...(systemAudio ? { systemAudio } : {}),
      ...(camera ? { camera } : {}),
      ...(microphone ? { microphone } : {}),
    });
    return () => {
      previewListeners.delete(listen);
      host.recordPreview({});
    };
  }, [!!screen, screen?.display, !!systemAudio, !!camera, camera?.id, !!microphone, microphone?.id, checking]);
  const pair = s.camera?.id && s.microphone?.id ? syncKey(s.camera.id, s.microphone.id) : undefined;
  const why = (on: unknown, kind: keyof RecordSheet["permissions"]) => (!on ? "Off" : !granted(kind) ? "Needs permission" : undefined);

  useEffect(() => {
    if (counting === undefined) return;
    if (counting > 0) {
      const t = setTimeout(() => setCounting(counting - 1), 1000);
      return () => clearTimeout(t);
    }
    void (narration ? host.startNarration(s.microphone ?? {}, hear && !still) : host.startRecording(s)).then((r) => {
      if (r.ok) return close();
      setCounting(undefined);
      setError(r.error);
    });
  }, [counting]);

  const display = (id: number | undefined) => sheet.displays.find((d) => d.id === id) ?? sheet.displays[0];
  const shown = display(s.screen?.display);
  const screenSize = shown?.pixelWidth && shown.pixelHeight ? `${shown.pixelWidth} × ${shown.pixelHeight} · ${s.screen?.fps ?? 60} fps` : undefined;
  const cam = sheet.cameras.find((c) => c.id === s.camera?.id);
  const cameraSize = cam?.width && cam.height ? `${cam.width} × ${cam.height}${cam.fps ? ` · ${cam.fps} fps` : ""}` : undefined;
  if (counting !== undefined) {
    return (
      <Modal title={narration ? "Voice Narration" : "Record"} width={360} onClose={() => setCounting(undefined)}>
        <div className="flex flex-col items-center gap-2 py-6" data-countdown>
          <div className="text-6xl font-semibold tabular-nums text-text-strong">{Math.max(counting, 1)}</div>
          <div className="text-center text-text-muted">
            {!narration
              ? "Beacon hides while you record. Stop from the menu bar or ⌘⇧2."
              : still
                ? `Records at ${clock(span.from)}. Stop in the top bar or ⌘⇧2 ends it.`
                : `The timeline plays from ${clock(span.from)} while you speak. Stop in the top bar or ⌘⇧2 ends it.`}
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={() => setCounting(undefined)}>Cancel</Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={narration ? "Voice Narration" : "Record"} width={560} onClose={close} onEnter={() => !nothing && setCounting(COUNTDOWN)}>
      {!narration && (
        <div className="mb-4 flex gap-3" data-record-monitors>
          <Monitor label="Screen" icon="monitor-play" jpeg={frames.screen} why={why(s.screen, "screen")} size={screenSize} className="flex-[1.6]" />
          <Monitor label="Camera" icon="video-camera" jpeg={frames.camera} mirrored why={why(s.camera, "camera")} size={cameraSize} className="flex-1" />
        </div>
      )}
      <div className="flex flex-col gap-3" data-record {...(narration ? { "data-narration": true } : {})}>
        <Source label="Screen" hint={permission("screen", sheet.permissions.screen)} on={!!s.screen} setOn={(on) => setS({ ...s, screen: on ? { display: display(undefined)?.id, fps: 60 } : undefined })}>
          <div className="w-56">
            <Select value={display(s.screen?.display)?.id ?? ""} onChange={(e) => setS({ ...s, screen: { ...s.screen, display: Number(e.target.value) } })}>
              {sheet.displays.map((d, i) => (
                <option key={d.id} value={d.id}>
                  Display {i + 1} ({d.pixelWidth ?? d.width} × {d.pixelHeight ?? d.height})
                </option>
              ))}
            </Select>
          </div>
          <div className="w-24">
            <Select value={s.screen?.fps ?? 60} onChange={(e) => setS({ ...s, screen: { ...s.screen, fps: Number(e.target.value) } })}>
              <option value={30}>30 fps</option>
              <option value={60}>60 fps</option>
            </Select>
          </div>
        </Source>
        <Source label="Camera" hint={permission("camera", sheet.permissions.camera)} on={!!s.camera} setOn={(on) => setS({ ...s, camera: on ? { id: sheet.cameras[0]?.id } : undefined })}>
          <div className="w-72">
            <Select value={s.camera?.id ?? ""} onChange={(e) => setS({ ...s, camera: { id: e.target.value } })}>
              {sheet.cameras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
        </Source>
        <Source label="Microphone" hint={permission("microphone", sheet.permissions.microphone)} on={!!s.microphone} setOn={(on) => setS({ ...s, microphone: on ? { id: sheet.microphones[0]?.id } : undefined })}>
          <div className="w-72">
            <Select value={s.microphone?.id ?? ""} onChange={(e) => setS({ ...s, microphone: { id: e.target.value } })}>
              {sheet.microphones.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </div>
          {microphone && <LevelMeter label="Microphone level" db={levels.microphone?.db} peak={levels.microphone?.peak} />}
        </Source>
        {pair && (
          <Row label="Sync">
            <div className="min-w-0 flex-1">
              <CameraSyncControl
                key={pair}
                sync={cameraSync[pair]}
                typed={false}
                onChange={(sync) => setCameraSync({ ...cameraSync, [pair]: sync })}
                onCheck={setChecking}
                host={host}
                devices={{
                  camera: sheet.cameras.find((c) => c.id === s.camera!.id) ?? { id: s.camera!.id!, name: s.camera!.id! },
                  microphone: sheet.microphones.find((m) => m.id === s.microphone!.id) ?? { id: s.microphone!.id!, name: s.microphone!.id! },
                  displays: sheet.displays,
                  display: s.screen?.display,
                  outputs: sheet.outputs,
                }}
              />
            </div>
          </Row>
        )}
        <Source label="System audio" on={!!s.systemAudio} setOn={(on) => setS({ ...s, systemAudio: on || undefined })}>
          {systemAudio && <LevelMeter label="System audio level" db={levels.systemAudio?.db} peak={levels.systemAudio?.peak} />}
        </Source>
        {narration && !still && (
          <Row label="Timeline sound" hint={hear ? <span className="text-warning">Use headphones: from speakers, the timeline records into the narration</span> : undefined}>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={hear} onChange={(e) => setHear(e.target.checked)} data-hear />
              Hear it while recording
            </label>
          </Row>
        )}
        {narration && (
          <div className="text-caption text-text-muted" data-narration-span>
            Voice narration: Beacon stays open
            {still
              ? ` and records at the playhead (${clock(span.from)}) until you stop. Nothing plays: the timeline ends there.`
              : span.ranged
                ? ` and plays the range ${clock(span.from)}–${clock(span.until)} while you speak, then stops.`
                : ` and plays from the playhead (${clock(span.from)}) while you speak, until you stop or the timeline ends.`}{" "}
            It goes on a new track at {clock(span.from)}.
          </div>
        )}
      </div>
      {error && <div className="mt-4 text-danger">{error}</div>}
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={close}>Cancel</Button>
        <Button look="primary" disabled={nothing} onClick={() => setCounting(COUNTDOWN)} data-record-start>
          Record
        </Button>
      </div>
    </Modal>
  );
}

/** After a take: its name (the date and time) selected to type over; Enter keeps what is typed, Esc the name it has. */
function RecordedDialog({ sheet, host }: { sheet: RecordedSheet; host: RecordHost }) {
  const [name, setName] = useState(sheet.name);
  const close = () => replica.recordedSheet(undefined);
  const save = () => {
    const n = name.trim();
    if (n && n !== sheet.name) host.run("asset.rename", { asset: sheet.asset, name: n }, "Rename Recording");
    close();
  };
  return (
    <Modal title="Name the Recording" width={420} onClose={close} onEnter={save}>
      <div className="flex flex-col gap-2" data-recorded>
        <TextInput
          value={name}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
          aria-label="Recording name"
          data-recorded-name
        />
        <div className="text-caption text-text-muted">{clock(sheet.duration)} recorded, at the end of the timeline. The name shows in the Media Bin and on its clips.</div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={close}>Skip</Button>
        <Button look="primary" onClick={save} data-recorded-save>
          Save
        </Button>
      </div>
    </Modal>
  );
}

export function RecordUi({ host }: { host: RecordHost }) {
  const sheet = useView((v) => v.recordSheet);
  const recorded = useView((v) => v.recordedSheet);
  if (sheet) return <RecordDialog sheet={sheet} host={host} />;
  return recorded ? <RecordedDialog key={recorded.asset} sheet={recorded} host={host} /> : null;
}
