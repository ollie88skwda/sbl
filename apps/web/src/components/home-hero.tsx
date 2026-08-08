import { lastPerformedByRoutine, suggestRoutineId } from "@frog/core";
import { ChevronRight, Play, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { formatDaysAgo, formatTime } from "@/lib/format";
import { useAllSessions } from "@/lib/profile-queries";
import { useActiveProgram } from "@/lib/program-queries";
import { useActiveSession } from "@/lib/queries";
import { useRepo } from "@/lib/repo";
import {
  useRoutineDetail,
  useRoutineFolders,
  useRoutines,
} from "@/lib/routine-queries";
import { useStartSession } from "@/lib/start-session";
import { cn } from "@/lib/utils";
import { useVoice } from "@/lib/voice";

// Home hero — "today's plan" (docs/DECISIONS.md 2026-07-30).
//
// Frog's premise is that the session is built *before* you walk into the gym,
// so Home's primary surface is not a Start button: it is the named plan you are
// about to run, its contents previewed, and one full-width tap to begin. What
// today *is* comes from `suggestRoutineId` in @frog/core — the same function
// the Trainer's next-workout card uses, so the two screens cannot disagree.
// Nothing is stored, so the suggestion can never drift from what you actually
// did.
//
// Picking a different plan is a horizontally-scrolling strip of the rest,
// directly under the CTA: one tap re-aims the hero (local state only — no
// server write for changing your mind), one more starts it.

const CTA_CLASS =
  "flex h-14 w-full items-center justify-center gap-2 text-base font-semibold transition-colors duration-150 ease-(--ease-out-quad) disabled:opacity-60";

const todayFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "short",
  day: "numeric",
});

/** Ref callback: centre the picked plan in the horizontal strip. `nearest` on
 *  the block axis so it never scrolls the page vertically. */
function scrollSelectedIntoView(el: HTMLButtonElement | null) {
  el?.scrollIntoView({ block: "nearest", inline: "center" });
}

function Shell({
  eyebrow,
  children,
  testId = "home-hero",
}: {
  eyebrow: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section
      className="mt-4 border border-border bg-surface"
      data-testid={testId}
    >
      <div className="flex items-baseline justify-between gap-3 border-b border-border bg-accent-soft px-4 py-2">
        <span className="truncate text-2xs font-medium tracking-widest text-accent uppercase">
          {eyebrow}
        </span>
        <span className="shrink-0 text-2xs text-faint">
          {todayFmt.format(Date.now())}
        </span>
      </div>
      {children}
    </section>
  );
}

export function HomeHero() {
  const navigate = useNavigate();
  const repo = useRepo();
  const { t } = useVoice();
  const { data: active } = useActiveSession();
  const { data: routines = [] } = useRoutines();
  const { data: folders = [] } = useRoutineFolders();
  const { data: program } = useActiveProgram();
  const { data: sessions = [] } = useAllSessions();
  const { start, starting, error } = useStartSession();
  // Overriding today's suggestion is a glance-and-go decision, not a setting:
  // it lives in component state and resets on reload back to the rotation.
  const [picked, setPicked] = useState<string | null>(null);
  const [startingRoutine, setStartingRoutine] = useState(false);

  const lastPerformed = useMemo(
    () => lastPerformedByRoutine(sessions),
    [sessions],
  );
  const suggestedId = useMemo(
    () => suggestRoutineId(routines, lastPerformed, program?.folderId),
    [routines, lastPerformed, program?.folderId],
  );

  const selectedId =
    picked && routines.some((r) => r.id === picked) ? picked : suggestedId;
  const selected = routines.find((r) => r.id === selectedId) ?? null;
  const { data: detail } = useRoutineDetail(active ? null : selectedId);

  // The program name only frames the hero while the suggestion actually came
  // from that program's rotation.
  const programFolder =
    program && selected?.folderId === program.folderId
      ? (folders.find((f) => f.id === program.folderId) ?? null)
      : null;

  async function startSelected() {
    if (!selected || startingRoutine) return;
    setStartingRoutine(true);
    try {
      const session = await repo.startRoutineSession(selected.id);
      navigate(`/session/${session.id}`);
    } finally {
      setStartingRoutine(false);
    }
  }

  // ── A live session outranks any plan: get back into it.
  if (active) {
    return (
      <Shell eyebrow={t("Session in progress", "The frog is watching")}>
        <div className="px-4 py-4">
          <h2 className="truncate text-2xl font-semibold tracking-tight">
            {active.title ?? "Workout"}
          </h2>
          <p className="num mt-1 text-2xs text-faint">
            started {formatTime(active.startedAt)}
          </p>
          <button
            type="button"
            className={cn(
              CTA_CLASS,
              "mt-4 bg-accent text-accent-fg hover:bg-accent-hover",
            )}
            onClick={() => navigate(`/session/${active.id}`)}
            data-testid="hero-resume-btn"
          >
            <Play className="size-5" /> Resume session
          </button>
        </div>
      </Shell>
    );
  }

  // ── Nothing pre-saved: the hero's job is to get one built.
  if (routines.length === 0) {
    return (
      <Shell eyebrow="Today's plan">
        <div className="px-4 py-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            {t("Nothing pre-built yet", "The lab bench is empty")}
          </h2>
          <p className="mt-2 text-sm text-soft">
            {t(
              "Frog works best when the session already exists before you walk in. Build a routine once, then start it in a tap.",
              "Build the session before you walk in. Then the frog only has to watch you do it.",
            )}
          </p>
          <button
            type="button"
            className={cn(
              CTA_CLASS,
              "mt-4 bg-accent text-accent-fg hover:bg-accent-hover",
            )}
            onClick={() => navigate("/routines/new")}
            data-testid="hero-build-btn"
          >
            <Plus className="size-5" /> Build a routine
          </button>
          <div className="mt-2 flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => navigate("/programs")}
            >
              Browse programs
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              disabled={starting}
              onClick={() => void start()}
              data-testid="home-start-btn"
            >
              {starting ? "Starting…" : "Empty session"}
            </Button>
          </div>
          {error && <p className="mt-2 text-xs text-neg">{error}</p>}
        </div>
      </Shell>
    );
  }

  const exercises = detail?.exercises ?? [];
  const setCount = exercises.reduce((n, e) => n + e.sets.length, 0);
  const lastAt = selected ? lastPerformed.get(selected.id) : undefined;
  const preview = exercises.slice(0, 4);
  const rest = exercises.length - preview.length;

  return (
    <Shell
      eyebrow={programFolder ? `Next in ${programFolder.name}` : "Today's plan"}
    >
      <div className="px-4 pt-4">
        <h2
          className="truncate text-2xl font-semibold tracking-tight"
          data-testid="hero-plan-name"
        >
          {selected?.name}
        </h2>
        <p className="num mt-1 flex flex-wrap gap-x-2 text-2xs text-faint">
          {exercises.length > 0 && (
            <>
              <span>
                {exercises.length} exercise{exercises.length === 1 ? "" : "s"}
              </span>
              <span>·</span>
              <span>{setCount} sets</span>
              <span>·</span>
            </>
          )}
          <span>
            {lastAt == null ? "never run" : `last ${formatDaysAgo(lastAt)}`}
          </span>
        </p>

        {/* Placeholder rows while the prescription loads: the hero is the top
            of the screen, so it must not grow under the reader's thumb. */}
        {detail === undefined && (
          <ul
            className="mt-3 flex flex-col gap-1.5 border-t border-border pt-3"
            aria-hidden
          >
            {[0, 1, 2].map((i) => (
              <li key={i} className="h-[18px] w-full bg-translucent" />
            ))}
          </ul>
        )}

        {/* The prescription itself — the point is that it already exists. */}
        {preview.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1.5 border-t border-border pt-3">
            {preview.map((e) => {
              const first = e.sets[0];
              const reps =
                first?.targetRepsMax != null
                  ? `${first.targetReps}–${first.targetRepsMax}`
                  : (first?.targetReps ?? null);
              return (
                <li
                  key={e.id}
                  className="flex items-baseline justify-between gap-3 text-xs"
                >
                  <span className="truncate text-soft">{e.exerciseName}</span>
                  <span className="num shrink-0 text-faint">
                    {e.sets.length}
                    {reps != null ? ` × ${reps}` : " sets"}
                  </span>
                </li>
              );
            })}
            {rest > 0 && (
              <li className="num text-2xs text-faint">+{rest} more</li>
            )}
          </ul>
        )}

        <button
          type="button"
          className={cn(
            CTA_CLASS,
            "mt-4 bg-accent text-accent-fg hover:bg-accent-hover",
          )}
          disabled={!selected || startingRoutine}
          onClick={() => void startSelected()}
          data-testid="home-start-btn"
        >
          <Play className="size-5 shrink-0" />
          <span className="truncate">
            {startingRoutine ? "Starting…" : `Start ${selected?.name ?? ""}`}
          </span>
        </button>
      </div>

      {/* Change your mind — every other pre-saved plan, one tap away. */}
      <div className="mt-4 border-t border-border px-4 py-3">
        <p className="text-2xs font-medium tracking-widest text-faint uppercase">
          Or run
        </p>
        <div className="-mx-4 mt-2 flex gap-2 overflow-x-auto px-4 pb-1">
          {routines.map((r) => {
            const at = lastPerformed.get(r.id);
            const isSelected = r.id === selectedId;
            return (
              <button
                key={r.id}
                type="button"
                // Keep the plan the hero is showing visible in the strip — with
                // a handful of routines the suggested one is otherwise off the
                // right edge of a phone, and the strip reads as "none picked".
                ref={isSelected ? scrollSelectedIntoView : undefined}
                onClick={() => setPicked(r.id)}
                aria-pressed={isSelected}
                data-testid={`hero-pick-${r.name}`}
                className={cn(
                  "w-36 shrink-0 border p-2 text-left transition-colors duration-150 ease-(--ease-out-quad)",
                  isSelected
                    ? "border-accent bg-accent-soft"
                    : "border-border bg-surface-2 hover:bg-surface-hover",
                )}
              >
                <span className="block truncate text-xs font-medium">
                  {r.name}
                </span>
                <span className="num block text-2xs text-faint">
                  {at == null ? "never run" : formatDaysAgo(at)}
                </span>
              </button>
            );
          })}
          <Link
            to="/routines/new"
            className="flex w-36 shrink-0 items-center gap-1 border border-dashed border-border bg-surface-2 p-2 text-xs text-soft transition-colors duration-150 ease-(--ease-out-quad) hover:bg-surface-hover"
            data-testid="hero-new-routine"
          >
            <Plus className="size-4" /> New routine
          </Link>
        </div>

        <div className="mt-2 flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={starting}
            onClick={() => void start()}
            data-testid="hero-empty-btn"
          >
            {starting ? "Starting…" : "Empty session"}
          </Button>
          <Link
            to="/routines"
            className="flex items-center gap-0.5 px-1 text-2xs text-faint transition-colors duration-150 hover:text-ink"
          >
            All routines <ChevronRight className="size-3" />
          </Link>
        </div>
        {error && <p className="mt-2 text-xs text-neg">{error}</p>}
      </div>
    </Shell>
  );
}
