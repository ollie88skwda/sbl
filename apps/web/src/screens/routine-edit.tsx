import {
  EXERCISE_TYPES,
  type Exercise,
  type ExerciseType,
  groupByPrimaryMuscle,
  isConfidentMatch,
  matchExerciseName,
  type NewRoutineInput,
  type ParsedExercise,
  parseRoutineText,
  type RoutineExerciseInput,
  type SetType,
  sameExerciseName,
  TYPE_FIELDS,
} from "@frog/core";
import { Select } from "@radix-ui/themes";
import {
  ArrowDown,
  ArrowUp,
  ClipboardPaste,
  Link2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ExerciseEditor } from "@/components/exercise-editor";
import {
  ExerciseFilterBar,
  filterExercises,
} from "@/components/exercise-filter";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SetTypeCell } from "@/components/ui/set-type-cell";
import { formatMMSS, parseDuration, parseIntOrNull } from "@/lib/format";
import { usePendingExercises } from "@/lib/pending-exercises";
import { useExercises } from "@/lib/queries";
import { parseTargetRirFields } from "@/lib/rir";
import {
  useCreateRoutine,
  useRoutineDetail,
  useRoutineFolders,
  useUpdateRoutine,
} from "@/lib/routine-queries";
import { useUnit } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useVoice } from "@/lib/voice";

// Draft model for the builder: targets in DISPLAY units (converted to kg on
// save). Rep range mode = repsMax non-empty.
type DraftSet = {
  key: string;
  setType: SetType;
  reps: string;
  repsMax: string;
  duration: string; // mm:ss or seconds
  distance: string; // km/mi display
  rirMin: string; // target RIR range (reps-based types only)
  rirMax: string;
  // Not authored here (the weight input was dropped from the builder) but
  // carried through the draft so a save doesn't erase a generator-seeded or
  // session-written-back target — updateRoutine re-creates the set graph from
  // this input rather than merging into it. Null for genuinely new sets.
  existingTargetWeightKg: number | null;
};

type DraftExercise = {
  key: string;
  exerciseId: string;
  name: string;
  exerciseType: ExerciseType;
  supersetGroup: number | null;
  restSec: number | null;
  note: string;
  sets: DraftSet[];
};

// A parsed "paste workout" line whose exercise name didn't fuzzy-match
// anything in the library — surfaced for the user to resolve, never dropped
// or guessed.
type UnmatchedLine = ParsedExercise & { key: string };

// A pasted line the parser couldn't read at all (no set×rep token, or no
// name beside one). Surfaced so a partial import is never silent — pasted
// text has no id and can repeat verbatim, hence the generated key.
type UnparsedLine = { key: string; text: string };

// A pasted line parsing to more sets than this is almost certainly a
// misread (e.g. weight×reps like "80x5" read as sets×reps, or a stray
// digit run) rather than a real prescription — route it to the unmatched
// list instead of materializing hundreds of DraftSet rows.
const MAX_PARSED_SETS = 20;

// What a line whose set count was rejected as implausible falls back to once
// the user resolves it by hand: the reps were readable, the count wasn't.
const FALLBACK_SETS = 3;

// A multi-week program pasted at once (150-250 set×rep lines) would render
// one full non-virtualized DraftExercise editor per line — cuts against the
// "lightweight & fast" requirement the set-count cap already protects at the
// set level. Cap exercises per parse too; overflow is reported, not dropped
// silently.
const MAX_PARSED_EXERCISES = 50;

// Radix Select forbids empty-string values; this sentinel stands in for the
// null case (no folder) and maps back to null at the boundary.
const NO_FOLDER = "__none__";

// A fresh set's target RIR range default: "leave a little in the tank" for
// most working sets (RIR ≈ 10 − RPE; 1-2 RIR ≈ RPE 8-9). Editable per set.
const DEFAULT_RIR_MIN = "1";
const DEFAULT_RIR_MAX = "2";

function emptySet(): DraftSet {
  return {
    key: crypto.randomUUID(),
    setType: "normal",
    reps: "",
    repsMax: "",
    duration: "",
    distance: "",
    rirMin: DEFAULT_RIR_MIN,
    rirMax: DEFAULT_RIR_MAX,
    existingTargetWeightKg: null,
  };
}

// + Add set inherits the prescription (reps/range/duration/distance/RIR
// range) from the previous set — not weight (intentionally variable
// set-to-set, e.g. ramping/drop sets) and not setType (a warmup/failure/drop
// label carried forward would silently mislabel a new working set).
function inheritedSet(prev: DraftSet | undefined): DraftSet {
  const base = emptySet();
  return prev
    ? {
        ...base,
        reps: prev.reps,
        repsMax: prev.repsMax,
        duration: prev.duration,
        distance: prev.distance,
        rirMin: prev.rirMin,
        rirMax: prev.rirMax,
      }
    : base;
}

function exerciseTypeOf(e: Exercise | undefined): ExerciseType {
  const t = e?.exerciseType as ExerciseType | undefined;
  return t && (EXERCISE_TYPES as readonly string[]).includes(t)
    ? t
    : "weight_reps";
}

// Shared by the exercise picker and the paste-workout parser — same
// DraftExercise shape either way, just a different starting set of `sets`.
function draftFromExercise(e: Exercise, sets: DraftSet[]): DraftExercise {
  return {
    key: crypto.randomUUID(),
    exerciseId: e.id,
    name: e.name,
    exerciseType: exerciseTypeOf(e),
    supersetGroup: null,
    restSec: e.defaultRestSec ?? null,
    note: "",
    sets,
  };
}

// A fresh "Add exercise" pick (not resolving a parsed/pasted line, which
// already carries its own reps) — prefills the exercise's own default rep
// range instead of three blank sets.
function defaultSetsFor(e: Exercise): DraftSet[] {
  const reps = e.defaultRepsMin != null ? String(e.defaultRepsMin) : "";
  const repsMax = e.defaultRepsMax != null ? String(e.defaultRepsMax) : "";
  return [emptySet(), emptySet(), emptySet()].map((s) => ({
    ...s,
    reps,
    repsMax,
  }));
}

function setsFromParsed(p: ParsedExercise): DraftSet[] {
  // A count over MAX_PARSED_SETS is precisely why the line was routed to the
  // unmatched list (a misread like weight×reps "80x5"), so materializing it —
  // even clamped — hands the user 20 rows to delete. Keep the readable half
  // (the reps) and fall back to a normal set count for the rest.
  const count = p.sets > MAX_PARSED_SETS ? FALLBACK_SETS : Math.max(1, p.sets);
  return Array.from({ length: count }, () => ({
    ...emptySet(),
    reps: p.reps != null ? String(p.reps) : "",
    repsMax: p.repsMax != null ? String(p.repsMax) : "",
  }));
}

// The picker's filter is a literal `includes`, strictly stricter than the
// fuzzy matcher that just failed on this same raw name — seeding the whole
// line would open the picker on zero results. The longest lettered word is
// the most distinctive part and keeps real candidates on screen.
function pickerSeed(rawName: string): string {
  return rawName
    .split(/[^a-zA-Z0-9]+/)
    .filter((w) => /[a-zA-Z]/.test(w))
    .reduce((best, w) => (w.length > best.length ? w : best), "");
}

export default function RoutineEditScreen() {
  const { id } = useParams(); // undefined on /routines/new
  const navigate = useNavigate();
  const { unit } = useUnit();
  const { t } = useVoice();
  const {
    data: exercises = [],
    isSuccess: libraryLoaded,
    isError: libraryFailed,
  } = useExercises();
  // Saving the routine inserts routine_exercises against a real FK, so a row
  // whose own create is still queued can't be drafted in.
  const pendingExercises = usePendingExercises();
  const { data: folders = [] } = useRoutineFolders();
  const { data: detail, isError: detailFailed } = useRoutineDetail(id ?? null);
  const createRoutine = useCreateRoutine();
  const updateRoutine = useUpdateRoutine();

  const [name, setName] = useState<string | null>(null);
  const [folderId, setFolderId] = useState<string | null | undefined>(
    undefined,
  );
  const [drafts, setDrafts] = useState<DraftExercise[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [muscle, setMuscle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Paste-workout import: raw text -> matched drafts + a resolvable
  // unmatched list. `pickFor` routes the (shared) exercise picker's
  // selection back into a specific unmatched line instead of a fresh add.
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [unmatched, setUnmatched] = useState<UnmatchedLine[]>([]);
  const [unparsed, setUnparsed] = useState<UnparsedLine[]>([]);
  const [overflowCount, setOverflowCount] = useState(0);
  const [pickFor, setPickFor] = useState<UnmatchedLine | null>(null);
  // "Create exercise…" opens the shared editor prefilled with the raw line;
  // pendingTwinCreate resolves every unmatched line sharing that name once
  // the new row lands in `exercises` (the editor itself is optimistic and
  // closes instantly, but the twin draft rows need the real exerciseType).
  const [creatingFor, setCreatingFor] = useState<UnmatchedLine | null>(null);
  const [pendingTwinCreate, setPendingTwinCreate] = useState<{
    id: string;
    forRawName: string;
  } | null>(null);

  const byId = useMemo(
    () => new Map(exercises.map((e) => [e.id, e])),
    [exercises],
  );

  // Read by createFromUnmatched after its await, where the render-time
  // `unmatched` closure would be stale — a line dismissed or picked while the
  // create was in flight must not come back as a draft row.
  const unmatchedRef = useRef(unmatched);
  unmatchedRef.current = unmatched;

  // Seed the draft once when editing an existing routine.
  const seeded = detail && drafts === null && id;
  if (seeded) {
    setName(detail.routine.name);
    setFolderId(detail.routine.folderId);
    setDrafts(
      detail.exercises.map((re) => ({
        key: crypto.randomUUID(),
        exerciseId: re.exerciseId,
        name: re.exerciseName,
        exerciseType: exerciseTypeOf(byId.get(re.exerciseId)),
        supersetGroup: re.supersetGroup,
        restSec: re.restSec,
        note: re.note ?? "",
        sets: re.sets.map((s) => ({
          key: crypto.randomUUID(),
          setType: (s.setType as SetType) ?? "normal",
          reps: s.targetReps != null ? String(s.targetReps) : "",
          repsMax: s.targetRepsMax != null ? String(s.targetRepsMax) : "",
          duration:
            s.targetDurationSec != null ? formatMMSS(s.targetDurationSec) : "",
          distance:
            s.targetDistanceM != null
              ? String(
                  Math.round(
                    (s.targetDistanceM / (unit === "kg" ? 1000 : 1609.344)) *
                      100,
                  ) / 100,
                )
              : "",
          // A pre-existing set with no authored target RIR shows blank, not
          // the fresh-set default — fabricating "1-2" for old data would
          // claim a prescription that was never made.
          rirMin: s.targetRirMin != null ? String(s.targetRirMin) : "",
          rirMax: s.targetRirMax != null ? String(s.targetRirMax) : "",
          existingTargetWeightKg: s.targetWeightKg ?? null,
        })),
      })),
    );
  }

  const list = drafts ?? [];
  const routineName = name ?? "";

  // Shared gate for every action that mutates the draft on /routines/:id.
  // Any of them makes `drafts` non-null, which permanently disables the
  // seed-once block above — so an Add/Paste that lands before the saved
  // routine arrives would leave its exercises unloaded and let Save
  // overwrite them with only the new rows.
  const draftReady = !id || drafts !== null;
  // Resolved-but-absent counts as broken too: without a seed, saving would
  // replace the routine's contents with whatever was added since.
  const detailBroken = detailFailed || detail === null;

  function patchExercise(i: number, patch: Partial<DraftExercise>) {
    setDrafts((prev) =>
      (prev ?? []).map((d, j) => (j === i ? { ...d, ...patch } : d)),
    );
  }

  function patchSet(i: number, si: number, patch: Partial<DraftSet>) {
    setDrafts((prev) =>
      (prev ?? []).map((d, j) =>
        j === i
          ? {
              ...d,
              sets: d.sets.map((s, k) => (k === si ? { ...s, ...patch } : s)),
            }
          : d,
      ),
    );
  }

  function move(i: number, dir: -1 | 1) {
    setDrafts((prev) => {
      const arr = [...(prev ?? [])];
      const j = i + dir;
      if (j < 0 || j >= arr.length) return arr;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return arr;
    });
  }

  // Superset toggle: joins this exercise with the NEXT one (Hevy pairs any
  // two exercises; adjacent pairing covers the common case without a second
  // picker — reorder first, then link).
  function toggleSupersetWithNext(i: number) {
    setDrafts((prev) => {
      const arr = [...(prev ?? [])];
      if (i + 1 >= arr.length) return arr;
      const cur = arr[i];
      const next = arr[i + 1];
      if (
        cur.supersetGroup != null &&
        cur.supersetGroup === next.supersetGroup
      ) {
        // Unlink the pair (next keeps group if a third member follows it).
        arr[i] = { ...cur, supersetGroup: null };
        const third = arr[i + 2];
        if (!third || third.supersetGroup !== next.supersetGroup)
          arr[i + 1] = { ...next, supersetGroup: null };
        return arr;
      }
      const group =
        cur.supersetGroup ??
        next.supersetGroup ??
        Math.max(0, ...arr.map((d) => (d.supersetGroup ?? -1) + 1));
      arr[i] = { ...cur, supersetGroup: group };
      arr[i + 1] = { ...next, supersetGroup: group };
      return arr;
    });
  }

  // Parse the pasted text against the current library, split matches (go
  // straight into the draft, same as picking one by hand) from misses (held
  // in `unmatched` for the user to resolve — never saved, never guessed).
  function parsePaste() {
    if (!draftReady) {
      setPasteError(
        t(
          "This routine is still loading — try again in a moment.",
          "The frog hasn't finished reading this routine. One moment.",
        ),
      );
      return;
    }
    // Matching against a library that hasn't loaded marks every line
    // unmatched, and "Create exercise" would then duplicate rows that already
    // exist — refuse to parse until the real list is in hand.
    if (!libraryLoaded) {
      setPasteError(
        libraryFailed
          ? t(
              "Couldn't load your exercise library. Reload before pasting a workout.",
              "The frog lost your library. Reload before you paste.",
            )
          : t(
              "Your exercise library is still loading — try again in a moment.",
              "The frog is still unpacking your library. One moment.",
            ),
      );
      return;
    }
    const parsed = parseRoutineText(pasteText);
    if (parsed.exercises.length === 0) {
      setPasteError(
        t(
          "No exercises found in that text.",
          "The frog found nothing to chew on there.",
        ),
      );
      return;
    }
    const exercisesToProcess = parsed.exercises.slice(0, MAX_PARSED_EXERCISES);
    const overflow = parsed.exercises.length - exercisesToProcess.length;
    const matchedDrafts: DraftExercise[] = [];
    const misses: UnmatchedLine[] = [];
    for (const p of exercisesToProcess) {
      // An implausible set count (likely a misread, not a real prescription)
      // always goes to the unmatched list for manual review, even if the
      // name matched cleanly — never auto-add a hundreds-of-sets draft row.
      const raw =
        p.sets <= MAX_PARSED_SETS
          ? matchExerciseName(p.rawName, exercises)
          : null;
      // Same confidence bar as voice logging (isConfidentMatch's default):
      // the merged matcher's scoring is more generous than this file's old
      // Jaccard formula was, so reusing that formula's old looser threshold
      // here would silently accept shorthand it used to reject (a bare
      // "row" against a library that also has "Barbell Bent Over Row").
      // A tie (two candidates scoring equally) is never auto-picked either;
      // it falls to "Pick manually" same as a low-confidence miss.
      const match =
        raw && raw.tied.length === 1 && isConfidentMatch(raw) ? raw : null;
      if (match)
        matchedDrafts.push(draftFromExercise(match, setsFromParsed(p)));
      else misses.push({ ...p, key: crypto.randomUUID() });
    }
    if (parsed.name && !name) setName(parsed.name);
    setDrafts((prev) => [...(prev ?? []), ...matchedDrafts]);
    setUnmatched((prev) => [...prev, ...misses]);
    setUnparsed((prev) => [
      ...prev,
      ...parsed.unparsed.map((text) => ({ key: crypto.randomUUID(), text })),
    ]);
    if (overflow > 0) setOverflowCount((prev) => prev + overflow);
    setPasteOpen(false);
    setPasteText("");
    setPasteError(null);
  }

  function pickManually(u: UnmatchedLine) {
    setQuery(pickerSeed(u.rawName));
    setPickFor(u);
    setPicking(true);
  }

  // Opens the shared editor prefilled with the raw line, instead of a bare
  // one-tap create — the primary action now produces a real record (report
  // §5.3), not a metadata-free row (mechanic/equipment/muscles all null).
  function createFromUnmatched(u: UnmatchedLine) {
    setCreatingFor(u);
  }

  // The editor's onCreated fires the instant Save is tapped (optimistic —
  // it doesn't wait on the network), so the new row lands in `exercises` on
  // the very next render; this resolves once it does.
  useEffect(() => {
    if (!pendingTwinCreate) return;
    // Wait for the create to settle: resolving against the still-pending
    // optimistic row binds the draft to an id that a publish dupe-hit then
    // drops (the RPC backstop's canonical row supersedes it — the editor
    // re-fires onCreated with that id, which re-points this effect at the
    // row that actually exists).
    if (pendingExercises.has(pendingTwinCreate.id)) return;
    const created = exercises.find((e) => e.id === pendingTwinCreate.id);
    if (!created) return;
    // A routine can name the same lift twice (main sets + a backoff line),
    // possibly with a plural mismatch ("Tricep Pushdowns" / "Tricep
    // Pushdown") — sameExerciseName is the matcher's own equality, so twin
    // detection can't drift from what matchExerciseName itself considers
    // one exercise. Resolve every unmatched line sharing this name against
    // the row we just created rather than leaving a button that
    // duplicates it.
    const twins = unmatchedRef.current.filter((x) =>
      sameExerciseName(x.rawName, pendingTwinCreate.forRawName),
    );
    setDrafts((prev) => [
      ...(prev ?? []),
      ...twins.map((x) => draftFromExercise(created, setsFromParsed(x))),
    ]);
    setUnmatched((prev) =>
      prev.filter(
        (x) => !sameExerciseName(x.rawName, pendingTwinCreate.forRawName),
      ),
    );
    setPendingTwinCreate(null);
  }, [pendingTwinCreate, exercises, pendingExercises]);

  function selectFromPicker(e: Exercise) {
    if (pickFor) {
      // Same twin resolution as createFromUnmatched: a routine can name the
      // same lift twice (main sets + a backoff line), so picking one exercise
      // for this line also resolves every sibling unmatched line sharing its
      // name, instead of leaving a Create-exercise button that would mint a
      // different row for the same lift.
      const twins = unmatchedRef.current.filter((x) =>
        sameExerciseName(x.rawName, pickFor.rawName),
      );
      setDrafts((prev) => [
        ...(prev ?? []),
        ...twins.map((x) => draftFromExercise(e, setsFromParsed(x))),
      ]);
      setUnmatched((prev) =>
        prev.filter((x) => !sameExerciseName(x.rawName, pickFor.rawName)),
      );
      setPickFor(null);
    } else {
      setDrafts((prev) => [
        ...(prev ?? []),
        draftFromExercise(e, defaultSetsFor(e)),
      ]);
    }
    setPicking(false);
    setQuery("");
    setMuscle("");
  }

  function toInput(): NewRoutineInput {
    const exercisesInput: RoutineExerciseInput[] = list.map((d, i) => ({
      exerciseId: d.exerciseId,
      orderIndex: i,
      supersetGroup: d.supersetGroup,
      restSec: d.restSec,
      note: d.note.trim() || null,
      sets: d.sets.map((s, si) => {
        const fields = TYPE_FIELDS[d.exerciseType];
        const reps = parseIntOrNull(s.reps);
        const repsMax = parseIntOrNull(s.repsMax);
        // An inverted range is unreadable as a prescription — drop it rather
        // than persist bounds the session UI would render backwards. The
        // session's logging path swaps instead (a performed set is data, not a
        // prescription); both rules live in lib/rir.ts.
        const { rirMin, rirMax } = parseTargetRirFields(s.rirMin, s.rirMax);
        return {
          setNo: si,
          setType: s.setType,
          // Weight is no longer authored ahead of time (dropped from the
          // form), but an existing target still round-trips: Update Routine
          // Values and the generator both write it, and updateRoutine
          // re-creates the set graph from this input rather than merging.
          targetWeightKg: s.existingTargetWeightKg ?? null,
          targetReps: fields.reps ? reps : null,
          targetRepsMax: fields.reps ? repsMax : null,
          targetDurationSec: fields.duration ? parseDuration(s.duration) : null,
          targetDistanceM: (() => {
            if (!fields.distance || s.distance.trim() === "") return null;
            const v = Number.parseFloat(s.distance);
            if (!Number.isFinite(v)) return null;
            return unit === "kg" ? v * 1000 : v * 1609.344;
          })(),
          targetRirMin: fields.reps ? rirMin : null,
          targetRirMax: fields.reps ? rirMax : null,
        };
      }),
    }));
    return {
      name: routineName.trim() || "Untitled routine",
      folderId: folderId ?? null,
      exercises: exercisesInput,
    };
  }

  async function save() {
    if (saving || !draftReady) return;
    if (
      unmatched.length > 0 &&
      !window.confirm(
        `${unmatched.length} pasted line${unmatched.length === 1 ? "" : "s"} from "Paste workout" ${unmatched.length === 1 ? "is" : "are"} still unresolved and will be left out of this save. Continue?`,
      )
    )
      return;
    setSaving(true);
    setError(null);
    try {
      const input = toInput();
      if (id) await updateRoutine.mutateAsync({ routineId: id, patch: input });
      else await createRoutine.mutateAsync(input);
      navigate("/routines");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      setSaving(false);
    }
  }

  const grouped = useMemo(
    () => groupByPrimaryMuscle(filterExercises(exercises, query, muscle)),
    [exercises, query, muscle],
  );

  // Superset color coding: group index → accent border tint.
  const supersetClass = (g: number | null) =>
    g == null ? "" : "border-l-2 border-l-accent";

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 pb-20 md:pb-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold tracking-tight">
          {id ? "Edit routine" : "New routine"}
        </h1>
        {/* TODO(lessons): <InfoTip lessonId="programming-a-routine" /> once copy exists */}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => navigate("/routines")}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={saving || list.length === 0 || !draftReady}
            data-testid="routine-save-btn"
          >
            {saving ? "Saving…" : "Save routine"}
          </Button>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Input
          size="3"
          placeholder="Routine name"
          value={routineName}
          onChange={(e) => setName(e.target.value)}
          // sm:flex-1, not flex-1: below `sm` this row is flex-col, and a
          // flex-basis:0 item there ignores its own explicit height (collapses
          // to content size) — only grow to fill width once the row is
          // actually a row. Mobile already gets full width from the default
          // align-items:stretch cross-axis behavior.
          className="sm:flex-1"
          data-testid="routine-name-input"
        />
        <Select.Root
          value={folderId ?? NO_FOLDER}
          onValueChange={(v) => setFolderId(v === NO_FOLDER ? null : v)}
          size="2"
        >
          <Select.Trigger
            variant="surface"
            className="w-full sm:w-40"
            data-testid="routine-folder-select"
          />
          <Select.Content>
            <Select.Item value={NO_FOLDER}>No folder</Select.Item>
            {folders.map((f) => (
              <Select.Item key={f.id} value={f.id}>
                {f.name}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </div>

      {/* Frog frames the failure; the exact error stays outside t() so the
          fact survives every register. */}
      {error && (
        <p className="mt-3 text-xs text-neg">
          {t("Save failed.", "The frog is annoyed (your draft is safe).")}{" "}
          {error}
        </p>
      )}

      {!draftReady && (
        <p
          className={cn(
            "mt-3 text-xs",
            detailBroken ? "text-neg" : "text-soft",
          )}
          data-testid="routine-detail-status"
        >
          {detailBroken
            ? t(
                "Couldn't load this routine. Reload before editing it — saving now would overwrite it.",
                "The frog lost this routine. Reload before you edit it.",
              )
            : t("Loading this routine…", "The frog is reading your routine…")}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-3">
        {list.map((d, i) => {
          const fields = TYPE_FIELDS[d.exerciseType];
          const linkedWithNext =
            i + 1 < list.length &&
            d.supersetGroup != null &&
            list[i + 1].supersetGroup === d.supersetGroup;
          return (
            <div
              key={d.key}
              className={cn(
                "rounded-lg border border-border bg-surface p-3",
                supersetClass(d.supersetGroup),
              )}
              data-testid={`routine-ex-${i}`}
            >
              <div className="flex items-center gap-2">
                <span className="flex-1 truncate text-sm font-medium">
                  {d.name}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Move up"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                >
                  <ArrowUp className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Move down"
                  onClick={() => move(i, 1)}
                  disabled={i === list.length - 1}
                >
                  <ArrowDown className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={
                    linkedWithNext ? "Remove superset" : "Superset with next"
                  }
                  className={cn(linkedWithNext && "text-accent")}
                  onClick={() => toggleSupersetWithNext(i)}
                  disabled={i === list.length - 1 && !linkedWithNext}
                  data-testid={`routine-ex-${i}-superset`}
                >
                  <Link2 className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove exercise"
                  onClick={() =>
                    setDrafts((prev) => (prev ?? []).filter((_, j) => j !== i))
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>

              <div className="mt-2">
                <Input
                  placeholder="Exercise note (shows every session)"
                  value={d.note}
                  onChange={(e) => patchExercise(i, { note: e.target.value })}
                  className="h-8 w-full text-xs"
                  data-testid={`routine-ex-${i}-note`}
                />
              </div>

              <div className="num mt-2 grid grid-cols-[2.5rem_1fr_1fr_2rem] items-center gap-1 text-2xs text-faint">
                <span>SET</span>
                {fields.reps ? (
                  <span>RIR</span>
                ) : fields.duration && !fields.weight ? (
                  <span>TIME</span>
                ) : (
                  <span />
                )}
                {fields.reps ? (
                  <span>REPS</span>
                ) : fields.distance ? (
                  <span>{unit === "kg" ? "KM" : "MI"}</span>
                ) : fields.weight && fields.duration ? (
                  <span>TIME</span>
                ) : (
                  <span />
                )}
                <span />
              </div>

              {d.sets.map((s, si) => (
                <div
                  key={s.key}
                  className={cn(
                    "-mx-3 grid grid-cols-[2.5rem_1fr_1fr_2rem] items-center gap-1 border-t border-border px-3",
                    si % 2 === 0 ? "bg-surface" : "bg-surface-2",
                  )}
                >
                  <SetTypeCell
                    setType={s.setType}
                    index={si}
                    onChange={(t) => patchSet(i, si, { setType: t })}
                    testId={`routine-ex-${i}-set-${si}-type`}
                  />
                  {fields.reps ? (
                    <div className="flex items-center gap-1">
                      <Field
                        inputMode="numeric"
                        placeholder="RIR"
                        value={s.rirMin}
                        onChange={(e) =>
                          patchSet(i, si, { rirMin: e.target.value })
                        }
                        className="flex-1 min-w-0"
                        data-testid={`routine-ex-${i}-set-${si}-rirmin`}
                      />
                      <span className="text-2xs text-faint">–</span>
                      <Field
                        inputMode="numeric"
                        placeholder="RIR"
                        title="Target RIR range max"
                        value={s.rirMax}
                        onChange={(e) =>
                          patchSet(i, si, { rirMax: e.target.value })
                        }
                        className="flex-1 min-w-0"
                        data-testid={`routine-ex-${i}-set-${si}-rirmax`}
                      />
                    </div>
                  ) : fields.duration && !fields.weight ? (
                    <Field
                      inputMode="numeric"
                      placeholder="mm:ss"
                      value={s.duration}
                      onChange={(e) =>
                        patchSet(i, si, { duration: e.target.value })
                      }
                    />
                  ) : (
                    <span />
                  )}
                  {fields.reps ? (
                    <div className="flex items-center gap-1">
                      <Field
                        inputMode="numeric"
                        placeholder="reps"
                        value={s.reps}
                        onChange={(e) =>
                          patchSet(i, si, { reps: e.target.value })
                        }
                        className="flex-1 min-w-0"
                        data-testid={`routine-ex-${i}-set-${si}-reps`}
                      />
                      <span className="text-2xs text-faint">–</span>
                      <Field
                        inputMode="numeric"
                        placeholder="max"
                        title="Optional rep-range max"
                        value={s.repsMax}
                        onChange={(e) =>
                          patchSet(i, si, { repsMax: e.target.value })
                        }
                        className="flex-1 min-w-0"
                        data-testid={`routine-ex-${i}-set-${si}-repsmax`}
                      />
                    </div>
                  ) : fields.distance ? (
                    <Field
                      inputMode="decimal"
                      placeholder="—"
                      value={s.distance}
                      onChange={(e) =>
                        patchSet(i, si, { distance: e.target.value })
                      }
                    />
                  ) : fields.weight && fields.duration ? (
                    <Field
                      inputMode="numeric"
                      placeholder="mm:ss"
                      value={s.duration}
                      onChange={(e) =>
                        patchSet(i, si, { duration: e.target.value })
                      }
                    />
                  ) : (
                    <span />
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove set"
                    onClick={() =>
                      patchExercise(i, {
                        sets: d.sets.filter((_, k) => k !== si),
                      })
                    }
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              ))}

              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() =>
                  patchExercise(i, {
                    sets: [...d.sets, inheritedSet(d.sets.at(-1))],
                  })
                }
                data-testid={`routine-ex-${i}-add-set`}
              >
                <Plus className="size-4" /> Add set
              </Button>
            </div>
          );
        })}
      </div>

      {unmatched.length > 0 && (
        <div className="mt-4 flex flex-col gap-2">
          <p className="text-xs text-warn">
            {t(
              `${unmatched.length} pasted line${unmatched.length === 1 ? "" : "s"} didn't match a library exercise.`,
              `The frog couldn't place ${unmatched.length} line${unmatched.length === 1 ? "" : "s"}. Pick one or teach it a name.`,
            )}
          </p>
          {unmatched.map((u) => (
            <div
              key={u.key}
              className="rounded-lg border border-border border-l-2 border-l-warn bg-surface p-3"
              data-testid={`routine-unmatched-${u.key}`}
            >
              {/* Stacked on phones: the name is what the user is resolving,
                and three actions on one row leave it unreadable at 375px. */}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {u.rawName}{" "}
                  <span className="num text-2xs text-faint">
                    {u.sets}×{u.reps ?? "?"}
                    {u.repsMax ? `–${u.repsMax}` : ""}
                  </span>
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => pickManually(u)}
                    data-testid={`routine-unmatched-${u.key}-pick`}
                  >
                    Pick manually
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => createFromUnmatched(u)}
                    data-testid={`routine-unmatched-${u.key}-create`}
                  >
                    Create exercise…
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Dismiss"
                    onClick={() =>
                      setUnmatched((prev) =>
                        prev.filter((x) => x.key !== u.key),
                      )
                    }
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {unparsed.length > 0 && (
        <div
          className="mt-4 rounded-lg border border-border bg-surface p-3"
          data-testid="routine-unparsed"
        >
          <div className="flex items-start gap-2">
            <p className="flex-1 text-xs text-soft">
              {t(
                `${unparsed.length} pasted line${unparsed.length === 1 ? "" : "s"} had no set×rep to read and ${unparsed.length === 1 ? "was" : "were"} left out.`,
                `The frog couldn't read ${unparsed.length} line${unparsed.length === 1 ? "" : "s"} — no set×rep in ${unparsed.length === 1 ? "it" : "them"}.`,
              )}
            </p>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Dismiss unreadable lines"
              onClick={() => setUnparsed([])}
            >
              <X className="size-4" />
            </Button>
          </div>
          <ul className="mt-1 flex flex-col gap-0.5">
            {unparsed.map((line) => (
              <li key={line.key} className="truncate text-xs text-faint">
                {line.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {overflowCount > 0 && (
        <div
          className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-surface p-3"
          data-testid="routine-paste-overflow"
        >
          <p className="flex-1 text-xs text-soft">
            {t(
              `Stopped after ${MAX_PARSED_EXERCISES} exercises per paste — ${overflowCount} more line${overflowCount === 1 ? "" : "s"} ${overflowCount === 1 ? "was" : "were"} left out. Paste the rest separately.`,
              `The frog stopped at ${MAX_PARSED_EXERCISES} exercises — ${overflowCount} more line${overflowCount === 1 ? "" : "s"} for another paste.`,
            )}
          </p>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Dismiss overflow notice"
            onClick={() => setOverflowCount(0)}
          >
            <X className="size-4" />
          </Button>
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <Button
          variant="outline"
          className="flex-1"
          onClick={() => setPicking(true)}
          disabled={!draftReady}
          data-testid="routine-add-exercise-btn"
        >
          <Plus className="size-4" /> Add exercise
        </Button>
        <Button
          variant="outline"
          className="flex-1"
          onClick={() => setPasteOpen(true)}
          disabled={!draftReady}
          data-testid="routine-paste-btn"
        >
          <ClipboardPaste className="size-4" /> Paste workout
        </Button>
      </div>

      <Dialog
        open={picking}
        onOpenChange={(o) => {
          setPicking(o);
          if (!o) {
            setPickFor(null);
            setQuery("");
            setMuscle("");
          }
        }}
      >
        <DialogContent
          title={pickFor ? "Match exercise" : "Add exercise"}
          className="max-h-[80vh] overflow-y-auto"
        >
          {pickFor && (
            <p className="mb-2 text-2xs text-faint">
              Matching "{pickFor.rawName}"
            </p>
          )}
          <ExerciseFilterBar
            query={query}
            onQuery={setQuery}
            muscle={muscle}
            onMuscle={setMuscle}
            autoFocus
          />
          <div className="mt-2 flex flex-col gap-3">
            {grouped.length === 0 && (
              <p className="text-xs text-faint">
                {t(
                  "No exercises match your search.",
                  "No exercises match. The frog refuses to speculate.",
                )}
              </p>
            )}
            {grouped.map((g) => (
              <div key={g.key}>
                <p className="text-2xs font-medium tracking-widest text-faint uppercase">
                  {g.label}
                </p>
                <div className="mt-1 flex flex-col">
                  {g.items.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      disabled={pendingExercises.has(e.id)}
                      title={
                        pendingExercises.has(e.id)
                          ? `${e.name} is still saving`
                          : undefined
                      }
                      className="flex h-10 items-center rounded-md px-2 text-left text-sm hover:bg-surface-2 disabled:opacity-50 disabled:hover:bg-transparent"
                      onClick={() => selectFromPicker(e)}
                      data-testid={`routine-pick-${e.name}`}
                    >
                      {e.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <ExerciseEditor
        open={!!creatingFor}
        onOpenChange={(o) => !o && setCreatingFor(null)}
        mode="create"
        initialName={creatingFor?.rawName ?? ""}
        onCreated={(id) => {
          // The pasted line, not the name the user saved: the unmatched list
          // is keyed by raw line, so a corrected spelling in the sheet would
          // match none of it and silently resolve nothing.
          if (creatingFor)
            setPendingTwinCreate({ id, forRawName: creatingFor.rawName });
        }}
      />

      <Dialog
        open={pasteOpen}
        onOpenChange={(o) => {
          setPasteOpen(o);
          if (!o) {
            setPasteText("");
            setPasteError(null);
          }
        }}
      >
        <DialogContent
          title="Paste workout"
          className="max-h-[80vh] overflow-y-auto"
        >
          <p className="text-xs text-faint">
            {t(
              'Paste or type a routine, one exercise per line — e.g. "Bench press 4x8". Unmatched exercises can be picked or created afterward.',
              'Feed the frog your scrawl, one exercise per line — e.g. "Bench press 4x8". Anything it can\'t place gets sorted out after.',
            )}
          </p>
          <textarea
            rows={8}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={
              "Push day\nBench press 4x8\nIncline dumbbell press 3x10\nTricep pushdown 3x12"
            }
            className="mt-2 w-full resize-y rounded-md border border-border-strong bg-surface-2 px-2 py-1.5 text-sm text-ink placeholder:text-faint focus:border-transparent focus:outline-none focus:ring-2 focus:ring-ring/70"
            data-testid="routine-paste-textarea"
          />
          {pasteError && <p className="mt-2 text-xs text-neg">{pasteError}</p>}
          {libraryFailed && (
            <p
              className="mt-2 text-xs text-neg"
              data-testid="routine-library-status"
            >
              {t(
                "Couldn't load your exercise library. Reload before pasting a workout.",
                "The frog lost your library. Reload before you paste.",
              )}
            </p>
          )}
          <Button
            variant="primary"
            className="mt-2 w-full"
            onClick={parsePaste}
            disabled={!pasteText.trim() || !libraryLoaded || !draftReady}
            data-testid="routine-paste-parse-btn"
          >
            {libraryLoaded && draftReady
              ? "Parse"
              : libraryFailed
                ? "Library unavailable"
                : "Loading…"}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
