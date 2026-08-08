import { expect, type Page, test } from "@playwright/test";
import {
  createExercise,
  EMAIL,
  PASSWORD,
  signIn,
  waitForExercise,
} from "./helpers";

// M2 finish flow: the End button opens a Save-Workout overlay (editable title /
// notes / start-time with a computed duration, Discard). Plus the two history
// actions built on it — Save as routine and Copy workout.

test.beforeEach(async ({ page }) => {
  test.skip(!EMAIL || !PASSWORD, "run via `bun run e2e` (seeds the user)");
  await page.addInitScript(() => localStorage.setItem("unit", "kg"));
  await signIn(page);
});

async function logSet(page: Page, index: number, weight: string, reps: string) {
  await page.getByTestId(`set-${index}-weight`).fill(weight);
  await page.getByTestId(`set-${index}-reps`).fill(reps);
  await page.getByTestId(`set-${index}-add`).click();
  await expect(page.getByTestId(`committed-${index}`)).toBeVisible();
}

async function newExercise(page: Page, name: string) {
  await page.goto("/library");
  await createExercise(page, name);
  await waitForExercise(page, name);
}

async function startAndLog(
  page: Page,
  ex: string,
  sets: [string, string][],
): Promise<string> {
  await page.goto("/train");
  await page.getByTestId("start-session-btn").click();
  await expect(page).toHaveURL(/\/session\//);
  const id = page.url().split("/session/")[1];
  await page.getByTestId(`pick-exercise-${ex}`).click();
  for (let i = 0; i < sets.length; i++) await logSet(page, i, ...sets[i]);
  return id;
}

test("finish overlay edits title + start-time (duration), and persists the backdate", async ({
  page,
}) => {
  const EX = `Finish ${Date.now()}`;
  await newExercise(page, EX);
  const id = await startAndLog(page, EX, [["100", "5"]]);

  // Open the finish overlay.
  await page.getByTestId("end-session-btn").click();
  await expect(page.getByTestId("finish-summary")).toContainText("1 set");

  // Title is editable.
  await page.getByTestId("finish-title").fill("Renamed Workout");
  await expect(page.getByTestId("finish-title")).toHaveValue("Renamed Workout");

  // Backdate the start → duration recomputes into hours.
  await page.getByTestId("finish-started-at").fill("2020-01-15T08:30");
  await expect(page.getByTestId("finish-duration")).toContainText("h");

  await page.getByTestId("finish-save").click();
  await expect(page).toHaveURL(new RegExp(`/history/${id}`));

  // The backdated start persisted (survives a reload).
  await expect(page.getByTestId("session-date-input")).toHaveValue(
    /^2020-01-15/,
  );
  await page.reload();
  await expect(page.getByTestId("session-date-input")).toHaveValue(
    /^2020-01-15/,
  );
});

test("discard abandons the session (soft-deleted, home)", async ({ page }) => {
  const EX = `Discard ${Date.now()}`;
  await newExercise(page, EX);
  const id = await startAndLog(page, EX, [["80", "8"]]);

  await page.getByTestId("end-session-btn").click();
  await page.getByTestId("finish-discard").click();
  await page.getByTestId("finish-discard-confirm").click();
  await expect(page).toHaveURL(/\/$/);

  // The session row is soft-deleted.
  await expect
    .poll(() =>
      page.evaluate(async (sid) => {
        const { data, error } = await window.__frog.supabase
          .from("sessions")
          .select("deleted_at")
          .eq("id", sid)
          .limit(1);
        if (error) throw new Error(error.message);
        return data?.[0]?.deleted_at ?? null;
      }, id),
    )
    .not.toBeNull();
});

test("Save as routine and Copy workout from history detail", async ({
  page,
}) => {
  const EX = `Hist ${Date.now()}`;
  const ROUTINE = `FromHistory ${Date.now()}`;
  await newExercise(page, EX);
  const id = await startAndLog(page, EX, [
    ["100", "5"],
    ["100", "5"],
  ]);

  // Finish → lands on the session's history, over the post-save summary (M9).
  await page.getByTestId("end-session-btn").click();
  await page.getByTestId("finish-save").click();
  await expect(page).toHaveURL(new RegExp(`/history/${id}`));
  // Dismiss the celebration overlay to reach the history-detail actions.
  await page.getByTestId("summary-dismiss").click();

  // Save as routine → appears on the Routines page.
  await page.getByTestId("save-as-routine-btn").click();
  await page.getByTestId("routine-name-input").fill(ROUTINE);
  await page.getByTestId("save-as-routine-confirm").click();
  await expect(page).toHaveURL(/\/routines$/);
  await expect(page.getByTestId(`routine-card-${ROUTINE}`)).toBeVisible();

  // Copy workout → new session seeded from this one's sets.
  await page.goto(`/history/${id}`);
  await page.getByTestId("copy-workout-btn").click();
  await expect(page).toHaveURL(new RegExp(`/session/(?!${id})`));
  await expect(page.getByTestId("set-0-weight")).toHaveValue("100");
  await expect(page.getByTestId("set-0-reps")).toHaveValue("5");
});
