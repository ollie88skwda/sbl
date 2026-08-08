import {
  checkSetForPR,
  computeRecords,
  countSets,
  type Exercise,
  type ExercisePatch,
  type ExercisePref,
  type ExerciseRecords,
  type ExerciseType,
  e1rmFromEffort,
  formatPrevious,
  formatWeight,
  type GhostSet,
  ghostFor,
  groupByPrimaryMuscle,
  groupSetsBySetNo,
  isBarLoaded,
  isConfidentMatch,
  kgToLb,
  kmToM,
  LATERALITY,
  LATERALITY_EXPLAINERS,
  LATERALITY_LABELS,
  type Laterality,
  type LoggedSet,
  lbToKg,
  type Machine,
  type MatchCandidate,
  type Metric,
  matchExerciseName,
  miToM,
  type NewRoutineInput,
  newId,
  type ParsedSetUtterance,
  type PlateConfig,
  type PrType,
  parseSetUtterance,
  previousCells,
  type RestTimerState,
  type RoutineDetail,
  SET_TYPE_MARKERS,
  type Session,
  type SetType,
  shouldStartRest,
  startRest,
  supportsEffort,
  type Tier,
  TYPE_FIELDS,
  toDisplayDistance,
  toDisplayWeight,
  unitLabel,
  warmupSets,
  weightLabel,
} from "@frog/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Calculator,
  Check,
  ChevronDown,
  Flame,
  History,
  Link2,
  Medal,
  Mic,
  MoreVertical,
  NotebookPen,
  Pause,
  Play,
  Plus,
  Search,
  Settings2,
  Square,
  StickyNote,
  Timer,
  Trash2,
  Unlink,
  Wrench,
} from "lucide-react";
import {
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { ExerciseRibbon, ExerciseThumb } from "@/components/anatomy-ui";
import { MachineAttachDialog } from "@/components/attach-machine";
import { ConditionsChip } from "@/components/conditions";
import { ExerciseEditor } from "@/components/exercise-editor";
import {
  ExerciseFilterBar,
  filterExercises,
} from "@/components/exercise-filter";
import { InfoTip } from "@/components/lesson";
import { MachineEditor } from "@/components/machines";
import { PlateSheet } from "@/components/session/plate-sheet";
import { PrBanner, type PrBannerData } from "@/components/session/pr-banner";
import { RestDock } from "@/components/session/rest-countdown";
import { RestTimerIcon } from "@/components/session/rest-timer-icon";
import {
  FinishPhotoStrip,
  type PendingPhoto,
} from "@/components/session-photos";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Dots } from "@/components/ui/dots";
import { Field } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { markerColorClass, SetTypeCell } from "@/components/ui/set-type-cell";
import { StatusRing } from "@/components/ui/status-ring";
import { Toolbar } from "@/components/ui/toolbar";
import { formatDurationSeconds, formatMMSS, parseDuration } from "@/lib/format";
import type { LessonId } from "@/lib/lessons";
import { usePendingExercises } from "@/lib/pending-exercises";
import { useUpdateUserPrefs, useUserPrefs } from "@/lib/profile-queries";
import {
  copyExerciseOpts,
  useCreateExercise,
  useDeleteExercise,
  useExercisePrefs,
  useExercises,
  useGhost,
  useLastNote,
  useLastSets,
  useMachines,
  useMetrics,
  useSession,
  useSessionExercises,
  useSetExerciseWeightUnit,
  useUpdateExercise,
} from "@/lib/queries";
import { useRepo } from "@/lib/repo";
import {
  effortReadout,
  parseLoggedRirFields,
  rirEditFields,
  rirRange,
} from "@/lib/rir";
import { useRoutineDetail } from "@/lib/routine-queries";
import {
  clearDraft,
  type DraftSnapshot,
  loadDraft,
  saveDraft,
} from "@/lib/session-draft";
import {
  type DistanceUnit,
  distanceUnitFor,
  type Unit,
  useUnit,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useVoice, voice } from "@/lib/voice";
import { getWarmupMethod } from "@/lib/warmup-method";
import {
  useKeepAwake,
  useLivePrBanner,
  useSmartSupersetScroll,
} from "@/lib/workout-prefs";

type BlockState = {
  seId: string;
  exerciseId: string;
  name: string;
  // The exercise the PREVIOUS/last-note lookups key on. Set by the
  // copy-on-write swap (a seed exercise cloned into a private custom copy)
  // so a fresh copy's empty history doesn't blank the reference column
  // mid-session; null = the block has never been swapped.
  ghostExerciseId?: string;
  // Provenance from a routine-started session (null = ad-hoc / empty workout).
  routineExerciseId: string | null;
  // Superset grouping (int id shared by members; null = solo). Per-exercise
  // session note (distinct from the routine template note).
  supersetGroup: number | null;
  note: string | null;
  committed: LoggedSet[];
};

// Context an ExerciseBlock hands up on set completion, so the screen can run the
// PR check + rest-timer + smart-scroll without re-deriving per-block facts.
type CommitCtx = {
  exerciseType: ExerciseType;
  // Planned type of the set that will follow (routine seed at the next index),
  // used for drop-set rest suppression.
  nextSetType: string | null;
};

// Four accent-tinted left-border colors keyed to a superset group's slot, so
// grouped exercises read as one unit (accent-monochrome: lightness steps of
// the accent, not separate hues).
const SUPERSET_COLORS = [
  "var(--accent)",
  "color-mix(in oklab, var(--accent) 62%, var(--surface))",
  "color-mix(in oklab, var(--accent) 88%, black)",
  "color-mix(in oklab, var(--accent) 40%, var(--surface))",
];

type CommitInput = Omit<LoggedSet, "id" | "setNo" | "restSec"> & {
  metricValues?: Record<string, unknown> | null;
  restSec?: number | null;
  /** Present only for a unilateral pair: the right side's own values,
   * written as a second row sharing this commit's set_no. Set type, RIR/RPE,
   * note and metrics seed the right row from the left side at commit — one
   * entry for the symmetric case. Only set type stays shared afterwards (its
   * ᴸ control writes both rows); post-commit RIR/RPE/note are per-limb, each
   * row's details sheet editing its own. */
  otherSide?: {
    weightKg: number | null;
    reps: number | null;
    durationSec: number | null;
    distanceM: number | null;
  } | null;
};

export type SetPatch = {
  weightKg?: number | null;
  reps?: number | null;
  durationSec?: number | null;
  distanceM?: number | null;
  rir?: number | null;
  rirMin?: number | null;
  rirMax?: number | null;
  rpe?: number | null;
  note?: string | null;
  setType?: SetType;
};

// Per-set-index seed for the draft row: routine targets (weights/reps/rep-range
// placeholder) OR the source sets when copying a workout. Both pre-populate the
// active row; the draft grid is seeded per index as the user advances.
export type SeedSet = {
  setType: SetType;
  weightKg: number | null;
  reps: number | null;
  repsMax: number | null; // non-null ⇒ rep range (placeholder only, never seeded as a value)
  durationSec: number | null;
  distanceM: number | null;
};

// mm:ss for a rest duration in whole seconds.
function formatRest(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = String(totalSec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

// ms epoch → "YYYY-MM-DDTHH:mm" (local) for a datetime-local input.
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Which logging columns an exercise type shows, left→right. Weight first, then
// distance, time, reps — the natural order for every type (e.g. WEIGHT | REPS,
// DISTANCE | TIME, WEIGHT | DISTANCE). See TYPE_FIELDS in @frog/core.
type ColKey = "weight" | "reps" | "duration" | "distance";
type Column = { key: ColKey; header: string };

function columnsFor(
  type: ExerciseType,
  unit: Unit,
  distUnit: DistanceUnit,
  laterality?: string | null,
): Column[] {
  const f = TYPE_FIELDS[type];
  const cols: Column[] = [];
  if (f.weight)
    cols.push({ key: "weight", header: weightLabel(type, unitLabel(unit)) });
  if (f.distance) cols.push({ key: "distance", header: distUnit });
  if (f.duration) cols.push({ key: "duration", header: "time" });
  // Unilateral: the ᴸ/ᴿ line markers already say "per side", so the header
  // stays "reps". Alternating logs as one row whose reps are a total across
  // both sides (L-R-L-R within the set) — the header says so since there's
  // no per-line marker to carry that meaning.
  if (f.reps)
    cols.push({
      key: "reps",
      header: laterality === "alternating" ? "total reps" : "reps",
    });
  return cols;
}

// `2.5rem` set-number + optional PREVIOUS reference + one flexible column each +
// a FIXED `2.5rem` commit track + a FIXED `2.5rem` menu-gutter track — the one
// column template shared by the column-header row, every committed row, the
// active row and the upcoming rows, so every value column stays a straight line
// regardless of type. The commit track carries the draft row's ⋯; the
// menu-gutter carries its "Mark set done" button (note 2: the check sits at the
// far right, right of the ⋯), so the draft's ✓ lands at the same x as every
// committed row's ⋯; committed/upcoming rows leave the commit track empty.
// The gutter is fixed, not auto: the RIR/RPE modifier readout lives as a badge
// OUT of the grid flow (see CommittedRow/ActiveRow), so no row content can
// ever widen the track and nudge its siblings. PREVIOUS only claims space when
// there's prior/target data to show (blank column suppressed for a brand-new
// exercise).
function gridTemplate(cols: Column[], showPrevious: boolean): string {
  const prev = showPrevious ? "3.5rem " : "";
  return `2.5rem ${prev}${cols.map(() => "1fr").join(" ")} 2.5rem 2.5rem`;
}

// Compact previous-performance string for the PREVIOUS column: weight sans unit
// (the weight column header already carries it) — "100 × 8", "1:30" for time.
function previousText(g: GhostSet, unit: Unit): string | null {
  return formatPrevious(g, (kg) => String(toDisplayWeight(kg, unit)));
}

// Nothing usable came back from the mic — either no speech at all or a
// transcript the parser couldn't read as a set.
function micUnheard(): string {
  return voice("Didn't catch that.", "Didn't catch that — try again?");
}

// SpeechRecognition error codes → honest copy. Recognition is server-backed in
// Chrome, so a dropped connection or a blocked service is an outage, not a
// mishearing: telling the user they weren't heard would invite an endless retry.
function micErrorMessage(error: string): string {
  if (error === "not-allowed")
    return voice(
      "Microphone blocked — allow mic access in your browser settings.",
      "Microphone blocked — the frog needs mic access in your browser settings.",
    );
  if (
    error === "network" ||
    error === "audio-capture" ||
    error === "service-not-allowed"
  )
    return voice(
      "Voice recognition unavailable — try again in a moment.",
      "Voice recognition unavailable — the frog's line dropped. Try again in a moment.",
    );
  return micUnheard();
}

// The stored per-exercise weight-unit override, null when unset or unreadable.
function weightUnitOverrideFor(
  prefs: ExercisePref[],
  exerciseId: string | null,
): Unit | null {
  const override = prefs.find((p) => p.exerciseId === exerciseId)?.weightUnit;
  return override === "kg" || override === "lb" ? override : null;
}

// A block's display weight unit: that override, else the session unit. One
// copy — the block's grid and the voice round-trip both read it, and a
// display↔kg conversion that disagreed would silently shift weights.
function blockUnitFor(
  prefs: ExercisePref[],
  exerciseId: string | null,
  sessionUnit: Unit,
): Unit {
  return weightUnitOverrideFor(prefs, exerciseId) ?? sessionUnit;
}

export default function SessionScreen() {
  const { id: sessionId = "" } = useParams();
  const repo = useRepo();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { unit } = useUnit();
  const { t } = useVoice();
  const sessionQuery = useSession(sessionId);
  const session = sessionQuery.data;
  // Until the row itself is in hand, routineId is unknown — the seed gate
  // below can't tell a routine start from an ad-hoc workout. Presence, not
  // isLoading: a query in `error` status reports isLoading false even while
  // the error branch's Retry is refetching it, and it stays false if the
  // session load failed outright — either way the gate would fall through
  // with routineId still unknown.
  const sessionLoaded = session !== undefined;
  const {
    data: restored,
    isError: restoredError,
    refetch: refetchRestored,
  } = useSessionExercises(sessionId);
  const { data: metrics = [] } = useMetrics();
  // Routine provenance: template targets + notes for prefill / write-back.
  const routineQuery = useRoutineDetail(session?.routineId ?? null);
  const routineDetail = routineQuery.data ?? null;
  // Presence, not isLoading (same rule as the session row above): an errored
  // query reports isLoading false, so it can't hold the gate while the error
  // branch's Retry refetches it. Only consulted for routine-started sessions
  // (the query is disabled otherwise), and false once the routine resolves —
  // even to null (deleted routine) or to a definitive error — so blocks
  // always eventually seed rather than hanging on the loading branch.
  const routineLoading =
    routineQuery.isFetching ||
    (routineQuery.data === undefined && !routineQuery.isError);

  const [blocks, setBlocks] = useState<BlockState[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  // Copy-workout seed passed via navigation state ({ [seId]: SeedSet[] }) —
  // pre-fills the draft grid from a source session's sets. Read once.
  const copySeed = (location.state as { seed?: Record<string, SeedSet[]> })
    ?.seed;
  // Inline duration stopwatch: at most one runs across the whole session. Holds
  // the timing block + its start; ActiveRow ticks and writes elapsed on stop.
  const [timer, setTimer] = useState<{
    seId: string;
    startedAt: number;
  } | null>(null);
  const toggleTimer = useCallback(
    (seId: string) =>
      setTimer((t) =>
        t?.seId === seId ? null : { seId, startedAt: Date.now() },
      ),
    [],
  );
  // Rest is measured per exercise: the timestamp of the last set committed in
  // each block (keyed by seId). Rest between sets of one exercise is the signal
  // a future recommendation wants — switching exercises must not count as rest.
  const [lastCommitByBlock, setLastCommitByBlock] = useState<
    Record<string, number>
  >({});
  // For the live header stopwatch: time since the most recent set anywhere.
  const lastCommitAt = useMemo(() => {
    const vals = Object.values(lastCommitByBlock);
    return vals.length ? Math.max(...vals) : null;
  }, [lastCommitByBlock]);

  const { data: exercises = [] } = useExercises();
  const pendingExercises = usePendingExercises();

  // Device prefs (localStorage) + server prefs (plate config).
  const [smartScroll] = useSmartSupersetScroll();
  const [livePrEnabled] = useLivePrBanner();
  const [keepAwake] = useKeepAwake();
  const { data: userPrefs } = useUserPrefs();
  const { data: exercisePrefs = [] } = useExercisePrefs();
  const updatePrefs = useUpdateUserPrefs();
  const plateConfig = userPrefs?.plateConfig ?? null;
  // PREVIOUS-column scope: "routine" narrows the ghost lookup to same-routine
  // sessions (only meaningful for a routine-started workout); else any workout.
  const previousRoutineId =
    userPrefs?.previousValuesScope === "routine"
      ? (session?.routineId ?? null)
      : null;

  // Keep the screen awake during an active session (opt-in; default off). The
  // Wake Lock auto-drops when the tab hides, so re-acquire on re-show.
  useEffect(() => {
    if (!keepAwake || session?.endedAt != null) return;
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        sentinel = await navigator.wakeLock.request("screen");
      } catch {
        // Denied, or the document isn't visible — ignore.
      }
    };
    const onVisible = () => {
      if (!cancelled && document.visibilityState === "visible") void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release();
      sentinel = null;
    };
  }, [keepAwake, session?.endedAt]);

  // Per-block rest stopwatch (keyed by seId; absent = none running).
  const [restByBlock, setRestByBlock] = useState<
    Record<string, RestTimerState>
  >({});
  const dismissRest = useCallback((seId: string) => {
    setRestByBlock((prev) => {
      if (!(seId in prev)) return prev;
      const next = { ...prev };
      delete next[seId];
      return next;
    });
  }, []);

  // The dock shows the most recently started stopwatch — the set you just
  // finished. Only a superset sibling of that block can still be running
  // alongside it (every commit prunes the rest); it takes the dock as it
  // frees up. Blocks removed mid-rest are skipped rather than blanking the
  // dock, so a still-running sibling keeps its Stop affordance.
  const activeRest = useMemo(() => {
    let latest: { seId: string; state: RestTimerState; name: string } | null =
      null;
    for (const [seId, state] of Object.entries(restByBlock)) {
      const name = blocks?.find((b) => b.seId === seId)?.name;
      if (!name) continue;
      if (!latest || state.startedAt > latest.state.startedAt) {
        latest = { seId, state, name };
      }
    }
    return latest;
  }, [restByBlock, blocks]);

  // Live PR banner + medal set. Bests snapshot captured once at mount, so the
  // logging path never triggers a records refetch (logSet invalidates
  // records-data; we read a plain, non-observing copy).
  const [prBanner, setPrBanner] = useState<PrBannerData | null>(null);
  const prIdRef = useRef(0);
  const [prSetIds, setPrSetIds] = useState<Set<string>>(new Set());
  // Optimistic set id → real server id. The committed row keeps its optimistic
  // id as its React key for the whole session (never swapped), so a background
  // logSet resolving mid-interaction never remounts the row (which would close
  // an open set menu); edit/delete translate to the real id here.
  const [idMap, setIdMap] = useState<Record<string, string>>({});
  const [prSnapshot, setPrSnapshot] = useState<Map<
    string,
    ExerciseRecords
  > | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Prefer a warm records cache (M5) to avoid any fetch; else fetch once.
      const cached = (qc.getQueryData(["records-data", true]) ??
        qc.getQueryData(["records-data", false])) as
        | { records?: { byExercise?: Map<string, ExerciseRecords> } }
        | undefined;
      if (cached?.records?.byExercise) {
        setPrSnapshot(cached.records.byExercise);
        return;
      }
      const history = await repo.recordsData();
      if (!cancelled) setPrSnapshot(computeRecords(history).byExercise);
    })();
    return () => {
      cancelled = true;
    };
  }, [qc, repo]);

  // Warm-up insert prepends typed 'warmup' seeds to a block's draft grid; the
  // nonce forces the active row to remount and pick up the new seed.
  const [seedOverride, setSeedOverride] = useState<Record<string, SeedSet[]>>(
    {},
  );
  const [blockNonce, setBlockNonce] = useState<Record<string, number>>({});

  // Pause: paused time accrues into pausedMs; duration = ended − started − paused.
  const [paused, setPaused] = useState(false);
  const [pausedMs, setPausedMs] = useState(0);
  const [pauseStartedAt, setPauseStartedAt] = useState<number | null>(null);
  const pausedSeeded = useRef(false);
  useEffect(() => {
    if (!pausedSeeded.current && session) {
      pausedSeeded.current = true;
      setPausedMs(session.pausedMs ?? 0);
    }
  }, [session]);
  const togglePause = useCallback(() => {
    setPaused((p) => {
      if (p) {
        setPausedMs(
          (ms) =>
            ms + (pauseStartedAt != null ? Date.now() - pauseStartedAt : 0),
        );
        setPauseStartedAt(null);
        return false;
      }
      setPauseStartedAt(Date.now());
      return true;
    });
  }, [pauseStartedAt]);
  const currentPausedMs = () =>
    pausedMs +
    (paused && pauseStartedAt != null ? Date.now() - pauseStartedAt : 0);

  // Block DOM refs for smart-superset scrolling.
  const blockRefs = useRef<Map<string, HTMLElement>>(new Map());
  const registerBlockRef = useCallback(
    (seId: string, el: HTMLElement | null) => {
      if (el) blockRefs.current.set(seId, el);
      else blockRefs.current.delete(seId);
    },
    [],
  );

  // ActiveRow handles, keyed by block — the voice mic's target for applying a
  // parsed weight/reps without going through onCommit.
  const rowHandles = useRef<Map<string, ActiveRowHandle>>(new Map());
  const registerRowHandle = useCallback(
    (seId: string, handle: ActiveRowHandle | null) => {
      if (handle) rowHandles.current.set(seId, handle);
      else rowHandles.current.delete(seId);
    },
    [],
  );

  // Voice logging: speak a full utterance ("bench press 135 lbs for 8 reps")
  // to fill the matching block's active row — parse → fuzzy-match against
  // this session's own blocks → apply to that row's local state. Never
  // auto-commits; Enter / Add set stays the explicit trigger. Feature-detect,
  // don't render a dead control: iOS Safari support is inconsistent, Firefox
  // has none, and the API requires a secure context.
  const speechSupported =
    typeof window !== "undefined" &&
    window.isSecureContext &&
    (window.SpeechRecognition != null ||
      window.webkitSpeechRecognition != null);
  const [listening, setListening] = useState(false);
  const [micMessage, setMicMessage] = useState<string | null>(null);
  // Parsed utterance awaiting a manual block pick (no confident match, or a tie
  // between blocks) — kept unconverted because the effective unit depends on
  // the picked block. `candidates` narrows the list when the tie names it.
  const [voicePicker, setVoicePicker] = useState<{
    parsed: ParsedSetUtterance;
    candidates: MatchCandidate[];
  } | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const micMessageTimer = useRef<number | null>(null);

  // Live snapshot for the speech handlers: onresult fires seconds after
  // startListening ran, by which time the blocks, the session unit, or the
  // per-exercise unit overrides may all have moved on.
  const voiceCtx = useRef({ blocks, unit, exercisePrefs });
  useEffect(() => {
    voiceCtx.current = { blocks, unit, exercisePrefs };
  });

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      if (micMessageTimer.current != null)
        window.clearTimeout(micMessageTimer.current);
    };
  }, []);

  function showMicMessage(message: string) {
    setMicMessage(message);
    if (micMessageTimer.current != null)
      window.clearTimeout(micMessageTimer.current);
    micMessageTimer.current = window.setTimeout(() => {
      micMessageTimer.current = null;
      setMicMessage(null);
    }, 2500);
  }

  // Effective unit for a spoken weight: spoken unit word > the target block's
  // per-exercise unit override (same lookup ExerciseBlock uses) > session unit.
  function voiceWeightKg(
    parsed: ParsedSetUtterance,
    exerciseId: string | null,
  ): number | null {
    if (parsed.weightDisplay == null) return null;
    const { unit: sessionUnit, exercisePrefs: prefs } = voiceCtx.current;
    const effectiveUnit = parsed.unitExplicit
      ? parsed.unit
      : blockUnitFor(prefs, exerciseId, sessionUnit);
    return effectiveUnit === "lb"
      ? lbToKg(parsed.weightDisplay)
      : parsed.weightDisplay;
  }

  function applyVoiceToBlock(seId: string, parsed: ParsedSetUtterance) {
    const block = (voiceCtx.current.blocks ?? []).find((b) => b.seId === seId);
    // False when the row's type has no field the utterance could fill (a weight
    // against a bodyweight row, anything against a duration row) — say so
    // rather than scrolling to a block that silently stayed empty.
    const applied =
      rowHandles.current.get(seId)?.applyVoice({
        weightKg: voiceWeightKg(parsed, block?.exerciseId ?? null),
        reps: parsed.reps,
      }) ?? false;
    blockRefs.current
      .get(seId)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (!applied)
      showMicMessage(
        `${block?.name ?? "That exercise"}: ${voice(
          "nothing there to fill.",
          "nothing there to fill — wrong shape of set.",
        )}`,
      );
  }

  function handleVoiceResult(transcript: string) {
    const { blocks: liveBlocks, unit: liveUnit } = voiceCtx.current;
    const parsed = parseSetUtterance(transcript, liveUnit);
    if (!parsed) {
      showMicMessage(micUnheard());
      return;
    }
    const candidates = (liveBlocks ?? []).map((b) => ({
      id: b.seId,
      name: b.name,
    }));
    const match = matchExerciseName(parsed.name, candidates);
    if (!match || !isConfidentMatch(match)) {
      setVoicePicker({ parsed, candidates });
      return;
    }
    // Equally good blocks (the same exercise logged twice for back-off work,
    // say) — filling the first one silently would fill the wrong one half the
    // time, so ask, scoped to the blocks that actually tied.
    if (match.tied.length > 1) {
      setVoicePicker({ parsed, candidates: match.tied });
      return;
    }
    applyVoiceToBlock(match.id, parsed);
  }

  function startListening() {
    // The ref, not `listening`: state only flips on the next render, so two
    // clicks in one batch would otherwise both build a recognition and the
    // second one's throw would orphan the first, still-recording instance.
    if (recognitionRef.current) return;
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    const reset = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognition.onresult = (e) => {
      handleVoiceResult(e.results[0]?.[0]?.transcript ?? "");
    };
    recognition.onerror = (e) => {
      reset();
      showMicMessage(micErrorMessage(e.error));
    };
    recognition.onnomatch = () => {
      reset();
      showMicMessage(micUnheard());
    };
    recognition.onend = reset;
    recognitionRef.current = recognition;
    setMicMessage(null);
    setListening(true);
    // start() throws synchronously when a recognition is already running, and
    // on some WebKit builds for permission/policy failures. Without this the
    // button would stay stuck in its active state with no live recognition
    // behind it, and stop() on a never-started instance can't unstick it.
    try {
      recognition.start();
    } catch {
      reset();
      showMicMessage(
        voice("Couldn't start the mic.", "Couldn't start the mic — try again?"),
      );
    }
  }

  function stopListening() {
    recognitionRef.current?.stop();
  }

  // Distinct superset groups in block order → color slot (index % 4).
  const supersetSlot = useMemo(() => {
    const m = new Map<number, number>();
    for (const b of blocks ?? []) {
      if (b.supersetGroup != null && !m.has(b.supersetGroup))
        m.set(b.supersetGroup, m.size % SUPERSET_COLORS.length);
    }
    return m;
  }, [blocks]);

  // Routine template lookup, keyed by routine_exercise id (provenance match).
  const routineByReId = useMemo(() => {
    const m = new Map<string, RoutineDetail["exercises"][number]>();
    for (const e of routineDetail?.exercises ?? []) m.set(e.id, e);
    return m;
  }, [routineDetail]);

  // Seed local block state once from the server (restores an open session on reload).
  // For routine-started sessions, wait for the template too: ActiveRow reads its
  // per-index seed once at mount, so the blocks must not mount before the
  // targets are available or the draft grid comes up blank.
  useEffect(() => {
    if (blocks !== null || !restored) return;
    // The two queries race: when session_exercises lands first, session is
    // still undefined and `session?.routineId` reads as "ad-hoc", skipping the
    // routine wait below and mounting the grid unseeded — permanently, since
    // blocks seed once. Wait for the session row before deciding.
    if (!sessionLoaded) return;
    if (session?.routineId && routineLoading) return;
    setBlocks(
      restored.map((se) => ({
        seId: se.id,
        exerciseId: se.exerciseId,
        name: se.exerciseName,
        routineExerciseId: se.routineExerciseId,
        supersetGroup: se.supersetGroup,
        note: se.note,
        committed: se.sets,
      })),
    );
  }, [restored, blocks, sessionLoaded, session?.routineId, routineLoading]);

  // Auto-open the exercise picker once when a session loads with no blocks —
  // but let it be dismissed (Escape/X). Not `open={blocks.length === 0}`, which
  // would force it open and block the header (conditions, End).
  const autoOpenedPicker = useRef(false);
  useEffect(() => {
    if (!autoOpenedPicker.current && blocks !== null && blocks.length === 0) {
      autoOpenedPicker.current = true;
      setPicking(true);
    }
  }, [blocks]);

  // Every set write that hasn't landed yet, keyed by tempId so an entry
  // clears without touching any other one. `failed` flips once the write
  // exhausts its retries (app.tsx: mutations retry 3x) and never persisted —
  // the optimistic row is still on screen looking saved, which is exactly the
  // silent-data-loss shape from the 2026-08-06 outage — and only those are
  // reported. Entries are registered when the write is dispatched, not when
  // it fails: the retries take ~7s, and an edit or delete inside that window
  // has to reach the queued payload too (see saveSet/removeSet/removeBlock)
  // or a later failure would queue the pre-edit values, or a deleted row.
  const [queuedSets, setQueuedSets] = useState<
    Record<
      string,
      {
        seId: string;
        set: CommitInput;
        tempId: string;
        setNo: number;
        failed: boolean;
      }
    >
  >({});

  const logSet = useMutation({
    mutationFn: (input: {
      seId: string;
      set: CommitInput;
      tempId: string;
      setNo: number;
    }) => repo.logSet(input.seId, input.set, input.tempId, input.setNo),
    // Record the optimistic→real id mapping (edit/delete translate through it).
    // The committed row keeps its optimistic id, so it never remounts here.
    onSuccess: (realId, { tempId }) => {
      setIdMap((prev) => ({ ...prev, [tempId]: realId }));
      setQueuedSets((prev) => {
        if (!(tempId in prev)) return prev;
        const next = { ...prev };
        delete next[tempId];
        return next;
      });
    },
    // Only ever marks an entry that is still queued: a set removed while its
    // write was in flight has no entry left, and must not come back here.
    onError: (_err, { tempId }) => {
      setQueuedSets((prev) => {
        const queued = prev[tempId];
        if (!queued || queued.failed) return prev;
        return { ...prev, [tempId]: { ...queued, failed: true } };
      });
    },
    // A new set can mint a PR — mark the records snapshot stale (no observer is
    // mounted mid-session, so this never refetches on the logging path).
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["records-data"] });
      void qc.invalidateQueries({ queryKey: ["recent-exercise-ids"] });
    },
  });

  // Track the payload from the moment it is dispatched, so the reconciliation
  // below covers the whole in-flight window and not just exhausted writes.
  function queueSet(v: {
    seId: string;
    set: CommitInput;
    tempId: string;
    setNo: number;
  }) {
    setQueuedSets((prev) => ({ ...prev, [v.tempId]: { ...v, failed: false } }));
  }

  const failedSets = Object.values(queuedSets).filter((v) => v.failed);
  const failedSetCount = failedSets.length;
  // The entry stays failed until its write actually lands (onSuccess clears
  // it), so the banner keeps telling the truth while a retry is in flight.
  function retryFailedSets() {
    for (const { seId, set, tempId, setNo } of failedSets)
      logSet.mutate({ seId, set, tempId, setNo });
  }
  // A queued payload must never outlive the row it describes: editing or
  // deleting a set that never persisted has to reach its retry entry too,
  // or Retry writes stale values / resurrects a deleted row.
  function dropQueuedSets(
    match: (tempId: string, v: (typeof queuedSets)[string]) => boolean,
  ) {
    setQueuedSets((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([id, v]) => !match(id, v)),
      );
      return Object.keys(next).length === Object.keys(prev).length
        ? prev
        : next;
    });
  }

  async function pickExercise(exerciseId: string, name: string) {
    // Its row exists locally but not yet in Postgres — the FK would reject it.
    if (pendingExercises.has(exerciseId)) return;
    setPicking(false);
    const seId = await repo.addExerciseToSession(sessionId, exerciseId);
    setBlocks((prev) => [
      ...(prev ?? []),
      {
        seId,
        exerciseId,
        name,
        routineExerciseId: null,
        supersetGroup: null,
        note: null,
        committed: [],
      },
    ]);
  }

  function commitSet(seId: string, set: CommitInput, ctx: CommitCtx) {
    // Optimistic: the row is already correct locally; persist in the background.
    // Rest time = seconds since the previous set of THIS exercise (null for its
    // first set) — a per-exercise rest gap, not a session-wide one.
    const prevAt = lastCommitByBlock[seId];
    const restSec =
      prevAt != null ? Math.round((Date.now() - prevAt) / 1000) : null;
    const block = (blocks ?? []).find((b) => b.seId === seId);
    // One number for both the optimistic row and the write, so a retry can't
    // re-derive a different one. High-water mark rather than a count: removing
    // a set leaves a gap (the row is only soft-deleted server-side), and
    // reusing its number would collide with a live row. A unilateral pair
    // shares this one set_no across its two rows.
    const setNo = (block?.committed ?? []).reduce(
      (next, s) => Math.max(next, s.setNo + 1),
      0,
    );
    const leftTempId = newId();
    const { otherSide, ...leftFields } = set;
    const leftRow = { ...leftFields, restSec, id: leftTempId, setNo };
    // The right side writes rest_sec: null — one commit per physical set means
    // one rest stopwatch (below), and the header average already filters nulls.
    // Set type / RIR / RPE / note / metrics seed from the left side at commit,
    // so the symmetric case is one entry. Only set type stays shared after
    // that — post-commit RIR/RPE/note are per-limb, edited from each row's own
    // details sheet and surfaced on that row's line when they diverge.
    const rightTempId = otherSide ? newId() : null;
    const rightRow =
      otherSide && rightTempId
        ? {
            weightKg: otherSide.weightKg,
            reps: otherSide.reps,
            durationSec: otherSide.durationSec,
            distanceM: otherSide.distanceM,
            setType: set.setType,
            rir: set.rir,
            rirMin: set.rirMin,
            rirMax: set.rirMax,
            rpe: set.rpe,
            note: set.note,
            metricValues: set.metricValues,
            side: "right" as const,
            restSec: null,
            id: rightTempId,
            setNo,
          }
        : null;
    setBlocks((prev) =>
      (prev ?? []).map((b) =>
        b.seId === seId
          ? {
              ...b,
              committed: [
                ...b.committed,
                leftRow,
                ...(rightRow ? [rightRow] : []),
              ],
            }
          : b,
      ),
    );
    setLastCommitByBlock((prev) => ({ ...prev, [seId]: Date.now() }));
    const leftWrite = { seId, set: leftRow, tempId: leftTempId, setNo };
    queueSet(leftWrite);
    logSet.mutate(leftWrite);
    if (rightRow) {
      const rightWrite = { seId, set: rightRow, tempId: rightRow.id, setNo };
      queueSet(rightWrite);
      logSet.mutate(rightWrite);
    }
    // The uncommitted row is now saved server-side — drop its local draft.
    clearDraft(seId);

    // Live PR check against the mount-time bests snapshot (session-scoped types
    // finalize at save; only set-scoped ones fire live) — once per side row,
    // since either side of a unilateral pair can PR independently.
    if (block && prSnapshot) {
      const rows = rightRow ? [leftRow, rightRow] : [leftRow];
      const hitTypes = new Set<PrType>();
      for (const row of rows) {
        const hits = checkSetForPR(
          prSnapshot.get(block.exerciseId),
          ctx.exerciseType,
          {
            setType: row.setType ?? "normal",
            weightKg: row.weightKg,
            reps: row.reps,
            durationSec: row.durationSec,
            distanceM: row.distanceM,
            setNo: row.setNo,
            side: row.side ?? null,
          },
        );
        if (hits.length) {
          for (const h of hits) hitTypes.add(h.prType);
          setPrSetIds((prev) => new Set(prev).add(row.id));
        }
      }
      // The banner is opt-out (default on); the row medal always pins.
      if (hitTypes.size && livePrEnabled) {
        prIdRef.current += 1;
        setPrBanner({
          id: prIdRef.current,
          exerciseName: block.name,
          prTypes: [...hitTypes],
        });
      }
    }

    // Rest stopwatch: every commit prunes, then starts. Only a superset
    // sibling of the committing block survives the prune — inside a group you
    // alternate between members, so both are genuinely resting; moving to any
    // other exercise (two solo blocks are not siblings) ends the old one, so
    // Stop can never resurface a timer you left behind. The start is then
    // suppressed when a drop set is next — including the just-committed set
    // being a drop (drops chain into the next reduction with no rest) — when
    // the just-committed set was a warm-up, or on duration/distance-type
    // exercises where "resting between sets" isn't meaningful.
    const committedIsDrop = (set.setType ?? "normal") === "drop";
    const nextType = committedIsDrop ? "drop" : ctx.nextSetType;
    const group = block?.supersetGroup ?? null;
    const siblings = new Set(
      group == null
        ? []
        : (blocks ?? [])
            .filter((b) => b.supersetGroup === group)
            .map((b) => b.seId),
    );
    const starting = shouldStartRest(nextType, set.setType, ctx.exerciseType);
    const startedAt = Date.now();
    setRestByBlock((prev) => {
      const next: Record<string, RestTimerState> = {};
      for (const [id, state] of Object.entries(prev)) {
        if (id !== seId && siblings.has(id)) next[id] = state;
      }
      if (starting) next[seId] = startRest(startedAt);
      return next;
    });

    // Smart superset scrolling: advance the view to the next member (wrapping).
    if (smartScroll && block?.supersetGroup != null) {
      const members = (blocks ?? []).filter(
        (b) => b.supersetGroup === block.supersetGroup,
      );
      const idx = members.findIndex((b) => b.seId === seId);
      const next = members[(idx + 1) % members.length];
      if (next && next.seId !== seId)
        blockRefs.current
          .get(next.seId)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  // Per-exercise session note: instant local update + background persist.
  function setBlockNote(seId: string, note: string) {
    setBlocks((prev) =>
      (prev ?? []).map((b) => (b.seId === seId ? { ...b, note } : b)),
    );
    void repo.updateSessionExercise(seId, { note: note.trim() || null });
  }

  const nextGroupId = () => {
    const ids = (blocks ?? [])
      .map((b) => b.supersetGroup)
      .filter((g): g is number => g != null);
    return ids.length ? Math.max(...ids) + 1 : 1;
  };

  // Link a block into a superset with another block: adopt the target's group
  // (or the source's, or a fresh id). 2 members = superset; 3+ = giant set.
  function linkSuperset(seId: string, targetSeId: string) {
    const list = blocks ?? [];
    const target = list.find((b) => b.seId === targetSeId);
    const source = list.find((b) => b.seId === seId);
    if (!target || !source) return;
    const group = target.supersetGroup ?? source.supersetGroup ?? nextGroupId();
    const ids = new Set([seId, targetSeId]);
    setBlocks((prev) =>
      (prev ?? []).map((b) =>
        ids.has(b.seId) ? { ...b, supersetGroup: group } : b,
      ),
    );
    for (const id of ids)
      void repo.updateSessionExercise(id, { supersetGroup: group });
  }

  // Remove a block from its superset; if that leaves a lone member, dissolve it.
  function unlinkSuperset(seId: string) {
    const list = blocks ?? [];
    const group = list.find((b) => b.seId === seId)?.supersetGroup ?? null;
    const toClear = new Set<string>([seId]);
    if (group != null) {
      const remaining = list.filter(
        (b) => b.supersetGroup === group && b.seId !== seId,
      );
      if (remaining.length === 1) toClear.add(remaining[0].seId);
    }
    setBlocks((prev) =>
      (prev ?? []).map((b) =>
        toClear.has(b.seId) ? { ...b, supersetGroup: null } : b,
      ),
    );
    for (const id of toClear)
      void repo.updateSessionExercise(id, { supersetGroup: null });
  }

  // Warm-up insert: prepend typed 'warmup' seeds (percentage ramp of the target
  // working weight) above the block's working sets.
  function addWarmup(seId: string, workingWeightKg: number) {
    const block = (blocks ?? []).find((b) => b.seId === seId);
    if (!block) return;
    const ex = exercises.find((e) => e.id === block.exerciseId);
    const sets = warmupSets(
      workingWeightKg,
      getWarmupMethod(),
      undefined,
      ex?.equipment,
    );
    if (!sets.length) return;
    const warmSeeds: SeedSet[] = sets.map((s) => ({
      setType: "warmup",
      weightKg: s.weightKg,
      reps: s.reps,
      repsMax: null,
      durationSec: null,
      distanceM: null,
    }));
    const base = seedOverride[seId] ?? seedFor(block);
    setSeedOverride((prev) => ({ ...prev, [seId]: [...warmSeeds, ...base] }));
    setBlockNonce((prev) => ({ ...prev, [seId]: (prev[seId] ?? 0) + 1 }));
  }

  function saveSet(seId: string, setId: string, patch: SetPatch) {
    setBlocks((prev) =>
      (prev ?? []).map((b) =>
        b.seId === seId
          ? {
              ...b,
              committed: b.committed.map((s) =>
                s.id === setId ? { ...s, ...patch } : s,
              ),
            }
          : b,
      ),
    );
    // A row whose write hasn't landed has no server row for updateSet to match
    // (0 rows, no error) — its queued payload is the only thing a retry will
    // write, so the edit has to land there too or Retry rewrites stale values.
    setQueuedSets((prev) => {
      const queued = prev[setId];
      if (!queued) return prev;
      return {
        ...prev,
        [setId]: { ...queued, set: { ...queued.set, ...patch } },
      };
    });
    // setId is the row's stable (optimistic) id — translate to the real server
    // id if logSet has resolved (else the optimistic id already equals it).
    void repo.updateSet(idMap[setId] ?? setId, patch);
  }

  function removeSet(seId: string, setId: string) {
    setBlocks((prev) =>
      (prev ?? []).map((b) =>
        b.seId === seId
          ? { ...b, committed: b.committed.filter((s) => s.id !== setId) }
          : b,
      ),
    );
    dropQueuedSets((id) => id === setId);
    void repo.deleteSet(idMap[setId] ?? setId).then(
      () => {
        void qc.invalidateQueries({ queryKey: ["recent-exercise-ids"] });
      },
      () => {},
    );
  }

  function removeBlock(seId: string) {
    setBlocks((prev) => (prev ?? []).filter((b) => b.seId !== seId));
    dismissRest(seId);
    dropQueuedSets((_id, v) => v.seId === seId);
    void repo.deleteSessionExercise(seId).then(
      () => {
        void qc.invalidateQueries({ queryKey: ["recent-exercise-ids"] });
      },
      () => {},
    );
  }

  // Repoint a block at a different exercise row (copy-on-write: a seed
  // exercise is RLS-read-only, so an in-session laterality/machine edit is
  // applied to a private custom copy and the block follows it). `ghostId`
  // pins the PREVIOUS/last-note lookups to the original exercise, so the
  // copy's empty history doesn't blank the reference column mid-session.
  function swapBlockExercise(
    seId: string,
    exerciseId: string,
    ghostExerciseId: string,
  ) {
    setBlocks((prev) =>
      (prev ?? []).map((b) =>
        b.seId === seId ? { ...b, exerciseId, ghostExerciseId } : b,
      ),
    );
  }

  // Per-block seed sets for the draft grid: routine targets (matched by
  // routine_exercise id) win; otherwise the copy-workout seed; otherwise none.
  const seedFor = useCallback(
    (block: BlockState): SeedSet[] => {
      if (block.routineExerciseId) {
        const t = routineByReId.get(block.routineExerciseId);
        if (t)
          return t.sets.map((s) => ({
            setType: (s.setType as SetType) ?? "normal",
            weightKg: s.targetWeightKg,
            reps: s.targetReps,
            repsMax: s.targetRepsMax,
            durationSec: s.targetDurationSec,
            distanceM: s.targetDistanceM,
          }));
      }
      return copySeed?.[block.seId] ?? [];
    },
    [routineByReId, copySeed],
  );

  const noteFor = useCallback(
    (block: BlockState): string | null =>
      block.routineExerciseId
        ? (routineByReId.get(block.routineExerciseId)?.note ?? null)
        : null,
    [routineByReId],
  );

  // Structural drift vs the routine template — gates the Update-Routine /
  // Keep-Original prompt: an added ad-hoc exercise, a template exercise dropped
  // from the session, or extra sets logged beyond the template. Logging *fewer*
  // sets than planned (an early stop) is not structural.
  const structuralChange = useMemo(() => {
    if (!session?.routineId || !routineDetail || !blocks) return false;
    if (blocks.some((b) => !b.routineExerciseId)) return true;
    const present = new Set(
      blocks.map((b) => b.routineExerciseId).filter(Boolean),
    );
    if (routineDetail.exercises.some((e) => !present.has(e.id))) return true;
    for (const b of blocks) {
      if (!b.routineExerciseId) continue;
      const t = routineByReId.get(b.routineExerciseId);
      if (t && countSets(b.committed) > t.sets.length) return true;
    }
    return false;
  }, [session?.routineId, routineDetail, blocks, routineByReId]);

  // NewRoutineInput describing the performed structure (Update Routine choice).
  function structureInput(): NewRoutineInput | null {
    if (!routineDetail || !blocks) return null;
    return {
      name: routineDetail.routine.name,
      folderId: routineDetail.routine.folderId,
      description: routineDetail.routine.description,
      exercises: blocks.map((b, i) => {
        const t = b.routineExerciseId
          ? routineByReId.get(b.routineExerciseId)
          : undefined;
        return {
          exerciseId: b.exerciseId,
          orderIndex: i,
          supersetGroup: t?.supersetGroup ?? null,
          restSec: t?.restSec ?? null,
          note: t?.note ?? null,
          // One routine set per *physical* set: a unilateral pair is two
          // committed rows sharing one set_no, and the left row is the
          // template for the target.
          sets: groupSetsBySetNo(b.committed).map(([s], si) => ({
            setNo: si,
            setType: (s.setType as string) ?? "normal",
            targetWeightKg: s.weightKg,
            targetReps: s.reps,
            targetRepsMax: null,
            targetDurationSec: s.durationSec,
            targetDistanceM: s.distanceM,
            // Performed sets carry no RIR prescription — updateRoutine
            // re-creates the set graph, so the authored range has to come
            // from the template or it's erased.
            targetRirMin: t?.sets[si]?.targetRirMin ?? null,
            targetRirMax: t?.sets[si]?.targetRirMax ?? null,
          })),
        };
      }),
    };
  }

  async function handleFinish(opts: {
    title: string;
    notes: string;
    startedAt: number;
    updateValues: boolean;
    updateStructure: boolean;
  }) {
    const routineId = session?.routineId;
    // 1) Update Routine Values (weights/reps write-back; rep-range sets skipped
    //    by the repo). Independent of the structural choice (Hevy rule).
    if (routineId && opts.updateValues && blocks) {
      const performed = blocks
        .filter((b) => b.routineExerciseId)
        .map((b) => ({
          routineExerciseId: b.routineExerciseId as string,
          // One target per physical set (see structureInput) — mapping rows
          // positionally would shift every target after a unilateral pair.
          sets: groupSetsBySetNo(b.committed).map(([s], i) => ({
            setNo: i,
            weightKg: s.weightKg,
            reps: s.reps,
            durationSec: s.durationSec,
            distanceM: s.distanceM,
          })),
        }));
      await repo.updateRoutineValues(routineId, performed);
    }
    // 2) Structural write-back (only when chosen).
    if (routineId && opts.updateStructure) {
      const input = structureInput();
      if (input) await repo.updateRoutine(routineId, input);
    }
    // 3) Title, notes, start-time, and accumulated pause (all via repo methods).
    if ((opts.title.trim() || null) !== (session?.title ?? null))
      await repo.updateSessionTitle(sessionId, opts.title.trim() || null);
    if (opts.notes !== (session?.notes ?? ""))
      await repo.updateSessionNotes(sessionId, opts.notes.trim() || null);
    if (session && opts.startedAt !== session.startedAt)
      await repo.updateSessionStartedAt(sessionId, opts.startedAt);
    const finalPausedMs = currentPausedMs();
    if (finalPausedMs !== (session?.pausedMs ?? 0))
      await repo.updateSessionPausedMs(sessionId, finalPausedMs);
    // 4) Close out the session; clear any lingering per-block drafts.
    await repo.endSession(sessionId);
    for (const b of blocks ?? []) clearDraft(b.seId);
    // Reflect the edited fields in the detail cache so /history/:id shows them
    // without a refetch.
    const now = Date.now();
    qc.setQueryData<Session | null>(["session", sessionId], (old) =>
      old
        ? {
            ...old,
            title: opts.title.trim() || old.title,
            notes: opts.notes.trim() || null,
            startedAt: opts.startedAt,
            endedAt: now,
          }
        : old,
    );
    void qc.invalidateQueries({ queryKey: ["active-session"] });
    void qc.invalidateQueries({ queryKey: ["sessions"] });
    // Profile/Calendar/Home streak + activity bars read this key — refresh so a
    // finished workout shows without waiting out the 60s stale window (M6).
    void qc.invalidateQueries({ queryKey: ["sessions-all"] });
    void qc.invalidateQueries({ queryKey: ["findings-data"] });
    // Records/charts (M5) read a cached snapshot — refresh it on finish rather
    // than waiting out the stale window.
    void qc.invalidateQueries({ queryKey: ["records-data"] });
    // The session grid logs to local state and never writes back to the
    // session-exercises query; refetch so /history/:id shows the real graph
    // (its staleTime is Infinity, so it would otherwise serve the stale load).
    void qc.invalidateQueries({ queryKey: ["session-exercises", sessionId] });
    if (routineId)
      void qc.invalidateQueries({ queryKey: ["routine-detail", routineId] });
    // ?summary=1 triggers the post-save celebration overlay on history detail.
    navigate(`/history/${sessionId}?summary=1`);
  }

  async function handleDiscard() {
    for (const b of blocks ?? []) clearDraft(b.seId);
    await repo.deleteSession(sessionId);
    void qc.invalidateQueries({ queryKey: ["active-session"] });
    void qc.invalidateQueries({ queryKey: ["sessions"] });
    void qc.invalidateQueries({ queryKey: ["findings-data"] });
    void qc.invalidateQueries({ queryKey: ["recent-exercise-ids"] });
    navigate("/");
  }

  // blocks stays null until the seed effect above runs, which never happens
  // if either query it depends on failed (a 400 from a schema-drifted
  // column, a dropped connection, ...) — without this branch that reads as
  // an unconditional blank screen, indistinguishable from "still loading".
  if (blocks === null) {
    if (sessionQuery.isError || restoredError) {
      return (
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-3 px-4 py-16 text-center">
          <p className="text-sm text-neg" data-testid="session-error">
            {t(
              "Couldn't reach the server. This session may still be there.",
              "The frog couldn't reach the pond. This session may still be there.",
            )}
          </p>
          <Button
            variant="outline"
            onClick={() => {
              void sessionQuery.refetch();
              void refetchRestored();
              // The routine template gates the seed too: leaving it errored
              // seeds every row with no targets, notes or prefill.
              if (session?.routineId) void routineQuery.refetch();
            }}
            data-testid="session-retry"
          >
            Retry
          </Button>
        </div>
      );
    }
    return (
      <p
        className="px-4 py-16 text-center text-xs text-faint"
        data-testid="session-loading"
      >
        {t("Loading…", "The frog is thinking…")}
      </p>
    );
  }

  const setCount = blocks.reduce((n, b) => n + countSets(b.committed), 0);
  const volumeKg = blocks.reduce(
    (sum, b) =>
      sum +
      b.committed.reduce((s, x) => s + (x.weightKg ?? 0) * (x.reps ?? 0), 0),
    0,
  );
  const volume = Math.round(unit === "lb" ? kgToLb(volumeKg) : volumeKg);
  const restValues = blocks.flatMap((b) =>
    b.committed
      .map((s) => s.restSec)
      .filter((r): r is number => r != null && r > 0),
  );
  const avgRestSec = restValues.length
    ? Math.round(restValues.reduce((a, b) => a + b, 0) / restValues.length)
    : null;

  return (
    <>
      <PrBanner data={prBanner} onDismiss={() => setPrBanner(null)} />
      {failedSetCount > 0 && (
        <div
          className={cn(
            "pointer-events-none fixed inset-x-0 z-30 flex justify-center px-4",
            // PrBanner owns top-28 (and auto-dismisses after 4s); sit below it
            // while both are up rather than painting over it.
            prBanner ? "top-44" : "top-28",
          )}
          role="status"
          data-testid="set-sync-error"
        >
          <div className="pointer-events-auto flex max-w-md items-center gap-2 border border-neg bg-(--color-panel-solid) px-3 py-2 shadow-(--shadow-6)">
            <span className="min-w-0 text-xs text-neg">
              {t(
                `${failedSetCount} set${failedSetCount === 1 ? "" : "s"} didn't save — couldn't reach the server.`,
                `The frog dropped ${failedSetCount} set${failedSetCount === 1 ? "" : "s"} — couldn't reach the pond.`,
              )}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={retryFailedSets}
              disabled={logSet.isPending}
              data-testid="set-sync-retry"
            >
              {logSet.isPending ? "Retrying…" : "Retry"}
            </Button>
          </div>
        </div>
      )}
      {activeRest && (
        <RestDock
          since={activeRest.state.startedAt}
          exerciseName={activeRest.name}
          onStop={() => dismissRest(activeRest.seId)}
          testId={`rest-${activeRest.name}`}
        />
      )}
      <header className="sticky top-0 z-10 border-b border-border bg-bg">
        {/* Title row: title + finish + mic only — everything else (duration,
            time-since-last-set) lives in the subheader row below so the title
            keeps its full width instead of wrapping around header metadata. */}
        <div className="mx-auto flex h-14 max-w-2xl items-center justify-between gap-3 px-4">
          <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">
            {session?.title ?? "Session"}
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            {speechSupported && (
              <span className="relative flex items-center">
                <Button
                  variant={listening ? "primary" : "outline"}
                  size="icon-lg"
                  onClick={listening ? stopListening : startListening}
                  title={listening ? "Stop listening" : "Log a set by voice"}
                  aria-pressed={listening}
                  data-testid="voice-log-mic"
                >
                  <Mic className="size-4" />
                </Button>
                {/* Always mounted: a live region that enters the DOM with its
                    text already in it is routinely missed by screen readers. */}
                <span
                  role="status"
                  className={cn(
                    "absolute top-full right-0 z-20 mt-1 whitespace-nowrap text-2xs text-faint",
                    micMessage && "floating px-2 py-1",
                  )}
                >
                  {micMessage}
                </span>
              </span>
            )}
            <Button
              size="lg"
              onClick={() => setFinishOpen(true)}
              title="Finish session"
              data-testid="end-session-btn"
            >
              <Square className="size-3" />
              Finish
            </Button>
          </div>
        </div>
        <div className="mx-auto flex max-w-2xl items-center gap-2 border-t border-border px-4 py-1.5">
          {session && (
            <SessionDurationControl
              startedAt={session.startedAt}
              endedAt={session.endedAt}
              paused={paused}
              pausedMs={pausedMs}
              pauseStartedAt={pauseStartedAt}
              onTogglePause={togglePause}
              onEditStart={(ms) => {
                void repo.updateSessionStartedAt(sessionId, ms);
                qc.setQueryData<Session | null>(
                  ["session", sessionId],
                  (old) => (old ? { ...old, startedAt: ms } : old),
                );
              }}
            />
          )}
          <RestTimer since={lastCommitAt} />
          {/* Routines stays reachable mid-workout: the shell's Training tab
              jumps to this session while one is live, so /routines (and from
              it /routines/new) would otherwise be unreachable until you
              finish. The session stays server-persisted, so this is safe to
              leave. */}
          <Button
            variant="ghost"
            size="lg"
            className="ml-auto"
            onClick={() => navigate("/routines")}
            data-testid="session-routines-btn"
          >
            <NotebookPen className="size-4" />
            Routines
          </Button>
        </div>
      </header>

      {/* Mobile keeps the shell's tab-bar padding (already clears the dock);
          desktop has none, so it makes room only while the dock is up. */}
      <div
        className={cn(
          "mx-auto max-w-2xl px-4 pt-4 pb-20",
          activeRest ? "md:pb-28" : "md:pb-6",
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <ConditionsChip sessionId={sessionId} />
          </div>
          <p
            className="num shrink-0 text-xs text-faint"
            data-testid="session-stats"
          >
            {setCount} {setCount === 1 ? "set" : "sets"} ·{" "}
            {volume.toLocaleString()} {unitLabel(unit)}
            {avgRestSec != null && ` · rest ${formatRest(avgRestSec)} avg`}
          </p>
        </div>

        <div className="mt-4 flex flex-col gap-4">
          {blocks.map((block) => (
            <ExerciseBlock
              key={block.seId}
              block={block}
              unit={unit}
              metrics={metrics}
              previousRoutineId={previousRoutineId}
              seedSets={seedOverride[block.seId] ?? seedFor(block)}
              seedNonce={blockNonce[block.seId] ?? 0}
              routineNote={noteFor(block)}
              supersetColor={
                block.supersetGroup != null
                  ? SUPERSET_COLORS[supersetSlot.get(block.supersetGroup) ?? 0]
                  : null
              }
              otherBlocks={blocks
                .filter((b) => b.seId !== block.seId)
                .map((b) => ({ seId: b.seId, name: b.name }))}
              inSuperset={block.supersetGroup != null}
              plateConfig={plateConfig}
              onSavePlateConfig={(cfg) =>
                updatePrefs.mutate({ plateConfig: cfg })
              }
              restRunning={restByBlock[block.seId] != null}
              onStopRest={() => dismissRest(block.seId)}
              onSetNote={(note) => setBlockNote(block.seId, note)}
              onLinkSuperset={(target) => linkSuperset(block.seId, target)}
              onUnlinkSuperset={() => unlinkSuperset(block.seId)}
              onAddWarmup={(w) => addWarmup(block.seId, w)}
              prSetIds={prSetIds}
              registerRef={(el) => registerBlockRef(block.seId, el)}
              registerRowRef={(handle) => registerRowHandle(block.seId, handle)}
              timerRunning={timer?.seId === block.seId}
              timerStartedAt={
                timer?.seId === block.seId ? timer.startedAt : null
              }
              onToggleTimer={() => toggleTimer(block.seId)}
              onCommit={(set, ctx) => commitSet(block.seId, set, ctx)}
              onSaveSet={(setId, patch) => saveSet(block.seId, setId, patch)}
              onRemoveSet={(setId) => removeSet(block.seId, setId)}
              onRemoveBlock={() => removeBlock(block.seId)}
              onSwapExercise={swapBlockExercise}
            />
          ))}

          <Button
            size="lg"
            className="h-12 w-full"
            onClick={() => setPicking(true)}
            data-testid="open-exercise-picker"
          >
            <Plus className="size-4" />
            Add exercise
          </Button>
          <ExercisePicker
            open={picking}
            onOpenChange={setPicking}
            onPick={pickExercise}
          />
          {voicePicker && (
            <VoiceMatchPicker
              query={voicePicker.parsed.name}
              candidates={voicePicker.candidates}
              onOpenChange={(open) => {
                if (!open) setVoicePicker(null);
              }}
              onPick={(id) => {
                applyVoiceToBlock(id, voicePicker.parsed);
                setVoicePicker(null);
              }}
            />
          )}
        </div>
      </div>

      {session && (
        <FinishOverlay
          open={finishOpen}
          onOpenChange={setFinishOpen}
          sessionId={sessionId}
          title={session.title ?? ""}
          notes={session.notes ?? ""}
          startedAt={session.startedAt}
          pausedMs={currentPausedMs()}
          setCount={setCount}
          volume={volume}
          unit={unit}
          isRoutine={session.routineId != null}
          structuralChange={structuralChange}
          onFinish={handleFinish}
          onDiscard={handleDiscard}
        />
      )}
    </>
  );
}

// Finish / Save Workout overlay (Hevy-parity M2): computed totals; editable
// title, notes, and start date/time (duration derives from the start edit);
// for routine sessions a default-ON "Update routine values" toggle and — when
// the structure drifted from the template — an Update / Keep-original choice;
// Discard (destructive). Save closes the session and lands on its history.
function FinishOverlay({
  open,
  onOpenChange,
  sessionId,
  title,
  notes,
  startedAt,
  pausedMs,
  setCount,
  volume,
  unit,
  isRoutine,
  structuralChange,
  onFinish,
  onDiscard,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  title: string;
  notes: string;
  startedAt: number;
  pausedMs: number;
  setCount: number;
  volume: number;
  unit: Unit;
  isRoutine: boolean;
  structuralChange: boolean;
  onFinish: (opts: {
    title: string;
    notes: string;
    startedAt: number;
    updateValues: boolean;
    updateStructure: boolean;
  }) => Promise<void>;
  onDiscard: () => Promise<void>;
}) {
  const repo = useRepo();
  // Freeze the finish moment on open so the computed duration is stable while
  // the sheet is up (matches when the user tapped Finish).
  const [endAt] = useState(() => Date.now());
  const [titleDraft, setTitleDraft] = useState(title);
  const [notesDraft, setNotesDraft] = useState(notes);
  const [startedDraft, setStartedDraft] = useState(startedAt);
  const [updateValues, setUpdateValues] = useState(true);
  const [updateStructure, setUpdateStructure] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  // Workout photos: resized client-side and held locally; uploaded (position =
  // index) only when the workout saves, so discarding never orphans storage.
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);

  const durationMs = Math.max(0, endAt - startedDraft - pausedMs);

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      for (let i = 0; i < photos.length; i++) {
        try {
          await repo.uploadSessionPhoto(sessionId, photos[i].blob, i);
        } catch {
          // A single failed photo upload must not block saving the workout.
        }
      }
      await onFinish({
        title: titleDraft,
        notes: notesDraft,
        startedAt: startedDraft,
        updateValues,
        updateStructure,
      });
    } catch {
      setSaving(false);
    }
  }

  const labelCls = "text-2xs font-medium tracking-wide text-faint uppercase";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Finish workout" className="md:max-w-sm">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between border-b border-border pb-3">
            <span
              className="num text-sm text-soft"
              data-testid="finish-summary"
            >
              {setCount} {setCount === 1 ? "set" : "sets"} ·{" "}
              {volume.toLocaleString()} {unitLabel(unit)}
            </span>
            <span
              className="num text-sm text-soft"
              data-testid="finish-duration"
            >
              {formatDurationSeconds(durationMs)}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <span className={labelCls}>Title</span>
            <Input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              placeholder="Workout"
              data-testid="finish-title"
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className={labelCls}>Start</span>
            <Input
              type="datetime-local"
              className="num"
              value={toLocalInput(startedDraft)}
              onChange={(e) => {
                const ms = new Date(e.target.value).getTime();
                if (Number.isFinite(ms)) setStartedDraft(ms);
              }}
              data-testid="finish-started-at"
            />
          </div>

          <label className="flex flex-col gap-1">
            <span className={labelCls}>Notes</span>
            <textarea
              rows={3}
              value={notesDraft}
              onChange={(e) => setNotesDraft(e.target.value)}
              placeholder="How did it go? PRs, aches, focus…"
              data-testid="finish-notes"
              className="w-full resize-y rounded-md border border-border-strong bg-surface-2 px-2 py-1.5 text-sm text-ink placeholder:text-faint focus:border-transparent focus:outline-none focus:ring-2 focus:ring-ring/70"
            />
          </label>

          <FinishPhotoStrip photos={photos} onChange={setPhotos} />

          {isRoutine && (
            <label className="flex items-start gap-2 rounded-md border border-border bg-surface-2 p-2">
              <input
                type="checkbox"
                checked={updateValues}
                onChange={(e) => setUpdateValues(e.target.checked)}
                className="mt-0.5 size-4 accent-(--accent)"
                data-testid="finish-update-values"
              />
              <span className="text-xs text-soft">
                <span className="font-medium text-ink">
                  Update routine values
                </span>
                <br />
                Save today's weights &amp; reps back to the routine (rep-range
                sets are left as-is).
              </span>
            </label>
          )}

          {isRoutine && structuralChange && (
            <div className="rounded-md border border-border bg-surface-2 p-2">
              <p className="text-xs text-soft">
                You changed this workout's structure. Update the routine to
                match, or keep the original?
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  variant={updateStructure ? "primary" : "outline"}
                  size="sm"
                  className="flex-1"
                  onClick={() => setUpdateStructure(true)}
                  data-testid="finish-update-structure"
                >
                  Update routine
                </Button>
                <Button
                  variant={!updateStructure ? "primary" : "outline"}
                  size="sm"
                  className="flex-1"
                  onClick={() => setUpdateStructure(false)}
                  data-testid="finish-keep-original"
                >
                  Keep original
                </Button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between border-t border-border pt-3">
            {confirmDiscard ? (
              <Button
                variant="danger"
                size="sm"
                onClick={() => void onDiscard()}
                data-testid="finish-discard-confirm"
              >
                <Trash2 className="size-3.5" />
                Confirm discard
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDiscard(true)}
                data-testid="finish-discard"
              >
                <Trash2 className="size-3.5" />
                Discard
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              disabled={saving}
              onClick={() => void save()}
              data-testid="finish-save"
            >
              <Check className="size-4" />
              {saving ? "Saving…" : "Save workout"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ExercisePicker({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (id: string, name: string) => void;
}) {
  const { data: exerciseData, isLoading, isError, refetch } = useExercises();
  // Presence, not query status (same rule as library.tsx): a failed background
  // refetch on a list we already have is not an error state to show.
  const exercises = exerciseData ?? [];
  const exercisesLoaded = exerciseData !== undefined;
  const { t } = useVoice();
  const { data: machines = [] } = useMachines();
  // A just-created exercise is in the list before its INSERT lands; adding it
  // to the session would violate the session_exercises FK. Leaving the
  // registry says the create settled, not that it succeeded — the list itself
  // is what separates the two (a rolled-back create takes its row with it).
  const pendingExercises = usePendingExercises();
  const [query, setQuery] = useState("");
  const [filterMuscle, setFilterMuscle] = useState("");
  const [yoursOnly, setYoursOnly] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);
  // Set by the editor's onCreated; auto-picked the instant its INSERT lands
  // (same FK wait pickExercise already does for any pending row) — the
  // highest-value change in the custom-exercise-adder plan: discovering
  // mid-workout that a lift isn't in the book no longer means abandoning
  // the session to go add it in Library first.
  const [awaitingPick, setAwaitingPick] = useState<{
    id: string;
    name: string;
  } | null>(null);
  useEffect(() => {
    if (!awaitingPick) return;
    if (pendingExercises.has(awaitingPick.id)) return;
    if (!exercises.some((e) => e.id === awaitingPick.id)) return;
    onPick(awaitingPick.id, awaitingPick.name);
    setAwaitingPick(null);
    onOpenChange(false);
  }, [awaitingPick, pendingExercises, exercises, onPick, onOpenChange]);
  // Muscle-grouped, tier-sorted — same reading order as the Library ribbon.
  const filtered = filterExercises(exercises, query, filterMuscle).filter(
    (ex) => !yoursOnly || ex.isCustom,
  );
  const groups = groupByPrimaryMuscle(filtered);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add exercise" className="md:max-w-lg">
        <div className="flex flex-col gap-3">
          <ExerciseFilterBar
            query={query}
            onQuery={setQuery}
            muscle={filterMuscle}
            onMuscle={setFilterMuscle}
            autoFocus
            after={
              <button
                type="button"
                onClick={() => setYoursOnly((v) => !v)}
                aria-pressed={yoursOnly}
                className={cn(
                  "h-8 shrink-0 px-2.5 text-2xs transition-colors duration-150",
                  yoursOnly
                    ? "bg-accent-soft text-accent"
                    : "bg-translucent text-soft hover:bg-surface-hover hover:text-ink",
                )}
                data-testid="picker-filter-yours"
              >
                Yours
              </button>
            }
          />
          {isLoading ? (
            <p className="px-4 py-6 text-center text-xs text-faint">Loading…</p>
          ) : isError && !exercisesLoaded ? (
            <div
              className="flex flex-col items-center gap-2 px-4 py-6 text-center"
              data-testid="picker-error"
            >
              <p className="text-xs text-neg">
                {t(
                  "Couldn't reach the server. Your exercises may still be there.",
                  "The frog couldn't reach the pond. Your exercises may still be there.",
                )}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetch()}
                data-testid="picker-retry"
              >
                Retry
              </Button>
            </div>
          ) : exercises.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-faint">
              No exercises yet — add one in Library.
            </p>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-6">
              <p className="text-center text-xs text-faint">
                {query.trim()
                  ? "No exercises match your search."
                  : "No exercises match these filters."}
              </p>
              <Button
                variant="primary"
                size="lg"
                className="w-full"
                onClick={() => setCreatingNew(true)}
                data-testid="picker-create-exercise-btn"
              >
                <Plus className="size-4" />
                {query.trim() ? `Create "${query.trim()}"` : "Create exercise"}
              </Button>
            </div>
          ) : (
            <div className="overflow-hidden border border-border bg-surface">
              {groups.map((group) => (
                <section key={group.key}>
                  <p className="border-b border-border bg-surface-2 px-4 py-1 text-2xs font-medium tracking-widest text-faint uppercase">
                    {group.label}
                  </p>
                  <ul className="divide-y divide-border">
                    {group.items.map((ex) => (
                      <PickerRow
                        key={ex.id}
                        exercise={ex}
                        tier={
                          ex.muscleTargets?.find((t) => t.muscle === group.key)
                            ?.tier
                        }
                        machine={machines.find((m) => m.id === ex.machineId)}
                        pending={pendingExercises.has(ex.id)}
                        onPick={onPick}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
      <ExerciseEditor
        open={creatingNew}
        onOpenChange={setCreatingNew}
        mode="create"
        initialName={query.trim()}
        onCreated={(id, name) => setAwaitingPick({ id, name })}
      />
    </Dialog>
  );
}

function ordinal(n: number): string {
  const teen = n % 100;
  if (teen >= 11 && teen <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

// Voice-log fallback: the parsed name didn't clearly match one block, so ask
// rather than guess. Scoped to this session's own blocks only (never the full
// exercise library) — same search-box pattern as ExercisePicker, above.
function VoiceMatchPicker({
  query,
  candidates,
  onPick,
  onOpenChange,
}: {
  query: string;
  candidates: MatchCandidate[];
  onPick: (id: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [search, setSearch] = useState(query);
  const filtered = candidates.filter((c) =>
    c.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  // The pre-filled spoken name usually isn't a substring of any block name
  // (that's why the picker opened) — fall back to the full list rather than
  // opening onto a dead-end empty state. Only while the box still holds that
  // untouched prefill: once the user types, their query wins, and a zero-result
  // search must read as empty rather than silently ignoring the filter.
  const shown = filtered.length > 0 || search !== query ? filtered : candidates;
  // The same exercise can hold two blocks (back-off work, a second wave), and
  // that tie is exactly what sends the user here — two rows reading "Bench
  // Press" would just move the coin flip into a dialog. Number the repeats by
  // their order in the session; unique names stay plain.
  const counted = new Map<string, number>();
  const rows = shown.map((c) => {
    const nth = (counted.get(c.name) ?? 0) + 1;
    counted.set(c.name, nth);
    return { ...c, nth };
  });
  const rowLabel = (row: (typeof rows)[number]) =>
    (counted.get(row.name) ?? 0) > 1
      ? `${row.name} (${ordinal(row.nth)})`
      : row.name;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title="Which exercise?" className="md:max-w-sm">
        <div className="flex flex-col gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-faint" />
            <Input
              placeholder="Search this session…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
              autoFocus
              data-testid="voice-picker-search"
            />
          </div>
          {rows.length === 0 ? (
            <p className="px-1 py-4 text-center text-xs text-faint">
              {voice(
                "No match in this session.",
                "No match in this session — the frog looked, promise.",
              )}
            </p>
          ) : (
            <ul className="divide-y divide-border overflow-hidden border border-border bg-surface">
              {rows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => onPick(row.id)}
                    className="block w-full px-4 py-3 text-left text-sm transition-colors duration-150 ease-(--ease-out-quad) hover:bg-surface-hover"
                    data-testid={`voice-pick-${rowLabel(row)}`}
                  >
                    {rowLabel(row)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// One picker row: the ribbon picks the exercise; a separate toggle reveals the
// last-session history. The history query only mounts once expanded, so opening
// the picker doesn't fire a lookup for every exercise at once.
function PickerRow({
  exercise,
  tier,
  machine,
  pending,
  onPick,
}: {
  exercise: Exercise;
  tier?: Tier | null;
  machine?: Machine;
  pending?: boolean;
  onPick: (id: string, name: string) => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  return (
    <li>
      <div className="flex items-stretch">
        <button
          type="button"
          data-testid={`pick-exercise-${exercise.name}`}
          onClick={() => onPick(exercise.id, exercise.name)}
          disabled={pending}
          title={pending ? "Still saving — available in a moment" : undefined}
          className="flex-1 px-4 py-3 text-left transition-colors duration-150 ease-(--ease-out-quad) hover:bg-surface-hover disabled:opacity-50 disabled:hover:bg-transparent"
        >
          <ExerciseRibbon exercise={exercise} tier={tier} machine={machine} />
          {pending && (
            <span className="mt-0.5 block text-2xs text-faint">Saving…</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          title="Last session"
          aria-expanded={showHistory}
          className="flex shrink-0 items-center gap-1 border-l border-border px-3 text-faint transition-colors duration-150 ease-(--ease-out-quad) hover:bg-surface-hover hover:text-ink"
          data-testid={`pick-history-toggle-${exercise.name}`}
        >
          <History className="size-4" />
          <ChevronDown
            className={cn(
              "size-3 transition-transform duration-150",
              showHistory && "rotate-180",
            )}
          />
        </button>
      </div>
      {showHistory && (
        <PickerHistory exerciseId={exercise.id} name={exercise.name} />
      )}
    </li>
  );
}

// Lazily-loaded last-session sets for one picker row (mounted only when the
// history dropdown is open).
function PickerHistory({
  exerciseId,
  name,
}: {
  exerciseId: string;
  name: string;
}) {
  const { unit } = useUnit();
  const { data: sets = [], isLoading } = useLastSets(exerciseId);
  const summary = sets
    .map((s) =>
      s.weightKg != null && s.reps != null
        ? `${formatWeight(s.weightKg, unit)}×${s.reps}`
        : null,
    )
    .filter((s): s is string => s != null)
    .join(", ");
  return (
    <div
      className="border-t border-border bg-surface-2 px-4 py-2 text-2xs text-soft"
      data-testid={`pick-history-${name}`}
    >
      {isLoading ? (
        <span className="text-faint">Loading…</span>
      ) : summary ? (
        <span className="flex items-center gap-1">
          <History className="size-3 shrink-0 text-faint" />
          Last: {summary}
        </span>
      ) : (
        <span className="text-faint">No history yet.</span>
      )}
    </div>
  );
}

function ExerciseBlock({
  block,
  unit,
  metrics,
  previousRoutineId,
  seedSets,
  seedNonce,
  routineNote,
  supersetColor,
  otherBlocks,
  inSuperset,
  plateConfig,
  onSavePlateConfig,
  restRunning,
  onStopRest,
  onSetNote,
  onLinkSuperset,
  onUnlinkSuperset,
  onAddWarmup,
  prSetIds,
  registerRef,
  registerRowRef,
  timerRunning,
  timerStartedAt,
  onToggleTimer,
  onCommit,
  onSaveSet,
  onRemoveSet,
  onRemoveBlock,
  onSwapExercise,
}: {
  block: BlockState;
  unit: Unit;
  metrics: Metric[];
  previousRoutineId: string | null;
  seedSets: SeedSet[];
  seedNonce: number;
  routineNote: string | null;
  supersetColor: string | null;
  otherBlocks: { seId: string; name: string }[];
  inSuperset: boolean;
  plateConfig: PlateConfig | null;
  onSavePlateConfig: (cfg: PlateConfig) => void;
  restRunning: boolean;
  onStopRest: () => void;
  onSetNote: (note: string) => void;
  onLinkSuperset: (targetSeId: string) => void;
  onUnlinkSuperset: () => void;
  onAddWarmup: (workingWeightKg: number) => void;
  prSetIds: Set<string>;
  registerRef: (el: HTMLElement | null) => void;
  registerRowRef: (handle: ActiveRowHandle | null) => void;
  timerRunning: boolean;
  timerStartedAt: number | null;
  onToggleTimer: () => void;
  onCommit: (set: CommitInput, ctx: CommitCtx) => void;
  onSaveSet: (setId: string, patch: SetPatch) => void;
  onRemoveSet: (setId: string) => void;
  onRemoveBlock: () => void;
  onSwapExercise: (seId: string, exerciseId: string, ghostId: string) => void;
}) {
  const { data: ghost = [] } = useGhost(
    block.ghostExerciseId ?? block.exerciseId,
    block.seId,
    previousRoutineId,
  );
  const { data: ghostNote } = useLastNote(
    block.ghostExerciseId ?? block.exerciseId,
    block.seId,
  );
  const { data: exercises = [] } = useExercises();
  const { data: machines = [] } = useMachines();
  const { data: prefs = [] } = useExercisePrefs();
  const setWeightUnit = useSetExerciseWeightUnit();
  const createExercise = useCreateExercise();
  const updateExercise = useUpdateExercise();
  const deleteExercise = useDeleteExercise();
  const repo = useRepo();
  const navigate = useNavigate();
  const { t } = useVoice();
  const [plateTarget, setPlateTarget] = useState<number | null>(null);
  const [plateOpen, setPlateOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const activeIndex = countSets(block.committed);
  // Whether a draft (active) row is shown for this block right now. The
  // first set's row is always open (fresh: blank; routine: seeded) so
  // logging starts instantly; after that a draft only reappears via an
  // explicit "Add set" tap (handleAddSet below) — or, on reload, when it
  // restores real in-progress keystrokes rather than fabricating one.
  const [draftOpen, setDraftOpen] = useState(
    () => activeIndex === 0 || loadDraft(block.seId) != null,
  );
  const activeRowHandleRef = useRef<ActiveRowHandle | null>(null);
  const enabledMetrics = metrics.filter(
    (m) => m.scope === "set" && m.exerciseIds?.includes(block.exerciseId),
  );
  const exercise = exercises.find((e) => e.id === block.exerciseId);
  const machine = machines.find((m) => m.id === exercise?.machineId);

  // In-session exercise edit (laterality toggle / machine attach). Custom
  // rows patch in place; seed rows are RLS-read-only (repo/types.ts), so the
  // change goes onto a private custom copy — the duplicate field contract,
  // minus aliases so the matcher stays unambiguous — and the block swaps
  // onto it. The swap is optimistic: the copy is already in the exercises
  // cache from the create's onMutate, and the session_exercises repoint
  // waits for the insert so the FK can't race it. The repoint runs through a
  // retrying mutation (the logSet contract); when its retries exhaust, the
  // failure is resolved by reading the row before any cleanup — the PATCH
  // can have committed with its response lost, so the orphan copy is
  // soft-deleted only when the row still points at the seed; a row already
  // on the copy means the edit landed and nothing is deleted. If the
  // resolution read itself fails, the copy is never deleted (deleting could
  // destroy a committed repoint) and the block stays on the copy with a
  // couldn't-confirm banner. Retry re-attempts the orphan copy's idempotent
  // soft-delete first (a cleanup delete can itself fail and leave a live
  // duplicate library row), resolves by read again, never mints a second
  // copy while the row already points at one, and a fork whose create never
  // resolved starts over from the seed instead of re-pointing at a copy that
  // was never inserted. The Laterality/Attach items stay disabled while a
  // copy-on-write is in flight or its failure banner is up, so a rapid
  // re-toggle can't target the not-yet-inserted copy id or bypass the orphan
  // cleanup.
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<{
    patch: ExercisePatch;
    unresolved?: boolean;
    created?: boolean;
    orphanId?: string;
    originalId: string;
  } | null>(null);
  const repoint = useMutation({
    mutationFn: ({ seId, copyId }: { seId: string; copyId: string }) =>
      repo.updateSessionExercise(seId, { exerciseId: copyId }),
  });
  function settleRepointFailure(
    seId: string,
    copyId: string,
    originalId: string,
    patch: ExercisePatch,
    created: boolean,
  ) {
    void (async () => {
      let state: "committed" | "not-committed" | "unresolved";
      try {
        const row = await repo.getSessionExercise(seId);
        state = row?.exerciseId === copyId ? "committed" : "not-committed";
      } catch {
        state = "unresolved";
      }
      if (state === "committed") {
        setCopying(false);
        return;
      }
      if (state === "unresolved") {
        setCopying(false);
        setCopyError({ patch, unresolved: true, created, originalId });
        return;
      }
      onSwapExercise(seId, originalId, originalId);
      setCopying(false);
      setCopyError({ patch, created, orphanId: copyId, originalId });
      deleteExercise.mutate(copyId);
    })();
  }
  function forkExercise(ex: Exercise, patch: ExercisePatch) {
    // Own custom rows patch in place; seed rows AND community-shared rows
    // (is_custom true, owner_id null) are RLS-immutable — a mid-session
    // laterality/machine edit forks a private copy for both (the shared-row
    // gate mirrors the library's, so the two can't drift —
    // docs/DECISIONS.md 2026-08-08).
    if (ex.isCustom && ex.ownerId !== null) {
      updateExercise.mutate({ exerciseId: ex.id, patch });
      return;
    }
    setCopyError(null);
    const originalId = ex.id;
    const copyId = newId();
    const creating = createExercise.mutateAsync({
      name: `${ex.name} (copy)`,
      // share: false — a mid-session copy-on-write fork is a private copy,
      // never a publish (docs/DECISIONS.md 2026-08-08).
      opts: { id: copyId, ...copyExerciseOpts(ex), ...patch, share: false },
    });
    onSwapExercise(block.seId, copyId, originalId);
    setCopying(true);
    void (async () => {
      let created = false;
      try {
        await creating;
        created = true;
      } catch {
        // The create's failure is itself ambiguous (the row can have landed
        // with the response lost) — settleRepointFailure resolves it by read.
      }
      if (!created) {
        settleRepointFailure(block.seId, copyId, originalId, patch, false);
        return;
      }
      try {
        await repoint.mutateAsync({ seId: block.seId, copyId });
        setCopying(false);
      } catch {
        settleRepointFailure(block.seId, copyId, originalId, patch, true);
      }
    })();
  }
  function editOrCopy(patch: ExercisePatch) {
    if (!exercise) return;
    forkExercise(exercise, patch);
  }
  function retryCopy() {
    if (!copyError) return;
    const err = copyError;
    setCopyError(null);
    setCopying(true);
    void (async () => {
      if (err.orphanId) {
        // The block was swapped back to the seed and the previous copy may
        // still exist (its cleanup delete can have failed) — re-attempt the
        // idempotent soft-delete first. The row no longer references it, so
        // this cannot destroy a committed repoint.
        try {
          await deleteExercise.mutateAsync(err.orphanId);
        } catch {
          setCopying(false);
          setCopyError(err);
          return;
        }
      }
      if (!err.unresolved) {
        setCopying(false);
        editOrCopy(err.patch);
        return;
      }
      let state: "committed" | "not-committed" | "unresolved";
      try {
        const row = await repo.getSessionExercise(block.seId);
        state =
          row?.exerciseId === block.exerciseId ? "committed" : "not-committed";
      } catch {
        state = "unresolved";
      }
      if (state === "committed") {
        setCopying(false);
        return;
      }
      if (state === "unresolved") {
        setCopying(false);
        setCopyError(err);
        return;
      }
      if (err.created) {
        // The copy exists but the repoint never confirmed; the block is
        // still on the copy — re-attempt the repoint on it.
        void repoint
          .mutateAsync({ seId: block.seId, copyId: block.exerciseId })
          .then(() => setCopying(false))
          .catch(() =>
            settleRepointFailure(
              block.seId,
              block.exerciseId,
              err.originalId,
              err.patch,
              true,
            ),
          );
        return;
      }
      // The copy create never resolved — the block may be pinned to a
      // nonexistent copy id; start a fresh copy from the seed exercise.
      const original = exercises.find((e) => e.id === err.originalId);
      if (!original) {
        setCopying(false);
        setCopyError(err);
        return;
      }
      setCopying(false);
      forkExercise(original, err.patch);
    })();
  }

  const type = (exercise?.exerciseType as ExerciseType) ?? "weight_reps";
  // Per-exercise weight-unit override falls back to the global display unit.
  const override = weightUnitOverrideFor(prefs, block.exerciseId);
  const blockUnit = blockUnitFor(prefs, block.exerciseId, unit);
  const distUnit = distanceUnitFor(blockUnit);
  const columns = columnsFor(type, blockUnit, distUnit, exercise?.laterality);
  const barLoaded =
    TYPE_FIELDS[type].weight && isBarLoaded(exercise?.equipment);
  const warmupEligible = TYPE_FIELDS[type].weight;
  // Warm-up prefill: the heaviest weight logged so far (display unit).
  const heaviestKg = block.committed.reduce(
    (max, s) => (s.weightKg != null && s.weightKg > max ? s.weightKg : max),
    0,
  );

  // PREVIOUS column: last performance per set index ('any workout' scope — the
  // existing ghost lookup). Only claims grid space when there's prior or seeded
  // (routine/copy) data. Per-index (no clamp-to-last), so a newly added set is
  // blank until logged once.
  const showPrevious = ghost.length > 0 || seedSets.length > 0;
  const cells = previousCells(
    ghost,
    [],
    Math.max(activeIndex + 1, seedSets.length),
  );
  const template = gridTemplate(columns, showPrevious);

  return (
    <section
      ref={registerRef}
      className="rounded-lg border border-border bg-surface pb-4"
      style={
        supersetColor ? { borderLeft: `3px solid ${supersetColor}` } : undefined
      }
      data-testid={`block-${block.name}`}
      data-superset={inSuperset ? "1" : undefined}
    >
      <header className="flex min-h-10 items-center justify-between gap-2 border-b border-border px-4 py-1 md:min-h-8">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <ExerciseThumb imageUrl={exercise?.imageUrl} name={block.name} />
          <span className="flex min-w-0 flex-col">
            {/* Tap the name → exercise detail; Hevy opens it mid-workout
                without pausing (the session stays server-persisted). Wraps to
                a second line rather than truncating — the left span now
                claims the width left over after the header controls. */}
            <button
              type="button"
              onClick={() => navigate(`/exercises/${block.exerciseId}`)}
              title="Exercise details"
              className="text-left text-sm font-medium transition-colors duration-100 hover:text-accent"
              data-testid={`block-${block.name}-open`}
            >
              {block.name}
            </button>
            {routineNote && (
              <span
                className="truncate text-2xs text-faint"
                data-testid={`block-${block.name}-note`}
              >
                {routineNote}
              </span>
            )}
          </span>
        </span>
        {/* Rest + options only — remove, machine-attach and the laterality
            toggle live inside the options ⋯ menu, so the header stays one
            row of uniform icon buttons and nothing claims its own row. */}
        <Toolbar>
          {supportsEffort(type) && (
            <IconButton
              active={restRunning}
              onClick={onStopRest}
              title={restRunning ? "Stop rest" : "Rest timer"}
              data-testid={`block-${block.name}-rest-timer`}
            >
              <RestTimerIcon className="size-4" />
            </IconButton>
          )}
          <BlockMenu
            blockName={block.name}
            unit={blockUnit}
            otherBlocks={otherBlocks}
            inSuperset={inSuperset}
            warmupEligible={warmupEligible}
            heaviestDisplay={
              heaviestKg > 0 ? toDisplayWeight(heaviestKg, blockUnit) : null
            }
            machineAttached={machine != null}
            busy={copying || copyError != null}
            onAttachMachine={() => setAttachOpen(true)}
            laterality={exercise?.laterality ?? null}
            onLateralityChange={(l) => editOrCopy({ laterality: l })}
            onRemoveBlock={onRemoveBlock}
            onLinkSuperset={onLinkSuperset}
            onUnlinkSuperset={onUnlinkSuperset}
            onAddWarmup={(displayWeight) =>
              onAddWarmup(
                blockUnit === "lb" ? lbToKg(displayWeight) : displayWeight,
              )
            }
          />
        </Toolbar>
      </header>

      {copyError && (
        <div
          role="status"
          data-testid={`block-${block.name}-copy-error`}
          className="flex items-center justify-between gap-2 border-b border-border px-4 py-2"
        >
          <span className="min-w-0 text-xs text-neg">
            {copyError.unresolved
              ? t(
                  "Couldn't confirm that change — check your connection and retry.",
                  "The frog can't tell if that landed — check the pond and retry.",
                )
              : t(
                  "Couldn't update this exercise — couldn't reach the server.",
                  "The frog couldn't reach the pond — that change didn't land.",
                )}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={retryCopy}
            disabled={copying}
            data-testid={`block-${block.name}-copy-retry`}
          >
            {copying ? "Retrying…" : "Retry"}
          </Button>
        </div>
      )}

      {/* The exercise's own cue ("brace before you unrack") — set once in
          the exercise editor, read-only here, distinct from this session's
          own note below. */}
      {exercise?.notes && (
        <p
          className="px-4 pb-1 text-2xs text-faint"
          data-testid={`block-${block.name}-exercise-notes`}
        >
          {exercise.notes}
        </p>
      )}

      <SessionNoteField
        blockName={block.name}
        note={block.note ?? ""}
        ghostNote={ghostNote ?? null}
        onCommit={onSetNote}
      />

      {/* No machine attached yet — the block header offers the in-workout
          catalog attach in SetupStrip's slot, so the affordance sits exactly
          where the remembered setup would. */}
      {machine ? (
        <SetupStrip machine={machine} blockName={block.name} />
      ) : (
        <MachineAttachDialog
          blockName={block.name}
          open={attachOpen}
          onOpenChange={setAttachOpen}
          onAttach={(machineId) => editOrCopy({ machineId })}
        />
      )}

      {/* One grid for the whole block, every row a `subgrid` spanning it.
          The menu-gutter track is FIXED at 2.5rem (gridTemplate above), so
          every row's ⋯ lands at the same x unconditionally — the modifier
          readout lives as a badge out of the grid flow precisely so nothing
          can stretch the track. The grid owns the `px-4` gutter; rows that
          paint a border or a background take it back with a net-zero
          `-mx-4 px-4`. */}
      <div
        className="grid gap-x-2 px-4"
        style={{ gridTemplateColumns: template }}
      >
        <div className="col-span-full grid grid-cols-subgrid items-center gap-x-2 py-1 text-2xs font-medium tracking-widest text-faint uppercase">
          <span>#</span>
          {showPrevious && <span>prev</span>}
          {columns.map((c) =>
            c.key === "weight" ? (
              <UnitOverrideMenu
                key={c.key}
                header={c.header}
                blockName={block.name}
                override={override}
                globalUnit={unit}
                onSet={(u) =>
                  setWeightUnit.mutate({
                    exerciseId: block.exerciseId,
                    unit: u,
                  })
                }
              />
            ) : (
              <span key={c.key}>{c.header}</span>
            ),
          )}
        </div>

        {groupSetsBySetNo(block.committed).map((rows, i) => (
          <CommittedRow
            key={rows[0].id}
            rows={rows}
            index={i}
            unit={blockUnit}
            distUnit={distUnit}
            type={type}
            columns={columns}
            showPrevious={showPrevious}
            previous={cells[i]?.previous ?? null}
            prSetIds={prSetIds}
            onSave={(setId, patch) => onSaveSet(setId, patch)}
            onSaveType={(patch) => {
              for (const r of rows) onSaveSet(r.id, patch);
            }}
            onDelete={() => {
              for (const r of rows) onRemoveSet(r.id);
            }}
          />
        ))}

        {draftOpen && (
          <ActiveRow
            key={`${activeIndex}-${seedNonce}`}
            ref={(handle) => {
              activeRowHandleRef.current = handle;
              registerRowRef(handle);
            }}
            seId={block.seId}
            index={activeIndex}
            unit={blockUnit}
            distUnit={distUnit}
            type={type}
            columns={columns}
            showPrevious={showPrevious}
            previous={cells[activeIndex]?.previous ?? null}
            seed={seedSets[activeIndex]}
            nextSeedType={seedSets[activeIndex + 1]?.setType ?? null}
            ghost={ghostFor(ghost, activeIndex)}
            hasGhost={ghost.length > 0}
            enabledMetrics={enabledMetrics}
            autoFocusWeight={activeIndex > 0}
            barLoaded={barLoaded}
            // The exercise-level laterality default; the per-set override
            // lives in the row itself (seeded from the draft snapshot), so
            // it dies with the row on commit and survives reloads.
            exerciseLaterality={exercise?.laterality ?? null}
            onOpenPlates={(target) => {
              setPlateTarget(target);
              setPlateOpen(true);
            }}
            timerRunning={timerRunning}
            timerStartedAt={timerStartedAt}
            onToggleTimer={onToggleTimer}
            onCommit={(set, ctx) => {
              // Logging a set never auto-adds the next row — only an
              // explicit "Add set" tap (handleAddSet) does that.
              onCommit(set, ctx);
              setDraftOpen(false);
            }}
          />
        )}

        {/* Only sets beyond the active row render as upcoming previews — the
            current index with no draft open is never a row you can't type
            into (note 3: no phantom upcoming rows). The plan preview for the
            rest of the routine stays (2026-07-30). */}
        {seedSets.slice(activeIndex + 1).map((seed, i) => {
          const idx = activeIndex + 1 + i;
          return (
            <UpcomingRow
              key={idx}
              index={idx}
              seed={seed}
              unit={blockUnit}
              distUnit={distUnit}
              columns={columns}
              showPrevious={showPrevious}
              previous={cells[idx]?.previous ?? null}
            />
          );
        })}

        {/* The explicit "Add set" affordance — the only way a new draft row
            appears. Sits below every committed row AND every upcoming
            (routine-seeded) row, so it never lands between two sets the way
            the old in-row button did. Commits any open draft first (same
            path as the row's own check button), then opens the next one. */}
        <div className="col-span-full mt-2">
          <Button
            variant="outline"
            size="lg"
            className="w-full"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (draftOpen) activeRowHandleRef.current?.commit(true);
              setDraftOpen(true);
            }}
            data-testid={`set-${activeIndex}-add`}
          >
            <Plus className="size-3" />
            Add set
          </Button>
        </div>
      </div>

      <PlateSheet
        open={plateOpen}
        onOpenChange={setPlateOpen}
        target={plateTarget}
        unit={blockUnit}
        plateConfig={plateConfig}
        onSaveConfig={onSavePlateConfig}
        testId={`plates-${block.name}`}
      />
    </section>
  );
}

// Per-exercise session note (distinct from the read-only routine template
// note). Instant local edit; persisted on blur. The carry-forward ghost is
// unavailable (the PREVIOUS/ghost fetch doesn't return notes), so it ships
// without the greyed previous-note.
function SessionNoteField({
  blockName,
  note,
  ghostNote,
  onCommit,
}: {
  blockName: string;
  note: string;
  ghostNote: string | null;
  onCommit: (note: string) => void;
}) {
  const [value, setValue] = useState(note);
  // Carry-forward ghost: the prior session's note shows greyed as the
  // placeholder until typed over (dropped on save if left untouched).
  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (value.trim() !== note.trim()) onCommit(value);
      }}
      placeholder={ghostNote ?? "Add a note…"}
      className="w-full border-b border-border bg-surface-2 px-4 py-1.5 text-2xs text-soft placeholder:text-faint focus:outline-none focus:ring-1 focus:ring-inset focus:ring-ring/70"
      data-testid={`block-${blockName}-session-note`}
    />
  );
}

// Per-exercise overflow menu (Hevy three-dots): superset link/unlink, warm-up
// insert, machine attach (when none is set), the laterality toggle and
// remove-exercise — the header keeps only rest + ⋯, so no per-exercise action
// claims its own full row. Superset opens a separate picker sheet (note 14:
// choosing the partner from all exercises, not an inline list).
function BlockMenu({
  blockName,
  unit,
  otherBlocks,
  inSuperset,
  warmupEligible,
  heaviestDisplay,
  machineAttached,
  busy,
  onAttachMachine,
  laterality,
  onLateralityChange,
  onRemoveBlock,
  onLinkSuperset,
  onUnlinkSuperset,
  onAddWarmup,
}: {
  blockName: string;
  unit: Unit;
  otherBlocks: { seId: string; name: string }[];
  inSuperset: boolean;
  warmupEligible: boolean;
  heaviestDisplay: number | null;
  machineAttached: boolean;
  busy: boolean;
  onAttachMachine: () => void;
  laterality: string | null;
  onLateralityChange: (l: Laterality) => void;
  onRemoveBlock: () => void;
  onLinkSuperset: (targetSeId: string) => void;
  onUnlinkSuperset: () => void;
  onAddWarmup: (displayWeight: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [supersetOpen, setSupersetOpen] = useState(false);
  const [warmupOpen, setWarmupOpen] = useState(false);
  const labelCls =
    "px-3 pt-2 pb-1 text-2xs font-medium tracking-widest text-faint uppercase";
  // null (never set) and any legacy value read as bilateral — the same
  // default the editor and the session's pairing logic use.
  const currentLaterality: Laterality =
    laterality === "unilateral" ||
    laterality === "alternating" ||
    laterality === "bilateral"
      ? laterality
      : "bilateral";

  return (
    <span className="relative">
      <IconButton
        onClick={() => setOpen((o) => !o)}
        title="Exercise options"
        data-testid={`block-${blockName}-menu`}
      >
        <MoreVertical className="size-4" />
      </IconButton>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            className="floating absolute top-full right-0 z-20 mt-1 max-h-80 min-w-48 overflow-y-auto py-1"
            data-testid={`block-${blockName}-menu-popup`}
          >
            <p className={labelCls}>Superset</p>
            {otherBlocks.length === 0 ? (
              <p className="px-3 pb-2 text-2xs text-faint">
                Add another exercise to link.
              </p>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setSupersetOpen(true);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-soft transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
                data-testid={`block-${blockName}-superset`}
              >
                <Link2 className="size-3.5 shrink-0 text-faint" />
                Link superset…
              </button>
            )}
            {inSuperset && (
              <button
                type="button"
                onClick={() => {
                  onUnlinkSuperset();
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-soft transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
                data-testid={`block-${blockName}-unsuperset`}
              >
                <Unlink className="size-3.5 shrink-0 text-faint" />
                Remove from superset
              </button>
            )}

            {!machineAttached && (
              <>
                <div className="border-t border-border" />
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onAttachMachine();
                  }}
                  disabled={busy}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-soft transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-soft"
                  data-testid={`setup-attach-${blockName}`}
                >
                  <Wrench className="size-3.5 shrink-0 text-faint" />
                  Attach machine
                </button>
              </>
            )}
            {warmupEligible && (
              <>
                <div className="border-t border-border" />
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setWarmupOpen(true);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-soft transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
                  data-testid={`block-${blockName}-warmup`}
                >
                  <Flame className="size-3.5 shrink-0 text-warn" />
                  Add warm-up sets
                </button>
              </>
            )}
            <div className="border-t border-border" />
            <p className={labelCls}>Laterality</p>
            <p className="px-3 pb-1 text-2xs text-faint">
              Unilateral: each side does the reps, logged as two rows.
              Alternating: sides take turns, reps count both sides combined.
            </p>
            {LATERALITY.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onLateralityChange(l);
                }}
                disabled={busy}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs text-soft transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-soft"
                data-testid={`block-${blockName}-laterality-${l}`}
              >
                <span className="flex flex-col">
                  {LATERALITY_LABELS[l]}
                  <span className="text-2xs font-normal normal-case tracking-normal text-faint">
                    {LATERALITY_EXPLAINERS[l]}
                  </span>
                </span>
                {currentLaterality === l && (
                  <Check className="size-3.5 shrink-0 text-accent" />
                )}
              </button>
            ))}
            <div className="border-t border-border" />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onRemoveBlock();
              }}
              disabled={busy}
              className="group flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-soft transition-colors duration-150 hover:bg-surface-hover hover:text-neg disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-soft"
              data-testid={`remove-block-${blockName}`}
            >
              <Trash2 className="size-3.5 shrink-0 text-faint group-hover:text-neg" />
              Remove exercise
            </button>
          </div>
        </>
      )}

      <SupersetPickerDialog
        open={supersetOpen}
        onOpenChange={setSupersetOpen}
        blockName={blockName}
        otherBlocks={otherBlocks}
        onPick={(target) => {
          onLinkSuperset(target);
          setSupersetOpen(false);
        }}
      />

      <WarmupDialog
        open={warmupOpen}
        onOpenChange={setWarmupOpen}
        blockName={blockName}
        unit={unit}
        prefill={heaviestDisplay}
        onInsert={onAddWarmup}
      />
    </span>
  );
}

// Superset partner picker (note 14): the block ⋯ menu's Superset option opens
// this separate bottom sheet listing every other exercise in the session,
// instead of inlining the whole list in the menu. Tapping one links the two.
function SupersetPickerDialog({
  open,
  onOpenChange,
  blockName,
  otherBlocks,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  blockName: string;
  otherBlocks: { seId: string; name: string }[];
  onPick: (seId: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Link superset" className="md:max-w-sm">
        <p className="text-2xs text-faint">
          Choose an exercise to pair {blockName} with — you'll alternate between
          them, one set at a time.
        </p>
        {otherBlocks.length === 0 ? (
          <p className="px-1 py-4 text-center text-xs text-faint">
            Add another exercise to link.
          </p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden border border-border bg-surface">
            {otherBlocks.map((b) => (
              <li key={b.seId}>
                <button
                  type="button"
                  onClick={() => onPick(b.seId)}
                  className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-soft transition-colors duration-150 ease-(--ease-out-quad) hover:bg-surface-hover hover:text-ink"
                  data-testid={`block-${blockName}-superset-${b.name}`}
                >
                  <Link2 className="size-4 shrink-0 text-faint" />
                  <span className="truncate">{b.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Prompts for the target working weight, then inserts a percentage-based
// warm-up ramp (typed as warm-ups) above the working sets.
function WarmupDialog({
  open,
  onOpenChange,
  blockName,
  unit,
  prefill,
  onInsert,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  blockName: string;
  unit: Unit;
  prefill: number | null;
  onInsert: (displayWeight: number) => void;
}) {
  const [weight, setWeight] = useState(prefill != null ? String(prefill) : "");
  // Re-seed the prefill each time the dialog opens.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current)
      setWeight(prefill != null ? String(prefill) : "");
    wasOpen.current = open;
  }, [open, prefill]);

  function insert() {
    const w = Number.parseFloat(weight);
    if (Number.isFinite(w) && w > 0) {
      onInsert(w);
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add warm-up sets" className="md:max-w-xs">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-2xs font-medium tracking-wide text-faint uppercase">
              Working weight ({unit})
            </span>
            <Input
              inputMode="decimal"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  insert();
                }
              }}
              autoFocus
              className="num"
              data-testid={`block-${blockName}-warmup-weight`}
            />
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={insert}
            data-testid={`block-${blockName}-warmup-insert`}
          >
            <Plus className="size-4" />
            Insert warm-up sets
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Weight-column header doubles as the per-exercise unit-override control: tap →
// kg / lbs / Default. The override lives in exercise_prefs (works on seed rows).
function UnitOverrideMenu({
  header,
  blockName,
  override,
  globalUnit,
  onSet,
}: {
  header: string;
  blockName: string;
  override: Unit | null;
  globalUnit: Unit;
  onSet: (unit: Unit | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const opts: { value: Unit | null; label: string }[] = [
    { value: "kg", label: "kg" },
    { value: "lb", label: "lbs" },
    { value: null, label: `Default (${unitLabel(globalUnit)})` },
  ];
  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Weight unit for this exercise"
        className="flex items-center gap-1 tracking-widest uppercase transition-colors duration-100 hover:text-ink"
        data-testid={`block-${blockName}-unit`}
      >
        {header}
        <ChevronDown className="size-3" />
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div className="floating absolute top-full left-0 z-20 mt-1 min-w-32 py-1">
            {opts.map((o) => (
              <button
                key={o.label}
                type="button"
                onClick={() => {
                  onSet(o.value);
                  setOpen(false);
                }}
                data-testid={`block-${blockName}-unit-${o.value ?? "default"}`}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs normal-case tracking-normal text-soft transition-colors duration-150 hover:bg-surface-hover hover:text-ink"
              >
                {o.label}
                {override === o.value && (
                  <Check className="size-3.5 text-accent" />
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

// Machine setup memory: the strip shows the remembered settings; the dialog
// edits them on the machine row itself, so the same setup appears in every
// future session.
function SetupStrip({
  machine,
  blockName,
}: {
  machine: Machine;
  blockName: string;
}) {
  const summary = (machine.settings ?? [])
    .filter((s) => s.value != null)
    .map((s) => `${s.label} ${s.value}`)
    .join(" · ");
  return (
    <Dialog>
      <DialogTrigger
        className="flex h-8 w-full items-center gap-2 border-b border-border bg-surface-2 px-4 text-left text-2xs text-soft transition-colors duration-150 ease-(--ease-out-quad) hover:bg-surface-hover"
        data-testid={`setup-strip-${blockName}`}
      >
        <Settings2 className="size-4 shrink-0 text-faint" />
        <span className="truncate">
          {machine.brand ? `${machine.brand} · ` : ""}
          {machine.name}
        </span>
        {summary ? (
          <span className="num ml-auto shrink-0 truncate text-faint">
            {summary}
          </span>
        ) : (
          <span className="ml-auto shrink-0 text-faint">set up…</span>
        )}
      </DialogTrigger>
      <DialogContent
        title={`Setup — ${machine.brand ? `${machine.brand} · ` : ""}${machine.name}`}
      >
        <MachineEditor machine={machine} />
      </DialogContent>
    </Dialog>
  );
}

// Committed-value formatter for one column (— when the field is empty).
function committedText(
  key: ColKey,
  set: LoggedSet,
  unit: Unit,
  distUnit: DistanceUnit,
): string {
  switch (key) {
    case "weight":
      return set.weightKg != null
        ? String(toDisplayWeight(set.weightKg, unit))
        : "—";
    case "reps":
      return set.reps != null ? String(set.reps) : "—";
    case "duration":
      return set.durationSec != null ? formatMMSS(set.durationSec) : "—";
    case "distance":
      return set.distanceM != null
        ? String(toDisplayDistance(set.distanceM, distUnit))
        : "—";
  }
}

// Target-value formatter for a not-yet-active seeded set (rep range renders
// as "6–8", same placeholder ActiveRow shows for its own reps field).
function seedText(
  key: ColKey,
  seed: SeedSet,
  unit: Unit,
  distUnit: DistanceUnit,
): string {
  switch (key) {
    case "weight":
      return seed.weightKg != null
        ? String(toDisplayWeight(seed.weightKg, unit))
        : "—";
    case "reps":
      if (seed.repsMax != null) return `${seed.reps ?? ""}–${seed.repsMax}`;
      return seed.reps != null ? String(seed.reps) : "—";
    case "duration":
      return seed.durationSec != null ? formatMMSS(seed.durationSec) : "—";
    case "distance":
      return seed.distanceM != null
        ? String(toDisplayDistance(seed.distanceM, distUnit))
        : "—";
  }
}

// A planned set from the routine/copy seed that hasn't become the active row
// yet — read-only, so the full count the template configured is visible from
// the moment the session starts instead of only the one row being logged.
function UpcomingRow({
  index,
  seed,
  unit,
  distUnit,
  columns,
  showPrevious,
  previous,
}: {
  index: number;
  seed: SeedSet;
  unit: Unit;
  distUnit: DistanceUnit;
  columns: Column[];
  showPrevious: boolean;
  previous: GhostSet | null;
}) {
  const marker = SET_TYPE_MARKERS[seed.setType];
  return (
    <div
      className="col-span-full grid h-8 grid-cols-subgrid items-center gap-x-2 -mx-4 border-t border-border px-4"
      data-testid={`upcoming-${index}`}
    >
      <span className="flex items-center gap-2">
        <StatusRing state="empty" />
        <span
          className={cn(
            "num min-w-3 text-left text-2xs tabular-nums",
            markerColorClass(seed.setType),
            seed.setType !== "normal" && "font-semibold",
          )}
        >
          {marker || index + 1}
        </span>
      </span>
      {showPrevious && (
        <PreviousCell
          previous={previous}
          unit={unit}
          testId={`upcoming-${index}-previous`}
        />
      )}
      {columns.map((c) => (
        <span
          key={c.key}
          className="num text-sm text-faint"
          data-testid={`upcoming-${index}-${c.key}`}
        >
          {seedText(c.key, seed, unit, distUnit)}
        </span>
      ))}
      <span />
    </div>
  );
}

// PREVIOUS reference cell — quiet, tabular; blank when never logged at this
// index. On the draft row it's a tap-to-fill button (see ActiveRow).
function PreviousCell({
  previous,
  unit,
  testId,
}: {
  previous: GhostSet | null;
  unit: Unit;
  testId: string;
}) {
  const text = previous ? previousText(previous, unit) : null;
  return (
    <span
      className="num truncate text-sm text-faint"
      data-testid={testId}
      title={text ?? undefined}
    >
      {text ?? "—"}
    </span>
  );
}

function CommittedRow({
  rows,
  index,
  unit,
  distUnit,
  type,
  columns,
  showPrevious,
  previous,
  prSetIds,
  onSave,
  onSaveType,
  onDelete,
}: {
  rows: LoggedSet[];
  index: number;
  unit: Unit;
  distUnit: DistanceUnit;
  type: ExerciseType;
  columns: Column[];
  showPrevious: boolean;
  previous: GhostSet | null;
  prSetIds: Set<string>;
  onSave: (setId: string, patch: SetPatch) => void;
  onSaveType: (patch: Pick<SetPatch, "setType">) => void;
  onDelete: () => void;
}) {
  const primary = rows[0];
  const secondary = rows[1] ?? null;
  const isPaired = secondary != null;

  const [editingRow, setEditingRow] = useState<LoggedSet | null>(null);
  const [weight, setWeight] = useState("");
  const [reps, setReps] = useState("");
  const [duration, setDuration] = useState("");
  const [distance, setDistance] = useState("");
  const [rirMin, setRirMin] = useState("");
  const [rirMax, setRirMax] = useState("");
  const [rpe, setRpe] = useState("");
  const [note, setNote] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const has = (k: ColKey) => columns.some((c) => c.key === k);
  const effort = supportsEffort(type);
  const setType = (primary.setType as SetType) ?? "normal";
  // A unilateral pair's ᴿ row has its own editable RIR/RPE/note (see the
  // details sheet below) that can diverge from the ᴸ row's after commit —
  // surface it only when it actually differs, so the common untouched-mirror
  // case doesn't clutter both lines with duplicate readouts.
  // Compared through the rendered readout, so a legacy scalar and the
  // equivalent zero-width range don't read as a divergence.
  const secondaryEffortDiffers =
    isPaired && effortReadout(primary) !== effortReadout(secondary);
  const primaryNote = primary.note?.trim() || null;
  const secondaryNote = isPaired ? secondary?.note?.trim() || null : null;
  const notesDiffer = isPaired && primaryNote !== secondaryNote;

  function openDetails(set: LoggedSet) {
    setWeight(
      set.weightKg != null ? String(toDisplayWeight(set.weightKg, unit)) : "",
    );
    setReps(set.reps != null ? String(set.reps) : "");
    setDuration(set.durationSec != null ? formatMMSS(set.durationSec) : "");
    setDistance(
      set.distanceM != null
        ? String(toDisplayDistance(set.distanceM, distUnit))
        : "",
    );
    const fields = rirEditFields(set);
    setRirMin(fields.min);
    setRirMax(fields.max);
    setRpe(set.rpe != null ? String(set.rpe) : "");
    setNote(set.note ?? "");
    setConfirmDelete(false);
    setEditingRow(set);
  }

  function save() {
    if (!editingRow) return;
    const patch: SetPatch = {
      note: note.trim() === "" ? null : note.trim(),
    };
    if (has("weight")) {
      const d = weight.trim() === "" ? null : Number.parseFloat(weight);
      patch.weightKg =
        d == null || Number.isNaN(d) ? null : unit === "lb" ? lbToKg(d) : d;
    }
    if (has("reps")) {
      const r = reps.trim() === "" ? null : Number.parseInt(reps, 10);
      patch.reps = r != null && Number.isNaN(r) ? null : r;
    }
    if (has("duration")) patch.durationSec = parseDuration(duration);
    if (has("distance")) {
      const d = distance.trim() === "" ? null : Number.parseFloat(distance);
      patch.distanceM =
        d == null || Number.isNaN(d)
          ? null
          : distUnit === "km"
            ? kmToM(d)
            : miToM(d);
    }
    if (effort) {
      // Writes always go through the range pair going forward — the legacy
      // scalar column is left null rather than kept alongside it.
      const r = parseLoggedRirFields(rirMin, rirMax);
      patch.rir = null;
      patch.rirMin = r.rirMin;
      patch.rirMax = r.rirMax;
      patch.rpe = rpe.trim() === "" ? null : Number.parseFloat(rpe);
    }
    onSave(editingRow.id, patch);
    setEditingRow(null);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    }
  }

  // e1RM previews live off the fields being edited, so it reacts as you type.
  const showE1rm = has("weight") && has("reps");
  const liveWeightKg =
    weight.trim() === ""
      ? null
      : unit === "lb"
        ? lbToKg(Number.parseFloat(weight))
        : Number.parseFloat(weight);
  const e1rm = showE1rm
    ? e1rmFromEffort(
        liveWeightKg,
        reps.trim() === "" ? null : Number.parseInt(reps, 10),
        {
          // Estimate off the low end of the range — the harder-effort bound.
          // Read through rirRange so a max-only entry still projects, matching
          // the badge rather than silently falling back to plain Epley.
          rir: rirRange(parseLoggedRirFields(rirMin, rirMax))?.min ?? null,
          rpe: rpe.trim() === "" ? null : Number.parseFloat(rpe),
        },
      )
    : null;
  const restLabel =
    primary.restSec != null
      ? formatDurationSeconds(primary.restSec * 1000)
      : null;
  const labelCls = "text-2xs font-medium tracking-wide text-faint uppercase";

  // The ᴿ line's weight cell (note 1: same weight both sides is the norm, the
  // unilateral part is only the reps). A right weight matching the left
  // renders blank — reading as "same as left" — and only a divergent right
  // weight (legacy data, or a post-commit edit via the details sheet) prints
  // its own value. A null right weight with a non-null left is "no value"
  // ("—"), never an implied mirror.
  function rightWeightText(): string {
    if (secondary.weightKg == null) return "—";
    if (primary.weightKg != null && secondary.weightKg === primary.weightKg)
      return "";
    return String(toDisplayWeight(secondary.weightKg, unit));
  }

  return (
    // The row is itself a `subgrid` of the block's grid, and so is each of its
    // ᴸ/ᴿ lines: every line in the block resolves its columns from the same
    // fixed tracks, so the value columns line up across all rows no matter
    // which line carries a divergence badge. The lines keep their own
    // full-bleed background (`-mx-4 px-4` nets to no track offset, so the
    // columns still land where the header row's do).
    <div className="relative col-span-full grid grid-cols-subgrid gap-x-2 -mx-4 border-t border-border px-4">
      <div
        className={cn(
          "relative commit-flash col-span-full grid h-11 grid-cols-subgrid items-center gap-x-2 -mx-4 px-4 transition-colors duration-150 ease-(--ease-out-quad) hover:bg-surface-hover md:h-8",
          // Zebra by physical set (this row's own index — a unilateral pair
          // is one stripe, since it's one CommittedRow), one quiet sage step;
          // hover stays the strongest so the interaction still reads.
          index % 2 === 1 ? "bg-surface-2" : "bg-surface",
          isPaired && "pb-0.5 md:pb-0",
        )}
        data-testid={`committed-${index}`}
      >
        <SetTypeCell
          index={index}
          setType={setType}
          ringState="done"
          onChange={(t) => onSaveType({ setType: t })}
          testId={`committed-${index}-type`}
          sideLabel={isPaired ? "L" : undefined}
        />
        {showPrevious && (
          <PreviousCell
            previous={previous}
            unit={unit}
            testId={`committed-${index}-previous`}
          />
        )}
        {columns.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => openDetails(primary)}
            className="num cursor-pointer text-left text-sm"
            title="Set details"
            data-testid={`committed-${index}-${c.key}`}
          >
            {committedText(c.key, primary, unit, distUnit)}
          </button>
        ))}
        {/* A fixed empty cell keeps the ⋯ right-anchored in the last
            (menu-gutter) track — the ActiveRow's commit button owns the
            track immediately to its left, and every row shares the one
            column template (gridTemplate above), so the draft row's actions
            sit on the same x as every committed row's ⋯. */}
        <span />
        <span className="flex items-center justify-end">
          <Dots
            onClick={() => openDetails(primary)}
            title="Set details"
            data-testid={`set-menu-${index}`}
          />
        </span>

        {/* RIR/RPE readout + per-limb note: rendered as badges OUT of the
            grid flow (absolute, straddling the row's top border) so the
            fixed gutter track never widens for them — the `@2 RPE 8`
            preview and the ᴸ/ᴿ divergence marker stay visible at every
            viewport. */}
        {((effort && (effortReadout(primary) || secondaryEffortDiffers)) ||
          (notesDiffer && primaryNote)) && (
          <span className="pointer-events-none absolute top-0 right-1.5 z-10 flex -translate-y-1/2 items-center gap-1">
            {effort && (effortReadout(primary) || secondaryEffortDiffers) && (
              <span
                className={cn(
                  "num rounded-sm border border-border bg-surface px-1 text-2xs text-faint",
                  // Below `md:` this readout is desktop chrome the narrow row
                  // can't spare — unless it's carrying a pair's divergence, in
                  // which case it has to show alongside the (touch-visible) ⋯
                  // button, or the ᴿ line's readout reads as the whole set's.
                  !secondaryEffortDiffers && "max-md:hidden",
                )}
                data-testid={`committed-${index}-effort`}
              >
                {effortReadout(primary) || "—"}
              </span>
            )}
            {notesDiffer && primaryNote && (
              <span
                className="text-faint"
                title={primaryNote}
                data-testid={`committed-${index}-note`}
              >
                <StickyNote className="size-3.5" />
              </span>
            )}
          </span>
        )}
      </div>

      {prSetIds.has(primary.id) && (
        <span
          className="pointer-events-none absolute top-0.5 right-1.5 text-accent"
          title="Personal record"
          data-testid={`committed-${index}-medal`}
        >
          <Medal className="size-3.5" />
        </span>
      )}

      {/* Right side of a unilateral pair: no ring, no set-type control — both
          belong to the physical set and are controlled from the ᴸ line above.
          No ⋯ either, but tapping any value opens this limb's own details
          sheet, which is where its per-limb RIR/RPE/note are edited. */}
      {isPaired && (
        <div
          className="relative col-span-full grid grid-cols-subgrid items-center gap-x-2 -mx-4 bg-surface px-4 pb-1.5 md:pb-1"
          data-testid={`committed-${index}-right`}
        >
          <span className="num pl-6 text-2xs tabular-nums text-faint md:pl-5">
            {index + 1}ᴿ
          </span>
          {showPrevious && <span />}
          {columns.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => openDetails(secondary)}
              className="num min-h-5 cursor-pointer text-left text-sm text-soft"
              title="Set details"
              data-testid={`committed-${index}-right-${c.key}`}
            >
              {c.key === "weight"
                ? rightWeightText()
                : committedText(c.key, secondary, unit, distUnit)}
            </button>
          ))}
          {(effort && secondaryEffortDiffers) ||
          (notesDiffer && secondaryNote) ? (
            <span className="pointer-events-none absolute top-0.5 right-1.5 z-10 flex items-center gap-1">
              {effort && secondaryEffortDiffers && (
                <span
                  className="num rounded-sm border border-border bg-surface px-1 text-2xs text-faint"
                  data-testid={`committed-${index}-right-effort`}
                >
                  {/* This line only prints when it diverges, so an empty
                      readout would render as nothing at all — identical to the
                      suppressed mirror case. A cleared ᴿ effort says so. */}
                  {effortReadout(secondary) || "—"}
                </span>
              )}
              {notesDiffer && secondaryNote && (
                <span
                  className="text-faint"
                  title={secondaryNote}
                  data-testid={`committed-${index}-right-note`}
                >
                  <StickyNote className="size-3.5" />
                </span>
              )}
            </span>
          ) : null}
          {prSetIds.has(secondary.id) && (
            <span
              className="pointer-events-none absolute top-0.5 right-1.5 text-accent"
              title="Personal record"
              data-testid={`committed-${index}-right-medal`}
            >
              <Medal className="size-3.5" />
            </span>
          )}
        </div>
      )}

      <Dialog
        open={editingRow != null}
        onOpenChange={(o) => !o && setEditingRow(null)}
      >
        <DialogContent
          title={
            isPaired
              ? `Set ${index + 1} (${editingRow === secondary ? "right" : "left"}) details`
              : `Set ${index + 1} details`
          }
          className="md:max-w-sm"
        >
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              {columns.map((c, i) => (
                <div key={c.key} className="flex flex-col gap-1">
                  <span className={labelCls}>
                    {c.key === "weight"
                      ? `Weight (${weightLabel(type, unitLabel(unit))})`
                      : c.key === "reps"
                        ? "Reps"
                        : c.key === "duration"
                          ? "Time (m:ss)"
                          : `Distance (${distUnit})`}
                  </span>
                  {c.key === "weight" ? (
                    <Input
                      inputMode="decimal"
                      value={weight}
                      onChange={(e) => setWeight(e.target.value)}
                      onKeyDown={onKeyDown}
                      autoFocus={i === 0}
                      className="num"
                      data-testid={`edit-${index}-weight`}
                    />
                  ) : c.key === "reps" ? (
                    <Input
                      inputMode="numeric"
                      value={reps}
                      onChange={(e) => setReps(e.target.value)}
                      onKeyDown={onKeyDown}
                      autoFocus={i === 0}
                      className="num"
                      data-testid={`edit-${index}-reps`}
                    />
                  ) : c.key === "duration" ? (
                    <Input
                      inputMode="text"
                      placeholder="m:ss"
                      value={duration}
                      onChange={(e) => setDuration(e.target.value)}
                      onKeyDown={onKeyDown}
                      autoFocus={i === 0}
                      className="num"
                      data-testid={`edit-${index}-duration`}
                    />
                  ) : (
                    <Input
                      inputMode="decimal"
                      value={distance}
                      onChange={(e) => setDistance(e.target.value)}
                      onKeyDown={onKeyDown}
                      autoFocus={i === 0}
                      className="num"
                      data-testid={`edit-${index}-distance`}
                    />
                  )}
                </div>
              ))}
            </div>

            {effort && (
              <div className="flex flex-col gap-3">
                {modifierBindings({
                  rirMin,
                  rirMax,
                  rpe,
                  setRirMin,
                  setRirMax,
                  setRpe,
                }).map((b) => (
                  <ModifierField
                    key={b.config.key}
                    {...b}
                    onKeyDown={onKeyDown}
                    testId={`edit-${index}-${b.config.key}`}
                  />
                ))}
              </div>
            )}

            <label className="flex flex-col gap-1">
              <span className={labelCls}>Note</span>
              <textarea
                rows={3}
                placeholder="e.g. seat height 4, pad on notch 2, felt strong out of the hole…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                data-testid={`edit-${index}-note`}
                className="w-full resize-y rounded-md border border-border-strong bg-surface-2 px-2 py-1.5 text-sm text-ink placeholder:text-faint focus:border-transparent focus:outline-none focus:ring-2 focus:ring-ring/70"
              />
            </label>

            <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border pt-3 text-2xs text-faint">
              <span className="flex items-center gap-1.5">
                <Timer className="size-3.5" />
                Rest{" "}
                <span
                  className="num text-soft"
                  data-testid={`set-rest-${index}`}
                >
                  {restLabel ?? "—"}
                </span>
              </span>
              {showE1rm && (
                <span>
                  e1RM ≈{" "}
                  <span className="num text-soft">
                    {e1rm != null
                      ? `${toDisplayWeight(e1rm, unit)} ${unitLabel(unit)}`
                      : "—"}
                  </span>
                </span>
              )}
            </div>

            <div className="flex items-center justify-between">
              {confirmDelete ? (
                <span className="flex items-center gap-2">
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      setEditingRow(null);
                      onDelete();
                    }}
                    data-testid={`set-menu-${index}-delete-confirm`}
                  >
                    <Trash2 className="size-3.5" />
                    Confirm delete
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setConfirmDelete(true)}
                  data-testid={`set-menu-${index}-delete`}
                >
                  <Trash2 className="size-3.5" />
                  Delete Set
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                onClick={save}
                data-testid={`edit-${index}-save`}
              >
                <Check className="size-4" />
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// RPE is a fixed 0.5-step scale (1–10), not a free-form number — a small
// select keeps it a quick pick and reads as clearly secondary to weight/reps.
const RPE_OPTIONS = Array.from({ length: 19 }, (_, i) => 10 - i * 0.5);

// Set-modifier registry (M4 UI redesign): RIR/RPE are the only two today, but
// the captain expects at most 1-2 more, ever — not an unbounded plugin system.
// A modifier is a small typed value attached to a set, rendered generically in
// the details sheet; adding one is a config entry here, never new layout JSX.
type ModifierConfig = {
  key: "rir" | "rpe";
  label: string;
  kind: "select" | "range";
  options?: number[];
  infoTipLessonId?: LessonId;
};

const SET_MODIFIERS: ModifierConfig[] = [
  { key: "rir", label: "RIR", kind: "range", infoTipLessonId: "rir" },
  { key: "rpe", label: "RPE", kind: "select", options: RPE_OPTIONS },
];

// A bounded min/max pair, always strings (draft-editable text) — same shape
// as the routine editor's rep-range fields.
type RangeValue = { min: string; max: string };

// A registry entry bound to the row state that backs it. Discriminated by
// `kind`, so a modifier's value and its setter can't drift apart in the shape
// they carry — handing a plain string to the range entry is a type error at
// the binding, not a crash on `range.min` at render.
type ModifierBinding = { config: ModifierConfig } & (
  | { kind: "range"; value: RangeValue; onChange: (v: RangeValue) => void }
  | { kind: "scalar"; value: string; onChange: (v: string) => void }
);

// Both row types (draft and committed) bind the same registry to the same
// three pieces of state, so the wiring lives here once rather than as a
// duplicated ternary at each call site.
function modifierBindings(state: {
  rirMin: string;
  rirMax: string;
  rpe: string;
  setRirMin: (v: string) => void;
  setRirMax: (v: string) => void;
  setRpe: (v: string) => void;
}): ModifierBinding[] {
  return SET_MODIFIERS.map((config) =>
    config.kind === "range"
      ? {
          config,
          kind: "range",
          value: { min: state.rirMin, max: state.rirMax },
          onChange: (v: RangeValue) => {
            state.setRirMin(v.min);
            state.setRirMax(v.max);
          },
        }
      : { config, kind: "scalar", value: state.rpe, onChange: state.setRpe },
  );
}

// Shared field renderer for every modifier — the label row reserves a fixed
// height (`min-h-6`) whether or not it carries an InfoTip icon, so RIR and RPE
// (or a future third modifier) always sit flush in the same grid row instead
// of drifting by the icon's height, and the select gets the exact classes as
// the shared Input so its box never looks "elevated" next to a sibling field.
function ModifierField(
  props: ModifierBinding & {
    onKeyDown?: (e: React.KeyboardEvent) => void;
    autoFocus?: boolean;
    testId: string;
  },
) {
  const { config, onKeyDown, autoFocus, testId } = props;
  const label = (
    <span className="flex min-h-6 items-center gap-1 text-2xs font-medium tracking-wide text-faint uppercase">
      {config.label}
      {config.infoTipLessonId && <InfoTip lessonId={config.infoTipLessonId} />}
    </span>
  );

  if (props.kind === "range") {
    const range = props.value;
    const onRangeChange = props.onChange;
    return (
      <div className="flex flex-col gap-1">
        {label}
        <div className="flex items-center gap-1">
          <Input
            inputMode="numeric"
            placeholder="—"
            value={range.min}
            onChange={(e) => onRangeChange({ ...range, min: e.target.value })}
            onKeyDown={onKeyDown}
            autoFocus={autoFocus}
            className="num"
            data-testid={`${testId}min`}
          />
          <span className="text-2xs text-faint">–</span>
          <Input
            inputMode="numeric"
            placeholder="—"
            value={range.max}
            onChange={(e) => onRangeChange({ ...range, max: e.target.value })}
            onKeyDown={onKeyDown}
            className="num"
            data-testid={`${testId}max`}
          />
        </div>
      </div>
    );
  }

  const { value, onChange } = props;
  return (
    <div className="flex flex-col gap-1">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        // biome-ignore lint/a11y/noAutofocus: focuses the just-added field
        autoFocus={autoFocus}
        data-testid={testId}
        className="num h-8 w-full border border-border-strong bg-surface px-2 text-sm text-soft transition-colors duration-150 ease-(--ease-out-quad) focus:border-transparent focus:outline-none focus:ring-2 focus:ring-ring/70"
      >
        <option value="">—</option>
        {config.options?.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </div>
  );
}

// Imperative escape hatch for voice logging: fills weight/reps as if typed,
// converting kg to this row's own display unit. Never commits — same as a
// manual edit, an explicit commit (Enter / Add set) still has to follow.
type ActiveRowHandle = {
  // Returns false when this row's type has no field the values could land in,
  // so the caller can report the miss instead of leaving the row blank.
  applyVoice: (values: {
    weightKg: number | null;
    reps: number | null;
  }) => boolean;
  // Commits the current draft (same path as Enter / the check button) — the
  // block-level "Add set" button drives this imperatively since it renders
  // outside the row.
  commit: (adoptGhost: boolean) => void;
};

function ActiveRow({
  seId,
  index,
  unit,
  distUnit,
  type,
  columns,
  showPrevious,
  previous,
  seed,
  nextSeedType,
  ghost,
  hasGhost,
  enabledMetrics,
  autoFocusWeight,
  barLoaded,
  exerciseLaterality,
  onOpenPlates,
  timerRunning,
  timerStartedAt,
  onToggleTimer,
  onCommit,
  ref,
}: {
  seId: string;
  index: number;
  unit: Unit;
  distUnit: DistanceUnit;
  type: ExerciseType;
  columns: Column[];
  showPrevious: boolean;
  previous: GhostSet | null;
  seed: SeedSet | undefined;
  nextSeedType: string | null;
  ghost: GhostSet;
  hasGhost: boolean;
  enabledMetrics: Metric[];
  autoFocusWeight: boolean;
  barLoaded: boolean;
  exerciseLaterality: string | null;
  onOpenPlates: (target: number | null) => void;
  timerRunning: boolean;
  timerStartedAt: number | null;
  onToggleTimer: () => void;
  onCommit: (set: CommitInput, ctx: CommitCtx) => void;
  ref: Ref<ActiveRowHandle>;
}) {
  // Restore any uncommitted keystrokes persisted for this block (draft wins over
  // the routine/copy seed once the user has started typing).
  const [draft] = useState<Partial<DraftSnapshot> | null>(() =>
    loadDraft(seId),
  );
  // Per-set laterality override ("just this one set", note 1): toggled from
  // the details sheet, seeded from the draft snapshot so a reload restores
  // the ᴿ line and the right-side keystrokes it protects. Local to this row,
  // so it dies on commit or remount — the next draft at the same index
  // starts from the exercise default again.
  const [lateralityOverride, setLateralityOverride] =
    useState<Laterality | null>(() => draft?.laterality ?? null);
  // Override wins over the exercise default.
  const laterality = lateralityOverride ?? exerciseLaterality;
  const isUnilateral = laterality === "unilateral";
  // Hidden for alternating exercises — their sets are all alternating, so a
  // per-set unilateral override would contradict the exercise-level semantics.
  const lateralityEditable = exerciseLaterality !== "alternating";
  // Seed the draft from the routine target / copied set for this index. A rep
  // range seeds only a placeholder (never a concrete reps value).
  const [weight, setWeight] = useState(
    () =>
      draft?.weight ??
      (seed?.weightKg != null
        ? String(toDisplayWeight(seed.weightKg, unit))
        : ""),
  );
  const [reps, setReps] = useState(
    () =>
      draft?.reps ??
      (seed && seed.repsMax == null && seed.reps != null
        ? String(seed.reps)
        : ""),
  );
  const [duration, setDuration] = useState(
    () =>
      draft?.duration ??
      (seed?.durationSec != null ? formatMMSS(seed.durationSec) : ""),
  );
  const [distance, setDistance] = useState(
    () =>
      draft?.distance ??
      (seed?.distanceM != null
        ? String(toDisplayDistance(seed.distanceM, distUnit))
        : ""),
  );
  const [rirMin, setRirMin] = useState(() => draft?.rirMin ?? "");
  const [rirMax, setRirMax] = useState(() => draft?.rirMax ?? "");
  const [rpe, setRpe] = useState(() => draft?.rpe ?? "");
  const [note, setNote] = useState(() => draft?.note ?? "");
  // Right side of a unilateral pair. Blank means "mirror the left value" —
  // the input shows it as a faint placeholder; typing here overrides it. The
  // right side has NO weight field (note 1: same weight both sides — the
  // unilateral part is only the reps), so only reps/duration/distance live
  // here.
  const [rReps, setRReps] = useState(() => draft?.rReps ?? "");
  const [rDuration, setRDuration] = useState(() => draft?.rDuration ?? "");
  const [rDistance, setRDistance] = useState(() => draft?.rDistance ?? "");
  const [setType, setSetType] = useState<SetType>(
    () => draft?.setType ?? seed?.setType ?? "normal",
  );
  const [metricDraft, setMetricDraft] = useState<Record<string, string>>(
    () => draft?.metricDraft ?? {},
  );
  // Optional per-set fields the user opts into via the ⋯ menu (RIR / RPE /
  // note / custom metrics). Nothing shows until explicitly added.
  const [extras, setExtras] = useState<Set<string>>(
    () => new Set(draft?.extras ?? []),
  );
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const done = useRef(false);
  const rowRef = useRef<HTMLDivElement>(null);
  // Set when the "…" button opens the details sheet: Radix moves focus into
  // the dialog once it mounts, blurring whichever weight/reps input was
  // focused. That blur reaches onFieldBlur/onRightFieldBlur just like a
  // real tap-away would, so without this it auto-checks the set off the
  // moment the sheet opens. Consumed by the next blur, or cleared when the
  // sheet closes without one (e.g. it opened while neither field was
  // focused).
  const suppressCheckoffRef = useRef(false);
  const moreCellRef = useRef<HTMLSpanElement>(null);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  // Mirror uncommitted keystrokes to localStorage so a reload restores them.
  // rWeight deliberately isn't saved: the right side has no weight input (note
  // 1) — legacy drafts that carry one are read for nothing.
  useEffect(() => {
    saveDraft(seId, {
      weight,
      reps,
      duration,
      distance,
      rirMin,
      rirMax,
      rpe,
      note,
      setType,
      extras: [...extras],
      metricDraft,
      rReps,
      rDuration,
      rDistance,
      laterality: lateralityOverride,
    });
  }, [
    seId,
    weight,
    reps,
    duration,
    distance,
    rirMin,
    rirMax,
    rpe,
    note,
    setType,
    extras,
    metricDraft,
    rReps,
    rDuration,
    rDistance,
    lateralityOverride,
  ]);

  // Closing without a field blur ever landing (e.g. the sheet opened while
  // neither weight nor reps had focus) leaves the guard armed — clear it on
  // every close, however the sheet was dismissed, so a later genuine
  // tap-away isn't swallowed too.
  useEffect(() => {
    if (!detailsOpen) suppressCheckoffRef.current = false;
  }, [detailsOpen]);

  function openPlates() {
    onOpenPlates(weight.trim() === "" ? null : Number.parseFloat(weight));
  }

  const f = TYPE_FIELDS[type];
  const effort = supportsEffort(type);

  useImperativeHandle(
    ref,
    () => ({
      applyVoice({ weightKg, reps: repsValue }) {
        let applied = false;
        if (f.weight && weightKg != null) {
          setWeight(String(toDisplayWeight(weightKg, unit)));
          applied = true;
        }
        if (f.reps && repsValue != null) {
          setReps(String(repsValue));
          applied = true;
        }
        return applied;
      },
      commit,
    }),
    // No deps array: `commit` closes over every field's current value and is
    // a fresh function every render, so memoizing this against a partial dep
    // list (the old [f.weight, f.reps, unit]) would expose a stale `commit`
    // to the ref holder whenever some other field changed without those three.
  );

  // Live stopwatch readout while this row's timer runs (ticks each second).
  useEffect(() => {
    if (!timerRunning) return;
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [timerRunning]);
  const liveElapsed =
    timerRunning && timerStartedAt != null
      ? Math.max(0, Math.floor((Date.now() - timerStartedAt) / 1000))
      : null;
  const durationDisplay =
    liveElapsed != null ? formatMMSS(liveElapsed) : duration;

  // Custom per-exercise metrics stay opt-in (their count is unbounded, unlike
  // the fixed RIR/RPE modifier set) — toggled on from inside the details
  // sheet itself, where the newly-revealed input also lives.
  function toggleExtra(key: string) {
    setExtras((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setLastAdded(key);
  }

  // Stop → capture elapsed into the duration field; start → begin the session
  // timer (which is exclusive, so any other running row's stops). Typing the
  // time by hand stays available whenever the timer isn't running.
  function toggleTimer() {
    if (liveElapsed != null) setDuration(formatMMSS(liveElapsed));
    onToggleTimer();
  }

  const ghostWeight =
    ghost.weightKg != null ? toDisplayWeight(ghost.weightKg, unit) : null;
  const ghostReps = ghost.reps != null ? String(ghost.reps) : null;
  const ghostDuration =
    ghost.durationSec != null ? formatMMSS(ghost.durationSec) : null;
  const ghostDistance =
    ghost.distanceM != null
      ? String(toDisplayDistance(ghost.distanceM, distUnit))
      : null;
  // Rep-range placeholder ("8–12") when the routine seeds a range at this index.
  const repRangePlaceholder =
    seed?.repsMax != null ? `${seed.reps ?? ""}–${seed.repsMax}` : null;

  // Tap the PREVIOUS cell → autofill this draft row from last time.
  function fillFromPrevious() {
    if (!previous) return;
    if (f.weight && previous.weightKg != null)
      setWeight(String(toDisplayWeight(previous.weightKg, unit)));
    if (f.reps && previous.reps != null) setReps(String(previous.reps));
    if (f.duration && previous.durationSec != null)
      setDuration(formatMMSS(previous.durationSec));
    if (f.distance && previous.distanceM != null)
      setDistance(String(toDisplayDistance(previous.distanceM, distUnit)));
    // An uneven pair last time restores uneven — otherwise the left fill
    // above already mirrors across as a placeholder. The right side has no
    // weight field (note 1: same weight both sides), so only a divergent
    // right REP is restored; a legacy divergent weight is dropped on fill.
    const other = previous.otherSide;
    if (isUnilateral && other) {
      if (f.reps && other.reps != null) setRReps(String(other.reps));
      if (f.duration && other.durationSec != null)
        setRDuration(formatMMSS(other.durationSec));
      if (f.distance && other.distanceM != null)
        setRDistance(String(toDisplayDistance(other.distanceM, distUnit)));
    }
  }

  function metricValues(): Record<string, unknown> | null {
    const out: Record<string, unknown> = {};
    for (const m of enabledMetrics) {
      const raw = (metricDraft[m.id] ?? "").trim();
      if (raw === "") continue;
      out[m.id] =
        m.type === "number" || m.type === "scale"
          ? Number.parseFloat(raw)
          : m.type === "checkbox"
            ? raw === "true"
            : raw;
    }
    return Object.keys(out).length ? out : null;
  }

  function parseFields(adoptGhost: boolean) {
    let weightKg: number | null = null;
    let repsN: number | null = null;
    let durationSec: number | null = null;
    let distanceM: number | null = null;
    if (f.weight) {
      const d = weight.trim() === "" ? null : Number.parseFloat(weight);
      weightKg =
        d == null || Number.isNaN(d) ? null : unit === "lb" ? lbToKg(d) : d;
    }
    if (f.reps) {
      const r = reps.trim() === "" ? null : Number.parseInt(reps, 10);
      repsN = r != null && Number.isNaN(r) ? null : r;
    }
    if (f.duration) durationSec = parseDuration(durationDisplay);
    if (f.distance) {
      const d = distance.trim() === "" ? null : Number.parseFloat(distance);
      distanceM =
        d == null || Number.isNaN(d)
          ? null
          : distUnit === "km"
            ? kmToM(d)
            : miToM(d);
    }
    if (adoptGhost && hasGhost) {
      // Enter on empty fields accepts the ghost values (tap-to-accept).
      if (f.weight) weightKg = weightKg ?? ghost.weightKg ?? null;
      if (f.reps) repsN = repsN ?? ghost.reps ?? null;
      if (f.duration) durationSec = durationSec ?? ghost.durationSec ?? null;
      if (f.distance) distanceM = distanceM ?? ghost.distanceM ?? null;
    }
    return { weightKg, reps: repsN, durationSec, distanceM };
  }

  // Right side of a unilateral pair: mirrors the left's resolved values
  // (symmetric by default) — only a field actually typed into here overrides
  // its left counterpart. Weight has no right-side input (note 1: same weight
  // both sides); the right row copies the left's weight at commit.
  function parseRightFields(left: ReturnType<typeof parseFields>) {
    const weightKg = left.weightKg;
    let repsN = left.reps;
    let durationSec = left.durationSec;
    let distanceM = left.distanceM;
    if (f.reps && rReps.trim() !== "") {
      const r = Number.parseInt(rReps, 10);
      repsN = Number.isNaN(r) ? null : r;
    }
    if (f.duration && rDuration.trim() !== "")
      durationSec = parseDuration(rDuration);
    if (f.distance && rDistance.trim() !== "") {
      const d = Number.parseFloat(rDistance);
      distanceM =
        d == null || Number.isNaN(d)
          ? null
          : distUnit === "km"
            ? kmToM(d)
            : miToM(d);
    }
    return { weightKg, reps: repsN, durationSec, distanceM };
  }

  function commit(adoptGhost: boolean) {
    if (done.current) return;
    const v = parseFields(adoptGhost);
    const parsedRir = parseLoggedRirFields(rirMin, rirMax);
    const anyPresent =
      (f.weight && v.weightKg != null) ||
      (f.reps && v.reps != null) ||
      (f.duration && v.durationSec != null) ||
      (f.distance && v.distanceM != null);
    if (!anyPresent) return;
    done.current = true;
    clearDraft(seId);
    if (timerRunning) onToggleTimer();
    onCommit(
      {
        weightKg: v.weightKg,
        reps: v.reps,
        setType,
        durationSec: v.durationSec,
        distanceM: v.distanceM,
        // New logging always writes the range pair, never the legacy scalar.
        rir: null,
        rirMin: effort ? parsedRir.rirMin : null,
        rirMax: effort ? parsedRir.rirMax : null,
        rpe: effort && rpe.trim() !== "" ? Number.parseFloat(rpe) : null,
        note: note.trim() === "" ? null : note.trim(),
        metricValues: metricValues(),
        side: isUnilateral ? "left" : null,
        otherSide: isUnilateral ? parseRightFields(v) : null,
      },
      { exerciseType: type, nextSetType: nextSeedType },
    );
  }

  // Wired to the row's data inputs only — deliberately not to the details-sheet
  // fields, where Enter must stay a newline in the note textarea rather than
  // commit the set out from under a sheet the user still has open.
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(true);
    }
  }

  // Auto-checkoff: once both weight and reps carry a typed value, leaving
  // either field commits the set — no separate confirm tap required. Doesn't
  // adopt ghost values (unlike Enter's tap-to-accept), so it never silently
  // pulls in an untyped duration/distance alongside it.
  //
  // Paired (unilateral) rows re-scope this: blurring a ᴸ field never commits
  // — only leaving the ᴿ line does, and only once the ᴸ line is complete.
  // Otherwise the moment you tab off "weight" into "reps" would half-log the
  // set before the right side ever gets a chance to mirror or override.
  function onFieldBlur(e: React.FocusEvent<HTMLInputElement>) {
    if (suppressCheckoffRef.current) {
      suppressCheckoffRef.current = false;
      return;
    }
    // Tab out of reps lands on the "…" trigger — mousedown-preventDefault
    // only covers pointers, so nothing has armed the guard above. Committing
    // here unmounts that trigger mid-Tab, putting set details out of reach of
    // the keyboard on a complete-but-uncommitted row.
    const next = e.relatedTarget as Node | null;
    if (next && moreCellRef.current?.contains(next)) return;
    if (isUnilateral) return;
    if (weight.trim() !== "" && reps.trim() !== "") commit(false);
  }

  // Guards against committing mid-override: tabbing from one ᴿ field to the
  // next (e.g. reps → duration) blurs the former while the ᴸ line is already
  // complete, which would otherwise auto-commit before the override is even
  // typed. (The ᴿ weight input this guard originally described is gone —
  // same weight both sides, note 1.) Only fires once focus actually leaves
  // this row.
  function onRightFieldBlur(e: React.FocusEvent<HTMLInputElement>) {
    if (suppressCheckoffRef.current) {
      suppressCheckoffRef.current = false;
      return;
    }
    const next = e.relatedTarget as Node | null;
    if (next && rowRef.current?.contains(next)) return;
    if (weight.trim() !== "" && reps.trim() !== "") commit(false);
  }

  // One input cell per data column (weight / reps / time / distance). The time
  // cell also carries the inline stopwatch control. `last` picks the mobile
  // keyboard's Return-key hint — "next" mid-row, "done" on the row's final
  // field (iOS numeric/decimal keypads often have no Return key at all
  // regardless of this hint, so it's a best-effort nicety, not the mobile
  // advance path — that's the checkmark / "Add set").
  function dataCell(key: ColKey, autoFocus: boolean, last: boolean) {
    const enterKeyHint = last ? "done" : "next";
    if (key === "weight") {
      return (
        <Field
          key={key}
          className="px-0 leading-5"
          inputMode="decimal"
          enterKeyHint={enterKeyHint}
          placeholder={
            ghostWeight != null ? String(ghostWeight) : unitLabel(unit)
          }
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onFieldBlur}
          autoFocus={autoFocus}
          data-testid={`set-${index}-weight`}
        />
      );
    }
    if (key === "reps")
      return (
        <Field
          key={key}
          className="px-0 leading-5"
          inputMode="numeric"
          enterKeyHint={enterKeyHint}
          placeholder={repRangePlaceholder ?? ghostReps ?? "reps"}
          value={reps}
          onChange={(e) => setReps(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onFieldBlur}
          autoFocus={autoFocus}
          data-testid={`set-${index}-reps`}
        />
      );
    if (key === "distance")
      return (
        <Field
          key={key}
          className="px-0 leading-5"
          inputMode="decimal"
          enterKeyHint={enterKeyHint}
          placeholder={ghostDistance ?? distUnit}
          value={distance}
          onChange={(e) => setDistance(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus={autoFocus}
          data-testid={`set-${index}-distance`}
        />
      );
    // duration
    return (
      <span key={key} className="flex items-center gap-1">
        <Field
          className="px-0 leading-5"
          inputMode="text"
          enterKeyHint={enterKeyHint}
          placeholder={ghostDuration ?? "m:ss"}
          value={durationDisplay}
          readOnly={timerRunning}
          onChange={(e) => setDuration(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus={autoFocus}
          data-testid={`set-${index}-duration`}
        />
        <IconButton
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleTimer}
          title={timerRunning ? "Stop timer" : "Start timer"}
          className={cn(
            timerRunning &&
              "border-accent bg-accent text-accent-fg hover:bg-accent hover:text-accent-fg",
            !timerRunning && "text-soft",
          )}
          data-testid={`set-${index}-timer`}
        >
          {timerRunning ? (
            <Square className="size-3.5" />
          ) : (
            <Play className="size-3.5" />
          )}
        </IconButton>
      </span>
    );
  }

  // Right-side input for a unilateral pair. Placeholder mirrors the left
  // line's own typed value (live, as faint text) so the pair reads as
  // symmetric until overridden — typing here just makes the row uneven. No
  // weight field: the weight is shared (note 1), so the ᴿ line's weight cell
  // is an empty span that keeps the columns aligned.
  function rDataCell(key: ColKey) {
    if (key === "weight") return <span key={key} aria-hidden="true" />;
    if (key === "reps")
      return (
        <Field
          key={key}
          className="px-0 leading-5"
          inputMode="numeric"
          placeholder={
            reps.trim() !== ""
              ? reps
              : (repRangePlaceholder ?? ghostReps ?? "reps")
          }
          value={rReps}
          onChange={(e) => setRReps(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onRightFieldBlur}
          data-testid={`set-${index}-right-reps`}
        />
      );
    if (key === "distance")
      return (
        <Field
          key={key}
          className="px-0 leading-5"
          inputMode="decimal"
          placeholder={
            distance.trim() !== "" ? distance : (ghostDistance ?? distUnit)
          }
          value={rDistance}
          onChange={(e) => setRDistance(e.target.value)}
          onKeyDown={onKeyDown}
          data-testid={`set-${index}-right-distance`}
        />
      );
    // duration — no second timer button: one physical set has one clock.
    return (
      <Field
        key={key}
        className="px-0 leading-5"
        inputMode="text"
        placeholder={
          duration.trim() !== "" ? duration : (ghostDuration ?? "m:ss")
        }
        value={rDuration}
        onChange={(e) => setRDuration(e.target.value)}
        onKeyDown={onKeyDown}
        data-testid={`set-${index}-right-duration`}
      />
    );
  }

  // Compact preview of what's filled in next to the details-sheet trigger —
  // mirrors CommittedRow's collapsed RIR/RPE readout, so the same information
  // is visible without opening the sheet on either row type.
  const modifierPreview = effort
    ? effortReadout({
        ...parseLoggedRirFields(rirMin, rirMax),
        rpe: rpe.trim() === "" ? null : Number.parseFloat(rpe),
      })
    : "";

  return (
    <div
      ref={rowRef}
      className="relative col-span-full grid grid-cols-subgrid gap-x-2 -mx-4 border-t border-border px-4"
    >
      <div
        className={cn(
          "col-span-full grid h-11 grid-cols-subgrid items-center gap-x-2 -mx-4 px-4 md:h-8",
          // Zebra continues the committed rows' alternation by physical-set
          // index, so the draft row reads as the next stripe in the block —
          // one quiet sage step; committed rows keep the stronger hover.
          index % 2 === 1 ? "bg-surface-2" : "bg-surface",
        )}
      >
        <SetTypeCell
          index={index}
          setType={setType}
          ringState="empty"
          onChange={setSetType}
          testId={`set-${index}-type`}
          sideLabel={isUnilateral ? "L" : undefined}
        />
        {showPrevious && (
          <button
            type="button"
            // Keep the input focused so tapping doesn't blur it.
            onMouseDown={(e) => e.preventDefault()}
            onClick={fillFromPrevious}
            disabled={!previous}
            title={previous ? "Fill from last time" : undefined}
            className="num truncate text-left text-sm text-faint transition-colors duration-100 enabled:hover:text-ink disabled:cursor-default"
            data-testid={`set-${index}-previous`}
          >
            {previous ? (previousText(previous, unit) ?? "—") : "—"}
          </button>
        )}
        {columns.map((c, i) =>
          dataCell(c.key, autoFocusWeight && i === 0, i === columns.length - 1),
        )}
        {/* Commit + details share the two right-most fixed tracks (commit +
            menu-gutter) inside one guard span, so tabbing into either button
            can't check the set off. The check sits at the far right, right of
            the ⋯ (note 2) — the ⋯ claims the commit track so the ✓ lands at
            the same x as every committed row's ⋯. ⋯ is first in DOM (Tab
            from the last input lands on details). */}
        <span
          ref={moreCellRef}
          className="col-span-2 flex items-center justify-end gap-1"
        >
          <Dots
            onClick={() => {
              // Opening the sheet is about to steal focus from weight/reps
              // via Radix's own auto-focus — arm the guard so that blur
              // doesn't read as "done with this row" and check it off.
              suppressCheckoffRef.current = true;
              setDetailsOpen(true);
            }}
            // Keep the weight/reps input focused so tapping doesn't blur it
            // — Safari doesn't focus buttons on tap.
            onMouseDown={(e) => e.preventDefault()}
            title="Set details"
            data-testid={`set-${index}-more`}
          />
          <IconButton
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => commit(true)}
            title="Mark set done"
            className="text-ink"
            data-testid={`set-${index}-done`}
          >
            <Check className="size-4" />
          </IconButton>
        </span>
      </div>

      {/* RIR/RPE draft preview: the same badge out of the grid flow as the
          committed rows', so the fixed gutter never widens for it. */}
      {modifierPreview && (
        <span className="num pointer-events-none absolute top-0 right-1.5 z-10 -translate-y-1/2 rounded-sm border border-border bg-surface px-1 text-2xs text-faint">
          {modifierPreview}
        </span>
      )}

      {/* Right side of a unilateral pair: no ring, no ⋯ — set type/RIR/RPE/
          note are entered once above and seed both rows at commit. Only set
          type stays shared after that; post-commit RIR/RPE/note are per-limb,
          edited from each committed row's own details sheet. */}
      {isUnilateral && (
        <div className="col-span-full mt-1 grid grid-cols-subgrid items-center gap-x-2">
          <span className="num pl-6 text-2xs tabular-nums text-faint">
            {index + 1}ᴿ
          </span>
          {showPrevious && <span />}
          {columns.map((c) => rDataCell(c.key))}
          <span />
        </div>
      )}

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent
          title={`Set ${index + 1} details`}
          className="md:max-w-sm"
        >
          <div className="flex flex-col gap-4">
            {lateralityEditable && (
              <label className="flex items-start gap-2 rounded-md border border-border bg-surface-2 p-2">
                <input
                  type="checkbox"
                  checked={isUnilateral}
                  onChange={(e) =>
                    setLateralityOverride(
                      e.target.checked ? "unilateral" : "bilateral",
                    )
                  }
                  className="mt-0.5 size-4 shrink-0 accent-(--accent)"
                  data-testid={`set-${index}-unilateral`}
                />
                <span className="text-xs text-soft">
                  <span className="font-medium text-ink">Unilateral</span>
                  <br />
                  Just this set: same weight both sides, log each side's reps
                  separately.
                </span>
              </label>
            )}
            {effort && (
              <div className="flex flex-col gap-3">
                {modifierBindings({
                  rirMin,
                  rirMax,
                  rpe,
                  setRirMin,
                  setRirMax,
                  setRpe,
                }).map((b) => (
                  <ModifierField
                    key={b.config.key}
                    {...b}
                    autoFocus={lastAdded === b.config.key}
                    testId={`set-${index}-${b.config.key}`}
                  />
                ))}
              </div>
            )}
            <label className="flex flex-col gap-1">
              <span className="text-2xs font-medium tracking-wide text-faint uppercase">
                Note
              </span>
              <textarea
                rows={3}
                placeholder="// note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                data-testid={`set-${index}-note`}
                className="w-full resize-y rounded-md border border-border-strong bg-surface-2 px-2 py-1.5 text-sm text-ink placeholder:text-faint focus:border-transparent focus:outline-none focus:ring-2 focus:ring-ring/70"
              />
            </label>
            {enabledMetrics
              .filter((m) => extras.has(m.id))
              .map((m) => (
                <div key={m.id} className="flex flex-col gap-1">
                  <span className="text-2xs font-medium tracking-wide text-faint uppercase">
                    {m.name}
                  </span>
                  {m.type === "checkbox" ? (
                    <input
                      type="checkbox"
                      checked={metricDraft[m.id] === "true"}
                      onChange={(e) =>
                        setMetricDraft((d) => ({
                          ...d,
                          [m.id]: e.target.checked ? "true" : "",
                        }))
                      }
                      className="size-4 justify-self-start accent-(--accent)"
                      data-testid={`set-${index}-metric-${m.id}`}
                    />
                  ) : (
                    <Input
                      inputMode={m.type === "text" ? undefined : "decimal"}
                      placeholder={m.type === "text" ? m.name : "0"}
                      value={metricDraft[m.id] ?? ""}
                      onChange={(e) =>
                        setMetricDraft((d) => ({
                          ...d,
                          [m.id]: e.target.value,
                        }))
                      }
                      autoFocus={lastAdded === m.id}
                      className="num"
                      data-testid={`set-${index}-metric-${m.id}`}
                    />
                  )}
                </div>
              ))}
            {enabledMetrics.some((m) => !extras.has(m.id)) && (
              <div className="flex flex-wrap gap-1.5 border-t border-border pt-3">
                {enabledMetrics
                  .filter((m) => !extras.has(m.id))
                  .map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => toggleExtra(m.id)}
                      data-testid={`set-${index}-add-${m.id}`}
                      className="flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-2xs text-soft transition-colors duration-100 hover:bg-surface-hover hover:text-ink"
                    >
                      <Plus className="size-3" />
                      {m.name}
                    </button>
                  ))}
              </div>
            )}
            {barLoaded && (
              <button
                type="button"
                onClick={() => {
                  setDetailsOpen(false);
                  openPlates();
                }}
                data-testid={`set-${index}-plates`}
                className="flex items-center gap-2 border-t border-border pt-3 text-left text-xs text-soft transition-colors duration-150 hover:text-ink"
              >
                <Calculator className="size-3.5" />
                Plate calculator
              </button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Top-bar duration readout that doubles as the pause / edit-start control
// (Hevy: tapping the stopwatch opens Pause·Resume and start-date/time edits).
// Duration = (end | now) − started − paused; freezes while paused.
function SessionDurationControl({
  startedAt,
  endedAt,
  paused,
  pausedMs,
  pauseStartedAt,
  onTogglePause,
  onEditStart,
}: {
  startedAt: number;
  endedAt: number | null;
  paused: boolean;
  pausedMs: number;
  pauseStartedAt: number | null;
  onTogglePause: () => void;
  onEditStart: (ms: number) => void;
}) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (endedAt != null || paused) return;
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [endedAt, paused]);

  const nowRef = paused && pauseStartedAt != null ? pauseStartedAt : Date.now();
  const duration = Math.max(0, (endedAt ?? nowRef) - startedAt - pausedMs);

  return (
    <span className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Duration · pause / edit start"
        className={cn(
          "num flex h-8 items-center gap-1 rounded-md px-1.5 text-xs transition-colors duration-100",
          paused
            ? "bg-accent-soft text-accent"
            : "text-soft hover:bg-surface-hover",
        )}
        data-testid="session-duration"
      >
        {paused && <Pause className="size-3.5" />}
        {formatDurationSeconds(duration)}
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div className="floating absolute top-full right-0 z-20 mt-1 min-w-52 p-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                onTogglePause();
                setOpen(false);
              }}
              data-testid="session-pause-toggle"
            >
              {paused ? (
                <>
                  <Play className="size-3.5" />
                  Resume
                </>
              ) : (
                <>
                  <Pause className="size-3.5" />
                  Pause
                </>
              )}
            </Button>
            <div className="mt-2 flex flex-col gap-1">
              <span className="text-2xs font-medium tracking-wide text-faint uppercase">
                Start
              </span>
              <Input
                type="datetime-local"
                className="num"
                value={toLocalInput(startedAt)}
                onChange={(e) => {
                  const ms = new Date(e.target.value).getTime();
                  if (Number.isFinite(ms)) onEditStart(ms);
                }}
                data-testid="session-start-input"
              />
            </div>
          </div>
        </>
      )}
    </span>
  );
}

function RestTimer({ since }: { since: number | null }) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (since === null) return;
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [since]);

  if (since === null) return null;
  const total = Math.floor((Date.now() - since) / 1000);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return (
    <span className="num flex h-8 shrink-0 items-center gap-2 rounded-md bg-translucent px-2 text-xs text-soft shadow-(--inset-control)">
      <Timer className="size-4" />
      {m}:{s}
    </span>
  );
}
