import { Button, Icon, Modal } from "./controls";
import { match, useKeymap } from "./keymap";
import type { RecentProject } from "./rpc";
import { replica, useView } from "./store";

export interface StartHost {
  openDialog(): void;
  openRecent(path: string): void;
  /** Its right-click menu: Open, Show in Finder, Remove from Recent Projects, Move to Trash…. */
  recentMenu(path: string): void;
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "5 minutes ago", "yesterday", "3 Oct". */
function whenOpened(at: number, now = Date.now()): string {
  const minutes = Math.round((at - now) / 60_000);
  if (minutes > -1) return "just now";
  if (minutes > -60) return RELATIVE.format(minutes, "minute");
  if (minutes > -24 * 60) return RELATIVE.format(Math.round(minutes / 60), "hour");
  const days = Math.round(minutes / (24 * 60));
  if (days > -7) return RELATIVE.format(days, "day");
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", ...(new Date(at).getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) });
}

function RecentCard({ project, host }: { project: RecentProject; host: StartHost }) {
  return (
    <button
      className="group flex min-w-0 flex-col gap-1.5 rounded-lg p-1.5 text-left hover:bg-control"
      title={project.path.replace(/^\/Users\/[^/]+/, "~")}
      onClick={() => host.openRecent(project.path)}
      onContextMenu={(e) => {
        e.preventDefault();
        host.recentMenu(project.path);
      }}
      data-recent={project.path}
    >
      <div className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-md border border-field-edge bg-app text-text-faint">
        {project.thumb ? <img src={project.thumb} draggable={false} className="h-full w-full object-contain" /> : <Icon name="film-strip" size={22} />}
      </div>
      <div className="flex items-baseline gap-2 px-0.5">
        <span className="min-w-0 flex-1 truncate text-text-strong">{project.name}</span>
        <span className="shrink-0 text-label text-text-faint">{whenOpened(project.opened)}</span>
      </div>
    </button>
  );
}

/** Opened without a project: New Project, the last four projects, and Open…; opening or creating one closes it. */
export function StartScreen({ host }: { host: StartHost }) {
  const show = useView((v) => !!v.init && !v.opened && !v.newProject && !v.settings && !v.resource);
  const recent = useView((v) => v.init?.recent);
  const folder = useView((v) => v.init?.projectsFolder ?? "");
  const keymap = useKeymap();
  if (!show) return null;
  const newProject = () => replica.newProject({ name: "Untitled Project", folder });
  return (
    <Modal
      width={560}
      onClose={() => {}}
      onKey={(e) => {
        const b = match(keymap, e.nativeEvent);
        if (b?.command === "app.open") host.openDialog();
        if (b?.command === "app.new") newProject();
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
        <div className="-mx-1.5 grid grid-cols-2 gap-1">
          {recent.slice(0, 4).map((p) => (
            <RecentCard key={p.path} project={p} host={host} />
          ))}
        </div>
      ) : (
        <div className="py-2 text-text-off">Projects you open appear here.</div>
      )}
    </Modal>
  );
}
