import type { Session } from "@beacon/model";
import type { HeadlineReview } from "@beacon/features";
import type { Host } from "./app";
import { Button, Check, Row, Select } from "./controls";
import { useShortcutTip } from "./keymap";
import { clock } from "./time";

export const headlineReviewOf = (s: Session) => (s.features.captions as { headlines?: HeadlineReview } | undefined)?.headlines;

/** The sentence with its keyword in bold. */
function Said({ text, keyword }: { text: string; keyword: string }) {
  const at = text.toLowerCase().indexOf(keyword.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <strong className="text-text-strong">{text.slice(at, at + keyword.length)}</strong>
      {text.slice(at + keyword.length)}
    </>
  );
}

/**
 * Dynamic Captions' Headlines review (headlines.plan): the sentences the planner picked, each with its keyword, ticked
 * to add; a click on one goes to it. Apply adds the ticked ones as headlines beside the speaker, one undo step.
 */
export function HeadlinesPanel({ session, host }: { session: Session; host: Host }) {
  const review = headlineReviewOf(session)!;
  const tip = useShortcutTip();
  const on = review.items.filter((i) => !i.off).length;
  return (
    <div className="panel-card flex w-[300px] shrink-0 flex-col overflow-y-auto p-4 text-body" data-headlines-review>
      <div className="mb-4 text-title font-semibold text-text-strong">Headlines</div>
      <Row label="Side">
        <Select data-headlines-side value={review.side} onChange={(e) => host.run("headlines.review", { side: e.target.value })}>
          <option value="center">Across the top</option>
          <option value="right">Right of the speaker</option>
          <option value="left">Left of the speaker</option>
        </Select>
      </Row>
      <Row label="Look">
        <Select data-headlines-look value={review.preset} onChange={(e) => host.run("headlines.review", { preset: e.target.value })}>
          <option value="editorial-headline">Editorial Headline</option>
          <option value="headline">Headline (underlined)</option>
          <option value="headline-glow">Headline Glow</option>
        </Select>
      </Row>
      <div className="mt-2 mb-3 rounded-md bg-groove px-3 py-2 text-text" data-headlines-summary>
        {review.planning
          ? "Picking the sentences worth a headline, and each one's keyword…"
          : review.error
            ? <span className="text-danger">{review.error}</span>
            : review.items.length
              ? `${review.items.length} headlines found: ${on} ticked to add.`
              : "No sentence here is worth a headline."}
      </div>
      <div className="mb-3 flex flex-col gap-2" data-headlines-list>
        {review.items.map((item, i) => (
          <div key={`${item.from}`} className="flex items-start gap-2" data-headline-item={i}>
            <Check checked={!item.off} title={item.off ? "Add this headline" : "Leave this one out"} onChange={(add) => host.run("headlines.review", { off: { index: i, off: !add } })} data-headline-tick={i} />
            <button className="flex-1 text-left text-label text-text-muted hover:text-text" title="Go to it" onClick={() => host.run("playhead.set", { time: item.from })}>
              <span className="mr-1 text-text-faint">{clock(item.from)}</span>
              <Said text={item.text} keyword={item.keyword} />
            </button>
          </div>
        ))}
      </div>
      <div className="mb-4 text-caption text-text-faint">The keyword is drawn big; the captions' line steps aside while a headline shows. Each one stays editable after: click its words in Caption Properties.</div>
      <div className="mt-auto flex justify-end gap-2">
        <Button onClick={() => host.run("headlines.close")} data-headlines-cancel>
          Cancel{tip("reviews.cancel")}
        </Button>
        <Button look="primary" disabled={review.planning || !on} onClick={() => host.run("headlines.apply")} data-headlines-apply>
          Apply{tip("reviews.apply")}
        </Button>
      </div>
    </div>
  );
}
