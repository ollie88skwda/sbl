import {
  buildSessionCard,
  countSets,
  type ExerciseType,
  groupSetsBySetNo,
  type NewRoutineInput,
  type SessionExerciseDetail,
  type SetType,
  toDisplayWeight,
  unitLabel,
} from "@frog/core";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, ListPlus, Share2, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { PostSaveSummary } from "@/components/post-save-summary";
import { SessionPhotoCarousel } from "@/components/session-photos";
import { ShareSheet } from "@/components/share-sheet";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/format";
import { useAllSessions, useUserPrefs } from "@/lib/profile-queries";
import {
  useExercises,
  useMetrics,
  useSession,
  useSessionExercises,
  useUpdateSessionStartedAt,
} from "@/lib/queries";
import { useRepo } from "@/lib/repo";
import { effortReadout } from "@/lib/rir";
import { useCreateRoutine } from "@/lib/routine-queries";
import { useUnit } from "@/lib/settings";
import { sessionConditionsLine } from "@/lib/share/conditions";
import { ordinalFor } from "@/lib/share/ordinal";
import { useLatestBodyweightQuery, useMuscleMap } from "@/lib/stats-queries";
import { useVoice } from "@/lib/voice";
import type { SeedSet } from "./session";

/** Average rest (mm:ss) across a block's sets, or null if none recorded. */
function avgRestLabel(sets: { restSec: number | null }[]): string | null {
  const rests = sets
    .map((s) => s.restSec)
    .filter((r): r is number => r != null && r > 0);
  if (!rests.length) return null;
  const total = Math.round(rests.reduce((a, b) => a + b, 0) / rests.length);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/** ms epoch → "YYYY-MM-DDTHH:mm" in local time for a datetime-local input. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The share card's data — the whole session list (for the "Experiment #N"
 * ordinal), the exercise catalog and the latest bodyweight — is only ever read
 * once the sheet is open, so it hangs off this component rather than the
 * screen: opening history detail must not pull a whole-table session fetch. */
function ShareWorkoutSheet({
  sessionId,
  title,
  startedAt,
  durationMs,
  conditionValues,
  blocks,
  onClose,
}: {
  sessionId: string;
  title: string;
  startedAt: number;
  durationMs: number;
  /** The session row's `condition_values` — feeds the card's lab-report
   * conditions strip; the screen already holds the session, so it passes the
   * map rather than re-fetching it here. */
  conditionValues: Record<string, unknown>;
  blocks: SessionExerciseDetail[];
  onClose: () => void;
}) {
  const { unit } = useUnit();
  const { data: exercises = [], isPending: exercisesPending } = useExercises();
  const { data: allSessions = [], isPending: sessionsPending } =
    useAllSessions();
  const { data: prefs, isPending: prefsPending } = useUserPrefs();
  const { data: bodyweightKg = null, isPending: bodyweightPending } =
    useLatestBodyweightQuery();
  const { data: metrics = [], isPending: metricsPending } = useMetrics();
  const muscleMap = useMuscleMap();

  const exerciseTypeById = useMemo(
    () => new Map(exercises.map((e) => [e.id, e.exerciseType as ExerciseType])),
    [exercises],
  );
  const shareBlocks = useMemo(
    () =>
      blocks.map((b) => ({
        exerciseId: b.exerciseId,
        exerciseName: b.exerciseName,
        exerciseType: exerciseTypeById.get(b.exerciseId) ?? "weight_reps",
        sets: b.sets,
      })),
    [blocks, exerciseTypeById],
  );
  const ordinal = ordinalFor(allSessions, sessionId, startedAt);
  // The card's lab-report conditions strip — the same display line as the
  // in-session chip (one formatter, lib/share/conditions.ts), or null when
  // the session recorded nothing (the strip never renders empty).
  const conditionsLine = useMemo(
    () =>
      sessionConditionsLine(
        conditionValues,
        metrics.filter((m) => m.scope === "session"),
      ),
    [conditionValues, metrics],
  );
  const buildShareCard = useMemo(
    () => (heroSet?: Parameters<typeof buildSessionCard>[0]["heroSet"]) =>
      buildSessionCard({
        ordinal,
        title: title || "Workout",
        date: formatDate(startedAt),
        durationMs,
        blocks: shareBlocks,
        muscles: muscleMap,
        bodyweightKg,
        unit,
        identity: { displayName: prefs?.displayName ?? null },
        heroSet,
        includeWarmups: prefs?.includeWarmupsInStats ?? true,
        conditionsLine,
      }),
    [
      ordinal,
      title,
      startedAt,
      durationMs,
      shareBlocks,
      muscleMap,
      bodyweightKg,
      unit,
      prefs,
      conditionsLine,
    ],
  );
  // Stable object identity, not an inline literal — an unmemoized `source`
  // would give ShareSheet a new object every render, defeating its own
  // internal memoization (share-sheet.tsx).
  const shareSource = useMemo(
    () => ({
      kind: "session" as const,
      blocks: shareBlocks,
      build: buildShareCard,
    }),
    [shareBlocks, buildShareCard],
  );

  // Every one of these feeds a value the card states as fact — the ordinal,
  // per-exercise volume, the identity handle, the conditions strip. Painting
  // before they land would render (and, once the export blob resolves, let the
  // user share) a card saying "Experiment #1" with a missing volume. Hold the
  // card, not the truth.
  if (
    exercisesPending ||
    sessionsPending ||
    prefsPending ||
    bodyweightPending ||
    metricsPending
  )
    return (
      <button
        type="button"
        onClick={onClose}
        className="fixed inset-0 z-50 flex items-center justify-center bg-bg text-xs text-faint"
        data-testid="share-sheet-loading"
      >
        Building your card…
      </button>
    );

  return (
    <ShareSheet
      source={shareSource}
      sessionId={sessionId}
      filename={`workout-${sessionId.slice(0, 8)}`}
      onClose={onClose}
    />
  );
}

function ShareWorkoutButton(
  props: Omit<Parameters<typeof ShareWorkoutSheet>[0], "onClose">,
) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        title="Share as image"
        data-testid="history-share-btn"
      >
        <Share2 className="size-4" />
      </Button>
      {open && <ShareWorkoutSheet {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

export default function HistoryDetailScreen() {
  const { id = "" } = useParams();
  const { t } = useVoice();
  const { unit } = useUnit();
  const repo = useRepo();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [savingRoutine, setSavingRoutine] = useState(false);
  const [routineName, setRoutineName] = useState("");
  const [copying, setCopying] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const showSummary = searchParams.get("summary") === "1";
  const { data: session } = useSession(id);
  const { data: blocks = [] } = useSessionExercises(id);
  const { data: metrics = [] } = useMetrics();
  const updateStartedAt = useUpdateSessionStartedAt(id);
  const createRoutine = useCreateRoutine();

  async function deleteSession() {
    await repo.deleteSession(id);
    void qc.invalidateQueries({ queryKey: ["sessions"] });
    void qc.invalidateQueries({ queryKey: ["findings-data"] });
    void qc.invalidateQueries({ queryKey: ["active-session"] });
    void qc.invalidateQueries({ queryKey: ["recent-exercise-ids"] });
    navigate("/history");
  }

  // Save as routine: turn this session's logged sets into a reusable template
  // (logged values become the targets; supersets/rest/notes carried over).
  function saveAsRoutine() {
    const input: NewRoutineInput = {
      name: routineName.trim() || session?.title || "New routine",
      exercises: blocks.map((b, i) => ({
        exerciseId: b.exerciseId,
        orderIndex: i,
        supersetGroup: b.supersetGroup,
        restSec: b.restSec,
        note: b.note,
        // One routine set per *physical* set — a unilateral pair is two rows
        // sharing one set_no, and the left row is the target's template.
        sets: groupSetsBySetNo(b.sets).map(([s], si) => ({
          setNo: si,
          setType: s.setType,
          targetWeightKg: s.weightKg,
          targetReps: s.reps,
          targetRepsMax: null,
          targetDurationSec: s.durationSec,
          targetDistanceM: s.distanceM,
        })),
      })),
    };
    createRoutine.mutate(input);
    setSavingRoutine(false);
    navigate("/routines");
  }

  // Copy workout: start a fresh session with the same exercises and seed each
  // draft grid from this session's sets (passed via navigation state).
  async function copyWorkout() {
    if (copying) return;
    setCopying(true);
    try {
      const s = await repo.startSession(session?.title ?? undefined);
      const seed: Record<string, SeedSet[]> = {};
      for (const b of blocks) {
        const seId = await repo.addExerciseToSession(s.id, b.exerciseId);
        // One draft row per physical set — the copied grid must ask for the
        // same number of sets the source session actually performed.
        seed[seId] = groupSetsBySetNo(b.sets).map(([x]) => ({
          setType: (x.setType as SetType) ?? "normal",
          weightKg: x.weightKg,
          reps: x.reps,
          repsMax: null,
          durationSec: x.durationSec,
          distanceM: x.distanceM,
        }));
      }
      void qc.invalidateQueries({ queryKey: ["active-session"] });
      navigate(`/session/${s.id}`, { state: { seed } });
    } catch {
      setCopying(false);
    }
  }

  const conditions = session?.conditionValues ?? {};
  const conditionLines = metrics
    .filter(
      (m) =>
        m.scope === "session" &&
        conditions[m.id] != null &&
        conditions[m.id] !== "",
    )
    .map((m) => `${m.name}: ${conditions[m.id]}`);

  // Share card for this workout — same Session card type as the post-save
  // summary's hero slide (report §6 step 6: "history-detail → Session").
  const durationMs =
    session?.endedAt != null
      ? Math.max(
          0,
          session.endedAt - session.startedAt - (session.pausedMs ?? 0),
        )
      : 0;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 pb-20 md:pb-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          to="/history"
          className="flex items-center gap-1 text-xs text-soft transition-colors duration-100 hover:text-ink"
        >
          <ArrowLeft className="size-4" />
          History
        </Link>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRoutineName(session?.title ?? "");
              setSavingRoutine(true);
            }}
            disabled={blocks.length === 0}
            data-testid="save-as-routine-btn"
          >
            <ListPlus className="size-4" />
            Save as routine
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copyWorkout()}
            disabled={blocks.length === 0 || copying}
            data-testid="copy-workout-btn"
          >
            <Copy className="size-4" />
            {copying ? "Copying…" : "Copy workout"}
          </Button>
          {blocks.length > 0 && session && (
            <ShareWorkoutButton
              sessionId={id}
              title={session.title ?? ""}
              startedAt={session.startedAt}
              durationMs={durationMs}
              conditionValues={session.conditionValues ?? {}}
              blocks={blocks}
            />
          )}
          <Button
            variant="danger"
            size="sm"
            onClick={() => setConfirming(true)}
            data-testid="delete-session-btn"
          >
            <Trash2 className="size-4" />
            Delete
          </Button>
        </div>
      </div>
      <Dialog open={savingRoutine} onOpenChange={setSavingRoutine}>
        <DialogContent title="Save as routine">
          <p className="text-xs text-soft">
            {t(
              "This workout's logged sets become the routine's targets. You can tweak it later in the builder.",
              "This workout's logged sets become the routine's targets. You can tweak it later in the builder. The frog approves of repeatable experiments.",
            )}
          </p>
          <Input
            placeholder="Routine name"
            value={routineName}
            onChange={(e) => setRoutineName(e.target.value)}
            autoFocus
            className="mt-3"
            data-testid="routine-name-input"
            onKeyDown={(e) => {
              if (e.key === "Enter" && blocks.length > 0) saveAsRoutine();
            }}
          />
          <div className="mt-3 flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSavingRoutine(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={saveAsRoutine}
              disabled={blocks.length === 0}
              data-testid="save-as-routine-confirm"
            >
              <ListPlus className="size-4" />
              Create routine
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent title="Delete this session?">
          <p className="text-xs text-soft">
            {t(
              "The session and its sets disappear from history and findings. (Soft-deleted — nothing is destroyed.)",
              "The session and its sets disappear from history and findings. Soft-deleted — nothing is destroyed. The frog does not throw away data.",
            )}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => void deleteSession()}
              data-testid="confirm-delete-session-btn"
            >
              Delete session
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <h1 className="mt-2 text-lg font-semibold tracking-tight">
        {session?.title ?? "Session"}
      </h1>
      {session && (
        <input
          type="datetime-local"
          className="num mt-0.5 block bg-transparent text-xs text-faint transition-colors duration-100 hover:text-soft focus:text-ink focus:outline-none"
          value={toLocalInput(session.startedAt)}
          onChange={(e) => {
            const ms = new Date(e.target.value).getTime();
            if (Number.isFinite(ms)) updateStartedAt.mutate(ms);
          }}
          title="Session start — edit to backdate"
          data-testid="session-date-input"
        />
      )}
      {conditionLines.length > 0 && (
        <p className="num mt-2 text-xs text-soft">
          {conditionLines.join(" · ")}
        </p>
      )}

      <SessionPhotoCarousel sessionId={id} />

      <div className="mt-5 flex flex-col gap-4">
        {blocks.map((block) => (
          <section
            key={block.id}
            className="overflow-hidden rounded-lg border border-border bg-surface"
          >
            <header className="flex items-center justify-between border-b border-border px-4 py-2">
              <h2 className="text-sm font-medium">{block.exerciseName}</h2>
              <span className="num text-2xs text-faint">
                {countSets(block.sets)}{" "}
                {countSets(block.sets) === 1 ? "set" : "sets"}
                {avgRestLabel(block.sets) &&
                  ` · rest ${avgRestLabel(block.sets)} avg`}
              </span>
            </header>
            <div className="grid grid-cols-[2rem_1fr_1fr_2.5rem] items-center gap-x-2 px-4 py-1 text-2xs font-medium tracking-wide text-faint uppercase">
              <span>#</span>
              <span>{unitLabel(unit)}</span>
              <span>reps</span>
              <span />
            </div>
            {block.sets.map((set) => (
              <div
                key={set.id}
                className="grid grid-cols-[2rem_1fr_1fr_2.5rem] items-center gap-x-2 border-t border-border px-4 py-2"
              >
                <span className="num text-xs text-faint">
                  {set.setNo + 1}
                  {set.side === "left" ? "ᴸ" : set.side === "right" ? "ᴿ" : ""}
                </span>
                <span className="num text-sm">
                  {set.weightKg != null
                    ? toDisplayWeight(set.weightKg, unit)
                    : "—"}
                </span>
                <span className="num text-sm">{set.reps ?? "—"}</span>
                <span className="num text-2xs text-faint">
                  {effortReadout(set)}
                </span>
              </div>
            ))}
            {block.sets.length === 0 && (
              <p className="border-t border-border px-4 py-3 text-center text-xs text-faint">
                {t(
                  "No sets logged.",
                  "No sets logged. The frog refuses to speculate.",
                )}
              </p>
            )}
          </section>
        ))}
      </div>

      {showSummary && (
        <PostSaveSummary
          sessionId={id}
          onDismiss={() => setSearchParams({}, { replace: true })}
        />
      )}
    </div>
  );
}
