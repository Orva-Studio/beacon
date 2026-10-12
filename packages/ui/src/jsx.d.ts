import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "electrobun-wgpu": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { class?: string; masks?: string; transparent?: boolean; passthrough?: boolean };
    }
  }
}
