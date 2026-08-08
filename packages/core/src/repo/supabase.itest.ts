import { execSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { SEED_CONDITIONS } from "../db/seed-ids";
import { newId } from "../domain/ids";
import type { ImportedSession } from "../import/types";
import { SupabaseRepo } from "./supabase";

function localStatus(): { url: string; anonKey: string; serviceKey: string } {
  // vitest runs with cwd = packages/core; the supabase project is at the repo root
  const out = execSync("supabase status -o json", {
    cwd: "../..",
    encoding: "utf8",
  });
  // The CLI may print warnings (e.g. "Stopped services: ...") before the JSON.
  const json = JSON.parse(out.slice(out.indexOf("{")));
  const url = json.API_URL ?? json.api_url;
  const anonKey = json.ANON_KEY ?? json.anon_key;
  const serviceKey = json.SERVICE_ROLE_KEY ?? json.service_role_key;
  if (!url || !anonKey || !serviceKey) {
    throw new Error(
      `unexpected supabase status output: ${Object.keys(json).join(", ")}`,
    );
  }
  return { url, anonKey, serviceKey };
}

async function makeUser(
  url: string,
  anonKey: string,
  serviceKey: string,
  fetchImpl?: typeof fetch,
) {
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
  const email = `test-${newId()}@example.com`;
  const password = "integration-test-password";
  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(error.message);
  const client = createClient(url, anonKey, {
    auth: { persistSession: false },
    ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  });
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) throw new Error(signInError.message);
  return client;
}

// The only seed exercises that end up with no muscle targets (sorted by name).
const NECK_ONLY_SEEDS = [
  "Isometric Neck Exercise - Front And Back",
  "Isometric Neck Exercise - Sides",
  "Lying Face Down Plate Neck Resistance",
  "Lying Face Up Plate Neck Resistance",
  "Neck-SMR",
  "Seated Head Harness Neck Resistance",
  "Side Neck Stretch",
];

describe("SupabaseRepo (integration, local supabase)", () => {
  let clientA: SupabaseClient;
  let clientB: SupabaseClient;
  let repoA: SupabaseRepo;
  let repoB: SupabaseRepo;
  let url: string;
  let anonKey: string;
  let serviceKey: string;

  beforeAll(async () => {
    ({ url, anonKey, serviceKey } = localStatus());
    clientA = await makeUser(url, anonKey, serviceKey);
    clientB = await makeUser(url, anonKey, serviceKey);
    repoA = new SupabaseRepo(clientA);
    repoB = new SupabaseRepo(clientB);
  });

  it("creates and lists exercises", async () => {
    const name = `Bench Press ${newId().slice(0, 8)}`;
    const created = await repoA.createExercise(name);
    expect(created.name).toBe(name);
    expect(created.isCustom).toBe(true);
    // Community population phase (COMMUNITY_SHARING = true,
    // docs/DECISIONS.md 2026-08-08): a plain create publishes — owner_id
    // null so every authenticated user can read it.
    expect(created.ownerId).toBeNull();
    expect(created.createdBy).not.toBeNull();

    const listed = await repoA.listExercises();
    expect(listed.map((e) => e.id)).toContain(created.id);
  });

  it("community sharing: global visibility, provenance, dupe backstop, frozen rows, private fork", async () => {
    const { data: aUser } = await clientA.auth.getUser();
    const author = aUser.user?.id;
    const name = `Community Lift ${newId().slice(0, 8)}`;

    // A default create publishes: owner_id null + created_by = the author,
    // and the other user sees it in their library.
    const shared = await repoA.createExercise(name, {
      muscleTargets: [{ muscle: "quads", tier: "B" }],
    });
    expect(shared.ownerId).toBeNull();
    expect(shared.createdBy).toBe(author);
    expect(shared.muscleTargets).toEqual([{ muscle: "quads", tier: "B" }]);
    expect((await repoB.listExercises()).map((e) => e.id)).toContain(shared.id);

    // Dupe backstop: re-publishing the same name (case-insensitively)
    // returns the canonical row and creates no second row.
    const dupe = await repoA.createExercise(name.toLowerCase());
    expect(dupe.id).toBe(shared.id);
    const { count } = await clientA
      .from("exercises")
      .select("id", { count: "exact", head: true })
      .ilike("name", name)
      .is("deleted_at", null);
    expect(count).toBe(1);

    // Frozen: updateExercise matches zero rows on a shared row (no owner
    // under RLS), so an update attempt leaves it unchanged — the fork
    // contract.
    await repoA.updateExercise(shared.id, { notes: "should not stick" });
    const after = await repoA.getExercise(shared.id);
    expect(after?.notes).toBeNull();

    // A private create (share: false) stays invisible to the other user.
    const priv = await repoA.createExercise(`Private ${newId().slice(0, 8)}`, {
      share: false,
    });
    expect(priv.ownerId).toBe(author);
    expect((await repoB.listExercises()).map((e) => e.id)).not.toContain(
      priv.id,
    );

    // A machine-linked create stays private even without an explicit flag:
    // the publish RPC's whitelist has no machine_id, so publishing would
    // silently drop the machine (resolveExerciseShare — the repo never lets
    // a machine-bearing create ride the shared library).
    const machine = await repoA.createMachine({ name: "A's Hack Squat" });
    const machineEx = await repoA.createExercise(
      `Machine Shared Guard ${newId().slice(0, 8)}`,
      { machineId: machine.id },
    );
    expect(machineEx.ownerId).toBe(author);
    expect(machineEx.machineId).toBe(machine.id);
    expect((await repoB.listExercises()).map((e) => e.id)).not.toContain(
      machineEx.id,
    );
  });

  it("starts a session and logs ordered sets", async () => {
    const ex = await repoA.createExercise(`Squat ${newId().slice(0, 8)}`);
    const session = await repoA.startSession();
    expect(session.startedAt).toBeGreaterThan(0);

    const se = await repoA.addExerciseToSession(session.id, ex.id);
    await repoA.logSet(se, { weightKg: 100, reps: 5 }, newId(), 0);
    await repoA.logSet(se, { weightKg: 102.5, reps: 3, rir: 1 }, newId(), 1);

    const { data } = await clientA
      .from("set_logs")
      .select("set_no, weight_kg, reps, rir")
      .eq("session_exercise_id", se)
      .order("set_no");
    expect(data).toEqual([
      { set_no: 0, weight_kg: 100, reps: 5, rir: null },
      { set_no: 1, weight_kg: 102.5, reps: 3, rir: 1 },
    ]);
  });

  it("logs a unilateral pair as two rows sharing one set_no", async () => {
    const ex = await repoA.createExercise(`One-Arm Row ${newId().slice(0, 8)}`);
    const session = await repoA.startSession();
    const se = await repoA.addExerciseToSession(session.id, ex.id);

    await repoA.logSet(
      se,
      { weightKg: 30, reps: 10, side: "left" },
      newId(),
      0,
    );
    await repoA.logSet(
      se,
      { weightKg: 28, reps: 8, side: "right" },
      newId(),
      0,
    );

    const { data } = await clientA
      .from("set_logs")
      .select("set_no, side, weight_kg, reps")
      .eq("session_exercise_id", se)
      .order("side");
    expect(data).toEqual([
      { set_no: 0, side: "left", weight_kg: 30, reps: 10 },
      { set_no: 0, side: "right", weight_kg: 28, reps: 8 },
    ]);
  });

  it("ghost-prefills from the most recent prior session", async () => {
    const ex = await repoA.createExercise(`Deadlift ${newId().slice(0, 8)}`);

    // no history yet
    expect(await repoA.lastSetsForExercise(ex.id)).toEqual([]);

    const s1 = await repoA.startSession();
    const se1 = await repoA.addExerciseToSession(s1.id, ex.id);
    await repoA.logSet(se1, { weightKg: 140, reps: 5 }, newId(), 0);
    await repoA.logSet(se1, { weightKg: 150, reps: 3 }, newId(), 1);

    const s2 = await repoA.startSession();
    const se2 = await repoA.addExerciseToSession(s2.id, ex.id);

    // excluding the just-created (empty) session-exercise returns s1's sets in order
    const ghost = await repoA.lastSetsForExercise(ex.id, se2);
    expect(ghost).toEqual([
      {
        weightKg: 140,
        reps: 5,
        durationSec: null,
        distanceM: null,
        otherSide: null,
      },
      {
        weightKg: 150,
        reps: 3,
        durationSec: null,
        distanceM: null,
        otherSide: null,
      },
    ]);
  });

  it("ghost-prefills a unilateral pair as one grouped ghost with otherSide", async () => {
    const ex = await repoA.createExercise(`One-Arm Row ${newId().slice(0, 8)}`);
    const s1 = await repoA.startSession();
    const se1 = await repoA.addExerciseToSession(s1.id, ex.id);
    await repoA.logSet(
      se1,
      { weightKg: 30, reps: 10, side: "left" },
      newId(),
      0,
    );
    await repoA.logSet(
      se1,
      { weightKg: 28, reps: 8, side: "right" },
      newId(),
      0,
    );

    const s2 = await repoA.startSession();
    const se2 = await repoA.addExerciseToSession(s2.id, ex.id);
    const ghost = await repoA.lastSetsForExercise(ex.id, se2);
    expect(ghost).toEqual([
      {
        weightKg: 30,
        reps: 10,
        durationSec: null,
        distanceM: null,
        otherSide: {
          weightKg: 28,
          reps: 8,
          durationSec: null,
          distanceM: null,
        },
      },
    ]);
  });

  it("recentExerciseIds returns recently-logged exercise ids, most recent first", async () => {
    const older = await repoA.createExercise(`Older ${newId().slice(0, 8)}`);
    const newer = await repoA.createExercise(`Newer ${newId().slice(0, 8)}`);
    const session = await repoA.startSession();
    const seOlder = await repoA.addExerciseToSession(session.id, older.id);
    const seNewer = await repoA.addExerciseToSession(session.id, newer.id);
    await repoA.logSet(seOlder, { weightKg: 100, reps: 5 }, newId(), 0);
    await repoA.logSet(seNewer, { weightKg: 80, reps: 8 }, newId(), 0);

    const recent = await repoA.recentExerciseIds(30);
    // Both logged in the window; newer's set is later than older's.
    expect(recent.slice(0, 2)).toEqual([newer.id, older.id]);

    // Far-future-only window returns nothing new.
    expect(await repoA.recentExerciseIds(0)).not.toContain(newer.id);
  });

  it("imports sessions idempotently and applies sleep without overwriting", async () => {
    const day = 86_400_000;
    const base = Date.now() - 30 * day;
    const sessions: ImportedSession[] = [0, 1, 2].map((i) => ({
      title: `Imported ${i}`,
      startedAt: base + i * day,
      endedAt: base + i * day + 3_600_000,
      exercises: [
        {
          name: `Import Lift ${base}`,
          sets: [
            { weightKg: 100 + i, reps: 5, rir: 1, note: null },
            { weightKg: 90, reps: 8, rir: null, note: "backoff" },
          ],
        },
      ],
    }));

    const first = await repoA.importSessions(sessions);
    expect(first).toEqual({
      imported: 3,
      skipped: 0,
      sets: 6,
      exercisesCreated: 1,
    });

    // Re-import: everything skipped, nothing duplicated.
    const second = await repoA.importSessions(sessions);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(3);

    // Sleep applies by local date, fills only sessions lacking a value.
    const d0 = new Date(base);
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    // Pre-set a sleep value on session 0 — applySleep must not overwrite it.
    const { data: s0 } = await clientA
      .from("sessions")
      .select("id")
      .eq("started_at", base)
      .single();
    await repoA.updateSessionConditions(s0?.id as string, {
      [SEED_CONDITIONS.sleepH]: 9,
    });

    const map = new Map<string, number>([
      [iso(d0), 6.5],
      [iso(new Date(base + day)), 7.5],
    ]);
    const filled = await repoA.applySleep(map);
    expect(filled).toBe(1); // only session 1 (session 0 already had a value)

    const { data: after } = await clientA
      .from("sessions")
      .select("started_at, condition_values")
      .in("started_at", [base, base + day]);
    const byStart = new Map(
      (after ?? []).map((r) => [r.started_at, r.condition_values]),
    );
    expect(byStart.get(base)?.[SEED_CONDITIONS.sleepH]).toBe(9);
    expect(byStart.get(base + day)?.[SEED_CONDITIONS.sleepH]).toBe(7.5);
  });

  it("machines: CRUD round-trip, exercise link, delete detaches", async () => {
    const machine = await repoA.createMachine({
      name: `Row Machine ${newId().slice(0, 8)}`,
      brand: "Matrix",
      catalogKey: "matrix-ultra-seated-row",
      settings: [
        { label: "Seat height", value: 4 },
        { label: "Chest pad", value: null },
      ],
    });
    expect(machine.brand).toBe("Matrix");
    expect(machine.settings).toEqual([
      { label: "Seat height", value: 4 },
      { label: "Chest pad", value: null },
    ]);

    await repoA.updateMachine(machine.id, {
      settings: [{ label: "Seat height", value: 5 }],
      notes: "lean forward",
    });
    const listed = await repoA.listMachines();
    const updated = listed.find((m) => m.id === machine.id);
    expect(updated?.settings).toEqual([{ label: "Seat height", value: 5 }]);
    expect(updated?.notes).toBe("lean forward");

    const ex = await repoA.createExercise(
      `Machine Row ${newId().slice(0, 8)}`,
      {
        // Private: the delete-detach write below must reach this row, and
        // shared rows are RLS-immutable.
        share: false,
        machineId: machine.id,
        jointActions: ["shoulder-extension", "elbow-flexion"],
        muscleTargets: [{ muscle: "lats", tier: "A" }],
      },
    );
    expect(ex.machineId).toBe(machine.id);
    expect(ex.jointActions).toEqual(["shoulder-extension", "elbow-flexion"]);
    expect(ex.muscleTargets).toEqual([{ muscle: "lats", tier: "A" }]);

    await repoA.deleteMachine(machine.id);
    expect((await repoA.listMachines()).map((m) => m.id)).not.toContain(
      machine.id,
    );
    const after = (await repoA.listExercises()).find((e) => e.id === ex.id);
    expect(after?.machineId).toBeNull();
  });

  it("machines: RLS isolates users; seed classifications are visible", async () => {
    const machine = await repoA.createMachine({ name: "A's Leg Press" });
    const bMachines = await repoB.listMachines();
    expect(bMachines.map((m) => m.id)).not.toContain(machine.id);

    // The curated seeds carry classifications from the migration… (the bulk
    // free-exercise-db rows are unclassified — a few of them target muscles
    // outside the Frog taxonomy, e.g. neck, so they have no muscle targets.)
    const seeds = (await repoB.listExercises()).filter((e) => !e.isCustom);
    expect(seeds.length).toBeGreaterThan(0);
    // …except the neck-only rows: free-exercise-db's "neck" muscle has no Frog
    // key (scripts/import-free-exercise-db.ts drops it). Pinned by name so a
    // seed that silently loses its targets still fails here.
    expect(
      seeds
        .filter((e) => !e.muscleTargets?.length)
        .map((e) => e.name)
        .sort(),
    ).toEqual(NECK_ONLY_SEEDS);
    // …and stay read-only for clients.
    const squat = seeds.find((e) => e.name === "Squat");
    const { data: updatedRows } = await clientB
      .from("exercises")
      .update({ muscle_targets: [{ muscle: "abs", tier: "S" }] })
      .eq("id", squat?.id as string)
      .select();
    expect(updatedRows ?? []).toHaveLength(0);

    // The name-heuristic backfill migration (docs/DECISIONS.md 2026-08-01)
    // tags exactly 67 seed rows unilateral and 16 alternating; the
    // gimmick-equipment purge (docs/DECISIONS.md 2026-08-07) soft-deleted 18
    // unilateral and 6 alternating of those, leaving 49 and 10. Alternating
    // is no longer an option (docs/DECISIONS.md 2026-08-08 — folded into
    // bilateral) but the seed DATA is untouched (text column, no migration):
    // the 10 rows below still store the legacy value and the app reads them
    // as bilateral. Pinning both raw counts keeps the backfill's classification
    // honest against the seed.
    expect(seeds.filter((e) => e.laterality === "unilateral")).toHaveLength(49);
    expect(seeds.filter((e) => e.laterality === "alternating")).toHaveLength(
      10,
    );
  });

  it("machine catalog: search matches brand/model/alias and browse filters by category", async () => {
    // Single-term brand search (the captain's "matrix" repro, frog-machine-db-lookup-slow):
    // regression guard for the 2026-08-07 hosted-DB-drift incident, where the whole
    // machine_catalog table + this RPC never got pushed to the hosted project, so this exact
    // query 404'd (PGRST202) instead of returning the first 20 (the repo's default
    // max_rows) of Matrix's 53 rows. Pins both correctness and that a plain
    // single-term brand query resolves quickly against a real Postgres round trip.
    const bareMatrix = await repoA.searchMachineCatalog("matrix");
    expect(bareMatrix.length).toBeGreaterThan(0);
    expect(bareMatrix.every((r) => r.brand === "Matrix")).toBe(true);

    // Multi-term AND over brand+model, same interaction the old static scan
    // had.
    const byTerms = await repoA.searchMachineCatalog("matrix diverging seated");
    expect(byTerms.map((r) => r.model)).toContain("Ultra Diverging Seated Row");

    // Alias-only hit: Freemotion's "Total Quad / Hip" carries the model code
    // "G628" in aliases (not in brand/model) — searchable via the jsonb array.
    const byAlias = await repoA.searchMachineCatalog("g628");
    expect(
      byAlias.some(
        (r) => r.brand === "Freemotion" && r.model === "Total Quad / Hip",
      ),
    ).toBe(true);

    // Empty query = browse: category filter applies, limit caps server-side.
    const chest = await repoA.searchMachineCatalog("", {
      category: "chest-press",
      limit: 5,
    });
    expect(chest).toHaveLength(5);
    expect(chest.every((r) => r.category === "chest-press")).toBe(true);

    // No match → empty list, not an error.
    expect(await repoA.searchMachineCatalog("zzzz-no-such-machine")).toEqual(
      [],
    );

    // Narrow entry shape only — no spec/mechanism fields on the picker path.
    expect(Object.keys(byTerms[0]).sort()).toEqual([
      "brand",
      "category",
      "id",
      "model",
    ]);
  });

  it("machine catalog: categories are distinct and sorted", async () => {
    const cats = await repoA.listMachineCategories();
    expect(cats.length).toBeGreaterThan(20);
    expect(cats[0]).toBe("ab-crunch");
    expect([...cats].sort()).toEqual(cats);
    expect(new Set(cats).size).toBe(cats.length);
  });

  it("machine photos: owner can upload, others cannot read", async () => {
    const machine = await repoA.createMachine({ name: "Photo Machine" });
    const pixel = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], {
      type: "image/jpeg",
    });
    await repoA.uploadMachinePhoto(machine.id, pixel);

    const updated = (await repoA.listMachines()).find(
      (m) => m.id === machine.id,
    );
    expect(updated?.photoPath).toContain(machine.id);

    const url = await repoA.machinePhotoUrl(updated ?? machine);
    expect(url).toContain("machine-photos");

    // Another user cannot sign a URL for A's object path.
    const { data: crossSign } = await clientB.storage
      .from("machine-photos")
      .createSignedUrl(updated?.photoPath as string, 60);
    expect(crossSign?.signedUrl ?? null).toBeNull();
  });

  it("exercise editor fields round-trip through createExercise", async () => {
    const ex = await repoA.createExercise(
      `Zercher Squat ${newId().slice(0, 8)}`,
      {
        mechanic: "compound",
        movementPattern: "squat",
        laterality: "bilateral",
        defaultRepsMin: 6,
        defaultRepsMax: 10,
        defaultRestSec: 150,
        notes: "brace before you unrack",
        aliases: ["Zercher squats"],
      },
    );
    expect(ex.mechanic).toBe("compound");
    expect(ex.movementPattern).toBe("squat");
    expect(ex.laterality).toBe("bilateral");
    expect(ex.defaultRepsMin).toBe(6);
    expect(ex.defaultRepsMax).toBe(10);
    expect(ex.defaultRestSec).toBe(150);
    expect(ex.notes).toBe("brace before you unrack");
    expect(ex.aliases).toEqual(["Zercher squats"]);

    const fetched = await repoA.getExercise(ex.id);
    expect(fetched?.notes).toBe("brace before you unrack");
  });

  it("listExercises omits the fat fields getExercise includes, but not notes", async () => {
    const ex = await repoA.createExercise(
      `Fat Field Test ${newId().slice(0, 8)}`,
      { instructions: ["Step one"], notes: "a note" },
    );
    const listed = (await repoA.listExercises()).find((e) => e.id === ex.id);
    expect(listed?.instructions).toBeNull();
    // notes is cheap (short text, not an array of frames) and renders on the
    // session logging hot path for every block — it stays in the list select.
    expect(listed?.notes).toBe("a note");

    const full = await repoA.getExercise(ex.id);
    expect(full?.instructions).toEqual(["Step one"]);
    expect(full?.notes).toBe("a note");
  });

  it("listExercises and exportAll return every row past PostgREST's 1000-row page cap", async () => {
    const TOTAL = 1100;
    const marker = `Page Cap Test ${newId().slice(0, 8)}`;
    const now = Date.now();
    const rows = Array.from({ length: TOTAL }, (_, i) => ({
      id: newId(),
      created_at: now,
      updated_at: now,
      name: `${marker} ${i.toString().padStart(4, "0")}`,
      is_custom: true,
      exercise_type: "weight_reps",
    }));
    const BATCH = 200;
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error } = await clientA
        .from("exercises")
        .insert(rows.slice(i, i + BATCH));
      if (error) throw new Error(error.message);
    }

    const listed = await repoA.listExercises();
    expect(listed.filter((e) => e.name.startsWith(marker))).toHaveLength(TOTAL);

    const bundle = await repoA.exportAll();
    expect(
      bundle.exercises.filter((e) => e.name.startsWith(marker)),
    ).toHaveLength(TOTAL);
  }, 30_000);

  it("paginating costs no request beyond the pages it needs, at any server max_rows", async () => {
    // Counts only PostgREST calls to /rest/v1/exercises (auth calls are noise).
    const makeCounter = (cap?: number) => {
      const calls: string[] = [];
      const impl: typeof fetch = (input, init) => {
        const target =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (target.includes("/rest/v1/exercises")) calls.push(target);
        if (cap == null) return fetch(input, init);
        // Emulate a server whose `max_rows` is configured below PAGE_SIZE: it
        // answers every window with at most `cap` rows. supabase-js's
        // `.range(from, to)` compiles to `?offset=from&limit=to-from+1`.
        const capped = new URL(target);
        const limit = Number(capped.searchParams.get("limit"));
        if (limit > cap) capped.searchParams.set("limit", `${cap}`);
        return fetch(capped.toString(), init);
      };
      return { calls, impl };
    };

    // A fresh user sees only the seed library — comfortably under one page, the
    // overwhelmingly common case. It must cost exactly one round trip.
    const plain = makeCounter();
    const repoC = new SupabaseRepo(
      await makeUser(url, anonKey, serviceKey, plain.impl),
    );
    const listed = await repoC.listExercises();
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThan(1000);
    expect(plain.calls).toHaveLength(1);

    // Same rows against a 100-row server: ceil(n/100) requests, no trailing
    // empty-page probe.
    const CAP = 100;
    const capped = makeCounter(CAP);
    const repoD = new SupabaseRepo(
      await makeUser(url, anonKey, serviceKey, capped.impl),
    );
    const paged = await repoD.listExercises();
    expect(paged.map((e) => e.id)).toEqual(listed.map((e) => e.id));
    expect(capped.calls).toHaveLength(Math.ceil(listed.length / CAP));
  }, 30_000);

  it("listMeasurements returns every row past PostgREST's 1000-row page cap", async () => {
    // One row per calendar day (upsertMeasurement dedupes on measured_on), so
    // daily bodyweight logging crosses the cap after ~3 years — and the
    // measured_on-descending order means truncation drops the oldest history.
    const TOTAL = 1100;
    const now = Date.now();
    const rows = Array.from({ length: TOTAL }, (_, i) => ({
      id: newId(),
      created_at: now,
      updated_at: now,
      measured_on: new Date(Date.UTC(2000, 0, 1 + i))
        .toISOString()
        .slice(0, 10),
      bodyweight_kg: 70 + i / 100,
    }));
    const BATCH = 200;
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error } = await clientB
        .from("measurements")
        .insert(rows.slice(i, i + BATCH));
      if (error) throw new Error(error.message);
    }

    const listed = await repoB.listMeasurements();
    expect(listed).toHaveLength(TOTAL);
    expect(listed[0]?.measuredOn).toBe(rows[TOTAL - 1]?.measured_on);
    expect(listed[TOTAL - 1]?.measuredOn).toBe(rows[0]?.measured_on);
  }, 30_000);

  it("exercise media: owner can upload/clear, others cannot read", async () => {
    const ex = await repoA.createExercise(`Media Test ${newId().slice(0, 8)}`, {
      // Private: media_path is owner-private and may never ride a shared
      // row (the publish RPC's field whitelist drops it), and the upload
      // writes the row.
      share: false,
    });
    const pixel = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], {
      type: "image/jpeg",
    });
    await repoA.uploadExerciseMedia(ex.id, pixel, "image");

    const updated = await repoA.getExercise(ex.id);
    expect(updated?.mediaPath).toContain(ex.id);
    expect(updated?.mediaType).toBe("image");

    const url = await repoA.exerciseMediaUrl(updated!);
    expect(url).toContain("exercise-media");

    // Another user cannot sign a URL for A's object path.
    const { data: crossSign } = await clientB.storage
      .from("exercise-media")
      .createSignedUrl(updated?.mediaPath as string, 60);
    expect(crossSign?.signedUrl ?? null).toBeNull();

    await repoA.clearExerciseMedia(ex.id);
    const cleared = await repoA.getExercise(ex.id);
    expect(cleared?.mediaPath).toBeNull();
    expect(cleared?.mediaType).toBeNull();
  });

  it("RLS: users cannot see or write each other's data", async () => {
    const exA = await repoA.createExercise(
      `Private Curl ${newId().slice(0, 8)}`,
      // share: false — this test is about isolation, so the row must be
      // the caller's own, not a published global row.
      { share: false },
    );
    const sessionA = await repoA.startSession("A's session");

    const bExercises = await repoB.listExercises();
    expect(bExercises.map((e) => e.id)).not.toContain(exA.id);

    const { data: bSessions } = await clientB.from("sessions").select("id");
    expect((bSessions ?? []).map((s) => s.id)).not.toContain(sessionA.id);

    // spoofing another user's owner_id must be rejected by RLS with-check
    const { data: aUser } = await clientA.auth.getUser();
    const now = Date.now();
    const { error } = await clientB.from("sessions").insert({
      id: newId(),
      created_at: now,
      updated_at: now,
      started_at: now,
      owner_id: aUser.user?.id,
    });
    expect(error).not.toBeNull();
  });

  it("session notes round-trip and clear", async () => {
    const s = await repoA.startSession();
    await repoA.updateSessionNotes(s.id, "legs felt heavy, cleared by set 2");
    expect((await repoA.getSession(s.id))?.notes).toBe(
      "legs felt heavy, cleared by set 2",
    );
    await repoA.updateSessionNotes(s.id, null);
    expect((await repoA.getSession(s.id))?.notes).toBeNull();
  });

  it("custom conditions carry type + unit", async () => {
    const scale = await repoA.createMetric({
      name: `RPE ${newId().slice(0, 8)}`,
      type: "scale",
      scope: "session",
    });
    expect(scale.type).toBe("scale");
    expect(scale.unit).toBeNull();

    const water = await repoA.createMetric({
      name: `Water ${newId().slice(0, 8)}`,
      type: "number",
      scope: "session",
      unit: "ml",
    });
    expect(water.unit).toBe("ml");
  });

  it("tracked conditions: empty for a fresh user, upserts one row per metric", async () => {
    const metric = await repoA.createMetric({
      name: `Soreness ${newId().slice(0, 8)}`,
      type: "scale",
      scope: "session",
    });

    // A fresh user has no explicit tracked rows (defaults live in app code).
    const before = await repoA.listTrackedConditions();
    expect(before.some((t) => t.metricId === metric.id)).toBe(false);

    await repoA.setConditionTracked(metric.id, true);
    let mine = (await repoA.listTrackedConditions()).filter(
      (t) => t.metricId === metric.id,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0].tracked).toBe(true);

    // Upsert: flipping to hidden updates the same row, never duplicates it.
    await repoA.setConditionTracked(metric.id, false);
    mine = (await repoA.listTrackedConditions()).filter(
      (t) => t.metricId === metric.id,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0].tracked).toBe(false);

    // RLS: user B never sees A's tracked rows.
    const bRows = await repoB.listTrackedConditions();
    expect(bRows.some((t) => t.metricId === metric.id)).toBe(false);
  });
});
