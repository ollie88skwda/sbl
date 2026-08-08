import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ApiToken,
  Exercise,
  ExerciseFavorite,
  ExercisePref,
  Machine,
  MachineSetting,
  Measurement,
  Metric,
  Program,
  PushSubscription,
  Routine,
  RoutineFolder,
  RoutineSet,
  Session,
  SessionExercise,
  SessionMediaRow,
  SetLog,
  TrackedCondition,
  UserPrefs,
} from "../db/schema";
import { SEED_CONDITIONS } from "../db/seed-ids";
import type { MuscleTarget } from "../domain/anatomy";
import { resolveExerciseShare } from "../domain/exercise-share";
import { newId } from "../domain/ids";
import { generateToken, hashToken } from "../domain/tokens";
import { groupSetsBySetNo } from "../domain/volume";
import type { FindingsSessionInput } from "../findings/types";
import type { ImportedSession, ImportResult } from "../import/types";
import type { RecordsSessionInput } from "../records/types";
import type {
  CreatedApiToken,
  ExercisePatch,
  ExportBundle,
  GhostSet,
  MachineCatalogEntry,
  MachinePatch,
  MeasurementPatch,
  NewExerciseOpts,
  NewMachineInput,
  NewMetricInput,
  NewRoutineInput,
  NewSetInput,
  Repo,
  RoutineDetail,
  RoutineExerciseInput,
  SessionExerciseDetail,
  SetSide,
  UserPrefsPatch,
} from "./types";

type Row = Record<string, unknown>;

// Left before right within a shared set_no, for stable pair ordering.
function sideRank(side: string | null): number {
  return side === "right" ? 1 : 0;
}

// PostgREST does not guarantee the order of an embedded resource, so every
// read of set_logs sorts rows into the set_no → left-before-right order that
// groupSetsBySetNo and the ᴸ/ᴿ renderers assume.
function bySetNoThenSide(a: Row, b: Row): number {
  return (
    (a.set_no as number) - (b.set_no as number) ||
    sideRank(a.side as string | null) - sideRank(b.side as string | null)
  );
}

// Library/picker list rows never render `instructions`/`image_urls` — those
// are How-to-tab-only (exercise-detail.tsx) — yet `select()` downloaded them
// on every cold load (734 kB of the ~1.17 MB payload on the seeded library).
// getExercise()/useExercise() fetch the fat fields for one row on demand.
// excluded: instructions, image_urls, media_path, media_type — detail screen
// only (media_path/media_type also cost a signed-URL round trip; not worth
// paying for on ~900 rows only to render a thumbnail nobody asked for).
// `notes` stays IN this list, unlike those: it's a short string (not an
// array of frames), and the session's block header renders it read-only for
// every logged block — fat-fielding it would mean one extra fetch per block
// on the logging hot path, exactly what LIST_COLUMNS exists to avoid.
const LIST_COLUMNS =
  "id, created_at, updated_at, deleted_at, owner_id, created_by, name, tags, " +
  "is_custom, machine_id, joint_actions, muscle_targets, image_url, " +
  "image_attribution, exercise_type, equipment, mechanic, movement_pattern, " +
  "laterality, default_reps_min, default_reps_max, default_rest_sec, aliases, notes";

// PostgREST speaks snake_case; the app speaks the schema's camelCase types.
function toExercise(r: Row): Exercise {
  return {
    id: r.id as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    deletedAt: (r.deleted_at as number | null) ?? null,
    ownerId: (r.owner_id as string | null) ?? null,
    createdBy: (r.created_by as string | null) ?? null,
    name: r.name as string,
    tags: (r.tags as string[] | null) ?? null,
    isCustom: r.is_custom as boolean,
    machineId: (r.machine_id as string | null) ?? null,
    jointActions: (r.joint_actions as string[] | null) ?? null,
    muscleTargets: (r.muscle_targets as MuscleTarget[] | null) ?? null,
    imageUrl: (r.image_url as string | null) ?? null,
    imageAttribution: (r.image_attribution as string | null) ?? null,
    exerciseType: (r.exercise_type as string) ?? "weight_reps",
    equipment: (r.equipment as string | null) ?? null,
    instructions: (r.instructions as string[] | null) ?? null,
    imageUrls: (r.image_urls as string[] | null) ?? null,
    mechanic: (r.mechanic as string | null) ?? null,
    movementPattern: (r.movement_pattern as string | null) ?? null,
    laterality: (r.laterality as string | null) ?? null,
    defaultRepsMin: (r.default_reps_min as number | null) ?? null,
    defaultRepsMax: (r.default_reps_max as number | null) ?? null,
    defaultRestSec: (r.default_rest_sec as number | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    aliases: (r.aliases as string[] | null) ?? null,
    mediaPath: (r.media_path as string | null) ?? null,
    mediaType: (r.media_type as string | null) ?? null,
  };
}

function toMachine(r: Row): Machine {
  return {
    id: r.id as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    deletedAt: (r.deleted_at as number | null) ?? null,
    ownerId: r.owner_id as string,
    name: r.name as string,
    brand: (r.brand as string | null) ?? null,
    catalogKey: (r.catalog_key as string | null) ?? null,
    settings: (r.settings as MachineSetting[] | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    photoPath: (r.photo_path as string | null) ?? null,
  };
}

function toSession(r: Row): Session {
  return {
    id: r.id as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    deletedAt: (r.deleted_at as number | null) ?? null,
    ownerId: r.owner_id as string,
    title: (r.title as string | null) ?? null,
    startedAt: r.started_at as number,
    endedAt: (r.ended_at as number | null) ?? null,
    conditionValues:
      (r.condition_values as Record<string, unknown> | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    routineId: (r.routine_id as string | null) ?? null,
    pausedMs: (r.paused_ms as number) ?? 0,
    shareSlug: (r.share_slug as string | null) ?? null,
  };
}

function toMetric(r: Row): Metric {
  return {
    id: r.id as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    deletedAt: (r.deleted_at as number | null) ?? null,
    ownerId: (r.owner_id as string | null) ?? null,
    name: r.name as string,
    type: r.type as string,
    scope: r.scope as string,
    unit: (r.unit as string | null) ?? null,
    exerciseIds: (r.exercise_ids as string[] | null) ?? null,
  };
}

function toTrackedCondition(r: Row): TrackedCondition {
  return {
    id: r.id as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    deletedAt: (r.deleted_at as number | null) ?? null,
    ownerId: r.owner_id as string,
    metricId: r.metric_id as string,
    tracked: r.tracked as boolean,
    position: (r.position as number | null) ?? null,
  };
}

function toExerciseFavorite(r: Row): ExerciseFavorite {
  return {
    id: r.id as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    deletedAt: (r.deleted_at as number | null) ?? null,
    ownerId: r.owner_id as string,
    exerciseId: r.exercise_id as string,
    favorite: r.favorite as boolean,
  };
}

function toSessionExercise(r: Row): SessionExercise {
  return {
    id: r.id as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    deletedAt: (r.deleted_at as number | null) ?? null,
    ownerId: r.owner_id as string,
    sessionId: r.session_id as string,
    exerciseId: r.exercise_id as string,
    orderIndex: r.order_index as number,
    supersetGroup: (r.superset_group as number | null) ?? null,
    restSec: (r.rest_sec as number | null) ?? null,
    note: (r.note as string | null) ?? null,
    routineExerciseId: (r.routine_exercise_id as string | null) ?? null,
  };
}

function toSetLog(r: Row): SetLog {
  return {
    id: r.id as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    deletedAt: (r.deleted_at as number | null) ?? null,
    ownerId: r.owner_id as string,
    sessionExerciseId: r.session_exercise_id as string,
    setNo: r.set_no as number,
    setType: (r.set_type as string) ?? "normal",
    weightKg: (r.weight_kg as number | null) ?? null,
    reps: (r.reps as number | null) ?? null,
    durationSec: (r.duration_sec as number | null) ?? null,
    distanceM: (r.distance_m as number | null) ?? null,
    rir: (r.rir as number | null) ?? null,
    rirMin: (r.rir_min as number | null) ?? null,
    rirMax: (r.rir_max as number | null) ?? null,
    rpe: (r.rpe as number | null) ?? null,
    note: (r.note as string | null) ?? null,
    restSec: (r.rest_sec as number | null) ?? null,
    metricValues: (r.metric_values as Record<string, unknown> | null) ?? null,
    completed: r.completed as boolean,
    side: (r.side as SetSide | null) ?? null,
  };
}

function toMeasurement(r: Row): Measurement {
  return {
    id: r.id as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    deletedAt: (r.deleted_at as number | null) ?? null,
    ownerId: r.owner_id as string,
    measuredOn: r.measured_on as string,
    bodyweightKg: (r.bodyweight_kg as number | null) ?? null,
    bodyfatPct: (r.bodyfat_pct as number | null) ?? null,
    neckCm: (r.neck_cm as number | null) ?? null,
    shouldersCm: (r.shoulders_cm as number | null) ?? null,
    chestCm: (r.chest_cm as number | null) ?? null,
    waistCm: (r.waist_cm as number | null) ?? null,
    abdomenCm: (r.abdomen_cm as number | null) ?? null,
    hipsCm: (r.hips_cm as number | null) ?? null,
    bicepLCm: (r.bicep_l_cm as number | null) ?? null,
    bicepRCm: (r.bicep_r_cm as number | null) ?? null,
    forearmLCm: (r.forearm_l_cm as number | null) ?? null,
    forearmRCm: (r.forearm_r_cm as number | null) ?? null,
    thighLCm: (r.thigh_l_cm as number | null) ?? null,
    thighRCm: (r.thigh_r_cm as number | null) ?? null,
    calfLCm: (r.calf_l_cm as number | null) ?? null,
    calfRCm: (r.calf_r_cm as number | null) ?? null,
    photoPath: (r.photo_path as string | null) ?? null,
  };
}

function toSessionMedia(r: Row): SessionMediaRow {
  return {
    id: r.id as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    deletedAt: (r.deleted_at as number | null) ?? null,
    ownerId: r.owner_id as string,
    sessionId: r.session_id as string,
    path: r.path as string,
    position: (r.position as number) ?? 0,
    mediaType: (r.media_type as string) ?? "photo",
  };
}

function toProgram(r: Row): Program {
  return {
    id: r.id as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    deletedAt: (r.deleted_at as number | null) ?? null,
    ownerId: r.owner_id as string,
    source: r.source as string,
    libraryKey: (r.library_key as string | null) ?? null,
    config: (r.config as Record<string, unknown> | null) ?? null,
    folderId: r.folder_id as string,
    active: (r.active as boolean) ?? false,
  };
}

function toRoutineFolder(r: Row): RoutineFolder {
  return {
    id: r.id as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    deletedAt: (r.deleted_at as number | null) ?? null,
    ownerId: r.owner_id as string,
    name: r.name as string,
    position: (r.position as number) ?? 0,
  };
}

function toRoutine(r: Row): Routine {
  return {
    id: r.id as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    deletedAt: (r.deleted_at as number | null) ?? null,
    ownerId: r.owner_id as string,
    name: r.name as string,
    folderId: (r.folder_id as string | null) ?? null,
    position: (r.position as number) ?? 0,
    description: (r.description as string | null) ?? null,
  };
}

function toRoutineSet(r: Row): RoutineSet {
  return {
    id: r.id as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    deletedAt: (r.deleted_at as number | null) ?? null,
    ownerId: r.owner_id as string,
    routineExerciseId: r.routine_exercise_id as string,
    setNo: r.set_no as number,
    setType: (r.set_type as string) ?? "normal",
    targetWeightKg: (r.target_weight_kg as number | null) ?? null,
    targetReps: (r.target_reps as number | null) ?? null,
    targetRepsMax: (r.target_reps_max as number | null) ?? null,
    targetDurationSec: (r.target_duration_sec as number | null) ?? null,
    targetDistanceM: (r.target_distance_m as number | null) ?? null,
    targetRirMin: (r.target_rir_min as number | null) ?? null,
    targetRirMax: (r.target_rir_max as number | null) ?? null,
  };
}

function toApiToken(r: Row): ApiToken {
  return {
    id: r.id as string,
    createdAt: r.created_at as number,
    lastUsedAt: (r.last_used_at as number | null) ?? null,
    revokedAt: (r.revoked_at as number | null) ?? null,
    ownerId: r.owner_id as string,
    name: r.name as string,
    tokenHash: r.token_hash as string,
  };
}

function throwIf(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

export class SupabaseRepo implements Repo {
  // getOwnerId is required when the client uses the `accessToken` option
  // (which disables `client.auth.*`, e.g. the Clerk-backed web client);
  // clients with native Supabase sessions (tests) can omit it.
  constructor(
    private client: SupabaseClient,
    private opts: { getOwnerId?: () => Promise<string> } = {},
  ) {}

  private static readonly PAGE_SIZE = 1000;

  // PostgREST caps every `select()` at 1000 rows by default; a flat select on
  // a table that can grow past that (exercise library, set logs, …) silently
  // truncates instead of erroring. Loop `.range()` until the rows collected so
  // far cover the total PostgREST reports, so the common single-page case costs
  // exactly one request. `page` must therefore ask for that total with
  // `.select(cols, { count: "exact" })`; a page that doesn't falls back to the
  // empty-page stop rule, which is still correct, just one request slower.
  // Advance by the rows actually returned, not by the requested page size, so a
  // server whose `max_rows` is configured below PAGE_SIZE still paginates
  // instead of stopping at the first short page. `page` must apply a
  // deterministic order (e.g. `id`) so rows aren't skipped or repeated across
  // pages.
  private async selectAll<T>(
    // `data` is typed `unknown` because a hand-written `.select("col, list")`
    // string makes supabase-js fall back to an error-sentinel type (same
    // reason other `.select("…")` calls in this file cast their result).
    page: (
      from: number,
      to: number,
    ) => PromiseLike<{
      data: unknown;
      error: { message: string } | null;
      count: number | null;
    }>,
  ): Promise<T[]> {
    const rows: T[] = [];
    let from = 0;
    for (;;) {
      const { data, error, count } = await page(
        from,
        from + SupabaseRepo.PAGE_SIZE - 1,
      );
      throwIf(error);
      const batch = (data as T[] | null) ?? [];
      rows.push(...batch);
      if (batch.length === 0 || (count != null && rows.length >= count)) {
        return rows;
      }
      from += batch.length;
    }
  }

  async createExercise(
    name: string,
    opts?: NewExerciseOpts,
  ): Promise<Exercise> {
    // One publish-vs-private rule shared with the app's optimistic row and
    // create form (domain/exercise-share.ts): an explicit share: false or a
    // machine link forces a private row — the RPC whitelist can't carry
    // machine_id, so publishing would silently drop it.
    const share = resolveExerciseShare(opts);
    const id = opts?.id ?? newId();
    if (share) {
      // Community publish path (docs/DECISIONS.md 2026-08-08): the row is
      // created as owner_id null + created_by = caller via the security
      // definer publish_exercise RPC — never by a direct insert, which RLS
      // rejects for null-owner rows by design. The RPC returns the canonical
      // id: the inserted row's id, or the existing row's id when the
      // case-insensitive dedupe backstop matched (no duplicate created).
      const { data: canonicalId, error } = await this.client.rpc(
        "publish_exercise",
        {
          p_id: id,
          p_name: name,
          p_joint_actions: opts?.jointActions?.length
            ? opts.jointActions
            : null,
          p_muscle_targets: opts?.muscleTargets?.length
            ? opts.muscleTargets
            : null,
          p_exercise_type: opts?.exerciseType ?? "weight_reps",
          p_equipment: opts?.equipment ?? null,
          p_instructions: opts?.instructions?.length ? opts.instructions : null,
          p_image_urls: opts?.imageUrls?.length ? opts.imageUrls : null,
          p_mechanic: opts?.mechanic ?? null,
          p_movement_pattern: opts?.movementPattern ?? null,
          p_laterality: opts?.laterality ?? null,
          p_default_reps_min: opts?.defaultRepsMin ?? null,
          p_default_reps_max: opts?.defaultRepsMax ?? null,
          p_default_rest_sec: opts?.defaultRestSec ?? null,
          p_notes: opts?.notes ?? null,
          p_aliases: opts?.aliases?.length ? opts.aliases : null,
        },
      );
      throwIf(error);
      if (!canonicalId) {
        throw new Error("Could not publish the exercise");
      }
      // Read back the canonical row (on the dupe-hit path this is the
      // existing global row, not the one the caller optimistically created).
      const { data, error: readError } = await this.client
        .from("exercises")
        .select()
        .eq("id", canonicalId as string)
        .single();
      throwIf(readError);
      return toExercise(data as Row);
    }
    // Private path — unchanged direct insert, owner_id = caller via RLS.
    const now = Date.now();
    const row = {
      id,
      created_at: now,
      updated_at: now,
      name,
      is_custom: true,
      machine_id: opts?.machineId ?? null,
      joint_actions: opts?.jointActions?.length ? opts.jointActions : null,
      muscle_targets: opts?.muscleTargets?.length ? opts.muscleTargets : null,
      exercise_type: opts?.exerciseType ?? "weight_reps",
      equipment: opts?.equipment ?? null,
      instructions: opts?.instructions?.length ? opts.instructions : null,
      image_urls: opts?.imageUrls?.length ? opts.imageUrls : null,
      mechanic: opts?.mechanic ?? null,
      movement_pattern: opts?.movementPattern ?? null,
      laterality: opts?.laterality ?? null,
      default_reps_min: opts?.defaultRepsMin ?? null,
      default_reps_max: opts?.defaultRepsMax ?? null,
      default_rest_sec: opts?.defaultRestSec ?? null,
      notes: opts?.notes ?? null,
      aliases: opts?.aliases?.length ? opts.aliases : null,
    };
    const { data, error } = await this.client
      .from("exercises")
      .insert(row)
      .select()
      .single();
    throwIf(error);
    return toExercise(data as Row);
  }

  async listMachines(): Promise<Machine[]> {
    const { data, error } = await this.client
      .from("machines")
      .select()
      .is("deleted_at", null)
      .order("name");
    throwIf(error);
    return (data as Row[]).map(toMachine);
  }

  // The lookup-UX search lives in SQL (search_machine_catalog, migration
  // 20260807101227): it must match a term against the `aliases` jsonb array
  // too, which PostgREST's or()/ilike filters can't express. SECURITY INVOKER
  // keeps it RLS-scoped exactly like a direct select.
  async searchMachineCatalog(
    query: string,
    opts: { category?: string | null; limit?: number } = {},
  ): Promise<MachineCatalogEntry[]> {
    const { data, error } = await this.client.rpc("search_machine_catalog", {
      q: query,
      cat: opts.category ?? null,
      max_rows: opts.limit ?? 20,
    });
    throwIf(error);
    return (data as Row[]).map((r) => ({
      id: r.id as string,
      brand: r.brand as string,
      model: r.model as string,
      category: r.category as string,
    }));
  }

  async listMachineCategories(): Promise<string[]> {
    const { data, error } = await this.client.rpc("list_machine_categories");
    throwIf(error);
    return (data as Row[]).map((r) => r.category as string);
  }

  async createMachine(input: NewMachineInput): Promise<Machine> {
    const now = Date.now();
    const row = {
      id: input.id ?? newId(),
      created_at: now,
      updated_at: now,
      name: input.name,
      brand: input.brand ?? null,
      catalog_key: input.catalogKey ?? null,
      settings: input.settings?.length ? input.settings : null,
      notes: input.notes ?? null,
    };
    const { data, error } = await this.client
      .from("machines")
      .insert(row)
      .select()
      .single();
    throwIf(error);
    return toMachine(data as Row);
  }

  async updateMachine(id: string, patch: MachinePatch): Promise<void> {
    const row: Row = { updated_at: Date.now() };
    if ("name" in patch && patch.name != null) row.name = patch.name;
    if ("brand" in patch) row.brand = patch.brand ?? null;
    if ("catalogKey" in patch) row.catalog_key = patch.catalogKey ?? null;
    if ("settings" in patch)
      row.settings = patch.settings?.length ? patch.settings : null;
    if ("notes" in patch) row.notes = patch.notes ?? null;
    const { error } = await this.client
      .from("machines")
      .update(row)
      .eq("id", id);
    throwIf(error);
  }

  async deleteMachine(id: string): Promise<void> {
    await this.softDelete("machines", id);
    const { error } = await this.client
      .from("exercises")
      .update({ machine_id: null, updated_at: Date.now() })
      .eq("machine_id", id);
    throwIf(error);
  }

  // Replaces setExerciseMachine/setExerciseClassification/
  // setExerciseTypeEquipment/setExerciseTags — one patch method instead of a
  // narrow setter per editable field (RLS still restricts writes to the
  // caller's own custom rows; this is the seam, not the security boundary).
  async updateExercise(id: string, patch: ExercisePatch): Promise<void> {
    const row: Row = { updated_at: Date.now() };
    if ("name" in patch && patch.name != null) row.name = patch.name;
    if ("muscleTargets" in patch)
      row.muscle_targets = patch.muscleTargets?.length
        ? patch.muscleTargets
        : null;
    if ("jointActions" in patch)
      row.joint_actions = patch.jointActions?.length
        ? patch.jointActions
        : null;
    if ("machineId" in patch) row.machine_id = patch.machineId ?? null;
    if ("exerciseType" in patch && patch.exerciseType != null)
      row.exercise_type = patch.exerciseType;
    if ("equipment" in patch) row.equipment = patch.equipment ?? null;
    if ("tags" in patch) row.tags = patch.tags?.length ? patch.tags : null;
    if ("mechanic" in patch) row.mechanic = patch.mechanic ?? null;
    if ("movementPattern" in patch)
      row.movement_pattern = patch.movementPattern ?? null;
    if ("laterality" in patch) row.laterality = patch.laterality ?? null;
    if ("defaultRepsMin" in patch)
      row.default_reps_min = patch.defaultRepsMin ?? null;
    if ("defaultRepsMax" in patch)
      row.default_reps_max = patch.defaultRepsMax ?? null;
    if ("defaultRestSec" in patch)
      row.default_rest_sec = patch.defaultRestSec ?? null;
    if ("notes" in patch) row.notes = patch.notes ?? null;
    if ("aliases" in patch)
      row.aliases = patch.aliases?.length ? patch.aliases : null;
    if ("instructions" in patch)
      row.instructions = patch.instructions?.length ? patch.instructions : null;
    if ("imageUrls" in patch)
      row.image_urls = patch.imageUrls?.length ? patch.imageUrls : null;
    const { error } = await this.client
      .from("exercises")
      .update(row)
      .eq("id", id);
    throwIf(error);
  }

  private async ownerId(): Promise<string> {
    if (this.opts.getOwnerId) return this.opts.getOwnerId();
    const { data, error } = await this.client.auth.getUser();
    if (error || !data.user) throw new Error(error?.message ?? "Not signed in");
    return data.user.id;
  }

  async uploadMachinePhoto(machineId: string, file: Blob): Promise<void> {
    const uid = await this.ownerId();
    const path = `${uid}/${machineId}.jpg`;
    const { error: uploadError } = await this.client.storage
      .from("machine-photos")
      .upload(path, file, { upsert: true, contentType: "image/jpeg" });
    throwIf(uploadError);
    const { error } = await this.client
      .from("machines")
      .update({ photo_path: path, updated_at: Date.now() })
      .eq("id", machineId);
    throwIf(error);
  }

  async machinePhotoUrl(machine: Machine): Promise<string | null> {
    if (!machine.photoPath) return null;
    const { data, error } = await this.client.storage
      .from("machine-photos")
      .createSignedUrl(machine.photoPath, 60 * 60);
    throwIf(error);
    return data?.signedUrl ?? null;
  }

  async uploadMachineSettingPhoto(
    machineId: string,
    file: Blob,
    existingPath: string | null,
  ): Promise<string> {
    const uid = await this.ownerId();
    // Reuse the existing object when one is being replaced (upsert, no
    // orphan); a fresh setting mints a unique path. The path rides in the
    // setting's jsonb (`photoPath`), so it survives settings reorders.
    const path = existingPath ?? `${uid}/${machineId}-${newId()}.jpg`;
    const { error: uploadError } = await this.client.storage
      .from("machine-photos")
      .upload(path, file, { upsert: true, contentType: "image/jpeg" });
    throwIf(uploadError);
    return path;
  }

  async machineSettingPhotoUrl(path: string): Promise<string | null> {
    const { data, error } = await this.client.storage
      .from("machine-photos")
      .createSignedUrl(path, 60 * 60);
    throwIf(error);
    return data?.signedUrl ?? null;
  }

  async uploadExerciseMedia(
    exerciseId: string,
    file: Blob,
    kind: "image" | "video",
  ): Promise<void> {
    const uid = await this.ownerId();
    // Image is always resized to JPEG client-side (lib/photo.ts); video is
    // uploaded as-is, so keep its own content type for correct playback.
    const path = `${uid}/${exerciseId}.${kind === "image" ? "jpg" : "mp4"}`;
    // Swapping a demo image for a clip (or back) writes a different key, so
    // `upsert` can't replace the old object and the row keeps only the new
    // path — the previous file would sit in the bucket with nothing pointing
    // at it. Read what it is replacing before the row moves on.
    const previous = await this.exerciseMediaPath(exerciseId);
    const { error: uploadError } = await this.client.storage
      .from("exercise-media")
      .upload(path, file, {
        upsert: true,
        contentType: kind === "image" ? "image/jpeg" : file.type || "video/mp4",
      });
    throwIf(uploadError);
    const { error } = await this.client
      .from("exercises")
      .update({ media_path: path, media_type: kind, updated_at: Date.now() })
      .eq("id", exerciseId);
    throwIf(error);
    if (previous && previous !== path) {
      // Best-effort, same as clearExerciseMedia: the row already points at the
      // new object, so a failed removal costs storage, not correctness.
      await this.client.storage.from("exercise-media").remove([previous]);
    }
  }

  private async exerciseMediaPath(exerciseId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from("exercises")
      .select("media_path")
      .eq("id", exerciseId)
      .limit(1);
    throwIf(error);
    return ((data as Row[] | null)?.[0]?.media_path as string | null) ?? null;
  }

  async clearExerciseMedia(exerciseId: string): Promise<void> {
    const path = await this.exerciseMediaPath(exerciseId);
    if (path) {
      // Best-effort object removal; the row update is the source of truth.
      await this.client.storage.from("exercise-media").remove([path]);
    }
    const { error } = await this.client
      .from("exercises")
      .update({ media_path: null, media_type: null, updated_at: Date.now() })
      .eq("id", exerciseId);
    throwIf(error);
  }

  async exerciseMediaUrl(exercise: Exercise): Promise<string | null> {
    if (!exercise.mediaPath) return null;
    const { data, error } = await this.client.storage
      .from("exercise-media")
      .createSignedUrl(exercise.mediaPath, 60 * 60);
    throwIf(error);
    return data?.signedUrl ?? null;
  }

  async listExercises(): Promise<Exercise[]> {
    // `.order("id")` tie-breaks `name` so pagination is deterministic even
    // when two exercises share a name (see `selectAll`).
    const rows = await this.selectAll<Row>((from, to) =>
      this.client
        .from("exercises")
        .select(LIST_COLUMNS, { count: "exact" })
        .is("deleted_at", null)
        .order("name")
        .order("id")
        .range(from, to),
    );
    return rows.map(toExercise);
  }

  /** Fat fields (instructions, imageUrls) for one exercise — see B2. */
  async getExercise(id: string): Promise<Exercise | null> {
    const { data, error } = await this.client
      .from("exercises")
      .select()
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle();
    throwIf(error);
    return data ? toExercise(data as Row) : null;
  }

  async startSession(title?: string): Promise<Session> {
    const now = Date.now();
    const row = {
      id: newId(),
      created_at: now,
      updated_at: now,
      title: title ?? null,
      started_at: now,
    };
    const { data, error } = await this.client
      .from("sessions")
      .insert(row)
      .select()
      .single();
    throwIf(error);
    return toSession(data as Row);
  }

  async endSession(sessionId: string): Promise<void> {
    const now = Date.now();
    const { error } = await this.client
      .from("sessions")
      .update({ ended_at: now, updated_at: now })
      .eq("id", sessionId);
    throwIf(error);
  }

  async updateSessionStartedAt(
    sessionId: string,
    startedAt: number,
  ): Promise<void> {
    const { error } = await this.client
      .from("sessions")
      .update({ started_at: startedAt, updated_at: Date.now() })
      .eq("id", sessionId);
    throwIf(error);
  }

  async activeSession(): Promise<Session | null> {
    const { data, error } = await this.client
      .from("sessions")
      .select()
      .is("ended_at", null)
      .is("deleted_at", null)
      .order("started_at", { ascending: false })
      .limit(1);
    throwIf(error);
    const row = (data as Row[] | null)?.[0];
    return row ? toSession(row) : null;
  }

  private async softDelete(table: string, id: string): Promise<void> {
    const now = Date.now();
    const { error } = await this.client
      .from(table)
      .update({ deleted_at: now, updated_at: now })
      .eq("id", id);
    throwIf(error);
  }

  deleteSet(id: string) {
    return this.softDelete("set_logs", id);
  }
  deleteExercise(id: string) {
    return this.softDelete("exercises", id);
  }
  deleteMetric(id: string) {
    return this.softDelete("metrics", id);
  }

  // Soft-delete cascade helper. Reads that key off session_exercises/set_logs
  // (ghost prefill, export) filter each table's own deleted_at without joining
  // the parent, so a soft-deleted parent must tombstone its children too — else
  // orphaned rows resurface (e.g. a deleted session's sets in ghost prefill).
  private async softDeleteSetsOf(
    sessionExerciseIds: string[],
    now: number,
  ): Promise<void> {
    if (sessionExerciseIds.length === 0) return;
    const { error } = await this.client
      .from("set_logs")
      .update({ deleted_at: now, updated_at: now })
      .in("session_exercise_id", sessionExerciseIds);
    throwIf(error);
  }

  async deleteSessionExercise(id: string): Promise<void> {
    const now = Date.now();
    await this.softDeleteSetsOf([id], now);
    const { error } = await this.client
      .from("session_exercises")
      .update({ deleted_at: now, updated_at: now })
      .eq("id", id);
    throwIf(error);
  }

  async deleteSession(id: string): Promise<void> {
    const now = Date.now();
    const { data: ses, error: seErr } = await this.client
      .from("session_exercises")
      .select("id")
      .eq("session_id", id);
    throwIf(seErr);
    const seIds = (ses ?? []).map((r) => r.id as string);
    await this.softDeleteSetsOf(seIds, now);
    if (seIds.length > 0) {
      const { error: seUpdErr } = await this.client
        .from("session_exercises")
        .update({ deleted_at: now, updated_at: now })
        .eq("session_id", id);
      throwIf(seUpdErr);
    }
    const { error } = await this.client
      .from("sessions")
      .update({ deleted_at: now, updated_at: now })
      .eq("id", id);
    throwIf(error);
  }

  async updateSet(setId: string, patch: Partial<NewSetInput>): Promise<void> {
    const row: Row = { updated_at: Date.now() };
    if ("weightKg" in patch) row.weight_kg = patch.weightKg ?? null;
    if ("reps" in patch) row.reps = patch.reps ?? null;
    if ("rir" in patch) row.rir = patch.rir ?? null;
    if ("rirMin" in patch) row.rir_min = patch.rirMin ?? null;
    if ("rirMax" in patch) row.rir_max = patch.rirMax ?? null;
    if ("rpe" in patch) row.rpe = patch.rpe ?? null;
    if ("note" in patch) row.note = patch.note ?? null;
    if ("restSec" in patch) row.rest_sec = patch.restSec ?? null;
    if ("metricValues" in patch) row.metric_values = patch.metricValues ?? null;
    if ("setType" in patch) row.set_type = patch.setType ?? "normal";
    if ("durationSec" in patch) row.duration_sec = patch.durationSec ?? null;
    if ("distanceM" in patch) row.distance_m = patch.distanceM ?? null;
    if ("side" in patch) row.side = patch.side ?? null;
    const { error } = await this.client
      .from("set_logs")
      .update(row)
      .eq("id", setId);
    throwIf(error);
  }

  async addExerciseToSession(
    sessionId: string,
    exerciseId: string,
  ): Promise<string> {
    const now = Date.now();
    const { count, error: countError } = await this.client
      .from("session_exercises")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId);
    throwIf(countError);
    const row = {
      id: newId(),
      created_at: now,
      updated_at: now,
      session_id: sessionId,
      exercise_id: exerciseId,
      order_index: count ?? 0,
    };
    const { error } = await this.client.from("session_exercises").insert(row);
    throwIf(error);
    return row.id;
  }

  async logSet(
    sessionExerciseId: string,
    set: NewSetInput,
    id: string,
    setNo: number,
  ): Promise<string> {
    const now = Date.now();
    const row = {
      id,
      created_at: now,
      updated_at: now,
      session_exercise_id: sessionExerciseId,
      set_no: setNo,
      weight_kg: set.weightKg,
      reps: set.reps,
      rir: set.rir ?? null,
      rir_min: set.rirMin ?? null,
      rir_max: set.rirMax ?? null,
      rpe: set.rpe ?? null,
      note: set.note ?? null,
      rest_sec: set.restSec ?? null,
      metric_values: set.metricValues ?? null,
      set_type: set.setType ?? "normal",
      duration_sec: set.durationSec ?? null,
      distance_m: set.distanceM ?? null,
      completed: true,
      side: set.side ?? null,
    };
    // Upsert (not insert): a mutation retry after a lost response replays
    // this with the same `id`, and must overwrite the same row rather than
    // append a duplicate set.
    const { error } = await this.client
      .from("set_logs")
      .upsert(row, { onConflict: "id" });
    throwIf(error);
    return row.id;
  }

  async listSessionExercises(
    sessionId: string,
  ): Promise<SessionExerciseDetail[]> {
    const { data, error } = await this.client
      .from("session_exercises")
      .select(
        "id, exercise_id, order_index, superset_group, rest_sec, note, routine_exercise_id, exercises(name), set_logs(id, set_no, set_type, weight_kg, reps, duration_sec, distance_m, rir, rir_min, rir_max, rpe, note, rest_sec, side, deleted_at)",
      )
      .eq("session_id", sessionId)
      .is("deleted_at", null)
      .order("order_index");
    throwIf(error);
    return ((data as Row[]) ?? []).map((r) => ({
      id: r.id as string,
      exerciseId: r.exercise_id as string,
      exerciseName: ((r.exercises as Row | null)?.name as string) ?? "",
      orderIndex: r.order_index as number,
      supersetGroup: (r.superset_group as number | null) ?? null,
      restSec: (r.rest_sec as number | null) ?? null,
      note: (r.note as string | null) ?? null,
      routineExerciseId: (r.routine_exercise_id as string | null) ?? null,
      sets: ((r.set_logs as Row[]) ?? [])
        .filter((s) => s.deleted_at == null)
        .sort(bySetNoThenSide)
        .map((s) => ({
          id: s.id as string,
          setNo: s.set_no as number,
          setType: (s.set_type as string) ?? "normal",
          weightKg: (s.weight_kg as number | null) ?? null,
          reps: (s.reps as number | null) ?? null,
          durationSec: (s.duration_sec as number | null) ?? null,
          distanceM: (s.distance_m as number | null) ?? null,
          rir: (s.rir as number | null) ?? null,
          rirMin: (s.rir_min as number | null) ?? null,
          rirMax: (s.rir_max as number | null) ?? null,
          rpe: (s.rpe as number | null) ?? null,
          note: (s.note as string | null) ?? null,
          restSec: (s.rest_sec as number | null) ?? null,
          side: (s.side as SetSide | null) ?? null,
        })),
    }));
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const { data, error } = await this.client
      .from("sessions")
      .select()
      .eq("id", sessionId)
      .maybeSingle();
    throwIf(error);
    return data ? toSession(data as Row) : null;
  }

  async updateSessionConditions(
    sessionId: string,
    values: Record<string, unknown>,
  ): Promise<void> {
    // Replace semantics: the conditions dialog owns the full set, so removing
    // a condition sticks. (applySleep does its own read-merge-write.)
    const { error } = await this.client
      .from("sessions")
      .update({ condition_values: values, updated_at: Date.now() })
      .eq("id", sessionId);
    throwIf(error);
  }

  async updateSessionNotes(
    sessionId: string,
    notes: string | null,
  ): Promise<void> {
    const { error } = await this.client
      .from("sessions")
      .update({
        notes: notes?.length ? notes : null,
        updated_at: Date.now(),
      })
      .eq("id", sessionId);
    throwIf(error);
  }

  async listSessions(limit: number, offset: number): Promise<Session[]> {
    const { data, error } = await this.client
      .from("sessions")
      .select()
      .is("deleted_at", null)
      .order("started_at", { ascending: false })
      .range(offset, offset + limit - 1);
    throwIf(error);
    return (data as Row[]).map(toSession);
  }

  async findingsData(): Promise<FindingsSessionInput[]> {
    const rows = await this.selectAll<Row>((from, to) =>
      this.client
        .from("sessions")
        .select(
          "id, started_at, condition_values, deleted_at, session_exercises(exercise_id, deleted_at, exercises(name), set_logs(weight_kg, reps, set_type, rir, rir_min, rir_max, rpe, deleted_at))",
          { count: "exact" },
        )
        .is("deleted_at", null)
        .order("started_at", { ascending: true })
        .order("id")
        .range(from, to),
    );
    return rows.map((s) => ({
      sessionId: s.id as string,
      startedAt: s.started_at as number,
      conditionValues:
        (s.condition_values as Record<string, unknown> | null) ?? null,
      sets: ((s.session_exercises as Row[]) ?? [])
        .filter((se) => se.deleted_at == null)
        .flatMap((se) =>
          (
            ((se.set_logs as Row[]) ?? []).filter(
              (sl) => sl.deleted_at == null,
            ) ?? []
          ).map((sl) => ({
            exerciseId: se.exercise_id as string,
            exerciseName: ((se.exercises as Row | null)?.name as string) ?? "",
            weightKg: (sl.weight_kg as number | null) ?? null,
            reps: (sl.reps as number | null) ?? null,
            setType: (sl.set_type as string | null) ?? null,
            rir: (sl.rir as number | null) ?? null,
            rirMin: (sl.rir_min as number | null) ?? null,
            rirMax: (sl.rir_max as number | null) ?? null,
            rpe: (sl.rpe as number | null) ?? null,
          })),
        ),
    }));
  }

  async updateSessionTitle(
    sessionId: string,
    title: string | null,
  ): Promise<void> {
    const { error } = await this.client
      .from("sessions")
      .update({ title, updated_at: Date.now() })
      .eq("id", sessionId);
    throwIf(error);
  }

  async updateSessionEndedAt(
    sessionId: string,
    endedAt: number,
  ): Promise<void> {
    const { error } = await this.client
      .from("sessions")
      .update({ ended_at: endedAt, updated_at: Date.now() })
      .eq("id", sessionId);
    throwIf(error);
  }

  async updateSessionPausedMs(
    sessionId: string,
    pausedMs: number,
  ): Promise<void> {
    const { error } = await this.client
      .from("sessions")
      .update({ paused_ms: pausedMs, updated_at: Date.now() })
      .eq("id", sessionId);
    throwIf(error);
  }

  async updateSessionExercise(
    sessionExerciseId: string,
    patch: {
      supersetGroup?: number | null;
      restSec?: number | null;
      note?: string | null;
      exerciseId?: string;
    },
  ): Promise<void> {
    const row: Row = { updated_at: Date.now() };
    if ("supersetGroup" in patch)
      row.superset_group = patch.supersetGroup ?? null;
    if ("restSec" in patch) row.rest_sec = patch.restSec ?? null;
    if ("note" in patch) row.note = patch.note ?? null;
    if ("exerciseId" in patch) row.exercise_id = patch.exerciseId;
    const { error } = await this.client
      .from("session_exercises")
      .update(row)
      .eq("id", sessionExerciseId);
    throwIf(error);
  }

  async getSessionExercise(
    sessionExerciseId: string,
  ): Promise<{ exerciseId: string } | null> {
    const { data, error } = await this.client
      .from("session_exercises")
      .select("exercise_id")
      .eq("id", sessionExerciseId)
      .maybeSingle();
    throwIf(error);
    return data ? { exerciseId: data.exercise_id as string } : null;
  }

  async recordsData(): Promise<RecordsSessionInput[]> {
    const rows = await this.selectAll<Row>((from, to) =>
      this.client
        .from("sessions")
        .select(
          "id, started_at, ended_at, paused_ms, deleted_at, session_exercises(exercise_id, deleted_at, exercises(exercise_type), set_logs(set_no, side, set_type, weight_kg, reps, duration_sec, distance_m, rir, rir_min, rir_max, rpe, deleted_at))",
          { count: "exact" },
        )
        .is("deleted_at", null)
        .order("started_at", { ascending: true })
        .order("id")
        .range(from, to),
    );
    return rows.map((s) => ({
      sessionId: s.id as string,
      startedAt: s.started_at as number,
      endedAt: (s.ended_at as number | null) ?? null,
      pausedMs: (s.paused_ms as number) ?? 0,
      exercises: ((s.session_exercises as Row[]) ?? [])
        .filter((se) => se.deleted_at == null)
        .map((se) => ({
          exerciseId: se.exercise_id as string,
          exerciseType:
            ((se.exercises as Row | null)?.exercise_type as string) ??
            "weight_reps",
          sets: ((se.set_logs as Row[]) ?? [])
            .filter((sl) => sl.deleted_at == null)
            .sort(bySetNoThenSide)
            .map((sl) => ({
              setNo: sl.set_no as number,
              side: (sl.side as SetSide | null) ?? null,
              setType: (sl.set_type as string) ?? "normal",
              weightKg: (sl.weight_kg as number | null) ?? null,
              reps: (sl.reps as number | null) ?? null,
              durationSec: (sl.duration_sec as number | null) ?? null,
              distanceM: (sl.distance_m as number | null) ?? null,
              rir: (sl.rir as number | null) ?? null,
              rirMin: (sl.rir_min as number | null) ?? null,
              rirMax: (sl.rir_max as number | null) ?? null,
              rpe: (sl.rpe as number | null) ?? null,
            })),
        })),
    }));
  }

  async listMetrics(): Promise<Metric[]> {
    const { data, error } = await this.client
      .from("metrics")
      .select()
      .is("deleted_at", null)
      .order("name");
    throwIf(error);
    return (data as Row[]).map(toMetric);
  }

  async createMetric(input: NewMetricInput): Promise<Metric> {
    const now = Date.now();
    const row = {
      id: newId(),
      created_at: now,
      updated_at: now,
      name: input.name,
      type: input.type,
      scope: input.scope,
      unit: input.unit ?? null,
    };
    const { data, error } = await this.client
      .from("metrics")
      .insert(row)
      .select()
      .single();
    throwIf(error);
    return toMetric(data as Row);
  }

  async listTrackedConditions(): Promise<TrackedCondition[]> {
    const { data, error } = await this.client
      .from("tracked_conditions")
      .select()
      .is("deleted_at", null);
    throwIf(error);
    return (data as Row[]).map(toTrackedCondition);
  }

  async setConditionTracked(metricId: string, tracked: boolean): Promise<void> {
    // Upsert one row per (owner, metric). RLS scopes rows to the caller, so an
    // update by metric_id targets only their own row; insert falls back when
    // none exists yet. owner_id defaults to auth.uid().
    const now = Date.now();
    const { data: updated, error: updateError } = await this.client
      .from("tracked_conditions")
      .update({ tracked, deleted_at: null, updated_at: now })
      .eq("metric_id", metricId)
      .select("id");
    throwIf(updateError);
    if (updated && updated.length > 0) return;
    const { error } = await this.client.from("tracked_conditions").insert({
      id: newId(),
      created_at: now,
      updated_at: now,
      metric_id: metricId,
      tracked,
    });
    throwIf(error);
  }

  async setMetricExercises(
    metricId: string,
    exerciseIds: string[],
  ): Promise<void> {
    const { error } = await this.client
      .from("metrics")
      .update({ exercise_ids: exerciseIds, updated_at: Date.now() })
      .eq("id", metricId);
    throwIf(error);
  }

  private async chunkedInsert(table: string, rows: Row[]): Promise<void> {
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await this.client
        .from(table)
        .insert(rows.slice(i, i + CHUNK));
      throwIf(error);
    }
  }

  async importSessions(sessions: ImportedSession[]): Promise<ImportResult> {
    // Idempotency: a session is identified by its started_at timestamp. This
    // must see *every* session — a truncated set would re-import already
    // imported sessions as duplicates.
    const existingRows = await this.selectAll<Row>((from, to) =>
      this.client
        .from("sessions")
        .select("started_at, id", { count: "exact" })
        .order("id")
        .range(from, to),
    );
    const existing = new Set(existingRows.map((r) => r.started_at as number));

    const fresh = sessions.filter((s) => !existing.has(s.startedAt));
    const skipped = sessions.length - fresh.length;
    if (fresh.length === 0) {
      return { imported: 0, skipped, sets: 0, exercisesCreated: 0 };
    }

    // Find-or-create exercises by case-insensitive name (seeds included).
    const known = await this.listExercises();
    const idByName = new Map(known.map((e) => [e.name.toLowerCase(), e.id]));
    const newExercises: Row[] = [];
    for (const session of fresh) {
      for (const ex of session.exercises) {
        const key = ex.name.toLowerCase();
        if (!idByName.has(key)) {
          const id = newId();
          idByName.set(key, id);
          newExercises.push({
            id,
            created_at: session.startedAt,
            updated_at: session.startedAt,
            name: ex.name,
            is_custom: true,
          });
        }
      }
    }
    await this.chunkedInsert("exercises", newExercises);

    // Historical created_at keeps ghost-prefill ordering chronological.
    const sessionRows: Row[] = [];
    const seRows: Row[] = [];
    const setRows: Row[] = [];
    for (const session of fresh) {
      const sessionId = newId();
      const t = session.startedAt;
      sessionRows.push({
        id: sessionId,
        created_at: t,
        updated_at: t,
        title: session.title,
        started_at: t,
        ended_at: session.endedAt,
      });
      session.exercises.forEach((ex, orderIndex) => {
        const seId = newId();
        seRows.push({
          id: seId,
          created_at: t,
          updated_at: t,
          session_id: sessionId,
          exercise_id: idByName.get(ex.name.toLowerCase()),
          order_index: orderIndex,
        });
        ex.sets.forEach((set, setNo) => {
          setRows.push({
            id: newId(),
            created_at: t,
            updated_at: t,
            session_exercise_id: seId,
            set_no: setNo,
            set_type: set.setType ?? "normal",
            weight_kg: set.weightKg,
            reps: set.reps,
            duration_sec: set.durationSec ?? null,
            distance_m: set.distanceM ?? null,
            rir: set.rir,
            note: set.note,
            completed: true,
          });
        });
      });
    }
    await this.chunkedInsert("sessions", sessionRows);
    await this.chunkedInsert("session_exercises", seRows);
    await this.chunkedInsert("set_logs", setRows);

    return {
      imported: fresh.length,
      skipped,
      sets: setRows.length,
      exercisesCreated: newExercises.length,
    };
  }

  async applySleep(sleepHoursByDate: Map<string, number>): Promise<number> {
    const rows = await this.selectAll<Row>((from, to) =>
      this.client
        .from("sessions")
        .select("id, started_at, condition_values", { count: "exact" })
        .is("deleted_at", null)
        .order("id")
        .range(from, to),
    );

    const updates: { id: string; merged: Record<string, unknown> }[] = [];
    for (const r of rows) {
      const conditions =
        (r.condition_values as Record<string, unknown> | null) ?? {};
      if (conditions[SEED_CONDITIONS.sleepH] != null) continue; // never overwrite
      const d = new Date(r.started_at as number);
      const dateISO = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const hours = sleepHoursByDate.get(dateISO);
      if (hours == null) continue;
      updates.push({
        id: r.id as string,
        merged: { ...conditions, [SEED_CONDITIONS.sleepH]: hours },
      });
    }

    const now = Date.now();
    for (const u of updates) {
      const { error: updateError } = await this.client
        .from("sessions")
        .update({ condition_values: u.merged, updated_at: now })
        .eq("id", u.id);
      throwIf(updateError);
    }
    return updates.length;
  }

  // Ordered by `created_at` (not just `id`) so the CSV/JSON export stays
  // roughly chronological — ids are random uuid v4, so an id-only order would
  // shuffle every exported table. `id` is the tiebreak that keeps pagination
  // deterministic.
  private selectAllFrom(table: string): Promise<Row[]> {
    return this.selectAll<Row>((from, to) =>
      this.client
        .from(table)
        .select("*", { count: "exact" })
        .is("deleted_at", null)
        .order("created_at")
        .order("id")
        .range(from, to),
    );
  }

  async exportAll(): Promise<ExportBundle> {
    const [
      exercises,
      machines,
      metrics,
      sessions,
      sessionExercises,
      setLogs,
      measurements,
      routineFolders,
      routines,
      routineExercises,
      routineSets,
    ] = await Promise.all([
      this.selectAllFrom("exercises"),
      this.selectAllFrom("machines"),
      this.selectAllFrom("metrics"),
      this.selectAllFrom("sessions"),
      this.selectAllFrom("session_exercises"),
      this.selectAllFrom("set_logs"),
      this.selectAllFrom("measurements"),
      this.selectAllFrom("routine_folders"),
      this.selectAllFrom("routines"),
      this.selectAllFrom("routine_exercises"),
      this.selectAllFrom("routine_sets"),
    ]);
    return {
      schemaVersion: 3,
      exportedAt: Date.now(),
      exercises: exercises.map(toExercise),
      machines: machines.map(toMachine),
      metrics: metrics.map(toMetric),
      sessions: sessions.map(toSession),
      sessionExercises: sessionExercises.map(toSessionExercise),
      setLogs: setLogs.map(toSetLog),
      measurements: measurements.map(toMeasurement),
      routineFolders: routineFolders.map(toRoutineFolder),
      routines: routines.map(toRoutine),
      routineExercises: routineExercises.map((r) => ({
        id: r.id as string,
        createdAt: r.created_at as number,
        updatedAt: r.updated_at as number,
        deletedAt: (r.deleted_at as number | null) ?? null,
        ownerId: r.owner_id as string,
        routineId: r.routine_id as string,
        exerciseId: r.exercise_id as string,
        orderIndex: r.order_index as number,
        supersetGroup: (r.superset_group as number | null) ?? null,
        restSec: (r.rest_sec as number | null) ?? null,
        note: (r.note as string | null) ?? null,
      })),
      routineSets: routineSets.map(toRoutineSet),
    };
  }

  async listApiTokens(): Promise<ApiToken[]> {
    const { data, error } = await this.client
      .from("api_tokens")
      .select()
      .order("created_at", { ascending: false });
    throwIf(error);
    return (data as Row[]).map(toApiToken);
  }

  async createApiToken(name: string): Promise<CreatedApiToken> {
    const token = generateToken();
    const row = {
      id: newId(),
      created_at: Date.now(),
      name,
      token_hash: await hashToken(token),
    };
    const { data, error } = await this.client
      .from("api_tokens")
      .insert(row)
      .select()
      .single();
    throwIf(error);
    return { token, row: toApiToken(data as Row) };
  }

  async revokeApiToken(id: string): Promise<void> {
    const { error } = await this.client
      .from("api_tokens")
      .update({ revoked_at: Date.now() })
      .eq("id", id);
    throwIf(error);
  }

  async lastSetsForExercise(
    exerciseId: string,
    excludeSessionExerciseId?: string,
    routineId?: string,
  ): Promise<GhostSet[]> {
    // "Same routine" PREVIOUS scope: inner-join sessions and filter on the
    // routine provenance; the default scope considers any workout.
    let query = this.client
      .from("session_exercises")
      .select(
        routineId
          ? "id, sessions!inner(routine_id), set_logs(weight_kg, reps, duration_sec, distance_m, set_no, side, deleted_at)"
          : "id, set_logs(weight_kg, reps, duration_sec, distance_m, set_no, side, deleted_at)",
      )
      .eq("exercise_id", exerciseId)
      .is("deleted_at", null)
      // created_at is millisecond-resolution and can tie; id desc breaks ties
      // deterministically (replaces the SQLite rowid-desc tiebreak).
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1);
    if (excludeSessionExerciseId)
      query = query.neq("id", excludeSessionExerciseId);
    if (routineId) query = query.eq("sessions.routine_id", routineId);
    const { data, error } = await query;
    throwIf(error);
    const latest = (data as Row[] | null)?.[0];
    if (!latest) return [];
    const sets = (latest.set_logs as Row[]) ?? [];
    // Group into physical sets (a unilateral pair is two rows sharing one
    // set_no) so the PREVIOUS column ghosts the whole set, uneven pairs
    // included, at the same index the active row commits at.
    const rows = sets
      .filter((s) => s.deleted_at == null)
      .sort(bySetNoThenSide)
      .map((r) => ({
        setNo: r.set_no as number,
        side: r.side as string | null,
        weightKg: (r.weight_kg as number | null) ?? null,
        reps: (r.reps as number | null) ?? null,
        durationSec: (r.duration_sec as number | null) ?? null,
        distanceM: (r.distance_m as number | null) ?? null,
      }));
    return groupSetsBySetNo(rows).map(([left, right]) => ({
      weightKg: left.weightKg,
      reps: left.reps,
      durationSec: left.durationSec,
      distanceM: left.distanceM,
      otherSide: right
        ? {
            weightKg: right.weightKg,
            reps: right.reps,
            durationSec: right.durationSec,
            distanceM: right.distanceM,
          }
        : null,
    }));
  }

  async recentExerciseIds(days: number): Promise<string[]> {
    const since = Date.now() - days * 86_400_000;
    // One row per set in the window, newest first; dedupe by exercise id
    // preserving that order (the first occurrence of each id is its most
    // recent set). Paginated via selectAll — a heavy log can exceed the
    // 1000-row PostgREST cap.
    const rows = await this.selectAll<Row>((from, to) =>
      this.client
        .from("set_logs")
        .select("created_at, session_exercises!inner(exercise_id)", {
          count: "exact",
        })
        .gte("created_at", since)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to),
    );
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const r of rows) {
      const exId = (r.session_exercises as Row | null)?.exercise_id as
        | string
        | undefined;
      if (!exId || seen.has(exId)) continue;
      seen.add(exId);
      ids.push(exId);
    }
    return ids;
  }

  async lastNoteForExercise(
    exerciseId: string,
    excludeSessionExerciseId?: string,
  ): Promise<string | null> {
    let query = this.client
      .from("session_exercises")
      .select("id, note")
      .eq("exercise_id", exerciseId)
      .not("note", "is", null)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1);
    if (excludeSessionExerciseId)
      query = query.neq("id", excludeSessionExerciseId);
    const { data, error } = await query;
    throwIf(error);
    return ((data as Row[] | null)?.[0]?.note as string | null) ?? null;
  }

  // ── Workout media ────────────────────────────────────────────────────

  async listSessionMedia(sessionId: string): Promise<SessionMediaRow[]> {
    const { data, error } = await this.client
      .from("session_media")
      .select()
      .eq("session_id", sessionId)
      .is("deleted_at", null)
      .order("position");
    throwIf(error);
    return ((data as Row[]) ?? []).map(toSessionMedia);
  }

  async listAllSessionMedia(limit = 30): Promise<SessionMediaRow[]> {
    const { data, error } = await this.client
      .from("session_media")
      .select()
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(limit);
    throwIf(error);
    return ((data as Row[]) ?? []).map(toSessionMedia);
  }

  async uploadSessionPhoto(
    sessionId: string,
    file: Blob,
    position: number,
  ): Promise<SessionMediaRow> {
    const uid = await this.ownerId();
    const id = newId();
    const path = `${uid}/${sessionId}/${id}.jpg`;
    const { error: uploadError } = await this.client.storage
      .from("session-media")
      .upload(path, file, { upsert: true, contentType: "image/jpeg" });
    throwIf(uploadError);
    const now = Date.now();
    const { data, error } = await this.client
      .from("session_media")
      .insert({
        id,
        created_at: now,
        updated_at: now,
        session_id: sessionId,
        path,
        position,
      })
      .select()
      .single();
    throwIf(error);
    return toSessionMedia(data as Row);
  }

  async deleteSessionMedia(id: string): Promise<void> {
    const { data, error: readError } = await this.client
      .from("session_media")
      .select("path")
      .eq("id", id)
      .limit(1);
    throwIf(readError);
    const path = ((data as Row[] | null)?.[0]?.path as string) ?? null;
    if (path) await this.client.storage.from("session-media").remove([path]);
    const now = Date.now();
    const { error } = await this.client
      .from("session_media")
      .update({ deleted_at: now, updated_at: now })
      .eq("id", id);
    throwIf(error);
  }

  async sessionMediaUrl(media: SessionMediaRow): Promise<string | null> {
    const { data, error } = await this.client.storage
      .from("session-media")
      .createSignedUrl(media.path, 60 * 60);
    throwIf(error);
    return data?.signedUrl ?? null;
  }

  async listExerciseFavorites(): Promise<ExerciseFavorite[]> {
    const { data, error } = await this.client
      .from("exercise_favorites")
      .select()
      .is("deleted_at", null);
    throwIf(error);
    return (data as Row[]).map(toExerciseFavorite);
  }

  async setExerciseFavorite(
    exerciseId: string,
    favorite: boolean,
  ): Promise<void> {
    // Upsert one row per (owner, exercise), same pattern as setConditionTracked.
    const now = Date.now();
    const { data: updated, error: updateError } = await this.client
      .from("exercise_favorites")
      .update({ favorite, deleted_at: null, updated_at: now })
      .eq("exercise_id", exerciseId)
      .select("id");
    throwIf(updateError);
    if (updated && updated.length > 0) return;
    const { error } = await this.client.from("exercise_favorites").insert({
      id: newId(),
      created_at: now,
      updated_at: now,
      exercise_id: exerciseId,
      favorite,
    });
    throwIf(error);
  }

  async listExercisePrefs(): Promise<ExercisePref[]> {
    const { data, error } = await this.client
      .from("exercise_prefs")
      .select()
      .is("deleted_at", null);
    throwIf(error);
    return ((data as Row[]) ?? []).map((r) => ({
      id: r.id as string,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      deletedAt: (r.deleted_at as number | null) ?? null,
      ownerId: r.owner_id as string,
      exerciseId: r.exercise_id as string,
      weightUnit: (r.weight_unit as string | null) ?? null,
      generatorExcluded: (r.generator_excluded as boolean) ?? false,
    }));
  }

  /** Upsert one exercise_prefs row per (owner, exercise) — favorites pattern. */
  private async upsertExercisePref(
    exerciseId: string,
    patch: Row,
  ): Promise<void> {
    const now = Date.now();
    const { data: updated, error: updateError } = await this.client
      .from("exercise_prefs")
      .update({ ...patch, deleted_at: null, updated_at: now })
      .eq("exercise_id", exerciseId)
      .select("id");
    throwIf(updateError);
    if (updated && updated.length > 0) return;
    const { error } = await this.client.from("exercise_prefs").insert({
      id: newId(),
      created_at: now,
      updated_at: now,
      exercise_id: exerciseId,
      ...patch,
    });
    throwIf(error);
  }

  async setExerciseWeightUnit(
    exerciseId: string,
    unit: "kg" | "lb" | null,
  ): Promise<void> {
    await this.upsertExercisePref(exerciseId, { weight_unit: unit });
  }

  async setGeneratorExcluded(
    exerciseId: string,
    excluded: boolean,
  ): Promise<void> {
    await this.upsertExercisePref(exerciseId, { generator_excluded: excluded });
  }

  async getUserPrefs(): Promise<UserPrefs | null> {
    const { data, error } = await this.client
      .from("user_prefs")
      .select()
      .is("deleted_at", null)
      .limit(1);
    throwIf(error);
    const r = (data as Row[] | null)?.[0];
    if (!r) return null;
    return {
      id: r.id as string,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      deletedAt: (r.deleted_at as number | null) ?? null,
      ownerId: r.owner_id as string,
      includeWarmupsInStats: (r.include_warmups_in_stats as boolean) ?? true,
      defaultRestSec: (r.default_rest_sec as number | null) ?? null,
      previousValuesScope: (r.previous_values_scope as string) ?? "any",
      bodyDiagram: (r.body_diagram as string) ?? "neutral",
      plateConfig: (r.plate_config as UserPrefs["plateConfig"]) ?? null,
      displayName: (r.display_name as string | null) ?? null,
      bio: (r.bio as string | null) ?? null,
    };
  }

  async updateUserPrefs(patch: UserPrefsPatch): Promise<void> {
    const row: Row = {};
    if ("includeWarmupsInStats" in patch)
      row.include_warmups_in_stats = patch.includeWarmupsInStats;
    if ("defaultRestSec" in patch)
      row.default_rest_sec = patch.defaultRestSec ?? null;
    if ("previousValuesScope" in patch)
      row.previous_values_scope = patch.previousValuesScope;
    if ("bodyDiagram" in patch) row.body_diagram = patch.bodyDiagram;
    if ("plateConfig" in patch) row.plate_config = patch.plateConfig ?? null;
    if ("displayName" in patch) row.display_name = patch.displayName ?? null;
    if ("bio" in patch) row.bio = patch.bio ?? null;

    const now = Date.now();
    const { data: updated, error: updateError } = await this.client
      .from("user_prefs")
      .update({ ...row, updated_at: now })
      .is("deleted_at", null)
      .select("id");
    throwIf(updateError);
    if (updated && updated.length > 0) return;
    const { error } = await this.client.from("user_prefs").insert({
      id: newId(),
      created_at: now,
      updated_at: now,
      ...row,
    });
    throwIf(error);
  }

  // ── Web-push subscriptions ────────────────────────────────────────────

  async listPushSubscriptions(): Promise<PushSubscription[]> {
    const { data, error } = await this.client
      .from("push_subscriptions")
      .select()
      .is("deleted_at", null);
    throwIf(error);
    return ((data as Row[]) ?? []).map((r) => ({
      id: r.id as string,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      deletedAt: (r.deleted_at as number | null) ?? null,
      ownerId: r.owner_id as string,
      endpoint: r.endpoint as string,
      keys: r.keys as { p256dh: string; auth: string },
    }));
  }

  async savePushSubscription(
    endpoint: string,
    keys: { p256dh: string; auth: string },
  ): Promise<void> {
    const now = Date.now();
    const { data: updated, error: updateError } = await this.client
      .from("push_subscriptions")
      .update({ keys, deleted_at: null, updated_at: now })
      .eq("endpoint", endpoint)
      .select("id");
    throwIf(updateError);
    if (updated && updated.length > 0) return;
    const { error } = await this.client.from("push_subscriptions").insert({
      id: newId(),
      created_at: now,
      updated_at: now,
      endpoint,
      keys,
    });
    throwIf(error);
  }

  async deletePushSubscription(endpoint: string): Promise<void> {
    const now = Date.now();
    const { error } = await this.client
      .from("push_subscriptions")
      .update({ deleted_at: now, updated_at: now })
      .eq("endpoint", endpoint);
    throwIf(error);
  }

  // ── Programs ──────────────────────────────────────────────────────────

  async listPrograms(): Promise<Program[]> {
    const { data, error } = await this.client
      .from("programs")
      .select()
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    throwIf(error);
    return ((data as Row[]) ?? []).map(toProgram);
  }

  async activeProgram(): Promise<Program | null> {
    const { data, error } = await this.client
      .from("programs")
      .select()
      .eq("active", true)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1);
    throwIf(error);
    const r = (data as Row[] | null)?.[0];
    return r ? toProgram(r) : null;
  }

  async createProgram(input: {
    source: "generated" | "library";
    folderId: string;
    config?: Record<string, unknown> | null;
    libraryKey?: string | null;
  }): Promise<Program> {
    const now = Date.now();
    // One active program at a time (Hevy Trainer semantics): deactivate any
    // current one before inserting the new active row.
    const { error: deactivateError } = await this.client
      .from("programs")
      .update({ active: false, updated_at: now })
      .eq("active", true);
    throwIf(deactivateError);
    const { data, error } = await this.client
      .from("programs")
      .insert({
        id: newId(),
        created_at: now,
        updated_at: now,
        source: input.source,
        folder_id: input.folderId,
        config: input.config ?? null,
        library_key: input.libraryKey ?? null,
        active: true,
      })
      .select()
      .single();
    throwIf(error);
    return toProgram(data as Row);
  }

  async setProgramActive(programId: string, active: boolean): Promise<void> {
    const { error } = await this.client
      .from("programs")
      .update({ active, updated_at: Date.now() })
      .eq("id", programId);
    throwIf(error);
  }

  async updateProgramConfig(
    programId: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.client
      .from("programs")
      .update({ config, updated_at: Date.now() })
      .eq("id", programId);
    throwIf(error);
  }

  async deleteProgram(programId: string): Promise<void> {
    const now = Date.now();
    const { error } = await this.client
      .from("programs")
      .update({ deleted_at: now, active: false, updated_at: now })
      .eq("id", programId);
    throwIf(error);
  }

  // ── Body measurements ─────────────────────────────────────────────────

  async listMeasurements(): Promise<Measurement[]> {
    // One row per calendar day, so daily logging crosses PostgREST's 1000-row
    // cap after ~2.7 years; `.order("id")` tie-breaks `measured_on` so
    // pagination is deterministic (see `selectAll`).
    const rows = await this.selectAll<Row>((from, to) =>
      this.client
        .from("measurements")
        .select("*", { count: "exact" })
        .is("deleted_at", null)
        .order("measured_on", { ascending: false })
        .order("id")
        .range(from, to),
    );
    return rows.map(toMeasurement);
  }

  async upsertMeasurement(
    measuredOn: string,
    patch: MeasurementPatch,
  ): Promise<Measurement> {
    const now = Date.now();
    const row: Row = { updated_at: now, deleted_at: null };
    const cols: Record<keyof MeasurementPatch, string> = {
      bodyweightKg: "bodyweight_kg",
      bodyfatPct: "bodyfat_pct",
      neckCm: "neck_cm",
      shouldersCm: "shoulders_cm",
      chestCm: "chest_cm",
      waistCm: "waist_cm",
      abdomenCm: "abdomen_cm",
      hipsCm: "hips_cm",
      bicepLCm: "bicep_l_cm",
      bicepRCm: "bicep_r_cm",
      forearmLCm: "forearm_l_cm",
      forearmRCm: "forearm_r_cm",
      thighLCm: "thigh_l_cm",
      thighRCm: "thigh_r_cm",
      calfLCm: "calf_l_cm",
      calfRCm: "calf_r_cm",
    };
    for (const [k, col] of Object.entries(cols)) {
      if (k in patch) row[col] = patch[k as keyof MeasurementPatch] ?? null;
    }
    const { data: updated, error: updateError } = await this.client
      .from("measurements")
      .update(row)
      .eq("measured_on", measuredOn)
      .select();
    throwIf(updateError);
    const existing = (updated as Row[] | null)?.[0];
    if (existing) return toMeasurement(existing);
    const { data, error } = await this.client
      .from("measurements")
      .insert({
        id: newId(),
        created_at: now,
        updated_at: now,
        measured_on: measuredOn,
        ...row,
      })
      .select()
      .single();
    throwIf(error);
    return toMeasurement(data as Row);
  }

  async deleteMeasurement(id: string): Promise<void> {
    const now = Date.now();
    const { error } = await this.client
      .from("measurements")
      .update({ deleted_at: now, updated_at: now })
      .eq("id", id);
    throwIf(error);
  }

  async uploadProgressPhoto(measurementId: string, file: Blob): Promise<void> {
    const uid = await this.ownerId();
    const path = `${uid}/${measurementId}.jpg`;
    const { error: uploadError } = await this.client.storage
      .from("progress-photos")
      .upload(path, file, { upsert: true, contentType: "image/jpeg" });
    throwIf(uploadError);
    const { error } = await this.client
      .from("measurements")
      .update({ photo_path: path, updated_at: Date.now() })
      .eq("id", measurementId);
    throwIf(error);
  }

  async clearProgressPhoto(measurementId: string): Promise<void> {
    const { data, error: readError } = await this.client
      .from("measurements")
      .select("photo_path")
      .eq("id", measurementId)
      .limit(1);
    throwIf(readError);
    const path =
      ((data as Row[] | null)?.[0]?.photo_path as string | null) ?? null;
    if (path) {
      // Best-effort object removal; the row update is the source of truth.
      await this.client.storage.from("progress-photos").remove([path]);
    }
    const { error } = await this.client
      .from("measurements")
      .update({ photo_path: null, updated_at: Date.now() })
      .eq("id", measurementId);
    throwIf(error);
  }

  async progressPhotoUrl(m: Measurement): Promise<string | null> {
    if (!m.photoPath) return null;
    const { data, error } = await this.client.storage
      .from("progress-photos")
      .createSignedUrl(m.photoPath, 60 * 60);
    throwIf(error);
    return data?.signedUrl ?? null;
  }

  async latestBodyweightKg(onOrBefore?: string): Promise<number | null> {
    let query = this.client
      .from("measurements")
      .select("bodyweight_kg, measured_on")
      .is("deleted_at", null)
      .not("bodyweight_kg", "is", null)
      .order("measured_on", { ascending: false })
      .limit(1);
    if (onOrBefore) query = query.lte("measured_on", onOrBefore);
    const { data, error } = await query;
    throwIf(error);
    const r = (data as Row[] | null)?.[0];
    return (r?.bodyweight_kg as number | null) ?? null;
  }

  // ── Routines & folders ────────────────────────────────────────────────

  async listRoutineFolders(): Promise<RoutineFolder[]> {
    const { data, error } = await this.client
      .from("routine_folders")
      .select()
      .is("deleted_at", null)
      .order("position")
      .order("created_at");
    throwIf(error);
    return ((data as Row[]) ?? []).map(toRoutineFolder);
  }

  async createRoutineFolder(name: string): Promise<RoutineFolder> {
    const now = Date.now();
    const { count } = await this.client
      .from("routine_folders")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null);
    const row = {
      id: newId(),
      created_at: now,
      updated_at: now,
      name,
      position: count ?? 0,
    };
    const { data, error } = await this.client
      .from("routine_folders")
      .insert(row)
      .select()
      .single();
    throwIf(error);
    return toRoutineFolder(data as Row);
  }

  async renameRoutineFolder(id: string, name: string): Promise<void> {
    const { error } = await this.client
      .from("routine_folders")
      .update({ name, updated_at: Date.now() })
      .eq("id", id);
    throwIf(error);
  }

  async reorderRoutineFolders(ids: string[]): Promise<void> {
    const now = Date.now();
    for (const [i, id] of ids.entries()) {
      const { error } = await this.client
        .from("routine_folders")
        .update({ position: i, updated_at: now })
        .eq("id", id);
      throwIf(error);
    }
  }

  async deleteRoutineFolder(id: string): Promise<void> {
    const now = Date.now();
    // Unfile the folder's routines rather than deleting them.
    const { error: unfileError } = await this.client
      .from("routines")
      .update({ folder_id: null, updated_at: now })
      .eq("folder_id", id);
    throwIf(unfileError);
    const { error } = await this.client
      .from("routine_folders")
      .update({ deleted_at: now, updated_at: now })
      .eq("id", id);
    throwIf(error);
  }

  async listRoutines(): Promise<Routine[]> {
    const { data, error } = await this.client
      .from("routines")
      .select()
      .is("deleted_at", null)
      .order("position")
      .order("created_at");
    throwIf(error);
    return ((data as Row[]) ?? []).map(toRoutine);
  }

  async getRoutineDetail(routineId: string): Promise<RoutineDetail | null> {
    const { data, error } = await this.client
      .from("routines")
      .select(
        "*, routine_exercises(id, exercise_id, order_index, superset_group, rest_sec, note, deleted_at, exercises(name), routine_sets(*))",
      )
      .eq("id", routineId)
      .is("deleted_at", null)
      .limit(1);
    throwIf(error);
    const r = (data as Row[] | null)?.[0];
    if (!r) return null;
    const exercises = ((r.routine_exercises as Row[]) ?? [])
      .filter((re) => re.deleted_at == null)
      .sort((a, b) => (a.order_index as number) - (b.order_index as number))
      .map((re) => ({
        id: re.id as string,
        exerciseId: re.exercise_id as string,
        exerciseName: ((re.exercises as Row | null)?.name as string) ?? "",
        orderIndex: re.order_index as number,
        supersetGroup: (re.superset_group as number | null) ?? null,
        restSec: (re.rest_sec as number | null) ?? null,
        note: (re.note as string | null) ?? null,
        sets: ((re.routine_sets as Row[]) ?? [])
          .filter((s) => s.deleted_at == null)
          .sort((a, b) => (a.set_no as number) - (b.set_no as number))
          .map(toRoutineSet),
      }));
    return { routine: toRoutine(r), exercises };
  }

  /** Inserts the child graph (exercises + sets) for a routine id. */
  private async insertRoutineChildren(
    routineId: string,
    exercises: RoutineExerciseInput[],
    now: number,
  ): Promise<void> {
    if (!exercises.length) return;
    const exerciseRows = exercises.map((e) => ({
      id: newId(),
      created_at: now,
      updated_at: now,
      routine_id: routineId,
      exercise_id: e.exerciseId,
      order_index: e.orderIndex,
      superset_group: e.supersetGroup ?? null,
      rest_sec: e.restSec ?? null,
      note: e.note ?? null,
    }));
    const { error: reError } = await this.client
      .from("routine_exercises")
      .insert(exerciseRows);
    throwIf(reError);
    const setRows = exercises.flatMap((e, i) =>
      e.sets.map((s) => ({
        id: newId(),
        created_at: now,
        updated_at: now,
        routine_exercise_id: exerciseRows[i].id,
        set_no: s.setNo,
        set_type: s.setType ?? "normal",
        target_weight_kg: s.targetWeightKg ?? null,
        target_reps: s.targetReps ?? null,
        target_reps_max: s.targetRepsMax ?? null,
        target_duration_sec: s.targetDurationSec ?? null,
        target_distance_m: s.targetDistanceM ?? null,
        target_rir_min: s.targetRirMin ?? null,
        target_rir_max: s.targetRirMax ?? null,
      })),
    );
    if (setRows.length) {
      const { error: rsError } = await this.client
        .from("routine_sets")
        .insert(setRows);
      throwIf(rsError);
    }
  }

  async createRoutine(input: NewRoutineInput): Promise<Routine> {
    const now = Date.now();
    const { count } = await this.client
      .from("routines")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null);
    const row = {
      id: newId(),
      created_at: now,
      updated_at: now,
      name: input.name,
      folder_id: input.folderId ?? null,
      description: input.description ?? null,
      position: count ?? 0,
    };
    const { data, error } = await this.client
      .from("routines")
      .insert(row)
      .select()
      .single();
    throwIf(error);
    await this.insertRoutineChildren(row.id, input.exercises, now);
    return toRoutine(data as Row);
  }

  async updateRoutine(
    routineId: string,
    input: NewRoutineInput,
  ): Promise<void> {
    const now = Date.now();
    const { error: metaError } = await this.client
      .from("routines")
      .update({
        name: input.name,
        folder_id: input.folderId ?? null,
        description: input.description ?? null,
        updated_at: now,
      })
      .eq("id", routineId);
    throwIf(metaError);
    // Replace the child graph: soft-delete old rows, insert fresh ones.
    // Simple and safe at template sizes; sessions keep provenance via their
    // own routine_exercise_id snapshots (soft-deleted rows stay readable).
    const { error: delSetsError } = await this.client
      .from("routine_sets")
      .update({ deleted_at: now, updated_at: now })
      .in(
        "routine_exercise_id",
        (
          await this.client
            .from("routine_exercises")
            .select("id")
            .eq("routine_id", routineId)
            .is("deleted_at", null)
        ).data?.map((r) => (r as Row).id as string) ?? [],
      );
    throwIf(delSetsError);
    const { error: delExError } = await this.client
      .from("routine_exercises")
      .update({ deleted_at: now, updated_at: now })
      .eq("routine_id", routineId)
      .is("deleted_at", null);
    throwIf(delExError);
    await this.insertRoutineChildren(routineId, input.exercises, now);
  }

  async moveRoutine(routineId: string, folderId: string | null): Promise<void> {
    const { error } = await this.client
      .from("routines")
      .update({ folder_id: folderId, updated_at: Date.now() })
      .eq("id", routineId);
    throwIf(error);
  }

  async reorderRoutines(ids: string[]): Promise<void> {
    const now = Date.now();
    for (const [i, id] of ids.entries()) {
      const { error } = await this.client
        .from("routines")
        .update({ position: i, updated_at: now })
        .eq("id", id);
      throwIf(error);
    }
  }

  async duplicateRoutine(routineId: string, name?: string): Promise<Routine> {
    const detail = await this.getRoutineDetail(routineId);
    if (!detail) throw new Error("Routine not found");
    return this.createRoutine({
      name: name ?? `${detail.routine.name} (copy)`,
      folderId: detail.routine.folderId,
      description: detail.routine.description,
      exercises: detail.exercises.map((e) => ({
        exerciseId: e.exerciseId,
        orderIndex: e.orderIndex,
        supersetGroup: e.supersetGroup,
        restSec: e.restSec,
        note: e.note,
        sets: e.sets.map((s) => ({
          setNo: s.setNo,
          setType: s.setType,
          targetWeightKg: s.targetWeightKg,
          targetReps: s.targetReps,
          targetRepsMax: s.targetRepsMax,
          targetDurationSec: s.targetDurationSec,
          targetDistanceM: s.targetDistanceM,
          targetRirMin: s.targetRirMin,
          targetRirMax: s.targetRirMax,
        })),
      })),
    });
  }

  async deleteRoutine(routineId: string): Promise<void> {
    const now = Date.now();
    const { error } = await this.client
      .from("routines")
      .update({ deleted_at: now, updated_at: now })
      .eq("id", routineId);
    throwIf(error);
  }

  async startRoutineSession(routineId: string): Promise<Session> {
    const detail = await this.getRoutineDetail(routineId);
    if (!detail) throw new Error("Routine not found");
    const now = Date.now();
    const sessionRow = {
      id: newId(),
      created_at: now,
      updated_at: now,
      title: detail.routine.name,
      started_at: now,
      routine_id: routineId,
    };
    const { data, error } = await this.client
      .from("sessions")
      .insert(sessionRow)
      .select()
      .single();
    throwIf(error);
    if (detail.exercises.length) {
      const seRows = detail.exercises.map((e) => ({
        id: newId(),
        created_at: now,
        updated_at: now,
        session_id: sessionRow.id,
        exercise_id: e.exerciseId,
        order_index: e.orderIndex,
        superset_group: e.supersetGroup,
        rest_sec: e.restSec,
        routine_exercise_id: e.id,
      }));
      const { error: seError } = await this.client
        .from("session_exercises")
        .insert(seRows);
      throwIf(seError);
    }
    return toSession(data as Row);
  }

  async updateRoutineValues(
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
  ): Promise<void> {
    const detail = await this.getRoutineDetail(routineId);
    if (!detail) return;
    const now = Date.now();
    for (const block of performed) {
      const re = detail.exercises.find((e) => e.id === block.routineExerciseId);
      if (!re) continue;
      for (const s of block.sets) {
        const target = re.sets.find((t) => t.setNo === s.setNo);
        if (!target) continue;
        // Rep-range sets are never auto-updated (plan §B).
        if (target.targetRepsMax != null) continue;
        const { error } = await this.client
          .from("routine_sets")
          .update({
            target_weight_kg: s.weightKg,
            target_reps: s.reps,
            target_duration_sec: s.durationSec,
            target_distance_m: s.distanceM,
            updated_at: now,
          })
          .eq("id", target.id);
        throwIf(error);
      }
    }
  }
}
