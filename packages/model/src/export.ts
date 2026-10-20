import { z } from "zod";

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

/** What an export writes, by the output path's extension. */
export const VIDEO_FORMATS = ["mp4", "mov", "gif", "webm"] as const;
/** The timeline's mix alone: no frames rendered. */
export const AUDIO_FORMATS = ["wav", "m4a", "mp3"] as const;
export const EXPORT_FORMATS = [...VIDEO_FORMATS, ...AUDIO_FORMATS] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const isAudioFormat = (f: ExportFormat): f is (typeof AUDIO_FORMATS)[number] => (AUDIO_FORMATS as readonly string[]).includes(f);

/** How an export encodes, for agents and the app alike; the format is the output path's extension (.mp4, .mov, .gif, .webm; .wav, .m4a, .mp3 for the audio alone). */
export const VideoEncodingSchema = z.strictObject({
  codec: z.enum(["h264", "hevc", "prores"]).optional().describe(".mp4/.mov; ProRes only in .mov. Default H.264"),
  bitrate: z
    .int()
    .min(64)
    .max(MAX_BITRATE)
    .optional()
    .describe("Video data rate in kbit/s; omitted: automatic: for H.264 and HEVC by the output's size and frame rate (10 Mbps at 1080p30, never below 8 Mbps), for WebM constant quality; not used by ProRes"),
  keyframe: z.int().positive().optional().describe("A keyframe every this many frames (default 30)"),
  profile: z.enum(["baseline", "main", "high"]).optional().describe("H.264 profile"),
  fps: z.number().positive().max(120).optional().describe("Output frame rate; omitted: the project's"),
  size: z.strictObject({ width: z.int().positive(), height: z.int().positive() }).optional().describe("Fit within this size, keeping the aspect ratio; omitted: the canvas"),
  audio: z.boolean().optional().describe("false: no audio track"),
  audioBitrate: z.int().min(32).max(512).optional().describe("Audio data rate in kbit/s (default 256; .mp3 at most 320; not used by .wav)"),
  colorSpace: z.enum(["bt709", "srgb"]).optional().describe("Export Color Space: bt709 (default) or srgb, which macOS players show as the editor does"),
});

export type VideoEncoding = z.infer<typeof VideoEncodingSchema>;
