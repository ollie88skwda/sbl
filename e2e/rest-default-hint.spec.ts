import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { EMAIL, PASSWORD, signIn, waitForExercise } from "./helpers";

// The exercise editor's "Rest — seconds" default stopped driving anything
// in-workout when rest became an untargeted, up-counting stopwatch
// (domain/rest-timer.ts: startRest/shouldStartRest take no target). The field
// stays because the Trainer's duration estimate still reads it, so the
// Defaults section carries a caption saying exactly that. This spec pins the
// caption AND the two behaviours it claims: the stopwatch ignores the default,
// the Trainer estimate doesn't.
//
// Set E2E_EVIDENCE_DIR to also dump reviewer screenshots there.

const HINT =
  "Doesn't set the in-workout rest timer — feeds the Trainer's duration estimate only.";

const REST_DEFAULT = 600; // deliberately absurd: 10:00 is unmissable in the UI

const evidenceDir = process.env.E2E_EVIDENCE_DIR;
const evidence = (name: string) => join(evidenceDir as string, name);

test.beforeEach(async ({ page }) => {
  test.skip(!EMAIL || !PASSWORD, "run via `bun run e2e` (seeds the user)");
  if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
  await signIn(page);
});

/** Creates a custom exercise whose Defaults carry an explicit rest default. */
async function createExerciseWithRest(page: Page, name: string) {
  await page.goto("/library");
  await page.getByTestId("new-exercise-btn").click();
  await page.getByTestId("exercise-name-input").fill(name);
  await page.getByTestId("exercise-editor-defaults").click();
  await page.getByPlaceholder("150").fill(String(REST_DEFAULT));
  await page.getByTestId("add-exercise-btn").click();
  await waitForExercise(page, name);
}

async function defaultRestOf(page: Page, name: string): Promise<number | null> {
  return page.evaluate(async (n) => {
    const { data, error } = await window.__frog.supabase
      .from("exercises")
      .select("default_rest_sec")
      .eq("name", n)
      .limit(1);
    if (error) throw new Error(error.message);
    return (data?.[0]?.default_rest_sec as number | null) ?? null;
  }, name);
}

test("the Rest default carries a caption explaining what it still does", async ({
  page,
}) => {
  const EX = `RestHint ${Date.now()}`;

  await page.goto("/library");
  await page.getByTestId("new-exercise-btn").click();
  await page.getByTestId("exercise-name-input").fill(EX);

  // Defaults is collapsed by default — the caption lives inside it.
  const toggle = page.getByTestId("exercise-editor-defaults");
  const section = toggle.locator("..");
  await expect(section.getByText(HINT)).toBeHidden();
  await toggle.click();

  const caption = section.getByText(HINT);
  await expect(caption).toBeVisible();

  // It reads as a caption for the Rest field: directly under the input, and
  // laid out inside the sheet rather than overflowing it.
  const rest = page.getByPlaceholder("150");
  const restBox = (await rest.boundingBox()) as { y: number; height: number };
  const capBox = (await caption.boundingBox()) as {
    x: number;
    y: number;
    width: number;
  };
  expect(capBox.y).toBeGreaterThanOrEqual(restBox.y + restBox.height);
  const sheet = (await section.boundingBox()) as { x: number; width: number };
  expect(capBox.x).toBeGreaterThanOrEqual(sheet.x - 1);
  expect(capBox.x + capBox.width).toBeLessThanOrEqual(
    sheet.x + sheet.width + 1,
  );

  // The false claim the review pass removed must not come back: the program
  // preview reads generator-prescribed rest, not this field.
  await expect(section).not.toContainText("program preview");

  if (evidenceDir) {
    await rest.fill(String(REST_DEFAULT));
    await section.screenshot({ path: evidence("editor-defaults-caption.png") });
    await page.screenshot({ path: evidence("editor-sheet-caption.png") });
  }
});

test("a 600s Rest default does not target the in-workout stopwatch", async ({
  page,
}) => {
  const EX = `RestHintTimer ${Date.now()}`;
  await createExerciseWithRest(page, EX);
  expect(await defaultRestOf(page, EX)).toBe(REST_DEFAULT);

  await page.goto("/train");
  await page.getByTestId("start-session-btn").click();
  await page.getByTestId(`pick-exercise-${EX}`).click();

  await page.getByTestId("set-0-weight").fill("100");
  await page.getByTestId("set-0-reps").fill("5");
  await page.getByTestId("set-0-add").click();

  // Starts at zero and counts UP — never seeded from (or counting down to)
  // the 10:00 default.
  const value = page.getByTestId(`rest-${EX}-value`);
  await expect(value).toBeVisible();
  await expect(value).toHaveText(/^0:0\d$/);
  const first = (await value.innerText()).trim();
  await page.waitForTimeout(2200);
  const later = (await value.innerText()).trim();
  expect(Number.parseInt(later.split(":")[1], 10)).toBeGreaterThan(
    Number.parseInt(first.split(":")[1], 10),
  );
  await expect(value).not.toHaveText("10:00");

  if (evidenceDir) {
    await page.screenshot({ path: evidence("session-stopwatch-ignores.png") });
  }
});

test("the Rest default still moves the Trainer's duration estimate", async ({
  page,
}) => {
  const EX = `RestHintTrainer ${Date.now()}`;
  await createExerciseWithRest(page, EX);

  // An active program is what puts a next-workout card (and its ~N min
  // estimate) on the Trainer.
  await page.goto("/programs");
  await page.getByTestId("program-card-full-body-foundations").click();
  const save = page.getByTestId("save-program-btn");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page).toHaveURL(/\/routines$/);

  await page.goto("/trainer");
  const card = page.getByTestId("next-workout-card");
  await expect(card).toBeVisible();
  const routineName = (await card.locator("p").nth(1).innerText()).trim();
  const before = await estMinutes(card);
  if (evidenceDir) {
    await card.screenshot({ path: evidence("trainer-estimate-before.png") });
  }

  // Add the 600s-rest exercise to exactly that routine, through the builder —
  // which is where the exercise default seeds routine_exercises.rest_sec.
  // Saving this catalog program is legal more than once, and other specs in the
  // suite do it, so routine names repeat across folders. Scope the lookup to the
  // active program's folder — the exact set the Trainer card reads (lib/trainer.ts).
  const routineId = await page.evaluate(async (n) => {
    const s = window.__frog.supabase;
    const p = await s
      .from("programs")
      .select("folder_id")
      .eq("active", true)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1);
    if (p.error) throw new Error(p.error.message);
    const folderId = p.data?.[0]?.folder_id as string | undefined;
    if (!folderId) return "";
    const { data, error } = await s
      .from("routines")
      .select("id")
      .eq("folder_id", folderId)
      .eq("name", n)
      .is("deleted_at", null)
      .limit(1);
    if (error) throw new Error(error.message);
    return (data?.[0]?.id as string) ?? "";
  }, routineName);
  expect(routineId).not.toBe("");

  await page.goto(`/routines/${routineId}/edit`);
  await page.getByTestId("routine-add-exercise-btn").click();
  await page.getByTestId(`routine-pick-${EX}`).click();
  await page.getByTestId("routine-save-btn").click();
  await expect(page).toHaveURL(/\/routines$/);

  // The editor default landed on the routine row…
  await expect
    .poll(() =>
      page.evaluate(async (rid) => {
        const { data, error } = await window.__frog.supabase
          .from("routine_exercises")
          .select("rest_sec")
          .eq("routine_id", rid)
          .is("deleted_at", null)
          .order("order_index");
        if (error) throw new Error(error.message);
        return (data ?? []).map((r) => r.rest_sec as number | null).at(-1);
      }, routineId),
    )
    .toBe(REST_DEFAULT);

  // …and the estimate grew by the three seeded sets × (600s rest + 45s work).
  await page.goto("/trainer");
  await expect(card).toBeVisible();
  const after = await estMinutes(card);
  expect(after - before).toBeGreaterThanOrEqual(31);
  expect(after - before).toBeLessThanOrEqual(33);

  if (evidenceDir) {
    await card.screenshot({ path: evidence("trainer-estimate-after.png") });
  }
});

async function estMinutes(card: ReturnType<Page["getByTestId"]>) {
  const txt = await card.innerText();
  const m = txt.match(/~(\d+) min/);
  if (!m) throw new Error(`no duration estimate in: ${txt}`);
  return Number.parseInt(m[1], 10);
}
