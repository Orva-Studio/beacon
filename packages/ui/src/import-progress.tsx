import { assetName, type Asset, type Project } from "@beacon/model";
import { Icon, Progress, Toast } from "./controls";
import { replica, useView } from "./store";
import type { ImportingFiles } from "./rpc";

const fileName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

/** What an imported file still waits for, as the Media Bin will show it: `undefined` once it is ready. */
function stage(a: Asset, v: { transcribing: Record<string, number>; preparing: Record<string, number>; jobFailed: Record<string, string> }): { label: string; progress?: number; error?: string } | undefined {
  if (v.jobFailed[a.id]) return { label: "Failed", error: v.jobFailed[a.id] };
  if (v.transcribing[a.id] !== undefined) return { label: "Transcribing", progress: v.transcribing[a.id] };
  if (v.preparing[a.id] !== undefined) return { label: "Making a proxy", progress: v.preparing[a.id] };
  return undefined;
}

/** Placeholder tiles in the Media Bin for files still being read: their media don't exist yet. */
export function PendingTiles({ list }: { list: boolean }) {
  const imports = useView((v) => v.imports);
  const files = Object.values(imports).flatMap((i) => (i.state === "reading" ? i.files.map((f) => ({ id: i.id, file: f })) : []));
  return files.map(({ id, file }) => (
    <div key={`${id}:${file}`} className={`flex gap-1.5 ${list ? "items-center" : "flex-col"}`} data-pending-media={fileName(file)} title={`Reading ${file}`}>
      <div className={`animate-pulse rounded-md bg-control ${list ? "h-9 w-14" : "aspect-[16/10] w-full"}`} />
      <div className="min-w-0">
        <div className="truncate text-label text-text-dim">{fileName(file)}</div>
        <div className="text-caption text-text-faint">Reading…</div>
      </div>
    </div>
  ));
}

/** The bottom-right panel while files import: each file's stage until all are ready, then it goes by itself. */
export function ImportProgress({ project }: { project?: Project }) {
  const imports = useView((v) => v.imports);
  const transcribing = useView((v) => v.transcribing);
  const preparing = useView((v) => v.preparing);
  const jobFailed = useView((v) => v.jobFailed);
  const hidden = useView((v) => v.importsHidden);
  const jobs = { transcribing, preparing, jobFailed };
  const all = Object.values(imports).filter((i) => !hidden.includes(i.id));
  if (!all.length) return null;
  const rows = all.flatMap((i) => rowsOf(i, project, jobs));
  const failed = rows.some((r) => r.label === "Failed");
  const busy = rows.some((r) => r.label !== "Ready" && r.label !== "Failed");
  const count = all.reduce((n, i) => n + i.files.length, 0);
  const files = `${count} file${count === 1 ? "" : "s"}`;
  return (
    <Toast title={busy ? `Importing ${files}` : failed ? `Imported ${files}, not all of it` : `Imported ${files}`} done={!busy && !failed} onDismiss={() => replica.importsDismissed()}>
      <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto" data-import-progress>
        {rows.map((r) => (
          <div key={r.key} className="flex flex-wrap items-center gap-x-2" data-import-row={r.name} data-import-stage={r.label}>
            <span className="min-w-0 flex-1 truncate text-label text-text">{r.name}</span>
            {r.label === "Ready" ? (
              <Icon name="check" size={14} className="text-accent" />
            ) : (
              <span className={`shrink-0 text-caption ${r.label === "Failed" ? "text-danger" : "text-text-muted"}`} title={r.error}>
                {r.label}
                {r.progress !== undefined && ` ${Math.round(r.progress * 100)}%`}
              </span>
            )}
            {r.error && <div className="w-full truncate text-caption text-danger" title={r.error}>{r.error}</div>}
          </div>
        ))}
        {busy && <Progress value={rows.filter((r) => r.label === "Ready").length / rows.length} className="mt-1" />}
      </div>
    </Toast>
  );
}

function rowsOf(i: ImportingFiles, project: Project | undefined, jobs: Parameters<typeof stage>[1]) {
  if (i.state === "reading") return i.files.map((f) => ({ key: `${i.id}:${f}`, name: fileName(f), label: "Reading", progress: undefined as number | undefined, error: undefined as string | undefined }));
  if (i.state === "failed") return i.files.map((f) => ({ key: `${i.id}:${f}`, name: fileName(f), label: "Failed", progress: undefined, error: i.error }));
  return (i.assets ?? []).flatMap((id) => {
    const a = project?.assets[id];
    if (!a) return [];
    const s = stage(a, jobs);
    return [{ key: `${i.id}:${id}`, name: assetName(a), label: s?.label ?? "Ready", progress: s?.progress, error: s?.error }];
  });
}
