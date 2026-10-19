/** The video's size: the canvas fitted within `size` (as ffmpeg's force_original_aspect_ratio=decrease), even. */
export function fittedSize(canvas: { width: number; height: number }, size?: { width: number; height: number } | null): { width: number; height: number } {
  const s = size ? Math.min(size.width / canvas.width, size.height / canvas.height) : 1;
  return { width: Math.max(2, Math.floor((canvas.width * s) / 2) * 2), height: Math.max(2, Math.floor((canvas.height * s) / 2) * 2) };
}

/** The highest data rate an export takes, kbit/s. */
export const MAX_BITRATE = 100_000;

/**
 * Automatic data rate in kbit/s for H.264 and HEVC: 10 Mbps at 1080p30, by pixels and less than in proportion to
 * the frame rate (frames close together compress well), never below 8 Mbps (the user's choice, 2026-10-18).
 */
export function autoBitrate(width: number, height: number, fps: number): number {
  const kbps = 10_000 * ((width * height) / (1920 * 1080)) * (fps / 30) ** 0.6;
  return Math.min(MAX_BITRATE, Math.max(8_000, Math.round(kbps / 100) * 100));
}
