import type { ExportSettings } from "./rpc";

/** The default export: H.264 High at 6 Mbps, a keyframe every 30 frames, the project's size and rate. */
export const DEFAULT_EXPORT: ExportSettings = { format: "mp4", codec: "h264", bitrate: 6000, keyframe: 30, profile: "high", fps: null, size: null, audio: true, audioBitrate: null };
