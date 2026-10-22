export * from "./api";
export * from "./local";
export * from "./remote";
export { findDropped, importDropped } from "./dropped";
export { LOCK_FILE, lockOwner, ProjectLockedError, projectName, readProject, writeProject, type Owner } from "./persist";
export { summarizeReport } from "@beacon/camtasia";
export { askOwner, CONTROL_SOCKET, DEFAULT_SOCKET, serveControl, serveCore, type CoreServer } from "./socket";
export {
  chordOf,
  enginePlacement,
  fitPercent,
  formatIssues,
  fpsRational,
  jsonSchemaOf,
  keyOfCode,
  isAudioFormat,
  KeysSchema,
  keysLabel,
  locateTrack,
  menuKey,
  MODIFIERS,
  placeCanvas,
  projectDuration,
  SETTINGS_TABS,
  SettingsPatchSchema,
  syncKey,
  ticksToSeconds,
  UI_DIALOGS,
  VideoEncodingSchema,
  walkClips,
  type Keys,
  type ShortcutInfo,
} from "@beacon/model";
export { LABEL_COLORS } from "@beacon/features";
export { captureWindow, focusPage, windowNumber, type DroppedFile } from "@beacon/media";
export type { LiveView, ViewTarget } from "@beacon/render";
