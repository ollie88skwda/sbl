import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// Dev click-to-comment overlay (apps/web/src/dev/annotate/). It ships in this
// build for the same reason the __frog auth bridge does: `bun run e2e` builds
// with VITE_E2E=1, which is not a production artifact. scripts/check-bundle.ts
// fails a real production build on either marker.

const COMMENT = "Make this the primary action and move it above the folders.";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("annotate a live element, copy the payload, restore normal clicks", async ({
  page,
}) => {
  const toggle = page.getByTestId("annotate-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  // Keyboard shortcut toggles the mode (touch users get the button below).
  await page.keyboard.press("a");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("a");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  // Clicking a real button annotates it instead of firing it: the composer
  // opens and no session was started.
  await page.getByTestId("start-session-btn").click();
  await expect(page.getByTestId("annotate-composer")).toBeVisible();
  await expect(page).toHaveURL(/\/train$/);
  await expect(page.getByTestId("annotate-highlight")).toBeVisible();
  // The identity is resolved from the DOM, not from any per-component wiring.
  await expect(page.getByTestId("annotate-composer-target")).toContainText(
    "apps/web/src/screens/train.tsx",
  );

  await page.getByTestId("annotate-comment").fill(COMMENT);
  await page.getByTestId("annotate-save").click();
  await expect(page.getByTestId("annotate-composer")).toBeHidden();
  await expect(page.getByTestId("annotate-list-btn")).toHaveText("1 note");

  // Copy all → plain markdown on the clipboard, carrying every identity field.
  await page.getByTestId("annotate-list-btn").click();
  await page.getByTestId("annotate-copy").click();
  await expect(page.getByTestId("annotate-status")).toContainText("Copied");

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("UI feedback — 1 note");
  expect(copied).toMatch(
    /- Source: apps\/web\/src\/screens\/train\.tsx:\d+:\d+/,
  );
  expect(copied).toContain("- Component:");
  expect(copied).toContain("- Test id: `start-session-btn`");
  expect(copied).toContain("- Selector: `");
  expect(copied).toContain("- Route: `/train`");
  expect(copied).toMatch(/- Viewport: \d+×\d+/);
  expect(copied).toContain(COMMENT);

  // Copy is not destructive.
  await expect(page.getByTestId("annotate-list-btn")).toHaveText("1 note");

  // Notes survive a reload; the mode itself starts off again.
  await page.reload();
  await expect(page.getByTestId("annotate-list-btn")).toHaveText("1 note");
  await expect(page.getByTestId("annotate-toggle")).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  // With the mode off, the same button behaves exactly as before.
  await page.getByTestId("start-session-btn").click();
  await expect(page).toHaveURL(/\/session\//);
});

test("notes can be edited and cleared before sending", async ({ page }) => {
  await page.goto("/routines");
  await page.getByTestId("annotate-toggle").click();
  await page.getByTestId("new-routine-btn").click();
  await page.getByTestId("annotate-comment").fill("first draft");
  await page.getByTestId("annotate-save").click();

  await page.getByTestId("annotate-list-btn").click();
  await expect(page.getByTestId("annotate-note-0")).toContainText(
    "first draft",
  );

  await page.getByTestId("annotate-note-0-edit").click();
  await page.getByTestId("annotate-note-0-input").fill("revised wording");
  await page.getByTestId("annotate-note-0-save").click();
  await expect(page.getByTestId("annotate-note-0")).toContainText(
    "revised wording",
  );

  const copied = await page.evaluate(async () => {
    const w = window as unknown as { __frogAnnotate: { markdown(): string } };
    return w.__frogAnnotate.markdown();
  });
  expect(copied).toContain("revised wording");
  expect(copied).not.toContain("first draft");

  // Clearing is explicit and armed — never a side effect of copying.
  await page.getByTestId("annotate-clear").click();
  await page.getByTestId("annotate-clear-confirm").click();
  await expect(page.getByTestId("annotate-list-btn")).toHaveText("0 notes");
  // With nothing to review, the floating control collapses to the small
  // chip (its footprint stays clear of app controls like the finish sheet's
  // Discard) — and the empty list survives the reload.
  await page.reload();
  await expect(page.getByTestId("annotate-toggle")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.getByTestId("annotate-list-btn")).toBeHidden();
  await page.getByTestId("annotate-toggle").click();
  await expect(page.getByTestId("annotate-list-btn")).toHaveText("0 notes");
});

test("bare letters never navigate; the dev-only bare `a` toggles annotate, exempting text entry", async ({
  page,
}) => {
  // Regression guard for the 2026-08-07 removal of the app's bare single-key
  // shortcuts (`s`/`l`/`h`/`f` on app-shell.tsx, `a`/`e` on session.tsx): none
  // of them should navigate or open anything, with or without annotate mode on.
  // The dev-only annotate overlay is the one exception to that removal
  // (2026-08-08): a bare `a` toggles it, and text entry is exempted so typing
  // the letter never flips the mode.
  for (const key of ["h", "l", "f", "s"]) {
    await page.keyboard.press(key);
  }
  // Give a navigation every chance to happen before asserting it didn't.
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/train$/);

  await page.getByTestId("annotate-toggle").click();
  await expect(page.getByTestId("annotate-toggle")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  for (const key of ["h", "l", "f", "s"]) {
    await page.keyboard.press(key);
  }
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/train$/);

  // Bare `a` toggles the mode, same key exits.
  await page.keyboard.press("a");
  await expect(page.getByTestId("annotate-toggle")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.keyboard.press("a");
  await expect(page.getByTestId("annotate-toggle")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Modifier combos never toggle — Ctrl+A is select-all in every app.
  await page.keyboard.press("Control+A");
  await expect(page.getByTestId("annotate-toggle")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Typing `a` while focused in a text input never toggles, mode on or off.
  await page.keyboard.press("a"); // exit the mode first (focus is on the body)
  await expect(page.getByTestId("annotate-toggle")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.getByTestId("exercises-link").click();
  await expect(page).toHaveURL(/\/library$/);
  const search = page.getByTestId("exercise-search-input");
  await search.pressSequentially("abacus"); // each `a` here must not toggle
  await expect(search).toHaveValue("abacus");
  await expect(page.getByTestId("annotate-toggle")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.getByTestId("annotate-toggle").click(); // mode on, still in the input
  await search.focus();
  await page.keyboard.press("a");
  await expect(page.getByTestId("annotate-toggle")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
