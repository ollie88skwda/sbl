import { expect, test } from "@playwright/test";
import {
  createExercise,
  EMAIL,
  PASSWORD,
  rowCount,
  signIn,
  waitForExercise,
  waitForSetLogs,
} from "./helpers";

// Unilateral set logging: a set_logs.side column pairs two rows under one
// set_no. The session UI renders them as ONE set (ᴸ line you type into, ᴿ
// line mirroring as faint placeholders until overridden), committed by one
// tap — this is the fix for the double-counting bug (a unilateral set was
// reading as two sets everywhere: session header, finish sheet, stats).

test.beforeEach(async ({ page }) => {
  test.skip(!EMAIL || !PASSWORD, "run via `bun run e2e` (seeds the user)");
  await signIn(page);
});

async function cellX(
  page: import("@playwright/test").Page,
  testId: string,
  // The draft row's cells are boxless inputs (no wrapper, no border), so the
  // test id sits directly on the element that fills the grid cell — measure
  // it directly, like a committed value button. Kept as a parameter so a
  // future bordered/wrapped field can opt back into measuring its wrapper.
  wrapper = false,
): Promise<number> {
  const el = page.getByTestId(testId);
  const box = await (wrapper ? el.locator("..") : el).boundingBox();
  if (!box) throw new Error(`${testId} has no bounding box`);
  return box.x;
}

async function markUnilateral(
  page: import("@playwright/test").Page,
  name: string,
) {
  await page.evaluate(async (n) => {
    const { error } = await window.__frog.supabase
      .from("exercises")
      .update({ laterality: "unilateral" })
      .eq("name", n);
    if (error) throw new Error(error.message);
  }, name);
}

// Community phase (docs/DECISIONS.md 2026-08-08): an exercise created via the
// library is published as a shared row (owner_id null) and is RLS-immutable —
// a direct update on it is silently blocked. Fork a private copy (the
// library's "Make a private copy") and return its name, so the tests below
// can mutate an owned row instead.
async function forkCopy(
  page: import("@playwright/test").Page,
  name: string,
): Promise<string> {
  const copy = `${name} (copy)`;
  await page.getByTestId(`exercise-row-toggle-${name}`).click();
  await page.getByTestId(`fork-exercise-${name}`).click();
  await expect(page.getByTestId(`exercise-row-${copy}`)).toBeVisible();
  await waitForExercise(page, copy);
  return copy;
}

test("logs a unilateral set as two rows sharing one set_no, and counts it once", async ({
  page,
}) => {
  const EX = `One-Arm Row ${Date.now()}`;

  await page.goto("/library");
  await createExercise(page, EX);
  await waitForExercise(page, EX);
  const copy = await forkCopy(page, EX);
  await markUnilateral(page, copy);

  await page.goto("/train");
  await page.getByTestId("start-session-btn").click();
  await expect(page).toHaveURL(/\/session\//);
  await page.getByTestId(`pick-exercise-${copy}`).click();

  // Header shows "reps" (not "reps/side") — the ᴸ/ᴿ line markers already say
  // per-side (report's own resolved judgment call).
  const block = page.getByTestId(`block-${copy}`);
  await expect(block).toContainText("reps");
  await expect(block).not.toContainText("reps/side");

  // Draft row: ᴸ line you type into, ᴿ line mirrors reps live as you type.
  // Same weight both sides (note 1) — the ᴿ line has NO weight input.
  await expect(page.getByTestId("set-0-type")).toContainText("1ᴸ");
  await page.getByTestId("set-0-weight").fill("30");
  await page.getByTestId("set-0-reps").fill("10");
  await expect(page.getByTestId("set-0-right-weight")).toHaveCount(0);
  await expect(page.getByTestId("set-0-right-reps")).toHaveAttribute(
    "placeholder",
    "10",
  );
  // Untouched — mirroring is a placeholder, not a value.
  await expect(page.getByTestId("set-0-right-reps")).toHaveValue("");

  await page.getByTestId("set-0-done").click();

  // ONE physical set, not two — the bug this feature fixes.
  await expect(page.getByTestId("session-stats")).toContainText("1 set");
  await expect(page.getByTestId("committed-0-type")).toContainText("1ᴸ");
  // Same weight both sides: the ᴿ weight cell is blank (reads "same as left"),
  // the ᴿ reps print their own value.
  await expect(page.getByTestId("committed-0-right-weight")).toHaveText("");
  await expect(page.getByTestId("committed-0-right-reps")).toContainText("10");

  // Both rows share one set_no. The two upserts run in the background behind
  // the optimistic UI, so poll until they land instead of reading once.
  const readRows = () =>
    page.evaluate(async (n) => {
      const { data: ex } = await window.__frog.supabase
        .from("exercises")
        .select("id")
        .eq("name", n)
        .single();
      const { data, error } = await window.__frog.supabase
        .from("set_logs")
        .select("set_no, side, weight_kg, reps, rest_sec")
        .eq(
          "session_exercise_id",
          (
            await window.__frog.supabase
              .from("session_exercises")
              .select("id")
              .eq("exercise_id", ex.id)
              .single()
          ).data.id,
        )
        .order("side");
      if (error) throw new Error(error.message);
      return data;
    }, copy);

  await expect.poll(async () => (await readRows()).length).toBe(2);
  const rows = await readRows();
  // Both share set_no 0; an untouched ᴿ line mirrors the ᴸ values exactly.
  expect(rows[0].set_no).toBe(0);
  expect(rows[1].set_no).toBe(0);
  expect(rows[0].side).toBe("left");
  expect(rows[1].side).toBe("right");
  expect(rows[0].reps).toBe(10);
  expect(rows[1].reps).toBe(10);
  expect(rows[0].weight_kg).toBe(rows[1].weight_kg);
  expect(rows[0].rest_sec).toBeNull(); // first set of the session
  expect(rows[1].rest_sec).toBeNull(); // right side never carries rest_sec

  // Logging a set never auto-adds the next draft; "Add set" opens it
  // explicitly, seeded at physical set 2 (not 3) — the same countSets() the
  // header uses, not a raw committed.length.
  await page.getByTestId("set-1-add").click();
  await expect(page.getByTestId("set-1-type")).toContainText("2ᴸ");

  // A pair with divergent REPS (the only thing that can diverge now — the
  // weight is shared) — volume sums both sides, and rest_sec lands on the
  // left row only (one commit, one countdown).
  await page.getByTestId("set-1-weight").fill("30");
  await page.getByTestId("set-1-reps").fill("10");
  await page.getByTestId("set-1-right-reps").fill("8");
  await page.getByTestId("set-1-done").click();

  await expect(page.getByTestId("session-stats")).toContainText("2 sets");
  await expect(page.getByTestId("committed-1-right-weight")).toHaveText("");
  await expect(page.getByTestId("committed-1-right-reps")).toContainText("8");
});

test("shows the laterality affix alongside the warm-up marker on a unilateral pair's top line", async ({
  page,
}) => {
  const EX = `Warmup Row ${Date.now()}`;

  await page.goto("/library");
  await createExercise(page, EX);
  await waitForExercise(page, EX);
  const copy = await forkCopy(page, EX);
  await markUnilateral(page, copy);

  await page.goto("/train");
  await page.getByTestId("start-session-btn").click();
  await expect(page).toHaveURL(/\/session\//);
  await page.getByTestId(`pick-exercise-${copy}`).click();

  // The marker must still carry the ᴸ affix once a type is assigned — losing
  // it drops the pairing cue that ties this line to its ᴿ line below.
  await page.getByTestId("set-0-type").click();
  await page.getByTestId("set-0-type-warmup").click();
  await expect(page.getByTestId("set-0-type")).toHaveText("Wᴸ");

  await page.getByTestId("set-0-weight").fill("20");
  await page.getByTestId("set-0-reps").fill("12");
  await page.getByTestId("set-0-done").click();

  await expect(page.getByTestId("committed-0-type")).toHaveText("Wᴸ");
});

test("editing only the ᴿ row's RIR/RPE/note surfaces them in the collapsed readout and reopened sheet", async ({
  page,
}) => {
  const EX = `One-Arm Press ${Date.now()}`;

  await page.goto("/library");
  await createExercise(page, EX);
  await waitForExercise(page, EX);
  const copy = await forkCopy(page, EX);
  await markUnilateral(page, copy);

  await page.goto("/train");
  await page.getByTestId("start-session-btn").click();
  await expect(page).toHaveURL(/\/session\//);
  await page.getByTestId(`pick-exercise-${copy}`).click();

  await page.getByTestId("set-0-weight").fill("20");
  await page.getByTestId("set-0-reps").fill("8");
  await page.getByTestId("set-0-done").click();
  // Same weight both sides — the ᴿ weight cell is blank, still the tap target
  // that opens this limb's own details sheet.
  await expect(page.getByTestId("committed-0-right-weight")).toBeVisible();
  await expect(page.getByTestId("committed-0-right-weight")).toHaveText("");
  await page.getByTestId("committed-0-right-weight").click();
  await page.getByTestId("edit-0-rirmin").fill("1");
  await page.getByTestId("edit-0-rpe").selectOption("9");
  await page.getByTestId("edit-0-note").fill("elbow flare on this side");
  await page.getByTestId("edit-0-save").click();

  // Collapsed readout now surfaces the ᴿ row's own values.
  await expect(page.getByTestId("committed-0-right-effort")).toContainText(
    "@1",
  );
  await expect(page.getByTestId("committed-0-right-effort")).toContainText(
    "RPE 9",
  );
  await expect(page.getByTestId("committed-0-right-note")).toHaveAttribute(
    "title",
    "elbow flare on this side",
  );

  // Nothing fanned back to the ᴸ row — and it says so with a "—" rather
  // than a blank span, which would read as "this line mirrors the other".
  await expect(page.getByTestId("committed-0-effort")).toHaveText("—");
  await expect(page.getByTestId("committed-0-effort")).toBeVisible();
  await expect(page.getByTestId("committed-0-note")).toHaveCount(0);

  // Reopening the ᴿ row's sheet still shows what was saved (it never was
  // truly invisible in storage — only in every UI surface, until now).
  await page.getByTestId("committed-0-right-weight").click();
  await expect(page.getByTestId("edit-0-rirmin")).toHaveValue("1");
  await expect(page.getByTestId("edit-0-rpe")).toHaveValue("9");
  await expect(page.getByTestId("edit-0-note")).toHaveValue(
    "elbow flare on this side",
  );
});

test("a mirrored pair prints no ᴿ readout; clearing the ᴿ side prints — beside the ᴸ values", async ({
  page,
}) => {
  const EX = `One-Arm Curl ${Date.now()}`;

  await page.goto("/library");
  await createExercise(page, EX);
  await waitForExercise(page, EX);
  const copy = await forkCopy(page, EX);
  await markUnilateral(page, copy);

  await page.goto("/train");
  await page.getByTestId("start-session-btn").click();
  await expect(page).toHaveURL(/\/session\//);
  await page.getByTestId(`pick-exercise-${copy}`).click();

  // Weight only, so far — auto-checkoff (weight+reps both filled) hasn't
  // armed yet, so opening the details sheet next can't race it. Effort
  // entered here fans out to both rows at commit.
  await page.getByTestId("set-0-weight").fill("20");
  await page.getByTestId("set-0-more").click();
  await page.getByTestId("set-0-rirmin").fill("2");
  await page.getByTestId("set-0-rpe").selectOption("8");
  await expect(page.getByTestId("set-0-note")).toBeVisible(); // sheet is open
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("set-0-note")).toBeHidden();

  // The draft row's ᴸ line now carries a preview badge its ᴿ line doesn't.
  // Both lines size their columns from one grid, so the values stay
  // pixel-aligned anyway — the whole point of the shared track. The ᴿ line
  // has no weight input (note 1: same weight both sides) — only its reps
  // column lines up with the ᴸ line's.
  await expect(page.getByTestId(`block-${copy}`)).toContainText("@2 RPE 8");
  await expect(page.getByTestId("set-0-right-weight")).toHaveCount(0);
  expect(await cellX(page, "set-0-right-reps")).toBeCloseTo(
    await cellX(page, "set-0-reps"),
    0,
  );

  await page.getByTestId("set-0-reps").fill("8");
  await page.getByTestId("set-0-done").click();

  // Both rows carry the same effort: the ᴿ line prints nothing at all, and
  // the ᴸ line's readout stays desktop-only chrome at this viewport (the
  // suite's iPhone 13 default, below `md:`). The ᴿ weight cell is blank
  // (same weight both sides).
  await expect(page.getByTestId("committed-0-right-weight")).toHaveText("");
  await expect(page.getByTestId("committed-0-right-effort")).toHaveCount(0);
  await expect(page.getByTestId("committed-0-effort")).toBeHidden();

  // Clear the ᴿ row's own effort — the two sides now differ, with nothing
  // left on the ᴿ one.
  await page.getByTestId("committed-0-right-weight").click();
  await page.getByTestId("edit-0-rirmin").fill("");
  await page.getByTestId("edit-0-rpe").selectOption("");
  await page.getByTestId("edit-0-save").click();

  // "—", not a blank span: cleared has to read differently from mirrored.
  await expect(page.getByTestId("committed-0-right-effort")).toHaveText("—");
  await expect(page.getByTestId("committed-0-right-effort")).toBeVisible();

  // …and the ᴸ line's own values come out of hiding on the same narrow
  // viewport, so the readout that IS there can't read as the whole set's.
  await expect(page.getByTestId("committed-0-effort")).toBeVisible();
  await expect(page.getByTestId("committed-0-effort")).toHaveText("@2 RPE 8");

  // The pair is HORIZONTAL (note 3): ᴸ and ᴿ sit side by side in ONE row —
  // the ᴿ cells are to the RIGHT of the ᴸ cells at the same y, not on a
  // stacked line below them.
  expect(
    await cellX(page, "committed-0-right-weight"),
    "committed-0-right-weight sits right of committed-0-weight",
  ).toBeGreaterThan(await cellX(page, "committed-0-weight"));
  expect(
    await cellX(page, "committed-0-right-reps"),
    "committed-0-right-reps sits right of committed-0-reps",
  ).toBeGreaterThan(await cellX(page, "committed-0-reps"));
  const leftBox = (await page
    .getByTestId("committed-0-weight")
    .boundingBox()) as { y: number };
  const rightBox = (await page
    .getByTestId("committed-0-right-weight")
    .boundingBox()) as { y: number };
  // Same row, not stacked: a 1px rounding drift between the two limb groups
  // is fine — a stacked ᴿ line sat ~44px lower.
  expect(Math.abs(rightBox.y - leftBox.y)).toBeLessThan(8);

  // …and the one-column-template invariant still holds across the block for
  // the non-paired rows: log a second, badge-free set. Every bilateral row of
  // one exercise shares one grid, so their value columns line up.
  await page.getByTestId("set-1-add").click();
  await page.getByTestId("set-1-weight").fill("20");
  await page.getByTestId("set-1-reps").fill("8");
  await page.getByTestId("set-1-done").click();
  await expect(page.getByTestId("committed-1-right-weight")).toHaveText("");
  // Open the next draft too — the alignment assertions below include its
  // cells (set-2-*).
  await page.getByTestId("set-2-add").click();

  const pairL = await cellX(page, "committed-0-reps");
  const pairR = await cellX(page, "committed-0-right-reps");
  // Both committed rows here are pairs — their ᴸ/ᴿ splits land at the same x
  // across sets (same flex structure, same block tracks), and the draft row's
  // standard track sits between them: the horizontal-space trade a pair makes
  // (its ᴸ side takes the left half of the row, its ᴿ side the right).
  expect(await cellX(page, "committed-1-reps")).toBeCloseTo(pairL, 0);
  expect(await cellX(page, "committed-1-right-reps")).toBeCloseTo(pairR, 0);
  expect(pairL).toBeLessThan(await cellX(page, "set-2-reps"));
  expect(pairR).toBeGreaterThan(await cellX(page, "set-2-reps"));

  // The draft row's controls stay right-anchored: its ✓ (Mark set done)
  // lands at the same x as every committed row's ⋯ (the check owns the
  // menu-gutter track, note 2), and its ⋯ sits one track left of it.
  const menuX = await cellX(page, "set-menu-0");
  await expect(page.getByTestId("set-2-done")).toBeVisible();
  expect(
    await cellX(page, "set-menu-1"),
    "set-menu-1 vs set-menu-0",
  ).toBeCloseTo(menuX, 0);
  expect(
    await cellX(page, "set-2-done"),
    "set-2-done vs set-menu-0",
  ).toBeCloseTo(menuX, 0);
  expect(
    await cellX(page, "set-2-more"),
    "set-2-more sits left of the ✓",
  ).toBeLessThan(menuX);
});

test("a legacy alternating exercise reads as bilateral (note 5)", async ({
  page,
}) => {
  const EX = `Alt Curl ${Date.now()}`;

  await page.goto("/library");
  await createExercise(page, EX);
  await waitForExercise(page, EX);
  const copy = await forkCopy(page, EX);
  await page.evaluate(async (n) => {
    const { error } = await window.__frog.supabase
      .from("exercises")
      .update({ laterality: "alternating" })
      .eq("name", n);
    if (error) throw new Error(error.message);
  }, copy);

  await page.goto("/train");
  await page.getByTestId("start-session-btn").click();
  await page.getByTestId(`pick-exercise-${copy}`).click();

  // Alternating was folded into bilateral (note 5): the "total reps" header
  // wording is gone — a legacy row logs exactly like a bilateral one.
  const block = page.getByTestId(`block-${copy}`);
  await expect(block).toContainText("reps");
  await expect(block).not.toContainText("total reps");
  // No paired ᴿ line — it logs identically to bilateral.
  await expect(page.getByTestId("set-0-right-weight")).toHaveCount(0);
  // And the per-set Unilateral toggle IS available — legacy alternating reads
  // as bilateral, so nothing contradicts a per-set override anymore.
  await page.getByTestId("set-0-more").click();
  await expect(page.getByTestId("set-0-unilateral")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("a single set's menu makes just that one set unilateral (note 1)", async ({
  page,
}) => {
  const EX = `One-Off Curl ${Date.now()}`;

  // A plain bilateral exercise — no laterality set at all.
  await page.goto("/library");
  await createExercise(page, EX);
  await waitForExercise(page, EX);

  await page.goto("/train");
  await page.getByTestId("start-session-btn").click();
  await expect(page).toHaveURL(/\/session\//);
  await page.getByTestId(`pick-exercise-${EX}`).click();

  // No ᴿ line by default.
  await expect(page.getByTestId("set-0-right-reps")).toHaveCount(0);

  // The set's ⋯ menu (details sheet) carries the Unilateral toggle. Weight
  // only so far, so opening the sheet can't race auto-checkoff.
  await page.getByTestId("set-0-weight").fill("20");
  await page.getByTestId("set-0-more").click();
  await expect(page.getByTestId("set-0-unilateral")).toBeVisible();
  await page.getByTestId("set-0-unilateral").check();
  await page.keyboard.press("Escape");

  // Just this set gained its ᴿ line.
  await expect(page.getByTestId("set-0-right-reps")).toBeVisible();
  await page.getByTestId("set-0-reps").fill("10");
  await page.getByTestId("set-0-right-reps").fill("8");
  await page.getByTestId("set-0-done").click();

  // Logged as a pair — same weight both sides, divergent reps.
  await expect(page.getByTestId("committed-0-right-reps")).toContainText("8");
  await expect(page.getByTestId("committed-0-right-weight")).toHaveText("");
  await waitForSetLogs(page, EX, 2);

  // The NEXT set is back to bilateral — the override was for set 1 only.
  await page.getByTestId("set-1-add").click();
  await expect(page.getByTestId("set-1-right-reps")).toHaveCount(0);
});

test("laterality menu speaks unilateral/bilateral, not sides (note 15)", async ({
  page,
}) => {
  const EX = `Wording Bench ${Date.now()}`;

  await page.goto("/library");
  await createExercise(page, EX);
  await waitForExercise(page, EX);

  await page.goto("/train");
  await page.getByTestId("start-session-btn").click();
  await page.getByTestId(`pick-exercise-${EX}`).click();

  await page.getByTestId(`block-${EX}-menu`).click();
  const menu = page.getByTestId(`block-${EX}-menu-popup`);
  await expect(menu).toContainText("Laterality");
  // The labels are the unilateral/bilateral vocabulary, not the old
  // "Both sides / One side" names (note 15) — and alternating is gone
  // (note 5), folded into bilateral.
  await expect(menu).toContainText("Unilateral");
  await expect(menu).toContainText("Bilateral");
  await expect(menu).not.toContainText("Alternating");
  // The explainers tell the two remaining options apart.
  await expect(menu).toContainText("one row per set");
  await expect(menu).toContainText("logged separately");
  await page.keyboard.press("Escape");
});

test("library last-set summary shows both sides of a divergent unilateral pair", async ({
  page,
}) => {
  // Display kg so the assertion below is unit-independent of the app's lb default.
  await page.evaluate(() => localStorage.setItem("unit", "kg"));

  const EX = `Lat Pulldown ${Date.now()}`;

  await page.goto("/library");
  await createExercise(page, EX);
  await waitForExercise(page, EX);
  const copy = await forkCopy(page, EX);
  await markUnilateral(page, copy);

  await page.goto("/train");
  await page.getByTestId("start-session-btn").click();
  await expect(page).toHaveURL(/\/session\//);
  await page.getByTestId(`pick-exercise-${copy}`).click();

  // Same weight both sides, divergent reps (note 1: the unilateral part is
  // only the reps).
  await page.getByTestId("set-0-weight").fill("40");
  await page.getByTestId("set-0-reps").fill("8");
  await page.getByTestId("set-0-right-reps").fill("12");
  await page.getByTestId("set-0-done").click();
  await expect(page.getByTestId("committed-0-right-reps")).toContainText("12");
  await waitForSetLogs(page, copy, 2);

  // A divergent WEIGHT is still expressible post-commit — the ᴿ row's own
  // details sheet edits it independently (the escape hatch the shared-weight
  // draft removed). 40 → 35 on the right side only.
  await page.getByTestId("committed-0-right-weight").click();
  await page.getByTestId("edit-0-weight").fill("35");
  await page.getByTestId("edit-0-save").click();
  await expect(page.getByTestId("committed-0-right-weight")).toContainText(
    "35",
  );

  // The library card's "Last:" ghost preview shares formatPrevious's uneven-
  // pair convention ("X × r / Y × r") with the session PREVIOUS column — it
  // must show the ᴿ side too, not silently drop it.
  await page.goto("/library");
  await page.getByTestId("exercise-search-input").fill(copy);
  await expect(page.getByTestId(`exercise-row-${copy}`)).toContainText(
    "Last: 40 kg × 8 / 35 kg × 12",
  );
});

test("the committed set's ⋯ flips the set to unilateral and back (note 7)", async ({
  page,
}) => {
  const EX = `Committed Toggle ${Date.now()}`;

  await page.goto("/library");
  await createExercise(page, EX);
  await waitForExercise(page, EX);

  await page.goto("/train");
  await page.getByTestId("start-session-btn").click();
  await expect(page).toHaveURL(/\/session\//);
  await page.getByTestId(`pick-exercise-${EX}`).click();

  // Log one bilateral set.
  await page.getByTestId("set-0-weight").fill("30");
  await page.getByTestId("set-0-reps").fill("10");
  await page.getByTestId("set-0-done").click();
  await expect(page.getByTestId("committed-0")).toBeVisible();
  await expect(page.getByTestId("committed-0-right-weight")).toHaveCount(0);
  await waitForSetLogs(page, EX, 1);

  // Non-deleted row count (the toggle's remove is a soft delete, so the raw
  // set_logs count would keep the ᴿ row forever).
  const liveRows = () =>
    page.evaluate(async (n) => {
      const { data: ex } = await window.__frog.supabase
        .from("exercises")
        .select("id")
        .eq("name", n)
        .single();
      const { data: ses } = await window.__frog.supabase
        .from("session_exercises")
        .select("id")
        .eq("exercise_id", ex.id);
      const { count } = await window.__frog.supabase
        .from("set_logs")
        .select("id", { count: "exact", head: true })
        .in(
          "session_exercise_id",
          ses.map((s) => s.id),
        )
        .is("deleted_at", null);
      return count ?? 0;
    }, EX);

  // The ⋯ → details sheet carries the unilateral toggle; flipping it adds
  // the paired ᴿ row mirroring the ᴸ values — nothing else changes.
  await page.getByTestId("set-menu-0").click();
  await expect(page.getByTestId("set-menu-0-unilateral")).toBeVisible();
  await page.getByTestId("set-menu-0-unilateral").check();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("committed-0-right-reps")).toContainText("10");
  await expect.poll(liveRows).toBe(2);

  // The flip is structural: the ᴸ row's side went null → 'left' server-side,
  // so the pair survives a reload instead of re-splitting into two sets.
  await page.reload();
  await expect(page.getByTestId("committed-0")).toBeVisible();
  await expect(page.getByTestId("committed-0-right-reps")).toContainText("10");
  await expect(page.getByTestId("committed-1")).toHaveCount(0);

  // Flip it back — the ᴿ row is soft-deleted and the set is one row again.
  await page.getByTestId("set-menu-0").click();
  await expect(page.getByTestId("set-menu-0-unilateral")).toBeVisible();
  await page.getByTestId("set-menu-0-unilateral").uncheck();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("committed-0-right-weight")).toHaveCount(0);
  await expect.poll(liveRows).toBe(1);

  // And the restore persisted too.
  await page.reload();
  await expect(page.getByTestId("committed-0")).toBeVisible();
  await expect(page.getByTestId("committed-0-right-weight")).toHaveCount(0);
  await expect.poll(liveRows).toBe(1);
});

test("Add set pre-creates a blank committed row when the previous set is unfilled (note 4)", async ({
  page,
}) => {
  const EX = `Blank Add ${Date.now()}`;

  await page.goto("/library");
  await createExercise(page, EX);
  await waitForExercise(page, EX);

  await page.goto("/train");
  await page.getByTestId("start-session-btn").click();
  await expect(page).toHaveURL(/\/session\//);
  await page.getByTestId(`pick-exercise-${EX}`).click();

  const before = await rowCount(page, "set_logs");

  // No values typed at all — Add set must still advance (committing the
  // empty draft as a blank committed row the user fills in later).
  await page.getByTestId("set-0-add").click();

  // The blank row renders with — placeholders and the next draft is open.
  await expect(page.getByTestId("committed-0")).toBeVisible();
  await expect(page.getByTestId("committed-0-weight")).toHaveText("—");
  await expect(page.getByTestId("committed-0-reps")).toHaveText("—");
  await expect(page.getByTestId("set-1-weight")).toBeVisible();

  // Server-side: exactly one blank row landed.
  await expect.poll(() => rowCount(page, "set_logs")).toBe(before + 1);

  // Fill the blank set in later via its details sheet.
  await page.getByTestId("set-menu-0").click();
  await page.getByTestId("edit-0-weight").fill("50");
  await page.getByTestId("edit-0-reps").fill("5");
  await page.getByTestId("edit-0-save").click();
  await expect(page.getByTestId("committed-0-weight")).toHaveText("50");
  await expect(page.getByTestId("committed-0-reps")).toHaveText("5");
});
