import { useCallback, useRef } from "react";
import { Modal, NativeView, PlayBar, type NativeTag } from "./controls";
import { replica, useView } from "./store";

export interface AssetPreviewInfo {
  kind: "video" | "audio" | "image";
  duration: number;
  width: number;
  height: number;
  fps: number;
}

export interface PreviewHost {
  /** What the asset's preview shows; the main process keeps it open until `previewClose`. */
  previewOpen(asset: string): Promise<AssetPreviewInfo | null>;
  /** The preview's native view and its box: the asset is drawn there, fitted. */
  previewView(id: number, rect: { x: number; y: number; width: number; height: number }, scale: number): void;
  previewPlay(from: number): void;
  /** `time`: where it stopped, as the window last heard. */
  previewPause(time: number): void;
  previewSeek(time: number): void;
  previewClose(): void;
}

/** Opens the Media Bin preview of an asset (a double-click), in the window. */
export async function openPreview(host: PreviewHost, asset: string, name: string) {
  const info = await host.previewOpen(asset);
  if (info) replica.preview({ asset, name, info });
}

const MAX = { width: 960, height: 540 };

function MediaPreview({ host, name, info }: { host: PreviewHost; name: string; info: AssetPreviewInfo }) {
  const tag = useRef<NativeTag>(null);
  const clock = useView((v) => v.previewClock);
  const report = useCallback((id: number, rect: { x: number; y: number; width: number; height: number }, scale: number) => host.previewView(id, rect, scale), [host]);
  const close = () => {
    // The modal goes at once; the main process lets go of the view and its decoders after.
    replica.preview(undefined);
    host.previewClose();
  };
  const toggle = () => (clock.playing ? host.previewPause(clock.time) : host.previewPlay(clock.time >= info.duration - 1 / info.fps ? 0 : clock.time));
  const k = Math.min(1, MAX.width / info.width, MAX.height / info.height);
  const picture = info.kind !== "audio";
  return (
    <Modal
      title={`Preview - "${name}"`}
      width={picture ? Math.max(360, Math.round(info.width * k)) + 40 : 520}
      onClose={close}
      onKey={(e) => {
        if (e.key !== " " || info.kind === "image") return;
        e.preventDefault();
        toggle();
      }}
    >
      <div>
        {picture && (
          <div className="relative bg-black" style={{ aspectRatio: `${info.width} / ${info.height}` }}>
            <NativeView tagRef={tag} onReport={report} style={{ position: "absolute", inset: 0, width: "auto", height: "auto", display: "block" }} />
          </div>
        )}
        {info.kind !== "image" && <PlayBar time={clock.time} end={info.duration} fps={info.fps} playing={clock.playing} onToggle={toggle} onSeek={(t) => host.previewSeek(t)} />}
      </div>
    </Modal>
  );
}

export function MediaPreviewUi({ host }: { host: PreviewHost }) {
  const preview = useView((v) => v.preview);
  return preview ? <MediaPreview key={preview.asset} host={host} name={preview.name} info={preview.info} /> : null;
}
