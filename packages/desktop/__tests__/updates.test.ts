import { beforeEach, expect, mock, test } from "bun:test";

// Electrobun's updater and dialogs, stood in for: what Beacon does with each outcome is what is tested.
let info = { version: "0.4.1", hash: "b", updateAvailable: true, updateReady: false, error: "" };
let applyError = "";
let quit = 0;
let dialogs: { message?: string; buttons?: string[] }[] = [];
let answer = 0;
const Updater = {
  localInfo: { version: async () => "0.4.0" },
  checkForUpdate: async () => info,
  downloadUpdate: async () => void (info = { ...info, updateReady: true }),
  // Electrobun 2.0.2 reports a failed handoff in updateInfo and returns, rather than throwing.
  applyUpdate: async () => void (info = { ...info, error: applyError }),
  updateInfo: () => info,
};
const Utils = {
  showMessageBox: async (o: { message?: string; buttons?: string[] }) => (dialogs.push(o), { response: answer }),
  quit: () => void quit++,
};
mock.module("electrobun/main", () => ({ Updater, Utils }));
const { checkForUpdates } = await import("../src/bun/updates");

let statuses: string[] = [];
const status = (t: string) => void statuses.push(t);
beforeEach(() => {
  info = { version: "0.4.1", hash: "b", updateAvailable: true, updateReady: false, error: "" };
  applyError = "Failed to start update helper: permission denied";
  quit = 0;
  dialogs = [];
  statuses = [];
  answer = 0;
});

test("an update whose handoff fails says so, and Beacon carries on when nothing was closed", async () => {
  await checkForUpdates({ status, stopped: () => false });
  expect(dialogs.map((d) => d.message)).toEqual(["Beacon 0.4.1 is available.", "Beacon couldn't update."]);
  expect(statuses.at(-1)).toBe(`Update failed: ${applyError}`);
  expect(quit).toBe(0);
});

test("a handoff that fails after Beacon closed its projects for it quits cleanly, saying why", async () => {
  await checkForUpdates({ status, stopped: () => true });
  expect(dialogs.at(-1)?.message).toBe("Beacon couldn't update and needs to quit.");
  expect(quit).toBe(1);
});

test("a failed download is said even from the quiet launch check, once the user said Update", async () => {
  Updater.downloadUpdate = async () => void (info = { ...info, updateReady: false, error: "HTTP 404" });
  await checkForUpdates({ quiet: true, status, stopped: () => false });
  expect(dialogs.at(-1)?.message).toBe("Beacon couldn't update.");
  expect(statuses.at(-1)).toBe("Update failed: HTTP 404");
});

test("Later downloads nothing", async () => {
  answer = 1;
  await checkForUpdates({ status, stopped: () => false });
  expect(dialogs).toHaveLength(1);
  expect(statuses).toEqual([]);
});
