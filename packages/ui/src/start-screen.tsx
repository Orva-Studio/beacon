import { Button, Icon, Modal } from "./controls";
import type { RecentProject } from "./rpc";
import { replica, useView } from "./store";

export interface StartHost {
  openDialog(): void;
  openRecent(path: string): void;
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "5 minutes ago", "yesterday", "3 Oct". */
export function whenOpened(at: number, now = Date.now()): string {
  const minutes = Math.round((at - now) / 60_000);
  if (minutes > -1) return "just now";
  if (minutes > -60) return RELATIVE.format(minutes, "minute");
  if (minutes > -24 * 60) return RELATIVE.format(Math.round(minutes / 60), "hour");
  const days = Math.round(minutes / (24 * 60));
  if (days > -7) return RELATIVE.format(days, "day");
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", ...(new Date(at).getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) });
}

function RecentRow({ project, host }: { project: RecentProject; host: StartHost }) {
  return (
    <button
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-control"
      title={project.path.replace(/^\/Users\/[^/]+/, "~")}
      onClick={() => host.openRecent(project.path)}
      data-recent={project.path}
    >
      <Icon name="film-strip" size={18} />
      <span className="min-w-0 flex-1 truncate text-text-strong">{project.name}</span>
      <span className="shrink-0 text-label text-text-faint">{whenOpened(project.opened)}</span>
    </button>
  );
}

/** Opened without a project: New Project, the last four projects, and Open…; opening or creating one closes it. */
export function StartScreen({ host }: { host: StartHost }) {
  const show = useView((v) => !!v.init && !v.opened && !v.newProject && !v.settings && !v.resource);
  const recent = useView((v) => v.init?.recent);
  if (!show) return null;
  const newProject = () => replica.newProject({ name: "Untitled Project" });
  return (
    <Modal
      width={480}
      onClose={() => {}}
      onKey={(e) => {
        if (e.metaKey && e.code === "KeyO") host.openDialog();
        if (e.metaKey && e.code === "KeyN") newProject();
      }}
    >
      <div className="mb-4 text-title font-semibold text-text-strong" data-start-screen>
        Beacon
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button look="primary" onClick={newProject}>
          New Project
        </Button>
        <Button onClick={host.openDialog}>Open…</Button>
      </div>
      <div className="mt-5 mb-1 text-label text-text-faint">Recent</div>
      {recent?.length ? (
        <div className="-mx-3">
          {recent.slice(0, 4).map((p) => (
            <RecentRow key={p.path} project={p} host={host} />
          ))}
        </div>
      ) : (
        <div className="py-2 text-text-off">Projects you open appear here.</div>
      )}
    </Modal>
  );
}
