import { NativeRenderer } from "@beacon/media";
import { type FeatureRegistry, type Project, type Scene, type Ticks } from "@beacon/model";
import { canvasKey, renderJob, sceneAt } from "./render";

/**
 * Stills for agents and previews (`frame.at`, contact sheets), rendered
 * in-process through beacon-ffi. Recreated when the canvas changes.
 */
export class FrameRenderer {
  #native?: NativeRenderer;
  #canvas = "";

  constructor(
    readonly registry: FeatureRegistry,
    readonly cacheDir?: string,
  ) {}

  #renderer(project: Project): NativeRenderer {
    const canvas = canvasKey(project);
    if (!this.#native || canvas !== this.#canvas) {
      this.#native?.close();
      this.#native = new NativeRenderer(JSON.stringify(renderJob(project, this.registry, { kind: "raw" }, this.cacheDir)));
      this.#canvas = canvas;
    }
    return this.#native;
  }

  #scene(project: Project, t: Ticks, data: <T>(assetId: string, key: string) => T | undefined): Scene {
    return sceneAt(project, this.registry, t, data);
  }

  /** PNG of the canvas at `t`, `width` pixels wide (0 = canvas width). */
  frame(project: Project, t: Ticks, data: <T>(assetId: string, key: string) => T | undefined, width = 0): Uint8Array {
    return this.#renderer(project).frame(JSON.stringify(this.#scene(project, t, data)), width);
  }

  /** PNG grid of the canvas at each time, `columns` wide. */
  sheet(project: Project, times: Ticks[], data: <T>(assetId: string, key: string) => T | undefined, columns: number, width: number): Uint8Array {
    const scenes = times.map((t) => this.#scene(project, t, data));
    return this.#renderer(project).sheet(JSON.stringify(scenes), columns, width, 4);
  }

  close() {
    this.#native?.close();
    this.#native = undefined;
  }
}
