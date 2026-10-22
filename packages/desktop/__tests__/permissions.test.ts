import { expect, test } from "bun:test";
import { askFor } from "../src/bun/permissions";

test("the Record dialog asks macOS for the camera and microphone its sources want, once, before Record", async () => {
  const permissions = { screen: "granted", camera: "not asked", microphone: "not asked" };
  const asked: string[] = [];
  const core = {
    recorderDevices: async () => ({ permissions }) as never,
    recorderAccess: async (kind: "camera" | "microphone") => (asked.push(kind), (permissions[kind] = "granted")) as never,
  };
  // The camera ticked: only it is asked about.
  expect(await askFor(core, { camera: { id: "cam" } })).toBe(true);
  expect(asked).toEqual(["camera"]);
  // Asked already: not again, whatever the answer was.
  permissions.camera = "denied";
  expect(await askFor(core, { camera: { id: "cam" }, microphone: {} })).toBe(true);
  expect(asked).toEqual(["camera", "microphone"]);
  expect(await askFor(core, { camera: { id: "cam" }, microphone: {} })).toBe(false);
  expect(asked).toEqual(["camera", "microphone"]);
  // Neither ticked: nothing asked.
  permissions.camera = permissions.microphone = "not asked";
  expect(await askFor(core, { screen: { fps: 60 } })).toBe(false);
  expect(asked).toHaveLength(2);
});
