import { expect, test } from "@playwright/test";
import { EMAIL, PASSWORD, signIn } from "./helpers";

// Mid-workout navigation (2026-08-08 UI note 11): while a session is live the
// shell's Training tab jumps straight to it (docs/DECISIONS.md 2026-07-14), so
// the routines page — and from it the builder — is only reachable from inside
// the session via the header's Routines button. This pins that entry point and
// the round trip back out of the session.

test.beforeEach(async ({ page }) => {
  test.skip(!EMAIL || !PASSWORD, "run via `bun run e2e` (seeds the user)");
  await signIn(page);
});

test("session header links to routines, and the builder, mid-workout", async ({
  page,
}) => {
  // Start an empty session.
  await page.getByTestId("start-session-btn").click();
  await expect(page).toHaveURL(/\/session\//);

  // An empty session auto-opens the exercise picker — dismiss it so the
  // sticky header is reachable (wait for it first: Escape before the dialog
  // mounts is a no-op).
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByTestId("session-routines-btn")).toBeVisible();

  // The routines page is reachable mid-workout…
  await page.getByTestId("session-routines-btn").click();
  await expect(page).toHaveURL(/\/routines$/);

  // …and from it the create-routine builder.
  await page.getByTestId("new-routine-btn").click();
  await expect(page).toHaveURL(/\/routines\/new/);

  // The session is still live, and the Training tab brings us straight back
  // to it (the pre-existing resume behavior is unchanged). Tab labels stay
  // collapsed to icons when inactive, so locate the link by its title.
  await page.getByTitle("Training").click();
  await expect(page).toHaveURL(/\/session\//);
});
