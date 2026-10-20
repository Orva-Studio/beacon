import { Button, Modal } from "./controls";
import { CanvasSettings } from "./canvas-settings";
import { canvasChange, canvasValues } from "./canvas-values";
import { replica, useView } from "./store";

/**
 * Edit › Project Settings… (⌥⌘,), or the canvas's right-click: the open project's canvas size, frame rate,
 * background and loudness, each change an undoable `project.settings.set`, as agents make them.
 */
export function ProjectSettingsUi({ host }: { host: { run(command: string, args?: unknown, label?: string): void } }) {
  const open = useView((v) => v.projectSettings);
  const project = useView((v) => v.project);
  if (!open || !project) return null;
  const close = () => replica.projectSettings(false);
  return (
    <Modal title="Project Settings" width={520} onClose={close} onEnter={close}>
      <div data-project-settings>
        <CanvasSettings value={canvasValues(project.settings)} onChange={(change, label) => host.run("project.settings.set", canvasChange(change), label)} />
      </div>
      <div className="mt-5 flex justify-end">
        <Button look="primary" onClick={close}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
