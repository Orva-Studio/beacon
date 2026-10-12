import type { ExportSettings } from "./rpc";

/** The Export dialog's settings as core's export options (those that apply to the format). */
export function exportOptions(s: ExportSettings) {
  const video = s.format === "mp4" || s.format === "mov";
  const gif = s.format === "gif";
  return {
    ...(video ? { codec: s.codec } : {}),
    ...(!gif && s.bitrate !== null && !(video && s.codec === "prores") ? { bitrate: s.bitrate } : {}),
    ...(!gif ? { keyframe: s.keyframe } : {}),
    ...(video && s.codec === "h264" ? { profile: s.profile } : {}),
    ...(s.fps !== null ? { fps: s.fps } : {}),
    ...(s.size ? { size: s.size } : {}),
    ...(!gif ? { audio: s.audio, ...(s.audioBitrate !== null ? { audioBitrate: s.audioBitrate } : {}) } : {}),
  };
}
