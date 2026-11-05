export * from "./api";
export * from "./local";
export * from "./remote";
export { asAuthor, currentAuthor } from "./author";
export { findDropped, importDropped } from "./dropped";
export { LOCK_FILE, lockOwner, ProjectLockedError, projectName, readProject, writeProject, type Owner } from "./persist";
export { summarizeReport } from "@beacon/camtasia";
export { askControl, askOwner, CONTROL_SOCKET, controlSockets, DEFAULT_SOCKET, serveControl, serveCore, type ControlHandlers, type CoreServer } from "./socket";
export {
  agentName,
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
  nestedOf,
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
export { captureWindow, focusPage, windowNumber, type DroppedFile } from "@beacon/media";
export type { LiveView, ViewTarget } from "@beacon/render";
