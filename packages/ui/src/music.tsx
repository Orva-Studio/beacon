import { useEffect, useRef, useState } from "react";
import { projectDuration, ticksToSeconds, type Project, type Session } from "@beacon/model";
import type { MusicPage, MusicReview, MusicTrack, PopIn, SoundEffect } from "@beacon/features";
import { POP_TERMS, type PopKind } from "@beacon/features/src/music/pops";
import { Button, Check, Icon, Segmented, Slider, TextInput } from "./controls";
import { useShortcutTip } from "./keymap";
import { useQuery } from "./query";
import { useView } from "./store";
import type { TimelineMark } from "./timeline-draw";
import type { Host } from "./app";
import { clock } from "./time";

export const musicReviewOf = (s: Session) => s.features.music as MusicReview | undefined;

/** The pop-ins, while the Music panel shows them: for the panel's list and the timeline's marks. */
export function usePopIns(host: Pick<Host, "query">, session: Session | undefined, project: Project | undefined): PopIn[] | undefined {
  const on = !!session && musicReviewOf(session)?.tab === "popins";
  return useQuery<PopIn[]>(host, on ? "sfx.popIns" : "", {}, project);
}

/** Each pop-in's sound on the timeline: green where one goes in, grey where it is left out or has no sound yet. */
export function popInMarks(found: PopIn[], review: MusicReview): TimelineMark[] {
  return found.map((p) => {
    const sound = review.pops.sounds[p.kind];
    const on = !!sound && !review.pops.off.includes(p.clip);
    return { start: p.time, end: p.time + Math.max(0.2, (sound?.ms ?? 300) / 1000), tone: on ? "take" : "keep" };
  });
}

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
export function MusicPanel({ project, session, host, popIns }: { project: Project; session: Session; host: Host; popIns?: PopIn[] }) {
  const review = musicReviewOf(session)!;
  const set = (
    settings: Partial<Omit<MusicReview, "open" | "pick" | "pops">> & {
      pick?: MusicReview["pick"] | null;
      popSound?: { kind: PopKind; pick: { id: string; title: string; ms: number } };
      popOff?: { clip: string; off: boolean };
    },
  ) => host.run("music.review", settings);
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
    if (!settingsOpen && review.tab !== "popins") void search();
  }, [review.tab, settingsOpen]);
  useEffect(() => () => audio.current?.pause(), []);

  const listen = (item: { id: string; preview: string }) => {
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
      <div className="mb-3 flex flex-col items-start gap-2">
        <span className="text-title font-semibold text-text-strong">{music ? "Music" : review.tab === "sfx" ? "Sound Effects" : "Pop-ins"}</span>
        <Segmented
          value={review.tab}
          onChange={(tab) => set({ tab })}
          options={[
            { value: "music", label: "Music", icon: <Icon name="music-note" size={16} /> },
            { value: "sfx", label: "Sound Effects", icon: <Icon name="waveform" size={16} /> },
            { value: "popins", label: "Pop-ins", icon: <Icon name="sparkle" size={16} /> },
          ]}
          data-music-tab
        />
      </div>
      {review.tab === "popins" ? (
        <PopIns review={review} found={popIns} host={host} set={set} listen={listen} playing={playing} />
      ) : (
        <>
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
                        {[item.artist, length(item.ms), item.bpm ? `${item.bpm} BPM` : "", item.vocals ? "vocals" : "", ...(item.moods ?? []).slice(0, 2)].filter(Boolean).join(" · ")}
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
              <Check
                label="Fit to the range (Epidemic re-cuts the track)"
                title="Off: cut where the range ends and faded out"
                checked={review.fit === "edit"}
                onChange={(on) => set({ fit: on ? "edit" : "cut" })}
                data-music-fit
              />
              {review.pick?.vocals && (
                <Check label="Keep the singing" title="Off: the track's instruments alone (cut to fit)" checked={review.vocals} onChange={(on) => set({ vocals: on })} data-music-vocals />
              )}
              <Check label="Duck under speech" title="Dips under what is said, as audio points you can drag" checked={review.duck} onChange={(on) => set({ duck: on })} data-music-duck />
              <Slider label="Volume" value={Math.round(review.level * 100)} unit="%" max={100} onChange={(v) => set({ level: Math.round(v) / 100 })} />
              {review.duck && <Slider label="Under speech" value={Math.round(review.under * 100)} unit="%" max={100} onChange={(v) => set({ under: Math.round(v) / 100 })} />}
            </div>
          )}
        </>
      )}
      {review.tab === "popins" ? (
        <div className="mb-3 rounded-md bg-groove px-3 py-2 text-text" data-music-where>
          {popSummary(review, popIns)}
        </div>
      ) : (
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
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={() => host.run("music.close")}>Cancel{tip("reviews.cancel")}</Button>
        <Button look="primary" disabled={review.tab === "popins" ? !popCount(review, popIns) : !review.pick} onClick={() => host.run("music.apply")} data-music-apply>
          Apply{tip("reviews.apply")}
        </Button>
      </div>
    </div>
  );
}

/** A track's or sound's length: "2:47", or "0.4 s" for a short sound. */
const length = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : clock(ms / 1000));

/** How many pop-ins get a sound as the panel is set. */
const popCount = (review: MusicReview, found: PopIn[] | undefined) => (found ?? []).filter((p) => review.pops.sounds[p.kind] && !review.pops.off.includes(p.clip)).length;

function popSummary(review: MusicReview, found: PopIn[] | undefined) {
  if (!found) return <span className="text-text-muted">Finding pop-ins…</span>;
  if (!found.length) return <span className="text-text-muted">Nothing comes onto the picture yet: add motion graphics, B-roll or pictures first.</span>;
  const n = popCount(review, found);
  return <span>{n === 1 ? "1 sound" : `${n} sounds`} on SFX tracks, one undo step. Downloads use your Epidemic Sound subscription.</span>;
}

const KIND_LABEL: Record<PopKind, string> = { motion: "Motion graphics and B-roll", picture: "Pictures, screenshots and logos" };

/**
 * Pop-ins: a sound on each motion graphic, B-roll and picture coming onto the picture. One sound per kind (first
 * found for "whoosh" and "pop", changeable), each pop-in ticked to take it; a click on one moves the playhead there.
 */
function PopIns({
  review,
  found,
  host,
  set,
  listen,
  playing,
}: {
  review: MusicReview;
  found: PopIn[] | undefined;
  host: Host;
  set: (s: { popSound?: { kind: PopKind; pick: { id: string; title: string; ms: number } }; popOff?: { clip: string; off: boolean } }) => void;
  listen: (item: { id: string; preview: string }) => void;
  playing: string | undefined;
}) {
  const kinds = (["motion", "picture"] as const).filter((k) => found?.some((p) => p.kind === k));
  return (
    <div className="-mx-1 mb-3 min-h-0 flex-1 overflow-y-auto px-1" data-popins>
      {kinds.map((kind) => (
        <PopSound key={kind} kind={kind} pick={review.pops.sounds[kind]} host={host} choose={(pick) => set({ popSound: { kind, pick } })} listen={listen} playing={playing} />
      ))}
      {found?.map((p) => {
        const off = review.pops.off.includes(p.clip);
        return (
          <div key={p.clip} className="mb-1 flex items-center gap-2 rounded-md px-2 py-1 hover:bg-chip" data-popin={p.clip}>
            <Check checked={!off} onChange={(on) => set({ popOff: { clip: p.clip, off: !on } })} title={off ? "Give it a sound" : "Leave it without"} />
            <button className="min-w-0 flex-1 truncate text-left" title="Go to it" onClick={() => host.run("playhead.set", { time: p.time })}>
              <span className="mr-2 text-text-faint">{clock(p.time)}</span>
              <span className={off ? "text-text-faint" : "text-text-strong"}>{p.name}</span>
            </button>
            <span className="shrink-0 text-caption text-text-faint">{POP_TERMS[p.kind]}</span>
          </div>
        );
      })}
    </div>
  );
}

/** One kind's sound: the first found for its word, or one picked from a search. */
function PopSound({
  kind,
  pick,
  host,
  choose,
  listen,
  playing,
}: {
  kind: PopKind;
  pick: { id: string; title: string; ms: number } | undefined;
  host: Host;
  choose: (pick: { id: string; title: string; ms: number }) => void;
  listen: (item: { id: string; preview: string }) => void;
  playing: string | undefined;
}) {
  const [term, setTerm] = useState(POP_TERMS[kind]);
  const [found, setFound] = useState<SoundEffect[] | { error: string }>();
  const [open, setOpen] = useState(false);
  const search = async (words: string) => {
    try {
      const page = (await host.query("sfx.search", { term: words, first: 8 })) as MusicPage<SoundEffect>;
      setFound(page.items);
      return page.items;
    } catch (e) {
      setFound({ error: (e as Error).message });
      return [];
    }
  };
  useEffect(() => {
    void search(term).then((items) => !pick && items[0] && choose({ id: items[0].id, title: items[0].title, ms: items[0].ms }));
  }, []);
  const shown = Array.isArray(found) ? found.find((f) => f.id === pick?.id) : undefined;
  return (
    <div className="mb-3 rounded-md bg-groove px-3 py-2" data-pop-sound={kind}>
      <div className="mb-1 text-label text-text-muted">{KIND_LABEL[kind]}</div>
      {found && "error" in found ? (
        <div className="flex flex-col items-start gap-2" data-music-error>
          <span className="text-danger">{found.error.replace(/^no Epidemic/, "No Epidemic")}</span>
          {/key/.test(found.error) && <Button onClick={() => host.app("app.settings:ai")}>Open Settings…</Button>}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {shown && (
            <button className="shrink-0 rounded-full bg-control p-1.5 text-text-strong hover:bg-tile-hover" title={playing === shown.id ? "Stop" : "Listen"} onClick={() => listen(shown)}>
              <Icon name={playing === shown.id ? "pause" : "play"} size={12} filled />
            </button>
          )}
          <span className="min-w-0 flex-1 truncate text-text-strong" data-pop-pick>
            {pick ? pick.title : "Finding a sound…"}
          </span>
          <Button look="quiet" onClick={() => setOpen(!open)}>
            {open ? "Done" : "Change"}
          </Button>
        </div>
      )}
      {open && (
        <div className="mt-2">
          <form
            className="mb-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void search(term);
            }}
          >
            <TextInput className="flex-1" value={term} onChange={(e) => setTerm(e.target.value)} />
            <Button type="submit" title="Search Epidemic Sound">
              <Icon name="magnifying-glass" size={14} />
            </Button>
          </form>
          {Array.isArray(found) &&
            found.map((f) => (
              <div
                key={f.id}
                role="option"
                aria-selected={f.id === pick?.id}
                onClick={() => choose({ id: f.id, title: f.title, ms: f.ms })}
                className={`mb-1 flex cursor-default items-center gap-2 rounded-md px-2 py-1 ${f.id === pick?.id ? "bg-accent/20 ring-1 ring-accent" : "hover:bg-chip"}`}
                data-pop-option={f.id}
              >
                <button
                  className="shrink-0 rounded-full bg-control p-1 text-text-strong hover:bg-tile-hover"
                  title={playing === f.id ? "Stop" : "Listen"}
                  onClick={(e) => {
                    e.stopPropagation();
                    listen(f);
                  }}
                >
                  <Icon name={playing === f.id ? "pause" : "play"} size={12} filled />
                </button>
                <span className="min-w-0 flex-1 truncate">{f.title}</span>
                <span className="shrink-0 text-caption text-text-faint">{length(f.ms)}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
