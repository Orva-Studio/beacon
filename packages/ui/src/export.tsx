import { useState } from "react";
import { autoBitrate, fittedSize, isAudioFormat, MAX_BITRATE } from "@beacon/model";
import { Button, Check, Icon, Modal, Progress, Select, SettingsRow as Row, TextInput, Toast } from "./controls";
import { DEFAULT_EXPORT } from "./export-defaults";
import type { ExportJob, ExportSettings, ExportSheet } from "./rpc";
import { replica, useView } from "./store";
import { clock } from "./time";

export interface ExportHost {
  chooseFolder(start: string): Promise<string | null>;
  startExport(params: { name: string; folder: string; settings: ExportSettings; range?: { in: number; out: number }; clips?: string[]; overwrite?: boolean }): Promise<{ ok: boolean; error?: string }>;
  cancelExport(id: string): void;
  showFile(path: string, open?: boolean): void;
}

/** The File format menu: the video formats, or with Audio only ticked the audio ones. */
const FORMATS: [ExportSettings["format"], string][] = [
  ["mp4", "Export to MP4 (.mp4)"],
  ["mov", "Export to QuickTime Movie (.mov)"],
  ["gif", "Export to Animated GIF (.gif)"],
  ["webm", "Export to WebM (.webm)"],
  ["wav", "Export to WAV (.wav)"],
  ["m4a", "Export to AAC (.m4a)"],
  ["mp3", "Export to MP3 (.mp3)"],
];

const FRAME_RATES = [10, 15, 24, 25, 30, 50, 60];
const SIZES = [
  [3840, 2160],
  [2560, 1440],
  [1920, 1080],
  [1280, 720],
  [854, 480],
] as const;

/** Automatic or a custom rate on a slider, as the Data rate rows. */
function DataRate({ value, min, max, auto, autoLabel = "Automatic", onChange }: { value: number | null; min: number; max: number; auto: number; autoLabel?: string; onChange: (v: number | null) => void }) {
  const shown = value ?? auto;
  return (
    <>
      <label className="flex items-center gap-1">
        <input type="radio" checked={value === null} onChange={() => onChange(null)} /> {autoLabel}
      </label>
      <label className="flex items-center gap-1">
        <input type="radio" checked={value !== null} onChange={() => onChange(shown)} /> Custom
      </label>
      <input type="range" className="w-40" min={min} max={max} value={shown} disabled={value === null} onChange={(e) => onChange(Number(e.target.value))} />
      <TextInput
        type="number"
        className="w-24 text-right"
        min={min}
        max={max}
        value={shown}
        disabled={value === null}
        data-rate
        onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || min)))}
      />
      <span className="text-text-dim">kbits/sec</span>
    </>
  );
}

/** File > Export…: name, folder, format and advanced options, in the window (Electrobun has no save panel). */
function ExportDialog({ sheet, host, muted = [], unmute }: { sheet: ExportSheet; host: ExportHost; muted?: string[]; unmute?: () => void }) {
  const [name, setName] = useState(sheet.name);
  const [folder, setFolder] = useState(sheet.folder);
  const [s, setS] = useState(sheet.settings);
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string>();
  const [exists, setExists] = useState(false);
  // The selected clips, else a range on the timeline, are what gets exported unless unticked.
  const [selectionOnly, setSelectionOnly] = useState(!!(sheet.clips ?? sheet.range));
  const span = sheet.clips ?? sheet.range;
  // Only pictures are being exported: there is nothing to hear.
  const silent = !!sheet.clips?.silent && selectionOnly;
  // The format last picked on the other side of Audio only, to come back to.
  const [other, setOther] = useState<ExportSettings["format"]>(isAudioFormat(sheet.settings.format) ? DEFAULT_EXPORT.format : "wav");
  const set = (patch: Partial<ExportSettings>) => setS((x) => ({ ...x, ...patch }));
  const pick = (format: ExportSettings["format"]) => set({ format, ...(format !== "mov" && s.codec === "prores" ? { codec: "h264" } : {}), ...(isAudioFormat(format) ? { audio: true } : {}) });
  const close = () => replica.exportSheet(undefined);
  const start = async (overwrite = false) => {
    const only = selectionOnly ? (sheet.clips ? { clips: sheet.clips.ids } : sheet.range ? { range: sheet.range } : {}) : {};
    const r = await host.startExport({ name: name.trim(), folder, settings: s, ...only, overwrite });
    if (r.ok) return close();
    setExists(!!r.error?.includes("already exists"));
    setError(r.error);
  };
  const video = s.format === "mp4" || s.format === "mov";
  const audioOnly = isAudioFormat(s.format);
  const sizeKey = s.size ? `${s.size.width}x${s.size.height}` : "";
  const fitted = fittedSize(sheet.canvas, s.size);
  const autoRate = autoBitrate(fitted.width, fitted.height, s.fps ?? sheet.canvas.fps);
  return (
    <Modal title={span && selectionOnly ? "Export Selection" : "Export"} width={680} onClose={close} onEnter={() => void start()}>
      <div className="flex flex-col gap-3">
        <Row label="Export As">
          <TextInput
            autoFocus
            className="flex-1"
            value={name}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => (setName(e.target.value), setError(undefined))}
          />
          <span className="text-text-dim">.{s.format}</span>
        </Row>
        <Row label="Where">
          <span className="min-w-0 flex-1 truncate text-text-strong" title={folder}>
            {folder.replace(/^\/Users\/[^/]+/, "~")}
          </span>
          <Button onClick={async () => (await host.chooseFolder(folder).then((f) => f && setFolder(f)), setError(undefined))}>Choose…</Button>
        </Row>
        {span && (
          <Row label="">
            <Check
              label={`${sheet.clips ? `Export the selected clips only (${sheet.clips.ids.length === 1 ? "1 clip" : `${sheet.clips.ids.length} clips`}, ` : "Export the selection only ("}${clock(span.in, { tenths: true })}–${clock(span.out, { tenths: true })})`}
              checked={selectionOnly}
              onChange={setSelectionOnly}
              data-export-only
            />
          </Row>
        )}
        <Row label="File format">
          <div className="w-72">
            <Select value={s.format} onChange={(e) => pick(e.target.value as ExportSettings["format"])}>
              {FORMATS.filter(([f]) => isAudioFormat(f) === audioOnly).map(([f, label]) => (
                <option key={f} value={f}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          <Button onClick={() => setAdvanced((a) => !a)}>{advanced ? "Hide Options" : "Options…"}</Button>
        </Row>
        <Row label="">
          <Check label="Audio only" checked={audioOnly} disabled={silent} title={silent ? "The selected clips have no sound" : undefined} onChange={() => (setOther(s.format), pick(other))} />
        </Row>
      </div>
      {advanced && (
        <div className="mt-4 flex flex-col gap-3 rounded-md bg-well/60 p-4">
          {!audioOnly && (
            <>
              <div className="text-text-strong">Video</div>
              <Row label="Frame rate">
                <div className="w-40">
                  <Select value={s.fps ?? ""} onChange={(e) => set({ fps: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">Automatic ({sheet.canvas.fps})</option>
                    {FRAME_RATES.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </Select>
                </div>
              </Row>
              <Row label="Dimensions">
                <div className="w-56">
                  <Select
                    value={sizeKey}
                    onChange={(e) => {
                      const [w, h] = e.target.value.split("x").map(Number);
                      set({ size: w && h ? { width: w, height: h } : null });
                    }}
                  >
                    <option value="">
                      Current ({sheet.canvas.width}×{sheet.canvas.height})
                    </option>
                    {SIZES.map(([w, h]) => (
                      <option key={w} value={`${w}x${h}`}>
                        Fit within {w}×{h}
                      </option>
                    ))}
                  </Select>
                </div>
              </Row>
              {s.format !== "gif" && !(video && s.codec === "prores") && (
                <Row label="Data rate">
                  <DataRate value={s.bitrate} min={64} max={MAX_BITRATE} auto={autoRate} autoLabel={s.format === "webm" ? "Automatic (constant quality)" : "Automatic"} onChange={(bitrate) => set({ bitrate })} />
                </Row>
              )}
              {video && (
                <Row label="Compression type">
                  <div className="w-40">
                    <Select value={s.codec} onChange={(e) => set({ codec: e.target.value as ExportSettings["codec"] })}>
                      <option value="h264">H.264</option>
                      <option value="hevc">HEVC (H.265)</option>
                      {s.format === "mov" && <option value="prores">ProRes 422 HQ</option>}
                    </Select>
                  </div>
                </Row>
              )}
              {s.format !== "gif" && s.codec !== "prores" && (
                <Row label="Keyframe every">
                  <TextInput type="number" min={1} className="w-20 text-right" value={s.keyframe} onChange={(e) => set({ keyframe: Math.max(1, Number(e.target.value) || 1) })} />
                  <span className="text-text-dim">frames</span>
                </Row>
              )}
              {video && s.codec === "h264" && (
                <Row label="Profile">
                  <div className="w-72">
                    <Select value={s.profile} onChange={(e) => set({ profile: e.target.value as ExportSettings["profile"] })}>
                      <option value="baseline">Baseline (Largest file, plays everywhere)</option>
                      <option value="main">Main</option>
                      <option value="high">High (Smallest file, playback on recent devices)</option>
                    </Select>
                  </div>
                </Row>
              )}
            </>
          )}
          {s.format !== "gif" && (
            <>
              <div className="mt-1 text-text-strong">Audio</div>
              {!audioOnly && (
                <Row label="">
                  <Check label="Encode audio" checked={s.audio} disabled={silent} title={silent ? "The selected clips have no sound" : undefined} onChange={(audio) => set({ audio })} />
                </Row>
              )}
              {s.audio && s.format !== "wav" && (
                <Row label="Data rate">
                  <DataRate value={s.audioBitrate} min={64} max={320} auto={256} onChange={(audioBitrate) => set({ audioBitrate })} />
                </Row>
              )}
            </>
          )}
          <div>
            <Button onClick={() => setS({ ...DEFAULT_EXPORT, format: s.format })}>Restore Defaults</Button>
          </div>
        </div>
      )}
      {muted.length > 0 && s.audio && s.format !== "gif" && (
        <div className="mt-4 flex items-center gap-3 rounded-lg border border-warning/50 bg-warning/12 px-3 py-2 text-text-strong" data-export-muted>
          <Icon name="speaker-slash" size={18} filled className="shrink-0 text-warning" />
          <span className="flex-1">
            <span className="font-semibold">{muted.join(", ")}</span> {muted.length === 1 ? "is muted: its audio won't be in the export." : "are muted: their audio won't be in the export."}
          </span>
          {unmute && <Button onClick={unmute}>Unmute</Button>}
        </div>
      )}
      {error && (
        <div className="mt-4 flex items-center gap-2 text-danger">
          <span className="flex-1">{error}</span>
          {exists && <Button onClick={() => void start(true)}>Replace</Button>}
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={close}>Cancel</Button>
        <Button look="primary" disabled={!name.trim()} onClick={() => void start()}>
          Export
        </Button>
      </div>
    </Modal>
  );
}

/** The running export's progress, then Show in Finder / Open when it is done; a failure stays until dismissed. */
function ExportProgress({ job, host }: { job: ExportJob; host: ExportHost }) {
  const file = job.output.split("/").at(-1);
  return (
    <Toast
      title={job.state === "running" ? `Exporting ${file}` : job.state === "done" ? `Exported ${file}` : `Export failed: ${file}`}
      hint={job.output}
      done={job.state === "done"}
      onDismiss={job.state === "running" ? undefined : () => replica.exportJob(undefined)}
    >
      {job.state === "running" && (
        <div className="flex items-center gap-2">
          <Progress value={job.progress} className="flex-1" />
          <span className="w-9 text-right font-mono text-xs tabular-nums">{Math.round(job.progress * 100)}%</span>
          <Button onClick={() => host.cancelExport(job.id)}>Cancel</Button>
        </div>
      )}
      {job.state === "done" && (
        <div className="flex justify-end gap-2">
          <Button onClick={() => host.showFile(job.output)}>Show in Finder</Button>
          <Button onClick={() => host.showFile(job.output, true)}>Open</Button>
        </div>
      )}
      {job.state === "failed" && <div className="text-danger">{job.error}</div>}
    </Toast>
  );
}

/** A saved Snapshot, with Show in Finder / Open. */
export function SnapshotSaved({ host }: { host: ExportHost }) {
  const path = useView((v) => v.snapshot);
  if (!path) return null;
  return (
    <Toast title={`Saved ${path.split("/").at(-1)}`} hint={path} done onDismiss={() => replica.snapshot(undefined)}>
      <div className="flex justify-end gap-2">
        <Button onClick={() => host.showFile(path)}>Show in Finder</Button>
        <Button onClick={() => host.showFile(path, true)}>Open</Button>
      </div>
    </Toast>
  );
}

/** The Export dialog, from the view store. */
export function ExportUi({ host, muted, unmute }: { host: ExportHost; muted?: string[]; unmute?: () => void }) {
  const sheet = useView((v) => v.exportSheet);
  return sheet ? <ExportDialog key={sheet.name + sheet.folder} sheet={sheet} host={host} muted={muted} unmute={unmute} /> : null;
}

/** The running export's toast, from the view store. */
export function ExportToast({ host }: { host: ExportHost }) {
  const job = useView((v) => v.exportJob);
  return job ? <ExportProgress job={job} host={host} /> : null;
}
