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
export async function checkForUpdates({ quiet = false, status }: { quiet?: boolean; status: (text: string) => void }) {
  if (busy) return;
  busy = true;
  try {
    const current = await Updater.localInfo.version();
    const info = await Updater.checkForUpdate();
    if (info.error) {
      if (!quiet) await Utils.showMessageBox({ type: "warning", title: "Check for Updates", message: "Beacon couldn't check for updates.", detail: info.error, buttons: ["OK"] });
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
    status(`Downloading Beacon ${info.version}…`);
    await Updater.downloadUpdate();
    if (!Updater.updateInfo().updateReady) throw new Error(Updater.updateInfo().error || "the download didn't finish");
    await Updater.applyUpdate();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (quiet) status(`Update failed: ${message}`);
    else await Utils.showMessageBox({ type: "error", title: "Update", message: "Beacon couldn't update.", detail: message, buttons: ["OK"] });
  } finally {
    busy = false;
  }
}

/** The quiet check, once, a little after launch. */
export function checkForUpdatesSoon(status: (text: string) => void) {
  setTimeout(() => void checkForUpdates({ quiet: true, status }), LAUNCH_DELAY_MS);
}
