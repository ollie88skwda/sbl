import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { MuscleTarget } from "../domain/anatomy";

// Conventions (see AGENTS.md): ids are client-generated uuid v4 (newId());
// timestamps are bigint millisecond epochs managed by the app (Date.now());
// rows are soft-deleted via deleted_at; owner_id + RLS on every table.
const base = {
  id: uuid("id").primaryKey(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  deletedAt: bigint("deleted_at", { mode: "number" }),
};

// owner_id null = global seed row (readable by everyone, RLS-enforced).
// text, not uuid: the JWT `sub` is a Clerk user ID (`user_…`) for Clerk
// sign-ins and a uuid string for Supabase-native (E2E) sessions.
const seedableOwner = text("owner_id").default(sql`(auth.jwt()->>'sub')`);
const requiredOwner = text("owner_id")
  .notNull()
  .default(sql`(auth.jwt()->>'sub')`);

// A user's gym machine: brand + numbered settings (seat height, pad position…)
// entered once and shown in every session ("same setup every time").
// catalog_key links to the static machine catalog (packages/core/src/data);
// photo_path points at the user's own photo in the machine-photos bucket.
export const machines = pgTable(
  "machines",
  {
    ...base,
    ownerId: requiredOwner,
    name: text("name").notNull(),
    brand: text("brand"),
    catalogKey: text("catalog_key"),
    settings: jsonb("settings").$type<MachineSetting[]>(),
    notes: text("notes"),
    photoPath: text("photo_path"),
  },
  (t) => [index("machines_owner_idx").on(t.ownerId)],
);

export type MachineSetting = {
  label: string;
  value: number | null;
  /** Path in the machine-photos bucket of a photo of THIS setting (e.g. the
   * notch/seat position it refers to). Optional — most settings are plain
   * numbers; the path rides in the jsonb so it survives setting reorders and
   * removals intact (see docs/DECISIONS.md 2026-08-08, note 16). */
  photoPath?: string | null;
};

// Global reference catalog of real gym-machine models (brand/model/specs),
// distinct from `machines` (a user's owned equipment, owner-scoped, no seed
// rows — see the comment above that table). Mirrors the `exercises` seed-row
// pattern: ownerId null = global, readable by all, writable only by
// migrations. v1 seeds the existing static catalog (867 rows, 16 brands as
// of 2026-08-07 — see docs/DECISIONS.md for the stale-count correction)
// (packages/core/src/data/machine-catalog.ts, which the web app no longer
// imports — the lookup-UX search reads this table server-side); `category`
// extends that file's MachineCategory union (app-validated, not a DB enum,
// same as exercises.exercise_type). No photo/image column — manufacturer
// photos stay out on copyright grounds (docs/DECISIONS.md 2026-07-12);
// productUrl links out instead. Read by Repo.searchMachineCatalog /
// listMachineCategories (see docs/DECISIONS.md 2026-08-07 phase 3) —
// `machines.catalog_key` stores this table's id for rows added from the
// catalog picker.
export const machineCatalog = pgTable(
  "machine_catalog",
  {
    ...base,
    ownerId: seedableOwner,
    brand: text("brand").notNull(),
    model: text("model").notNull(),
    aliases: jsonb("aliases").$type<string[]>(),
    category: text("category").notNull(),
    mechanism: text("mechanism"), // 'selectorized'|'plate-loaded'|'cable'|'pneumatic'|'smith'|'bodyweight'|'electronic'
    muscleTargets: jsonb("muscle_targets").$type<MuscleTarget[]>(),
    weightStackKg: real("weight_stack_kg"),
    plateCapacityKg: real("plate_capacity_kg"),
    dimensions: jsonb("dimensions").$type<{
      lengthCm?: number;
      widthCm?: number;
      heightCm?: number;
      weightKg?: number;
    }>(),
    productUrl: text("product_url"),
    introducedYear: integer("introduced_year"),
    discontinuedYear: integer("discontinued_year"), // null = current line
    sourceUrl: text("source_url"), // provenance
    sourceNote: text("source_note"),
    // Community-shared rows carry the publisher's JWT `sub` here (owner_id
    // stays null = global, readable by all); null on migration seeds so the
    // two populations stay distinguishable. Provenance for the moderation
    // story (rate limits, abuse takedown) — see the publish_exercise RPC.
    createdBy: text("created_by"),
  },
  (t) => [index("machine_catalog_brand_idx").on(t.brand)],
);

export const exercises = pgTable(
  "exercises",
  {
    ...base,
    ownerId: seedableOwner,
    // Community-shared rows (owner_id null + is_custom true) carry the
    // publisher's JWT `sub` here; null on migration seeds. Set only by the
    // publish_exercise RPC — never by a plain insert.
    createdBy: text("created_by"),
    name: text("name").notNull(),
    tags: jsonb("tags").$type<string[]>(), // light tagging only in v1
    isCustom: boolean("is_custom").notNull().default(true),
    machineId: uuid("machine_id").references(() => machines.id),
    // Classification (docs/DECISIONS.md): muscleTargets drives library
    // grouping (first = primary); jointActions are display labels.
    jointActions: jsonb("joint_actions").$type<string[]>(),
    muscleTargets: jsonb("muscle_targets").$type<MuscleTarget[]>(),
    // Reference diagram (seed exercises only, docs/DECISIONS.md): hotlinked
    // Wikimedia Commons URL, all same Everkinetic CC BY-SA 3.0 line-art set
    // for a consistent visual style. Null for custom exercises in v1.
    imageUrl: text("image_url"),
    imageAttribution: text("image_attribution"),
    // Measurement type decides the logging columns and volume/PR math
    // (domain/exercise-types.ts). App-enforced immutable once sets exist;
    // duplicate-as-custom is the reset path (docs/hevy-parity plan §B).
    exerciseType: text("exercise_type").notNull().default("weight_reps"),
    // 'barbell' | 'ez_bar' | 'dumbbell' | 'machine' | 'cable'
    // | 'bodyweight' | 'plate' | 'other'
    // Drives picker filters, plate-calc eligibility, generator matching.
    // kettlebell/band/suspension were removed from the picker 2026-08-08
    // (docs/DECISIONS.md) but legacy rows may still carry those values.
    equipment: text("equipment"),
    instructions: jsonb("instructions").$type<string[]>(), // how-to steps
    imageUrls: jsonb("image_urls").$type<string[]>(), // how-to frames (detail screen)

    // ── Custom-exercise-editor fields (all nullable, no default: a book row
    // that never fills them behaves exactly as today) ──────────────────────
    // Explicit compound/isolation. Replaces the muscleTargets.length>=2 proxy
    // in generator/generate.ts — a one-primary custom exercise is no longer
    // forced to "isolation" for having a short muscle list.
    mechanic: text("mechanic"), // 'compound' | 'isolation' (domain/exercise-types)
    // Movement pattern — the taxonomy the push/pull/legs day templates in
    // generator/generate.ts reconstruct from muscle keys.
    movementPattern: text("movement_pattern"),
    // Bilateral vs unilateral (domain/exercise-types); legacy 'alternating'
    // values read as bilateral since 2026-08-08 (docs/DECISIONS.md).
    laterality: text("laterality"),
    // Per-exercise defaults — prefill only, consumed by the routine editor's
    // "Add exercise" (default_rest_sec seeds routine_exercises.rest_sec; the
    // session has no rest target to read since rest became an untargeted
    // stopwatch); never rewrites a logged or prescribed value.
    defaultRepsMin: integer("default_reps_min"),
    defaultRepsMax: integer("default_reps_max"),
    defaultRestSec: integer("default_rest_sec"),
    // The user's own note about the exercise itself (setup, cue, "left
    // knee") — rendered read-only under the block header in a session.
    notes: text("notes"),
    // Alternate names the fuzzy matcher and search also accept. Stored as the
    // user typed them (trimmed only) — normalizeExerciseName runs over every
    // label at match time (domain/match-exercise), so anything reading this
    // column directly must normalize before comparing.
    aliases: jsonb("aliases").$type<string[]>(),
    // User-uploaded demo image/video (captain's call: real storage, not a
    // URL field) — path in the private exercise-media bucket, resized
    // client-side before upload (lib/photo.ts), same shape as
    // machines.photoPath. mediaType disambiguates the two content kinds.
    mediaPath: text("media_path"),
    mediaType: text("media_type"), // 'image' | 'video', null when no media
  },
  (t) => [index("exercises_owner_idx").on(t.ownerId)],
);

export const metrics = pgTable(
  "metrics",
  {
    ...base,
    ownerId: seedableOwner,
    name: text("name").notNull(),
    type: text("type").notNull(), // 'number' | 'scale' | 'text' | 'checkbox'
    scope: text("scope").notNull(), // 'set' | 'session'
    // Optional display unit for number metrics (kg, mg, g, h…), shown as a suffix.
    unit: text("unit"),
    // Set-scope metrics: which exercises show this metric. Lives on the metric
    // (user-owned) rather than the exercise so it works on seed exercises too.
    exerciseIds: jsonb("exercise_ids").$type<string[]>(),
  },
  (t) => [index("metrics_owner_idx").on(t.ownerId)],
);

// A user's tracked conditions — the "experiment variables" pre-loaded into
// every session. A row records an EXPLICIT choice; its absence means "use the
// default" (see DEFAULT_TRACKED_CONDITIONS in domain/conditions). This lets us
// tell a new user (no rows → defaults show) apart from one who removed a
// default (a tracked=false row hides it), without an auth-schema trigger.
export const trackedConditions = pgTable(
  "tracked_conditions",
  {
    ...base,
    ownerId: requiredOwner,
    metricId: uuid("metric_id")
      .notNull()
      .references(() => metrics.id),
    tracked: boolean("tracked").notNull().default(true),
    position: integer("position"),
  },
  (t) => [
    index("tracked_conditions_owner_idx").on(t.ownerId),
    uniqueIndex("tracked_conditions_owner_metric_idx").on(
      t.ownerId,
      t.metricId,
    ),
  ],
);

// A user's favorited exercises (works on shared seed rows too, since this is
// a separate owner-scoped table, not a column on the shared exercise row).
// One row per (owner, exercise); presence + favorite=true means favorited.
export const exerciseFavorites = pgTable(
  "exercise_favorites",
  {
    ...base,
    ownerId: requiredOwner,
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercises.id),
    favorite: boolean("favorite").notNull().default(true),
  },
  (t) => [
    index("exercise_favorites_owner_idx").on(t.ownerId),
    uniqueIndex("exercise_favorites_owner_exercise_idx").on(
      t.ownerId,
      t.exerciseId,
    ),
  ],
);

// Reusable workout templates ("routines"), optionally grouped into folders.
// Starting a routine copies its prescription into a live session; finishing
// can write performed values back (Update Routine Values, plan §B).
export const routineFolders = pgTable(
  "routine_folders",
  {
    ...base,
    ownerId: requiredOwner,
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("routine_folders_owner_idx").on(t.ownerId)],
);

export const routines = pgTable(
  "routines",
  {
    ...base,
    ownerId: requiredOwner,
    name: text("name").notNull(),
    folderId: uuid("folder_id").references(() => routineFolders.id), // null = unfiled
    position: integer("position").notNull().default(0),
    description: text("description"),
  },
  (t) => [
    index("routines_owner_idx").on(t.ownerId),
    index("routines_folder_idx").on(t.folderId),
  ],
);

export const routineExercises = pgTable(
  "routine_exercises",
  {
    ...base,
    ownerId: requiredOwner,
    routineId: uuid("routine_id")
      .notNull()
      .references(() => routines.id),
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercises.id),
    orderIndex: integer("order_index").notNull(),
    // Same non-null int = same superset; color = group index. Null = none.
    supersetGroup: integer("superset_group"),
    // Per-exercise rest seconds. Null = unset, 0 = off. No longer a timer
    // target — rest is an untargeted stopwatch. The routine builder has no
    // field for it, but still writes it: a newly added exercise seeds from
    // exercises.default_rest_sec (the exercise editor's "Rest — seconds"),
    // and an existing value round-trips through every save. Read by the
    // Trainer's duration estimate.
    restSec: integer("rest_sec"),
    // Persistent template note — re-renders under the exercise every session.
    note: text("note"),
  },
  (t) => [
    index("routine_exercises_owner_idx").on(t.ownerId),
    index("routine_exercises_routine_idx").on(t.routineId),
  ],
);

export const routineSets = pgTable(
  "routine_sets",
  {
    ...base,
    ownerId: requiredOwner,
    routineExerciseId: uuid("routine_exercise_id")
      .notNull()
      .references(() => routineExercises.id),
    setNo: integer("set_no").notNull(),
    setType: text("set_type").notNull().default("normal"), // 'normal'|'warmup'|'failure'|'drop'
    targetWeightKg: real("target_weight_kg"),
    targetReps: integer("target_reps"),
    // Non-null ⇒ rep range [targetReps, targetRepsMax]; null ⇒ fixed reps.
    // Rep-range sets are never auto-updated by Update Routine Values.
    targetRepsMax: integer("target_reps_max"),
    targetDurationSec: integer("target_duration_sec"),
    targetDistanceM: real("target_distance_m"),
    // Target RIR range (reps-based exercise types only). Both nullable —
    // no target authored until the user sets one.
    targetRirMin: integer("target_rir_min"),
    targetRirMax: integer("target_rir_max"),
  },
  (t) => [
    index("routine_sets_owner_idx").on(t.ownerId),
    index("routine_sets_routine_exercise_idx").on(t.routineExerciseId),
  ],
);

// Generator/library program provenance. Progression state is NOT stored —
// the overload rule reads history via sessions.routine_id, so regenerate /
// restart stays trivially consistent (plan §B).
export const programs = pgTable(
  "programs",
  {
    ...base,
    ownerId: requiredOwner,
    source: text("source").notNull(), // 'generated' | 'library'
    libraryKey: text("library_key"),
    config: jsonb("config").$type<Record<string, unknown>>(), // questionnaire answers
    folderId: uuid("folder_id")
      .notNull()
      .references(() => routineFolders.id),
    active: boolean("active").notNull().default(true),
  },
  (t) => [index("programs_owner_idx").on(t.ownerId)],
);

export const sessions = pgTable(
  "sessions",
  {
    ...base,
    ownerId: requiredOwner,
    title: text("title"),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    endedAt: bigint("ended_at", { mode: "number" }),
    conditionValues: jsonb("condition_values").$type<Record<string, unknown>>(), // {metricId: value}
    notes: text("notes"), // freeform per-session notes (not tied to a condition)
    // Provenance: which routine this session was started from (null = empty
    // workout). Serves same-routine PREVIOUS scope + routine write-back.
    routineId: uuid("routine_id").references(() => routines.id),
    // Total paused time; duration = endedAt − startedAt − pausedMs.
    pausedMs: bigint("paused_ms", { mode: "number" }).notNull().default(0),
    // Dormant hook for a future public share link (share redesign, see
    // docs/DECISIONS.md): null until a session is explicitly published.
    // Nothing reads or writes this yet — no public read path, no RLS policy
    // exposing it, no UI. Exists now so adding public links later is a
    // backend-only change (mint a slug + a public SELECT policy keyed off
    // "share_slug is not null"), not a schema rework. Unique so a slug can
    // safely double as the public URL segment; Postgres unique indexes allow
    // any number of NULLs, so unpublished sessions are unaffected.
    shareSlug: text("share_slug"),
  },
  (t) => [
    index("sessions_owner_started_idx").on(t.ownerId, t.startedAt.desc()),
    index("sessions_routine_idx").on(t.routineId),
    uniqueIndex("sessions_share_slug_idx").on(t.shareSlug),
  ],
);

export const sessionExercises = pgTable(
  "session_exercises",
  {
    ...base,
    ownerId: requiredOwner,
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercises.id),
    orderIndex: integer("order_index").notNull(),
    // Same non-null int = same superset (color = group index). Null = none.
    supersetGroup: integer("superset_group"),
    // Dormant rest target (seconds) — retained and still round-tripped, but
    // unread since rest became an up-counting stopwatch with no target.
    restSec: integer("rest_sec"),
    // Per-exercise session note — saved with the workout; prior session's
    // note ghosts (read-only) next time the exercise is logged.
    note: text("note"),
    // Provenance link to the routine row this block came from (null for
    // ad-hoc adds). Serves Update-Routine-Values write-back + PREVIOUS scope.
    routineExerciseId: uuid("routine_exercise_id").references(
      () => routineExercises.id,
    ),
  },
  (t) => [
    index("session_exercises_owner_idx").on(t.ownerId),
    index("session_exercises_session_idx").on(t.sessionId),
    // Serves the ghost-prefill lookup: latest prior session for an exercise.
    index("session_exercises_exercise_created_idx").on(
      t.exerciseId,
      t.createdAt.desc(),
    ),
  ],
);

export const setLogs = pgTable(
  "set_logs",
  {
    ...base,
    ownerId: requiredOwner,
    sessionExerciseId: uuid("session_exercise_id")
      .notNull()
      .references(() => sessionExercises.id),
    // Physical set number within the exercise. NOT unique per row: a
    // unilateral set has one 'left' and one 'right' row at the same set_no.
    setNo: integer("set_no").notNull(),
    setType: text("set_type").notNull().default("normal"), // 'normal'|'warmup'|'failure'|'drop'
    // Canonical kg; kg/lb is a display setting. Reinterpreted per exercise
    // type: added weight (weighted_bodyweight), assistance (assisted_bodyweight).
    weightKg: real("weight_kg"),
    reps: integer("reps"),
    durationSec: integer("duration_sec"), // duration-type exercises
    distanceM: real("distance_m"), // distance-type exercises (canonical meters)
    rir: integer("rir"), // legacy scalar RIR — kept as a read-compat fallback
    rirMin: integer("rir_min"),
    rirMax: integer("rir_max"),
    rpe: real("rpe"), // 1–10 perceived exertion (halves allowed); RIR ≈ 10 − RPE
    note: text("note"),
    restSec: integer("rest_sec"), // seconds rested before this set (null = first/unknown)
    metricValues: jsonb("metric_values").$type<Record<string, unknown>>(), // {metricId: value}
    completed: boolean("completed").notNull().default(false),
    // Which limb this row records. Null = the whole set (bilateral, and every
    // row logged before this feature existed — including legacy alternating
    // rows, which read as bilateral since 2026-08-08). A unilateral set is TWO
    // rows sharing (session_exercise_id, set_no): one 'left', one 'right' —
    // see docs/DECISIONS.md.
    side: text("side"), // 'left' | 'right' | null
  },
  (t) => [
    index("set_logs_owner_idx").on(t.ownerId),
    index("set_logs_session_exercise_idx").on(t.sessionExerciseId),
  ],
);

// Body measurements: one entry per local day (unique owner+date), any subset
// of fields per entry. Canonical bodyweight store — powers bodyweight-exercise
// volume math, trend graphs, and the generator report. The seeded Bodyweight
// condition metric remains the correlation-UX entry point and mirrors here.
export const measurements = pgTable(
  "measurements",
  {
    ...base,
    ownerId: requiredOwner,
    measuredOn: text("measured_on").notNull(), // local YYYY-MM-DD
    bodyweightKg: real("bodyweight_kg"),
    bodyfatPct: real("bodyfat_pct"),
    neckCm: real("neck_cm"),
    shouldersCm: real("shoulders_cm"),
    chestCm: real("chest_cm"),
    waistCm: real("waist_cm"),
    abdomenCm: real("abdomen_cm"),
    hipsCm: real("hips_cm"),
    bicepLCm: real("bicep_l_cm"),
    bicepRCm: real("bicep_r_cm"),
    forearmLCm: real("forearm_l_cm"),
    forearmRCm: real("forearm_r_cm"),
    thighLCm: real("thigh_l_cm"),
    thighRCm: real("thigh_r_cm"),
    calfLCm: real("calf_l_cm"),
    calfRCm: real("calf_r_cm"),
    // Progress photo is part of the day's entry → Hevy's 1/day rule falls out
    // structurally. Path in the private progress-photos bucket; always private.
    photoPath: text("photo_path"),
  },
  (t) => [
    index("measurements_owner_idx").on(t.ownerId),
    uniqueIndex("measurements_owner_date_idx").on(t.ownerId, t.measuredOn),
  ],
);

// Per-exercise user prefs — satellite on shared seed rows (favorites pattern).
export const exercisePrefs = pgTable(
  "exercise_prefs",
  {
    ...base,
    ownerId: requiredOwner,
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercises.id),
    weightUnit: text("weight_unit"), // 'kg' | 'lb' | null = global default
    generatorExcluded: boolean("generator_excluded").notNull().default(false),
  },
  (t) => [
    index("exercise_prefs_owner_idx").on(t.ownerId),
    uniqueIndex("exercise_prefs_owner_exercise_idx").on(
      t.ownerId,
      t.exerciseId,
    ),
  ],
);

// Server-side user preferences: only settings that change data semantics or
// must agree across devices (plan §B). Pure device behavior (theme, display
// unit, sounds, keep-awake…) stays in localStorage (apps/web lib/settings.ts).
export const userPrefs = pgTable(
  "user_prefs",
  {
    ...base,
    ownerId: requiredOwner,
    includeWarmupsInStats: boolean("include_warmups_in_stats")
      .notNull()
      .default(true),
    defaultRestSec: integer("default_rest_sec"), // dormant — no writer, no reader
    previousValuesScope: text("previous_values_scope").notNull().default("any"), // 'any' | 'routine'
    bodyDiagram: text("body_diagram").notNull().default("neutral"),
    plateConfig: jsonb("plate_config").$type<PlateConfig>(),
    displayName: text("display_name"),
    bio: text("bio"),
  },
  (t) => [uniqueIndex("user_prefs_owner_idx").on(t.ownerId)],
);

export type PlateConfig = {
  barKg: number;
  platesKg: number[];
  barLb: number;
  platesLb: number[];
  dumbbellStepKg?: number;
};

// Workout photos attached at save time (photos only in v1; ≤3 app-enforced).
// Paths live in the private session-media bucket.
export const sessionMedia = pgTable(
  "session_media",
  {
    ...base,
    ownerId: requiredOwner,
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    path: text("path").notNull(),
    position: integer("position").notNull().default(0),
    mediaType: text("media_type").notNull().default("photo"),
  },
  (t) => [
    index("session_media_owner_idx").on(t.ownerId),
    index("session_media_session_idx").on(t.sessionId),
  ],
);

// Web-push subscriptions for the Settings → Notifications toggle (M12). The
// sender Edge Function went with the rest countdown; the table stays.
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    ...base,
    ownerId: requiredOwner,
    endpoint: text("endpoint").notNull().unique(),
    keys: jsonb("keys").$type<{ p256dh: string; auth: string }>().notNull(),
  },
  (t) => [index("push_subscriptions_owner_idx").on(t.ownerId)],
);

// Personal access tokens for the read-only API (sha256 of the plaintext;
// the plaintext is shown once at creation and never stored).
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    lastUsedAt: bigint("last_used_at", { mode: "number" }),
    revokedAt: bigint("revoked_at", { mode: "number" }),
    ownerId: requiredOwner,
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
  },
  (t) => [index("api_tokens_owner_idx").on(t.ownerId)],
);

export type Machine = typeof machines.$inferSelect;
export type MachineCatalogRow = typeof machineCatalog.$inferSelect;
export type Exercise = typeof exercises.$inferSelect;
export type Metric = typeof metrics.$inferSelect;
export type TrackedCondition = typeof trackedConditions.$inferSelect;
export type ExerciseFavorite = typeof exerciseFavorites.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type SessionExercise = typeof sessionExercises.$inferSelect;
export type SetLog = typeof setLogs.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type RoutineFolder = typeof routineFolders.$inferSelect;
export type Routine = typeof routines.$inferSelect;
export type RoutineExercise = typeof routineExercises.$inferSelect;
export type RoutineSet = typeof routineSets.$inferSelect;
export type Program = typeof programs.$inferSelect;
export type Measurement = typeof measurements.$inferSelect;
export type ExercisePref = typeof exercisePrefs.$inferSelect;
export type UserPrefs = typeof userPrefs.$inferSelect;
export type SessionMediaRow = typeof sessionMedia.$inferSelect;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
