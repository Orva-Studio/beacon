import { z } from "zod";

/** One of the user's own texts kept app-wide (motion graphics' Your Skills): a name and its wording. */
export const CustomStyleSchema = z.strictObject({ id: z.string().min(1), name: z.string().min(1).max(80), text: z.string().min(1).max(20_000) });
export const CustomStylesSchema = z.array(CustomStyleSchema).max(200);
export type CustomStyle = z.infer<typeof CustomStyleSchema>;

/**
 * A text read from a file: a skill's `name` (its front matter) or first heading, else the file's name; its body
 * without the front matter.
 */
export function styleFromFile(fileName: string, content: string): { name: string; text: string } {
  const front = content.match(/^---\n([\s\S]*?)\n---\n?/);
  const body = (front ? content.slice(front[0].length) : content).trim();
  const named = front?.[1]?.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return { name: (named || heading || fileName.replace(/\.[^.]+$/, "")).slice(0, 80), text: body.slice(0, 20_000) };
}
