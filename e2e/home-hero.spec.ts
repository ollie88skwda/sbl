import { expect, test } from "@playwright/test";
import {
  createExercise,
  EMAIL,
  PASSWORD,
  signIn,
  waitForExercise,
} from "./helpers";

// Home hero — "today's plan". The hero is the primary way to start training:
// it names the routine you're about to run, previews what's in it, and starts
// it in one tap. Phone viewport, because Frog is a mobile web app first.

test.use({ viewport: { width: 390, height: 844 } });

test.beforeEach(async ({ page }) => {
  test.skip(!EMAIL || !PASSWORD, "run via `bun run e2e` (seeds the user)");
  await page.addInitScript(() => localStorage.setItem("unit", "kg"));
  await signIn(page);
  // The hero's shape depends on whether a session is live, and the suite shares
  // one seeded user — abandon any leftover so each assertion here is about the
  // hero, not about what ran before it.
  await page.evaluate(async () => {
    const now = Date.now();
    const { error } = await window.__frog.supabase
      .from("sessions")
      .update({ deleted_at: now, updated_at: now })
      .is("deleted_at", null)
      .is("ended_at", null);
    if (error) throw new Error(error.message);
    // Likewise an active program left by an earlier spec would confine the
    // hero's suggestion to that program's folder.
    await window.__frog.supabase
      .from("programs")
      .update({ active: false })
      .eq("active", true);
  });
});

test("with no routines the hero offers to build one, and can still start empty", async ({
  page,
}) => {
  // The suite shares one seeded user and earlier specs leave routines behind,
  // so clear the shelf to get the genuinely-empty hero. Specs that need
  // routines build their own.
  await page.evaluate(async () => {
    const { error } = await window.__frog.supabase
      .from("routines")
      .update({ deleted_at: Date.now(), updated_at: Date.now() })
      .is("deleted_at", null);
    if (error) throw new Error(error.message);
  });

  await page.goto("/");
  const hero = page.getByTestId("home-hero");
  await expect(hero).toBeVisible();
  await expect(page.getByTestId("hero-build-btn")).toBeVisible();

  // The escape hatch survives — an unplanned session is still one tap away.
  await page.getByTestId("home-start-btn").click();
  await expect(page).toHaveURL(/\/session\//);
  // A fresh empty session opens the exercise picker; dismiss it and bin the
  // session so the next spec inherits a clean slate.
  const picker = page.getByRole("dialog");
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await page.getByTestId("end-session-btn").click();
  await page.getByTestId("finish-discard").click();
  await page.getByTestId("finish-discard-confirm").click();
  await expect(page).toHaveURL(/\/$/);
});

test("the hero names today's routine, previews it, and starts it in one tap", async ({
  page,
}) => {
  const EX_A = `HeroEx A ${Date.now()}`;
  const EX_B = `HeroEx B ${Date.now()}`;
  const PUSH = `Push Day ${Date.now()}`;
  const PULL = `Pull Day ${Date.now()}`;

  await page.goto("/library");
  for (const name of [EX_A, EX_B]) {
    await createExercise(page, name);
    await waitForExercise(page, name);
  }

  // Two pre-saved routines.
  for (const [routine, ex] of [
    [PUSH, EX_A],
    [PULL, EX_B],
  ] as const) {
    await page.goto("/routines");
    await page.getByTestId("new-routine-btn").click();
    await page.getByTestId("routine-name-input").fill(routine);
    await page.getByTestId("routine-add-exercise-btn").click();
    await page.getByTestId(`routine-pick-${ex}`).click();
    await page.getByTestId("routine-save-btn").click();
    await expect(page).toHaveURL(/\/routines$/);
  }

  await page.goto("/");
  const hero = page.getByTestId("home-hero");
  await expect(hero).toBeVisible();

  // A pre-saved routine is named in the hero — not a generic "Start".
  await expect(page.getByTestId("hero-plan-name")).toHaveText(PUSH);
  // …and its contents are previewed, so you know what you're walking into.
  await expect(hero.getByText(EX_A)).toBeVisible();

  // Picking a different plan re-aims the hero without leaving Home.
  await page.getByTestId(`hero-pick-${PULL}`).click();
  await expect(page.getByTestId("hero-plan-name")).toHaveText(PULL);
  await expect(hero.getByText(EX_B)).toBeVisible();

  // One tap starts it, prefilled.
  await page.getByTestId("home-start-btn").click();
  await expect(page).toHaveURL(/\/session\//);
  await expect(page.getByText(EX_B).first()).toBeVisible();

  // Back on Home the hero switches to the live session.
  await page.goto("/");
  await expect(page.getByTestId("hero-resume-btn")).toBeVisible();
  await page.getByTestId("hero-resume-btn").click();
  await expect(page).toHaveURL(/\/session\//);

  await page.getByTestId("set-0-weight").fill("60");
  await page.getByTestId("set-0-reps").fill("5");
  await page.getByTestId("set-0-add").click();
  await expect(page.getByTestId("committed-0")).toBeVisible();
  await page.getByTestId("end-session-btn").click();
  await page.getByTestId("finish-save").click();
  await expect(page).toHaveURL(/\/history\//);

  // Having just run Pull, the hero moves on rather than repeating it.
  await page.goto("/");
  await expect(page.getByTestId("hero-plan-name")).toHaveText(PUSH);
});
