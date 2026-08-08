import { expect, type Page, test } from "@playwright/test";
import {
  createExercise,
  EMAIL,
  PASSWORD,
  signIn,
  waitForExercise,
} from "./helpers";

// M2 routine → session integration: build a routine with a fixed-target set and
// a rep-range set, start it (draft grid prefilled from the targets, PREVIOUS
// blank the first time), log the sets, finish with Update-Routine-Values ON,
// and confirm the fixed set's target updated while the rep-range set did not.

test.beforeEach(async ({ page }) => {
  test.skip(!EMAIL || !PASSWORD, "run via `bun run e2e` (seeds the user)");
  // Force kg so builder inputs round-trip 1:1 to the session grid.
  await page.addInitScript(() => localStorage.setItem("unit", "kg"));
  await signIn(page);
});

async function routineIdByName(page: Page, name: string): Promise<string> {
  return page.evaluate(async (n) => {
    const { data, error } = await window.__frog.supabase
      .from("routines")
      .select("id")
      .eq("name", n)
      .is("deleted_at", null)
      .limit(1);
    if (error) throw new Error(error.message);
    return (data?.[0]?.id as string) ?? "";
  }, name);
}

// Weight is no longer authored in the routine builder (dropped from the
// form), so this reads target_weight_kg/target_reps straight from
// routine_sets instead of the (now-removed) routine-editor weight input.
async function routineSetTargets(
  page: Page,
  routineId: string,
): Promise<
  Array<{
    set_no: number;
    target_weight_kg: number | null;
    target_reps: number;
  }>
> {
  return page.evaluate(async (rid) => {
    const { data: exRows, error: exError } = await window.__frog.supabase
      .from("routine_exercises")
      .select("id")
      .eq("routine_id", rid)
      .is("deleted_at", null)
      .limit(1);
    if (exError) throw new Error(exError.message);
    const routineExerciseId = exRows?.[0]?.id as string;
    const { data, error } = await window.__frog.supabase
      .from("routine_sets")
      .select("set_no, target_weight_kg, target_reps")
      .eq("routine_exercise_id", routineExerciseId)
      .is("deleted_at", null)
      .order("set_no");
    if (error) throw new Error(error.message);
    return data as Array<{
      set_no: number;
      target_weight_kg: number | null;
      target_reps: number;
    }>;
  }, routineId);
}

test("start routine prefills the grid, PREVIOUS is blank, and Update Routine Values writes back fixed (not rep-range) sets", async ({
  page,
}) => {
  const EX = `RoutineEx ${Date.now()}`;
  const ROUTINE = `Routine ${Date.now()}`;

  // Exercise to build the routine around.
  await page.goto("/library");
  await createExercise(page, EX);
  await waitForExercise(page, EX);

  // Build a routine: set 0 fixed (5 reps), set 1 rep-range (8–12). Weight is
  // not authored in the builder — only Update Routine Values writes it,
  // after a session is performed.
  await page.goto("/routines");
  await page.getByTestId("new-routine-btn").click();
  await expect(page).toHaveURL(/\/routines\/new/);
  await page.getByTestId("routine-name-input").fill(ROUTINE);
  await page.getByTestId("routine-add-exercise-btn").click();
  await page.getByTestId(`routine-pick-${EX}`).click();

  // The picker seeds 3 blank sets; drop the third so this routine has
  // exactly the two sets under test (fixed, rep-range).
  await page
    .getByTestId("routine-ex-0")
    .getByLabel("Remove set")
    .last()
    .click();
  await page.getByTestId("routine-ex-0-set-0-reps").fill("5");
  await page.getByTestId("routine-ex-0-set-1-reps").fill("8");
  await page.getByTestId("routine-ex-0-set-1-repsmax").fill("12");
  await page.getByTestId("routine-save-btn").click();
  await expect(page).toHaveURL(/\/routines$/);

  // Start the routine → prefilled session.
  await page.getByTestId(`routine-start-${ROUTINE}`).click();
  await expect(page).toHaveURL(/\/session\//);

  // Set 0 draft: reps seeded from the fixed target, weight blank (never
  // authored). PREVIOUS is blank too (never logged).
  await expect(page.getByTestId("set-0-weight")).toHaveValue("");
  await expect(page.getByTestId("set-0-reps")).toHaveValue("5");
  await expect(page.getByTestId("set-0-previous")).toHaveText("—");

  // Perform set 0 at 65.
  await page.getByTestId("set-0-weight").fill("65");
  await page.getByTestId("set-0-add").click();
  await expect(page.getByTestId("committed-0")).toBeVisible();

  // Set 1 draft: weight and reps both blank for the 8–12 range.
  await expect(page.getByTestId("set-1-weight")).toHaveValue("");
  await expect(page.getByTestId("set-1-reps")).toHaveValue("");
  await page.getByTestId("set-1-weight").fill("50");
  await page.getByTestId("set-1-reps").fill("10");
  await page.getByTestId("set-1-add").click();
  await expect(page.getByTestId("committed-1")).toBeVisible();

  // Finish with Update Routine Values ON (default).
  await page.getByTestId("end-session-btn").click();
  await expect(page.getByTestId("finish-summary")).toBeVisible();
  await expect(page.getByTestId("finish-update-values")).toBeChecked();
  await page.getByTestId("finish-save").click();
  await expect(page).toHaveURL(/\/history\//);

  // Fixed set 0's target wrote back (65×5); rep-range set 1 is NEVER
  // auto-updated and keeps its authored target (null weight, 8 reps — not 50/10).
  const routineId = await routineIdByName(page, ROUTINE);
  expect(routineId).not.toBe("");
  const targets = await routineSetTargets(page, routineId);
  expect(targets).toEqual([
    { set_no: 0, target_weight_kg: 65, target_reps: 5 },
    { set_no: 1, target_weight_kg: null, target_reps: 8 },
  ]);
});

// The session row and its exercises are fetched in parallel; when the
// exercises win, routineId isn't known yet. Mounting the grid then would seed
// it blank for good (blocks seed once). Delaying the session GET makes that
// ordering deterministic instead of a coin flip under CI load.
test("start routine still prefills when the session row resolves after its exercises", async ({
  page,
}) => {
  const EX = `RaceEx ${Date.now()}`;
  const ROUTINE = `Race routine ${Date.now()}`;

  await page.goto("/library");
  await createExercise(page, EX);
  await waitForExercise(page, EX);

  await page.goto("/routines");
  await page.getByTestId("new-routine-btn").click();
  await page.getByTestId("routine-name-input").fill(ROUTINE);
  await page.getByTestId("routine-add-exercise-btn").click();
  await page.getByTestId(`routine-pick-${EX}`).click();
  await page.getByTestId("routine-ex-0-set-0-reps").fill("5");
  await page.getByTestId("routine-save-btn").click();
  await expect(page).toHaveURL(/\/routines$/);

  await page.route(/\/rest\/v1\/sessions\?/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });

  await page.getByTestId(`routine-start-${ROUTINE}`).click();
  await expect(page).toHaveURL(/\/session\//);
  await expect(page.getByTestId("set-0-reps")).toHaveValue("5");
});

// Routine-builder revamp (routine-plan-c4): per-exercise set add/remove
// inherits the prescription from the previous set, RIR range replaces the
// weight field, the exercise note is full-width, and the training-page menu
// flips upward when clipped.

test("+ Add set inherits reps/range/RIR from the previous set, not weight or set type", async ({
  page,
}) => {
  const EX = `InheritEx ${Date.now()}`;
  await page.goto("/library");
  await createExercise(page, EX);
  await waitForExercise(page, EX);

  await page.goto("/routines/new");
  await page.getByTestId("routine-add-exercise-btn").click();
  await page.getByTestId(`routine-pick-${EX}`).click();

  // No weight field anywhere in the authoring form (dropped per #3).
  await expect(page.getByTestId("routine-ex-0-set-0-weight")).toHaveCount(0);

  // Set 0: give it a distinctive prescription and mark it a warm-up.
  await page.getByTestId("routine-ex-0-set-0-reps").fill("6");
  await page.getByTestId("routine-ex-0-set-0-repsmax").fill("8");
  await page.getByTestId("routine-ex-0-set-0-rirmin").fill("2");
  await page.getByTestId("routine-ex-0-set-0-rirmax").fill("3");
  await page.getByTestId("routine-ex-0-set-0-type").click();
  await page.getByTestId("routine-ex-0-set-0-type-warmup").click();

  // Remove one of the two default extra sets so "Add set" appends after a
  // single, known-shape set.
  await page
    .getByTestId("routine-ex-0")
    .getByLabel("Remove set")
    .last()
    .click();
  await page
    .getByTestId("routine-ex-0")
    .getByLabel("Remove set")
    .last()
    .click();
  await page.getByTestId("routine-ex-0-add-set").click();

  // The new set (index 1) inherited reps/range/RIR range…
  await expect(page.getByTestId("routine-ex-0-set-1-reps")).toHaveValue("6");
  await expect(page.getByTestId("routine-ex-0-set-1-repsmax")).toHaveValue("8");
  await expect(page.getByTestId("routine-ex-0-set-1-rirmin")).toHaveValue("2");
  await expect(page.getByTestId("routine-ex-0-set-1-rirmax")).toHaveValue("3");
  // …but not the warm-up type — a carried-forward label would silently
  // mislabel a new working set.
  await expect(page.getByTestId("routine-ex-0-set-1-type")).toHaveText("2");
});

test("a fresh set defaults its target RIR range to 1-2, and the RIR/name controls meet the 40px floor", async ({
  page,
}) => {
  const EX = `RirDefaultEx ${Date.now()}`;
  await page.goto("/library");
  await createExercise(page, EX);
  await waitForExercise(page, EX);

  await page.goto("/routines/new");
  await page.getByTestId("routine-add-exercise-btn").click();
  await page.getByTestId(`routine-pick-${EX}`).click();

  await expect(page.getByTestId("routine-ex-0-set-0-rirmin")).toHaveValue("1");
  await expect(page.getByTestId("routine-ex-0-set-0-rirmax")).toHaveValue("2");
  await page.getByTestId("routine-ex-0-set-0-rirmin").fill("0");
  await expect(page.getByTestId("routine-ex-0-set-0-rirmin")).toHaveValue("0");

  // The tap target is the TextField wrapper (Radix puts sizing there and
  // spreads data-testid onto the inner <input>, which renders a couple of
  // px smaller than its own wrapper).
  const nameBox = await page
    .getByTestId("routine-name-input")
    .locator("..")
    .boundingBox();
  expect(nameBox?.height).toBeGreaterThanOrEqual(39);
  // The RIR fields are the boxless `Field` primitive now (a bare <input>, no
  // wrapper div) — its parent is the two-field flex group, sized by the
  // input's own h-10 (40px) at this mobile viewport.
  const rirBox = await page
    .getByTestId("routine-ex-0-set-0-rirmin")
    .locator("..")
    .boundingBox();
  expect(rirBox?.height).toBeGreaterThanOrEqual(39);
  // The set-type cell is the same boxless marker+StatusRing treatment as the
  // session screen (docs/DECISIONS.md 2026-08-07) — a small glyph, not a 40px
  // box — so it's covered by visibility/click coverage elsewhere in this
  // file (the warm-up-type test above) rather than a tap-target floor here.
  await expect(page.getByTestId("routine-ex-0-set-0-type")).toBeVisible();
});

test("Exercise Note is a full-width row with no Rest select, and doesn't clip a long note", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const EX = `NoteEx ${Date.now()}`;
  await page.goto("/library");
  await createExercise(page, EX);
  await waitForExercise(page, EX);

  await page.goto("/routines/new");
  await page.getByTestId("routine-add-exercise-btn").click();
  await page.getByTestId(`routine-pick-${EX}`).click();

  // The Rest select is gone entirely (rest becomes a stopwatch elsewhere).
  await expect(page.getByTestId("routine-ex-0-rest")).toHaveCount(0);

  const note = page.getByTestId("routine-ex-0-note");
  const longNote = "Keep knees soft, pause at top for a full second";
  await note.fill(longNote);
  await expect(note).toHaveValue(longNote);
  // Full width of the card (minus padding), not squeezed beside a Rest select.
  const box = await note.boundingBox();
  expect(box?.width).toBeGreaterThan(320);
});

test("routines-page routine menu flips upward when it would render below the fold", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const stamp = Date.now();
  const names = Array.from({ length: 10 }, (_, i) => `MenuFlipR${i} ${stamp}`);

  await page.goto("/routines");
  await page.evaluate(async (routineNames) => {
    const sb = window.__frog.supabase;
    const { data: userData } = await sb.auth.getUser();
    const ownerId = userData.user.id;
    // Clean slate: this test asserts an exact pixel geometry (the last card
    // flush against the viewport bottom), which routines left behind by
    // earlier tests in this file would perturb. Soft-delete them first so
    // the 10 seeded below are deterministically the whole list.
    const now = Date.now();
    await sb
      .from("routines")
      .update({ deleted_at: now, updated_at: now })
      .is("deleted_at", null);
    const rows = routineNames.map((name: string, i: number) => ({
      id: crypto.randomUUID(),
      created_at: now + i,
      updated_at: now + i,
      owner_id: ownerId,
      name,
      folder_id: null,
      position: i,
      description: null,
    }));
    const { error } = await sb.from("routines").insert(rows);
    if (error) throw new Error(error.message);
  }, names);

  await page.goto("/routines");
  await expect(
    page.locator('button[data-testid^="routine-menu-"]').last(),
  ).toBeVisible();
  // The scroll container reserves a fixed chunk of trailing space below its
  // content (room for the mobile tab bar), so scrolling to its absolute max
  // still leaves the last card with slack underneath — not the tight-margin
  // case this bug needs. Stop just short of max instead, which is exactly
  // what a real scroll gesture that doesn't snap to the very bottom looks
  // like, and reliably leaves less than POPUP_HEIGHT of room below the last
  // card's menu button.
  const btnBox = await page.evaluate(() => {
    const main = document.querySelector("main") as HTMLElement;
    const max = main.scrollHeight - main.clientHeight;
    main.scrollTop = max - 100;
    const buttons = document.querySelectorAll(
      'button[data-testid^="routine-menu-"]',
    );
    const last = buttons[buttons.length - 1] as HTMLElement;
    const r = last.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  expect(844 - (btnBox.y + btnBox.height)).toBeLessThan(118);

  // The `button` tag scopes this to menu triggers only — the popup's own
  // testid ("...-popup") also starts with "routine-menu-" and would
  // otherwise win `.last()` once a menu is open.
  const lastBtn = page.locator('button[data-testid^="routine-menu-"]').last();
  await lastBtn.click();
  const popup = lastBtn.locator("xpath=following-sibling::div[1]");
  await expect(popup).toBeVisible();
  const popupBox = await popup.boundingBox();
  expect(popupBox).not.toBeNull();
  // Opened upward (ends at/above the button's top) and fully on-screen.
  expect(popupBox?.y).toBeLessThan(btnBox.y);
  expect((popupBox?.y ?? 0) + (popupBox?.height ?? 0)).toBeLessThanOrEqual(
    btnBox.y + btnBox.height + 1,
  );
  expect(popupBox?.y).toBeGreaterThanOrEqual(0);
});

// Regression: starting a routine with N configured sets used to render only
// the one active (currently-being-logged) row — the other N-1 were invisible
// until each prior set was logged, which read as "the routine only kept 1 of
// my 5 sets." All N are now visible immediately: one editable active row plus
// read-only "upcoming" previews for the rest, counting down as sets are logged.
test("start routine materializes every configured set as a visible row, not just the active one", async ({
  page,
}) => {
  const EX = `MaterializeEx ${Date.now()}`;
  const ROUTINE = `Materialize routine ${Date.now()}`;

  await page.goto("/library");
  await createExercise(page, EX);
  await waitForExercise(page, EX);

  // 5 identical rep-range sets (6-8), matching the reported repro exactly.
  await page.goto("/routines");
  await page.getByTestId("new-routine-btn").click();
  await page.getByTestId("routine-name-input").fill(ROUTINE);
  await page.getByTestId("routine-add-exercise-btn").click();
  await page.getByTestId(`routine-pick-${EX}`).click();
  await page.getByTestId("routine-ex-0-add-set").click(); // 3 → 4
  await page.getByTestId("routine-ex-0-add-set").click(); // 4 → 5
  for (let i = 0; i < 5; i++) {
    await page.getByTestId(`routine-ex-0-set-${i}-reps`).fill("6");
    await page.getByTestId(`routine-ex-0-set-${i}-repsmax`).fill("8");
  }
  await page.getByTestId("routine-save-btn").click();
  await expect(page).toHaveURL(/\/routines$/);

  await page.getByTestId(`routine-start-${ROUTINE}`).click();
  await expect(page).toHaveURL(/\/session\//);

  // Set 0 is the active, editable row; sets 1-4 are read-only upcoming
  // previews — all 5 configured sets are on screen with zero user action.
  await expect(page.getByTestId("set-0-reps")).toBeVisible();
  for (let i = 1; i < 5; i++) {
    await expect(page.getByTestId(`upcoming-${i}-reps`)).toHaveText("6–8");
  }

  // Logging set 0 advances the active row to index 1 and drops it from the
  // upcoming list — the previously-seeded target isn't left behind or
  // duplicated, and it isn't something the user had to re-add by hand.
  await page.getByTestId("set-0-reps").fill("7");
  await page.getByTestId("set-0-add").click();
  await expect(page.getByTestId("committed-0")).toBeVisible();
  await expect(page.getByTestId("set-1-reps")).toBeVisible();
  await expect(page.getByTestId("upcoming-1-reps")).toHaveCount(0);
  for (let i = 2; i < 5; i++) {
    await expect(page.getByTestId(`upcoming-${i}-reps`)).toHaveText("6–8");
  }
});
