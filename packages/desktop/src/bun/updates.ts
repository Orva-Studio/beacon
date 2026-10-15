import { Updater, Utils } from "electrobun/main";

/** How long after launch the quiet check waits, so it doesn't compete with opening a project. */
const LAUNCH_DELAY_MS = 15_000;

let busy = false;

/**
 * Beacon › Check for Updates…, and the same quietly at launch: asks the release's update.json whether a newer
 * version is out and, if the user agrees, downloads it and restarts into it (`applyUpdate` swaps the app in place;
 * the quit path saves and closes projects first). Quiet, it says nothing unless there is an update. Dev builds
 * have no updates.
 */
export async function checkForUpdates({ quiet = false, status, stopped }: { quiet?: boolean; status: (text: string) => void; stopped: () => boolean }) {
  if (busy) return;
  busy = true;
  try {
    const current = await Updater.localInfo.version();
    let info;
    try {
      info = await Updater.checkForUpdate();
      if (info.error) throw new Error(info.error);
    } catch (e) {
      if (!quiet) await Utils.showMessageBox({ type: "warning", title: "Check for Updates", message: "Beacon couldn't check for updates.", detail: message(e), buttons: ["OK"] });
      return;
    }
    if (!info.updateAvailable) {
      if (!quiet) await Utils.showMessageBox({ type: "info", title: "Check for Updates", message: "Beacon is up to date.", detail: `You have version ${current}.`, buttons: ["OK"] });
      return;
    }
    const { response } = await Utils.showMessageBox({
      type: "question",
      title: "Update Available",
      message: `Beacon ${info.version} is available.`,
      detail: `You have version ${current}. Beacon restarts to update; your projects are saved first. Until Beacon is signed, macOS asks again for screen recording, camera and microphone permission after an update.`,
      buttons: ["Update and Restart", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
    // The user asked for it: from here a failure is always said, launch check or not.
    try {
      status(`Downloading Beacon ${info.version}…`);
      await Updater.downloadUpdate();
      if (!Updater.updateInfo().updateReady) throw new Error(Updater.updateInfo().error || "the download didn't finish");
      await Updater.applyUpdate();
      // A handoff that worked quits Beacon; returning means it didn't, and Electrobun says why in updateInfo, not by throwing.
      throw new Error(Updater.updateInfo().error || "the update didn't start");
    } catch (e) {
      status(`Update failed: ${message(e)}`);
      if (!stopped()) {
        await Utils.showMessageBox({ type: "error", title: "Update", message: "Beacon couldn't update.", detail: message(e), buttons: ["OK"] });
        return;
      }
      // It failed after Electrobun's before-quit: projects are saved and closed and the agents' socket is down, so
      // Beacon can't go on as it was; it quits cleanly rather than staying open half shut down.
      await Utils.showMessageBox({
        type: "error",
        title: "Update",
        message: "Beacon couldn't update and needs to quit.",
        detail: `${message(e)}\n\nYour projects are saved. Open Beacon again to keep working.`,
        buttons: ["Quit"],
      });
      Utils.quit();
    }
  } finally {
    busy = false;
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The quiet check, once, a little after launch. */
export function checkForUpdatesSoon(status: (text: string) => void, stopped: () => boolean) {
  setTimeout(() => void checkForUpdates({ quiet: true, status, stopped }), LAUNCH_DELAY_MS);
}
