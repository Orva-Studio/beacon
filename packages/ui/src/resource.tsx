import { Button, Modal } from "./controls";
import { Progress } from "./controls/progress";
import { replica, useView } from "./store";
import { useOnline } from "./online";

import type { JobInfo, ResourceInfo } from "@beacon/core";

export type { ResourceInfo };
/** A resource's download, while the dialog shows it. */
export type ResourceJob = Pick<JobInfo, "id" | "state" | "progress" | "error">;

export interface ResourceHost {
  /** Starts the download; replies with its job. */
  fetchResource(id: string): Promise<{ ok: boolean; error?: string; result?: string }>;
  /** Not Now: not offered again on its own (Settings › General still offers it). */
  declineResource(id: string): void;
  cancelJob(id: string): void;
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

/** Asks before downloading something large (the speech model for transcripts), then shows the download. */
function ResourceDialog({ resource, job, host }: { resource: ResourceInfo; job?: ResourceJob; host: ResourceHost }) {
  const close = () => replica.resource(undefined);
  const download = async () => {
    const r = await host.fetchResource(resource.id);
    if (r.ok && r.result) replica.resourceJob({ id: r.result, state: "running", progress: 0 });
    else replica.resourceJob({ id: "", state: "failed", progress: 0, error: r.error ?? "the download didn't start" });
  };
  const running = job?.state === "running";
  const online = useOnline();
  return (
    <Modal title={running ? `Downloading the ${resource.title}` : `Download the ${resource.title}?`} width={480} onClose={close} onEnter={running || !online ? undefined : () => void download()}>
      <div className="flex flex-col gap-3 text-text" data-resource={resource.id}>
        <p>{resource.description}</p>
        <p className="text-text-muted">
          A one-time download of about {megabytes(resource.bytes)}, kept on this Mac. Nothing you record or edit is sent anywhere.
        </p>
        {running && (
          <div className="flex items-center gap-3" data-resource-progress>
            <Progress value={job.progress} className="flex-1" />
            <span className="w-10 text-right text-text-muted tabular-nums">{Math.round(job.progress * 100)}%</span>
          </div>
        )}
        {job?.state === "failed" && job.error !== "cancelled" && <p className="text-danger">{job.error}</p>}
        {!online && !running && (
          <p className="text-warning" data-offline>
            You're offline: it can be downloaded once you're back online.
          </p>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        {running ? (
          <>
            <Button onClick={() => host.cancelJob(job.id)}>Cancel Download</Button>
            <Button look="primary" title="Keep downloading with this closed" onClick={close}>
              Hide
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => (host.declineResource(resource.id), close())}>Not Now</Button>
            <Button look="primary" disabled={!online} onClick={() => void download()}>
              {job?.state === "failed" && job.error !== "cancelled" ? "Try Again" : "Download"}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}

export function ResourceUi({ host }: { host: ResourceHost }) {
  const resource = useView((v) => v.resource);
  const job = useView((v) => v.resourceJob);
  return resource ? <ResourceDialog resource={resource} job={job} host={host} /> : null;
}
