import type {
  ApiToken,
  Exercise,
  ExerciseFavorite,
  ExercisePref,
  Machine,
  MachineSetting,
  Measurement,
  Metric,
  PlateConfig,
  Program,
  PushSubscription,
  Routine,
  RoutineExercise,
  RoutineFolder,
  RoutineSet,
  Session,
  SessionExercise,
  SessionMediaRow,
  SetLog,
  TrackedCondition,
  UserPrefs,
} from "../db/schema";
import type { MuscleTarget } from "../domain/anatomy";
import type { FindingsSessionInput } from "../findings/types";
import type { ImportedSession, ImportResult } from "../import/types";
import type { RecordsSessionInput } from "../records/types";

export type ExportBundle = {
  schemaVersion: number;
  exportedAt: number;
  exercises: Exercise[];
  machines: Machine[]; // photos not included in v1 exports
  metrics: Metric[];
  sessions: Session[];
  sessionExercises: SessionExercise[];
  setLogs: SetLog[];
  // v3 additions (Hevy parity): body measurements + the routines graph.
  measurements?: Measurement[];
  routineFolders?: RoutineFolder[];
  routines?: Routine[];
  routineExercises?: RoutineExercise[];
  routineSets?: RoutineSet[];
};

export type CreatedApiToken = { token: string; row: ApiToken };

export type SetSide = "left" | "right";

export type NewSetInput = {
  weightKg: number | null;
  reps: number | null;
  rir?: number | null;
  rirMin?: number | null;
  rirMax?: number | null;
  rpe?: number | null;
  note?: string | null;
  /** Seconds rested before this set (time since the previous set committed). */
  restSec?: number | null;
  metricValues?: Record<string, unknown> | null;
  /** 'normal' (default) | 'warmup' | 'failure' | 'drop'. */
  setType?: string;
  /** Duration-type exercises (seconds). */
  durationSec?: number | null;
  /** Distance-type exercises (canonical meters). */
  distanceM?: number | null;
  /** Limb for a unilateral exercise; omit/null for bilateral (and legacy alternating) rows. */
  side?: SetSide | null;
};

export type MetricType = "number" | "scale" | "text" | "checkbox";

export type NewMetricInput = {
  name: string;
  type: MetricType;
  scope: "set" | "session";
  /** Optional display unit for number metrics (kg, mg, g, h…). */
  unit?: string | null;
};

export type GhostSet = {
  weightKg: number | null;
  reps: number | null;
  durationSec?: number | null;
  distanceM?: number | null;
  /** The other limb's values when the previous set was unilateral. */
  otherSide?: Omit<GhostSet, "otherSide"> | null;
};

export type NewMachineInput = {
  /**
   * Client-generated id (newId()) so the optimistic cache row and the server
   * row share one identity — follow-up edits against the optimistic id must
   * hit the real row. Omitted → repo generates one.
   */
  id?: string;
  name: string;
  brand?: string | null;
  catalogKey?: string | null;
  settings?: MachineSetting[] | null;
  notes?: string | null;
};

export type MachinePatch = Partial<NewMachineInput>;

// One row of the global reference catalog (`machine_catalog`) as returned by
// the lookup-UX search — the narrow columns the picker renders. Not the full
// `MachineCatalogRow` schema type: search never ships the spec/mechanism
// fields. Read-only from the app's side (seed rows, RLS readable by all).
export type MachineCatalogEntry = {
  id: string;
  brand: string;
  model: string;
  category: string;
};

export type NewExerciseOpts = {
  /** Client-generated id — same optimistic-identity rule as NewMachineInput. */
  id?: string;
  /**
   * Publish to the shared library instead of creating a private row
   * (community phase, docs/DECISIONS.md 2026-08-08). Defaults to
   * COMMUNITY_SHARING (true in dev). A shared row is owner_id null +
   * created_by = the caller and is RLS-immutable afterward — editing it
   * forks a private copy (share: false) via the duplicate flow; the fork
   * paths in the app pass false explicitly so a duplicate or mid-session
   * copy-on-write is never published.
   */
  share?: boolean;
  jointActions?: string[] | null;
  muscleTargets?: MuscleTarget[] | null;
  machineId?: string | null;
  /** Measurement type (domain/exercise-types). Default 'weight_reps'. */
  exerciseType?: string;
  equipment?: string | null;
  /** How-to content — carried over by duplicate-exercise. */
  instructions?: string[] | null;
  imageUrls?: string[] | null;
  mechanic?: string | null;
  movementPattern?: string | null;
  laterality?: string | null;
  defaultRepsMin?: number | null;
  defaultRepsMax?: number | null;
  defaultRestSec?: number | null;
  notes?: string | null;
  aliases?: string[] | null;
};

// One patch method replaces the four narrow setters
// (setExerciseClassification/setExerciseTypeEquipment/setExerciseTags/
// setExerciseMachine) that used to accrete one per new editable field.
export type ExercisePatch = Partial<{
  name: string;
  muscleTargets: MuscleTarget[] | null;
  jointActions: string[] | null;
  machineId: string | null;
  /** App-enforced immutable once the exercise has logged sets. */
  exerciseType: string;
  equipment: string | null;
  tags: string[] | null;
  mechanic: string | null;
  movementPattern: string | null;
  laterality: string | null;
  defaultRepsMin: number | null;
  defaultRepsMax: number | null;
  defaultRestSec: number | null;
  notes: string | null;
  aliases: string[] | null;
  instructions: string[] | null;
  imageUrls: string[] | null;
}>;

export type LoggedSet = {
  id: string;
  setNo: number;
  setType: string;
  weightKg: number | null;
  reps: number | null;
  durationSec: number | null;
  distanceM: number | null;
  rir: number | null; // legacy scalar — read-compat fallback, see rirRange()
  rirMin: number | null;
  rirMax: number | null;
  rpe: number | null;
  note: string | null;
  restSec: number | null;
  side: SetSide | null;
};

export type SessionExerciseDetail = {
  id: string;
  exerciseId: string;
  exerciseName: string;
  orderIndex: number;
  supersetGroup: number | null;
  restSec: number | null;
  note: string | null;
  routineExerciseId: string | null;
  sets: LoggedSet[];
};

// Routines: reusable workout templates (Hevy-parity plan §B).
export type RoutineSetInput = {
  setNo: number;
  setType?: string;
  targetWeightKg?: number | null;
  targetReps?: number | null;
  /** Non-null ⇒ rep range [targetReps, targetRepsMax]. */
  targetRepsMax?: number | null;
  targetDurationSec?: number | null;
  targetDistanceM?: number | null;
  /** Target RIR range (reps-based exercise types only). */
  targetRirMin?: number | null;
  targetRirMax?: number | null;
};

export type RoutineExerciseInput = {
  exerciseId: string;
  orderIndex: number;
  supersetGroup?: number | null;
  restSec?: number | null;
  note?: string | null;
  sets: RoutineSetInput[];
};

export type NewRoutineInput = {
  name: string;
  folderId?: string | null;
  description?: string | null;
  exercises: RoutineExerciseInput[];
};

export type RoutineExerciseDetail = {
  id: string;
  exerciseId: string;
  exerciseName: string;
  orderIndex: number;
  supersetGroup: number | null;
  restSec: number | null;
  note: string | null;
  sets: RoutineSet[];
};

export type RoutineDetail = {
  routine: Routine;
  exercises: RoutineExerciseDetail[];
};

/**
 * All data access goes through this interface — screens never touch a client
 * directly. SupabaseRepo is the v1 (online-first) implementation; a future
 * mobile/offline SqliteRepo slots in behind the same seam.
 */
export interface Repo {
  createExercise(name: string, opts?: NewExerciseOpts): Promise<Exercise>;
  /** Narrow columns only — excludes instructions/imageUrls (see getExercise). */
  listExercises(): Promise<Exercise[]>;
  /** Full row, including the How-to-tab-only fields listExercises omits. */
  getExercise(id: string): Promise<Exercise | null>;
  /**
   * Partial update — only provided fields are written. Custom exercises
   * only (seed rows are read-only under RLS; the client-side `isCustom`
   * gate is the UX affordance, RLS is the actual boundary). Includes rename
   * — there was previously no rename path for any exercise.
   */
  updateExercise(id: string, patch: ExercisePatch): Promise<void>;

  // Machines: the user's gym equipment — settings entered once, shown in
  // every session (setup memory). No seed machines; all rows owner-scoped.
  listMachines(): Promise<Machine[]>;

  // Global reference catalog (`machine_catalog`): server-side ranked/filtered
  // search over brand/model/category/aliases (AND-ed ILIKE terms, limited
  // server-side — this replaced the static TS array scan, which leaves the
  // bundle entirely). Read-only; the table is seed-owned. `category` narrows
  // to one MachineCategory for the browse view; empty query = browse.
  searchMachineCatalog(
    query: string,
    opts?: { category?: string | null; limit?: number },
  ): Promise<MachineCatalogEntry[]>;
  /** Distinct catalog categories, for browse chips (DB-derived, not a copy). */
  listMachineCategories(): Promise<string[]>;
  createMachine(input: NewMachineInput): Promise<Machine>;
  /** Partial update; `settings` replaces the whole array when provided. */
  updateMachine(id: string, patch: MachinePatch): Promise<void>;
  /** Soft delete + detaches the owner's exercises referencing it. */
  deleteMachine(id: string): Promise<void>;
  /** Uploads the user's own photo (already resized) and stores its path. */
  uploadMachinePhoto(machineId: string, file: Blob): Promise<void>;
  /** Short-lived signed URL for the machine's photo, or null if none. */
  machinePhotoUrl(machine: Machine): Promise<string | null>;
  /**
   * Uploads a photo for ONE machine setting (the setup strip's per-value
   * photos). Returns the stored path for the caller to save into that
   * setting's `photoPath`. Re-uploading with an existing path replaces that
   * same object (no orphans on replace); a fresh path is minted otherwise.
   */
  uploadMachineSettingPhoto(
    machineId: string,
    file: Blob,
    existingPath: string | null,
  ): Promise<string>;
  /** Short-lived signed URL for a machine-setting photo path, or null. */
  machineSettingPhotoUrl(path: string): Promise<string | null>;

  /**
   * Uploads a user demo image (already resized) or video for a custom
   * exercise and stores its path + kind. Custom exercises only.
   */
  uploadExerciseMedia(
    exerciseId: string,
    file: Blob,
    kind: "image" | "video",
  ): Promise<void>;
  /** Short-lived signed URL for the exercise's demo media, or null if none. */
  exerciseMediaUrl(exercise: Exercise): Promise<string | null>;
  /** Removes the stored object and clears the exercise's media fields. */
  clearExerciseMedia(exerciseId: string): Promise<void>;

  startSession(title?: string): Promise<Session>;
  /** Stamps ended_at. Active session = ended_at null. */
  endSession(sessionId: string): Promise<void>;
  /** Backdate/correct a session's start time (ms epoch). */
  updateSessionStartedAt(sessionId: string, startedAt: number): Promise<void>;
  /** Newest open session (ended_at null), if any. */
  activeSession(): Promise<Session | null>;
  addExerciseToSession(sessionId: string, exerciseId: string): Promise<string>;
  /** `id` is the caller's optimistic row id — also the write's idempotency
   * key, so a mutation retry (see `apps/web` QueryClient's `retry: 3`) upserts
   * the same row instead of inserting a duplicate. `setNo` comes from the
   * caller for the same reason: re-deriving it server-side makes a retry
   * position-dependent on whatever was logged in between. */
  logSet(
    sessionExerciseId: string,
    set: NewSetInput,
    id: string,
    setNo: number,
  ): Promise<string>;
  /** Partial update — only provided fields are written (others preserved). */
  updateSet(setId: string, patch: Partial<NewSetInput>): Promise<void>;

  // All deletes are soft (deleted_at) — nothing is ever hard-deleted.
  deleteSet(setId: string): Promise<void>;
  deleteSessionExercise(id: string): Promise<void>;
  deleteExercise(id: string): Promise<void>;
  deleteMetric(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;

  /**
   * Bulk history import (Hevy etc.): find-or-create exercises by name,
   * batched inserts, idempotent — sessions whose started_at already exists
   * are skipped.
   */
  importSessions(sessions: ImportedSession[]): Promise<ImportResult>;

  /**
   * Fills the seeded Sleep (h) condition on sessions whose local start date
   * matches; never overwrites an existing value. Returns sessions filled.
   */
  applySleep(sleepHoursByDate: Map<string, number>): Promise<number>;

  /** Exercises + logged sets of one session, in order (restores an open session). */
  listSessionExercises(sessionId: string): Promise<SessionExerciseDetail[]>;

  getSession(sessionId: string): Promise<Session | null>;
  /** Replaces the session's condition values ({metricId: value}). */
  updateSessionConditions(
    sessionId: string,
    values: Record<string, unknown>,
  ): Promise<void>;
  /** Sets the session's freeform notes (null clears them). */
  updateSessionNotes(sessionId: string, notes: string | null): Promise<void>;

  /** Newest-first page of sessions (history). */
  listSessions(limit: number, offset: number): Promise<Session[]>;

  /** Full session graph shaped for the findings engine (client-side compute). */
  findingsData(): Promise<FindingsSessionInput[]>;

  /** Full history shaped for the records/PR engine (client-side compute). */
  recordsData(): Promise<RecordsSessionInput[]>;

  listMetrics(): Promise<Metric[]>;
  createMetric(input: NewMetricInput): Promise<Metric>;
  /** Which exercises a set-scope metric is enabled for (stored on the metric row). */
  setMetricExercises(metricId: string, exerciseIds: string[]): Promise<void>;

  // Tracked conditions: the user's "experiment variables" pre-loaded into every
  // session. A row is an explicit choice; absence = use the default set.
  listTrackedConditions(): Promise<TrackedCondition[]>;
  /** Track (true) or hide (false) a condition going forward. Upserts one row. */
  setConditionTracked(metricId: string, tracked: boolean): Promise<void>;

  /** Full user data graph (RLS-scoped), for JSON/CSV export. */
  exportAll(): Promise<ExportBundle>;

  listApiTokens(): Promise<ApiToken[]>;
  /** Returns the plaintext token exactly once; only its sha256 is stored. */
  createApiToken(name: string): Promise<CreatedApiToken>;
  revokeApiToken(id: string): Promise<void>;

  /**
   * Most recent PRIOR session's sets for an exercise (ghost prefill /
   * PREVIOUS column). Pass the current session-exercise id to exclude the one
   * being logged now. routineId narrows to sessions started from that routine
   * (the "Same routine" PREVIOUS scope).
   */
  lastSetsForExercise(
    exerciseId: string,
    excludeSessionExerciseId?: string,
    routineId?: string,
  ): Promise<GhostSet[]>;

  /**
   * Exercise ids with at least one set logged within the last `days` days,
   * most-recent set first (one entry per exercise). Powers the library's
   * "Recent" band — the Hevy-style recently-logged-first ordering.
   */
  recentExerciseIds(days: number): Promise<string[]>;

  /** Sets the session title (null clears it). */
  updateSessionTitle(sessionId: string, title: string | null): Promise<void>;
  /** Corrects a finished session's end time (ms epoch) — duration edits. */
  updateSessionEndedAt(sessionId: string, endedAt: number): Promise<void>;
  /** Accumulated pause time (ms); duration = ended − started − paused. */
  updateSessionPausedMs(sessionId: string, pausedMs: number): Promise<void>;
  /**
   * Per-block session fields: superset grouping, per-exercise rest seconds
   * (dormant — nothing writes it since rest became an untargeted stopwatch),
   * and the per-exercise session note. Only provided fields are written.
   * `exerciseId` repoints the block at a different exercise row (the
   * session-side copy-on-write: a seed exercise is RLS-read-only, so an
   * in-session laterality/machine edit clones it into a private custom
   * exercise and the session_exercise follows the copy).
   */
  updateSessionExercise(
    sessionExerciseId: string,
    patch: {
      supersetGroup?: number | null;
      restSec?: number | null;
      note?: string | null;
      exerciseId?: string;
    },
  ): Promise<void>;

  /**
   * Reads one session_exercise row's current exercise id — the
   * resolve-by-read for the copy-on-write repoint's ambiguous-failure path
   * (the PATCH can have committed with its response lost, so cleanup must
   * confirm the row no longer points at the seed before soft-deleting the
   * copy). Null when the row is gone.
   */
  getSessionExercise(
    sessionExerciseId: string,
  ): Promise<{ exerciseId: string } | null>;

  /**
   * Previous session's per-exercise note (carry-forward ghost). Latest prior
   * session_exercise of this exercise that has a note, or null.
   */
  lastNoteForExercise(
    exerciseId: string,
    excludeSessionExerciseId?: string,
  ): Promise<string | null>;

  // Workout media (photos attached at save; ≤3 app-enforced, photos v1).
  listSessionMedia(sessionId: string): Promise<SessionMediaRow[]>;
  /** Uploads an already-resized JPEG and inserts the row at `position`. */
  uploadSessionPhoto(
    sessionId: string,
    file: Blob,
    position: number,
  ): Promise<SessionMediaRow>;
  /** Soft-deletes the row and removes the storage object. */
  deleteSessionMedia(id: string): Promise<void>;
  /** Short-lived signed URL for a media row. */
  sessionMediaUrl(media: SessionMediaRow): Promise<string | null>;
  /** All of the user's media rows, newest first (profile strip). */
  listAllSessionMedia(limit?: number): Promise<SessionMediaRow[]>;

  // Favorited exercises: owner-scoped, works on shared seed rows too since
  // it's a separate table, not a column on the exercise row.
  listExerciseFavorites(): Promise<ExerciseFavorite[]>;
  /** Favorite (true) or unfavorite (false) an exercise. Upserts one row. */
  setExerciseFavorite(exerciseId: string, favorite: boolean): Promise<void>;

  // Per-exercise prefs: satellite on shared seed rows (favorites pattern).
  listExercisePrefs(): Promise<ExercisePref[]>;
  /** Per-exercise weight-unit override; null reverts to the global setting. */
  setExerciseWeightUnit(
    exerciseId: string,
    unit: "kg" | "lb" | null,
  ): Promise<void>;
  /** Generator "don't recommend again" flag. */
  setGeneratorExcluded(exerciseId: string, excluded: boolean): Promise<void>;

  // Server-side user prefs (semantics-bearing settings; one row per user).
  getUserPrefs(): Promise<UserPrefs | null>;
  /** Partial upsert — only provided fields are written. */
  updateUserPrefs(patch: UserPrefsPatch): Promise<void>;

  // Routines & folders (Hevy-parity M2).
  listRoutineFolders(): Promise<RoutineFolder[]>;
  createRoutineFolder(name: string): Promise<RoutineFolder>;
  renameRoutineFolder(id: string, name: string): Promise<void>;
  /** Reorder folders; positions written by array index. */
  reorderRoutineFolders(ids: string[]): Promise<void>;
  /** Soft delete; the folder's routines become unfiled (folder_id null). */
  deleteRoutineFolder(id: string): Promise<void>;

  listRoutines(): Promise<Routine[]>;
  getRoutineDetail(routineId: string): Promise<RoutineDetail | null>;
  /** Inserts the full template graph (routine + exercises + target sets). */
  createRoutine(input: NewRoutineInput): Promise<Routine>;
  /**
   * Replaces the routine's exercise/set graph and metadata. Old child rows
   * are soft-deleted; new rows inserted (simple + safe for template sizes).
   */
  updateRoutine(routineId: string, input: NewRoutineInput): Promise<void>;
  /** Move to a folder (null = unfiled). */
  moveRoutine(routineId: string, folderId: string | null): Promise<void>;
  /** Reorder within the whole routines list; positions by array index. */
  reorderRoutines(ids: string[]): Promise<void>;
  /** History-free copy: "<name> (copy)" unless a name is given. */
  duplicateRoutine(routineId: string, name?: string): Promise<Routine>;
  /** Soft delete routine + children. */
  deleteRoutine(routineId: string): Promise<void>;

  /**
   * Starts a live session from a routine: creates the session (routine_id
   * provenance) + one session_exercise per template exercise carrying
   * superset group, rest seconds, note, and routine_exercise_id. Target sets
   * stay on the template — the session screen reads them via
   * getRoutineDetail for draft prefill.
   */
  startRoutineSession(routineId: string): Promise<Session>;

  // Web-push subscriptions (Hevy-parity M12) for the Settings → Notifications
  // toggle; the sender Edge Function went with the rest countdown, so nothing
  // posts to these endpoints today.
  listPushSubscriptions(): Promise<PushSubscription[]>;
  /** Upserts by endpoint (a browser re-subscribing rotates keys). */
  savePushSubscription(
    endpoint: string,
    keys: { p256dh: string; auth: string },
  ): Promise<void>;
  deletePushSubscription(endpoint: string): Promise<void>;

  // Programs (Hevy-parity M11): provenance rows tying a routine folder to a
  // generator config or a catalog entry. Progression state is never stored.
  listPrograms(): Promise<Program[]>;
  /** Newest active program, if any (the Trainer's current program). */
  activeProgram(): Promise<Program | null>;
  createProgram(input: {
    source: "generated" | "library";
    folderId: string;
    config?: Record<string, unknown> | null;
    libraryKey?: string | null;
  }): Promise<Program>;
  /** Deactivate (keeps the folder/routines; Trainer forgets the program). */
  setProgramActive(programId: string, active: boolean): Promise<void>;
  /** Replaces the stored questionnaire config (generated programs). */
  updateProgramConfig(
    programId: string,
    config: Record<string, unknown>,
  ): Promise<void>;
  /** Soft delete; the folder/routines stay. */
  deleteProgram(programId: string): Promise<void>;

  // Body measurements (Hevy-parity M7): one entry per local day; any subset
  // of fields. measurements is the canonical bodyweight store.
  listMeasurements(): Promise<Measurement[]>;
  /**
   * Upsert the day's entry (unique owner+measuredOn). Only provided fields
   * are written; null clears a field. measuredOn = local YYYY-MM-DD.
   */
  upsertMeasurement(
    measuredOn: string,
    patch: MeasurementPatch,
  ): Promise<Measurement>;
  deleteMeasurement(id: string): Promise<void>;
  /** Uploads a progress photo (already resized) for the day's entry. */
  uploadProgressPhoto(measurementId: string, file: Blob): Promise<void>;
  /** Clears the entry's photo (removes the object too); measurements stay. */
  clearProgressPhoto(measurementId: string): Promise<void>;
  /** Short-lived signed URL for a measurement's progress photo. */
  progressPhotoUrl(m: Measurement): Promise<string | null>;
  /** Latest entry with a bodyweight on/before the given local date. */
  latestBodyweightKg(onOrBefore?: string): Promise<number | null>;

  /**
   * Update Routine Values (save-screen toggle, default ON): overwrite the
   * template's target weight/reps with performed values, matched per
   * routine_exercise + set index. Rep-range sets are NEVER auto-updated.
   */
  updateRoutineValues(
    routineId: string,
    performed: Array<{
      routineExerciseId: string;
      sets: Array<{
        setNo: number;
        weightKg: number | null;
        reps: number | null;
        durationSec: number | null;
        distanceM: number | null;
      }>;
    }>,
  ): Promise<void>;
}

export type MeasurementPatch = Partial<{
  bodyweightKg: number | null;
  bodyfatPct: number | null;
  neckCm: number | null;
  shouldersCm: number | null;
  chestCm: number | null;
  waistCm: number | null;
  abdomenCm: number | null;
  hipsCm: number | null;
  bicepLCm: number | null;
  bicepRCm: number | null;
  forearmLCm: number | null;
  forearmRCm: number | null;
  thighLCm: number | null;
  thighRCm: number | null;
  calfLCm: number | null;
  calfRCm: number | null;
}>;

export type UserPrefsPatch = Partial<{
  includeWarmupsInStats: boolean;
  defaultRestSec: number | null;
  previousValuesScope: "any" | "routine";
  bodyDiagram: string;
  plateConfig: PlateConfig | null;
  displayName: string | null;
  bio: string | null;
}>;
