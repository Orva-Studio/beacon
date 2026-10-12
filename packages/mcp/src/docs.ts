import SKILL from "../../../skills/SKILL.md" with { type: "text" };
import HOUSE_STYLE from "../../../skills/references/house-style.md" with { type: "text" };
import EXPORT from "../../../skills/workflows/export.md" with { type: "text" };
import REVIEW from "../../../skills/workflows/review.md" with { type: "text" };
import ROUGH_CUT from "../../../skills/workflows/rough-cut.md" with { type: "text" };
import ZOOM_PASS from "../../../skills/workflows/zoom-pass.md" with { type: "text" };

export interface Workflow {
  description: string;
  args: Record<string, string>;
  body: string;
}

function workflow(md: string): Workflow {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) throw new Error("workflow without frontmatter");
  const meta = Bun.YAML.parse(m[1]!) as { description: string; args?: Record<string, string> };
  return { description: meta.description, args: meta.args ?? {}, body: md.slice(m[0].length).trim() };
}

/** The server's `instructions`: the entry doc, version-matched by being built in. */
export const INSTRUCTIONS: string = SKILL;

export const DOCS: Record<string, string> = { "house-style": HOUSE_STYLE };

export const WORKFLOWS: Record<string, Workflow> = {
  "rough-cut": workflow(ROUGH_CUT),
  "zoom-pass": workflow(ZOOM_PASS),
  review: workflow(REVIEW),
  export: workflow(EXPORT),
};
