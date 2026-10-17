import { z } from "zod";

/** How late a camera's picture is behind a microphone's sound, typed or measured by Check Sync. */
export const CameraSyncSchema = z.object({
  cameraLateMs: z.number(),
  /** When it was measured (Unix ms), from how many flashes, and how far they spread (ms). */
  checked: z.object({ at: z.number(), flashes: z.number(), spreadMs: z.number() }).optional(),
});

/** App-wide settings (Settings › General and Recording), kept by core in `settings.json` beside the preferences. */
export const AppSettingsSchema = z.object({
  exportColorSpace: z.enum(["bt709", "srgb"]),
  /** Which media get proxies made on their own when a project is shown (Create Proxy Video makes any). */
  autoProxy: z.object({ recording: z.boolean(), video: z.boolean() }),
  /** quiet: one proxy at a time at background priority, so the fans stay off; fast: two at once. */
  proxyMode: z.enum(["quiet", "fast"]),
  /** Where Snapshot saves its PNGs; unset, the project's own media folder. */
  snapshotFolder: z.string().optional(),
  /** By camera and microphone (`camera|microphone`): how late the camera is; each take's camera clip moves earlier by it. */
  cameraSync: z.record(z.string(), CameraSyncSchema).optional(),
  /** Resources the user said Not Now to: not offered again on their own. */
  declinedResources: z.array(z.string()).optional(),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;
export type CameraSync = z.infer<typeof CameraSyncSchema>;

/** Proxies are off until turned on: the preview reads originals in process, and a proxy is one more copy to build. */
export const DEFAULT_APP_SETTINGS: AppSettings = { exportColorSpace: "bt709", autoProxy: { recording: false, video: false }, proxyMode: "quiet" };
