import type { ExportSettings } from "./rpc";

/** The default export: H.264 High at the automatic data rate, a keyframe every 30 frames, the project's size and rate. */
export const DEFAULT_EXPORT: ExportSettings = { format: "mp4", codec: "h264", bitrate: null, keyframe: 30, profile: "high", fps: null, size: null, audio: true, audioBitrate: null };
