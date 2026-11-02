import { useEffect, useRef, useState } from "react";
import { projectDuration, ticksToSeconds, type Project, type Session } from "@beacon/model";
import type { MusicPage, MusicReview, MusicTrack, SoundEffect } from "@beacon/features";
import { Button, Check, Icon, Segmented, Slider, TextInput } from "./controls";
import { useShortcutTip } from "./keymap";
import { useView } from "./store";
import type { Host } from "./app";
import { clock } from "./time";

export const musicReviewOf = (s: Session) => s.features.music as MusicReview | undefined;

type Item = (MusicTrack | SoundEffect) & { artist?: string; bpm?: number; moods?: string[]; vocals?: boolean };

/** What Apply would do with the range and playhead as they are: where the music goes, and how long it lasts. */
function where(review: MusicReview, project: Project, session: Session): string {
  if (review.tab === "sfx") return `At the playhead (${clock(session.playhead)}), on an SFX track`;
  const end = ticksToSeconds(projectDuration(project));
  const [from, to] = session.range ? [session.range.in, session.range.out] : [session.playhead, end - session.playhead >= 1 ? end : undefined];
  if (to === undefined) return `From the playhead (${clock(from)}), the whole track`;
  const fitted = review.fit === "edit" && to - from <= 300 && (review.vocals || !review.pick?.vocals);
  return `${session.range ? "Over the range" : "From the playhead to the end"}, ${clock(from)}–${clock(to)} (${clock(to - from)}): ${fitted ? "re-cut by Epidemic Sound to fit" : "cut there and faded out"}`;
}

/**
 * The Music panel, in place of the properties panel (the AI panel's Music tile): Epidemic Sound's music or sound
 * effects searched and previewed, the pick added over the range (music) or at the playhead (a sound effect).
 */
export function MusicPanel({ project, session, host }: { project: Project; session: Session; host: Host }) {
  const review = musicReviewOf(session)!;
  const set = (settings: Partial<Omit<MusicReview, "open" | "pick">> & { pick?: MusicReview["pick"] | null }) => host.run("music.review", settings);
  const [term, setTerm] = useState(review.term);
  const [found, setFound] = useState<{ items: Item[]; total?: number; next?: string } | { error: string }>();
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<string>();
  const audio = useRef<HTMLAudioElement>(null);
  const settingsOpen = useView((v) => !!v.settings);

  const search = async (more?: string) => {
    setBusy(true);
    try {
      const page = (await host.query(review.tab === "sfx" ? "sfx.search" : "music.search", { ...(term.trim() ? { term: term.trim() } : {}), ...(more ? { after: more } : {}) })) as MusicPage<Item>;
      setFound((was) => (more && was && "items" in was ? { ...page, items: [...was.items, ...page.items] } : page));
    } catch (e) {
      setFound({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  // Asked again when the tab changes, and when Settings closes (the key may just have been added there).
  useEffect(() => {
    if (!settingsOpen) void search();
  }, [review.tab, settingsOpen]);
  useEffect(() => () => audio.current?.pause(), []);

  const listen = (item: Item) => {
    const el = audio.current!;
    if (playing === item.id) {
      el.pause();
      setPlaying(undefined);
      return;
    }
    el.src = item.preview;
    void el.play().catch(() => setPlaying(undefined));
    setPlaying(item.id);
  };
  const pick = (item: Item) => {
    // Out of the search field, so ↩ applies the pick instead of searching again.
    (document.activeElement as HTMLElement | null)?.blur();
    set({ pick: { id: item.id, title: item.title, ms: item.ms, ...(item.vocals ? { vocals: true } : {}) } });
  };
  const tip = useShortcutTip();
  const music = review.tab === "music";

  return (
    <div className="panel-card flex w-[320px] shrink-0 flex-col overflow-hidden p-4 text-body" data-music-review>
      <audio ref={audio} onEnded={() => setPlaying(undefined)} />
      <div className="mb-3 flex items-center justify-between">
        <span className="text-title font-semibold text-text-strong">{music ? "Music" : "Sound Effects"}</span>
        <Segmented
          value={review.tab}
          onChange={(tab) => set({ tab })}
          options={[
            { value: "music", label: "Music", icon: <Icon name="music-note" size={16} /> },
            { value: "sfx", label: "Sound Effects", icon: <Icon name="waveform" size={16} /> },
          ]}
          data-music-tab
        />
      </div>
      <form
        className="mb-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          set({ term });
          void search();
        }}
      >
        <TextInput className="flex-1" placeholder={music ? "Mood, genre, instrument…" : "Whoosh, pop, click…"} value={term} onChange={(e) => setTerm(e.target.value)} data-music-term />
        <Button type="submit" disabled={busy} title="Search Epidemic Sound">
          <Icon name="magnifying-glass" size={16} />
        </Button>
      </form>
      <div className="-mx-1 mb-3 min-h-0 flex-1 overflow-y-auto px-1" data-music-results>
        {found === undefined && <div className="text-text-muted">Searching Epidemic Sound…</div>}
        {found && "error" in found && (
          <div className="flex flex-col items-start gap-2" data-music-error>
            <span className="text-danger">{found.error.replace(/^no Epidemic/, "No Epidemic")}</span>
            {/key/.test(found.error) && <Button onClick={() => host.app("app.settings:ai")}>Open Settings…</Button>}
          </div>
        )}
        {found && "items" in found && !found.items.length && <div className="text-text-muted">Nothing found: try other words.</div>}
        {found &&
          "items" in found &&
          found.items.map((item) => {
            const picked = review.pick?.id === item.id;
            return (
              <div
                key={item.id}
                role="option"
                aria-selected={picked}
                onClick={() => pick(item)}
                className={`mb-1 flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 ${picked ? "bg-accent/20 ring-1 ring-accent" : "hover:bg-chip"}`}
                data-music-item={item.id}
              >
                <button
                  className="shrink-0 rounded-full bg-control p-1.5 text-text-strong hover:bg-tile-hover"
                  title={playing === item.id ? "Stop" : "Listen"}
                  onClick={(e) => {
                    e.stopPropagation();
                    listen(item);
                  }}
                  data-music-listen
                >
                  <Icon name={playing === item.id ? "pause" : "play"} size={14} filled />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-text-strong" title={item.title}>
                    {item.title}
                  </div>
                  <div className="truncate text-caption text-text-faint">
                    {[item.artist, clock(item.ms / 1000), item.bpm ? `${item.bpm} BPM` : "", item.vocals ? "vocals" : "", ...(item.moods ?? []).slice(0, 2)].filter(Boolean).join(" · ")}
                  </div>
                </div>
              </div>
            );
          })}
        {found && "next" in found && found.next && (
          <Button disabled={busy} onClick={() => void search(found.next)} data-music-more>
            More
          </Button>
        )}
      </div>
      {music && (
        <div className="mb-3 flex flex-col gap-2 border-t border-divider pt-3">
          <Check label="Fit to the range (Epidemic re-cuts the track)" title="Off: cut where the range ends and faded out" checked={review.fit === "edit"} onChange={(on) => set({ fit: on ? "edit" : "cut" })} data-music-fit />
          {review.pick?.vocals && <Check label="Keep the singing" title="Off: the track's instruments alone (cut to fit)" checked={review.vocals} onChange={(on) => set({ vocals: on })} data-music-vocals />}
          <Check label="Duck under speech" title="Dips under what is said, as audio points you can drag" checked={review.duck} onChange={(on) => set({ duck: on })} data-music-duck />
          <Slider label="Volume" value={Math.round(review.level * 100)} unit="%" max={100} onChange={(v) => set({ level: Math.round(v) / 100 })} />
          {review.duck && <Slider label="Under speech" value={Math.round(review.under * 100)} unit="%" max={100} onChange={(v) => set({ under: Math.round(v) / 100 })} />}
        </div>
      )}
      <div className="mb-3 rounded-md bg-groove px-3 py-2 text-text" data-music-where>
        {review.pick ? (
          <>
            <div className="truncate font-medium text-text-strong">{review.pick.title}</div>
            <div className="text-caption text-text-muted">{where(review, project, session)}</div>
          </>
        ) : (
          <span className="text-text-muted">{music ? "Pick a track." : "Pick a sound effect."} Downloads use your Epidemic Sound subscription.</span>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={() => host.run("music.close")}>Cancel{tip("reviews.cancel")}</Button>
        <Button look="primary" disabled={!review.pick} onClick={() => host.run("music.apply")} data-music-apply>
          Apply{tip("reviews.apply")}
        </Button>
      </div>
    </div>
  );
}
