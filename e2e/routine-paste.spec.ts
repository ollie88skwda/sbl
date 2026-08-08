import { expect, test } from "@playwright/test";
import {
  createExercise,
  EMAIL,
  PASSWORD,
  signIn,
  waitForExercise,
} from "./helpers";

// "Paste workout" import path: freeform text -> fuzzy-matched draft rows,
// with unmatched lines surfaced (never silently dropped or saved) and
// resolvable via "Pick manually" / "Create exercise".

test.beforeEach(async ({ page }) => {
  test.skip(!EMAIL || !PASSWORD, "run via `bun run e2e` (seeds the user)");
  await signIn(page);
});

test("parses a pasted routine into matched drafts and surfaces the unmatched line", async ({
  page,
}) => {
  const stamp = Date.now();
  const EX1 = `PasteEx1 ${stamp}`;
  const EX2 = `PasteEx2 ${stamp}`;
  const UNKNOWN = `PasteUnknown ${stamp}`;
  const ROUTINE = `Paste routine ${stamp}`;

  // Two library exercises to fuzzy-match against.
  await page.goto("/library");
  for (const name of [EX1, EX2]) {
    await createExercise(page, name);
    await waitForExercise(page, name);
  }

  await page.goto("/routines");
  await page.getByTestId("new-routine-btn").click();
  await expect(page).toHaveURL(/\/routines\/new/);

  await page.getByTestId("routine-paste-btn").click();
  await page.getByTestId("routine-paste-textarea").fill(
    [
      ROUTINE,
      `${EX1} 4x8`,
      `${EX2} 3x10-12`,
      `${UNKNOWN} 2x5`,
      "Plank 60s", // no set×rep token — out of scope, must be reported
    ].join("\n"),
  );
  await page.getByTestId("routine-paste-parse-btn").click();

  // Title prefilled from the first lettered line.
  await expect(page.getByTestId("routine-name-input")).toHaveValue(ROUTINE);

  // Matched lines became normal editable draft rows, in paste order.
  await expect(page.getByTestId("routine-ex-0")).toContainText(EX1);
  await expect(page.getByTestId("routine-ex-0-set-3-reps")).toHaveValue("8"); // 4th of 4 sets
  await expect(page.getByTestId("routine-ex-1")).toContainText(EX2);
  await expect(page.getByTestId("routine-ex-1-set-2-reps")).toHaveValue("10"); // 3rd of 3 sets
  await expect(page.getByTestId("routine-ex-1-set-2-repsmax")).toHaveValue(
    "12",
  );

  // Unknown line surfaced, not silently dropped, and nothing invented for it.
  const unmatchedRow = page
    .locator('[data-testid^="routine-unmatched-"]')
    .filter({ hasText: UNKNOWN });
  await expect(unmatchedRow).toBeVisible();

  // The line the parser couldn't read at all is reported too — a partial
  // import is never silent.
  await expect(page.getByTestId("routine-unparsed")).toContainText("Plank 60s");

  // Resolve it via "Create exercise…" — opens the editor prefilled with the
  // raw line; saving appends a third matched draft row.
  await unmatchedRow.getByRole("button", { name: "Create exercise" }).click();
  await expect(page.getByTestId("exercise-name-input")).toHaveValue(UNKNOWN);
  await page.getByTestId("add-exercise-btn").click();
  await expect(unmatchedRow).not.toBeVisible();
  await expect(page.getByTestId("routine-ex-2")).toContainText(UNKNOWN);
  await expect(page.getByTestId("routine-ex-2-set-0-reps")).toHaveValue("5");

  // Nothing saved until Save routine is hit.
  await page.getByTestId("routine-save-btn").click();
  await expect(page).toHaveURL(/\/routines$/);
});

test("caps an implausible set count into the unmatched list and resets the picker search after resolving", async ({
  page,
}) => {
  const stamp = Date.now();
  const EX = `PasteCapEx ${stamp}`;

  await page.goto("/library");
  await createExercise(page, EX);
  await waitForExercise(page, EX);

  await page.goto("/routines");
  await page.getByTestId("new-routine-btn").click();
  await expect(page).toHaveURL(/\/routines\/new/);

  await page.getByTestId("routine-paste-btn").click();
  // A misread like "1000x5" (e.g. weight×reps read as sets×reps) — even
  // though the name matches EX exactly, the implausible set count must
  // still route this to the unmatched list rather than silently building a
  // 1000-row draft.
  await page.getByTestId("routine-paste-textarea").fill(`${EX} 1000x5`);
  await page.getByTestId("routine-paste-parse-btn").click();

  const unmatchedRow = page
    .locator('[data-testid^="routine-unmatched-"]')
    .filter({ hasText: EX });
  await expect(unmatchedRow).toBeVisible();
  await expect(page.getByTestId("routine-ex-0")).toHaveCount(0);

  // Resolve via "Pick manually": the picker seeds its search with the longest
  // word of the raw name (the whole line would filter down to nothing), so
  // the exercise it needs to match is on screen.
  await unmatchedRow.getByRole("button", { name: "Pick manually" }).click();
  await expect(page.getByTestId("exercise-search-input")).toHaveValue(
    "PasteCapEx",
  );
  await page.getByTestId(`routine-pick-${EX}`).click();

  // The implausible 1000 was the reason this line was rejected, so it falls
  // back to a normal 3 sets carrying the parsed reps — not 20 rows to delete.
  await expect(page.getByTestId("routine-ex-0")).toContainText(EX);
  await expect(page.getByTestId("routine-ex-0-set-2-reps")).toHaveValue("5");
  await expect(page.getByTestId("routine-ex-0-set-3-reps")).toHaveCount(0);
  await expect(unmatchedRow).not.toBeVisible();

  // The picker's search box must not carry the stale seeded query into the
  // next plain "Add exercise" open.
  await page.getByTestId("routine-add-exercise-btn").click();
  await expect(page.getByTestId("exercise-search-input")).toHaveValue("");
});

test("picking one exercise resolves every unmatched line naming the same lift", async ({
  page,
}) => {
  const stamp = Date.now();
  const EX = `PasteTwinEx ${stamp}`;

  await page.goto("/library");
  await createExercise(page, EX);
  await waitForExercise(page, EX);

  await page.goto("/routines");
  await page.getByTestId("new-routine-btn").click();
  await expect(page).toHaveURL(/\/routines\/new/);

  await page.getByTestId("routine-paste-btn").click();
  // The same lift twice — main sets plus a backoff line — both with a misread
  // set count, so both land in the unmatched list under one name.
  await page
    .getByTestId("routine-paste-textarea")
    .fill([`${EX} 1000x5`, `${EX} 900x8`].join("\n"));
  await page.getByTestId("routine-paste-parse-btn").click();

  const unmatchedRows = page
    .locator('[data-testid^="routine-unmatched-"]')
    .filter({ hasText: EX });
  await expect(unmatchedRows).toHaveCount(2);

  // Resolving one line via "Pick manually" resolves its twin too: leaving the
  // sibling behind would offer a Create-exercise button that mints a second
  // library row for the lift just picked.
  await unmatchedRows
    .first()
    .getByRole("button", { name: "Pick manually" })
    .click();
  await page.getByTestId(`routine-pick-${EX}`).click();

  await expect(unmatchedRows).toHaveCount(0);
  await expect(page.getByTestId("routine-ex-0")).toContainText(EX);
  await expect(page.getByTestId("routine-ex-0-set-0-reps")).toHaveValue("5");
  await expect(page.getByTestId("routine-ex-1")).toContainText(EX);
  await expect(page.getByTestId("routine-ex-1-set-0-reps")).toHaveValue("8");
});
