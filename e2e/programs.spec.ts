import { expect, type Page, test } from "@playwright/test";
import { EMAIL, PASSWORD, signIn } from "./helpers";

// M11 program library: open a curated catalog program, save it, and confirm it
// lands as a folder of routines on the Routines page plus an active `programs`
// row.

test.beforeEach(async ({ page }) => {
  test.skip(!EMAIL || !PASSWORD, "run via `bun run e2e` (seeds the user)");
  await signIn(page);
});

async function count(page: Page, sql: () => Promise<number>): Promise<number> {
  return page.evaluate(sql);
}

test("save a catalog program creates a named folder + routines + program row", async ({
  page,
}) => {
  await page.goto("/programs");

  // Filter chips narrow the list.
  await page.getByTestId("filter-level-beginner").click();
  await expect(
    page.getByTestId("program-card-full-body-foundations"),
  ).toBeVisible();

  await page.getByTestId("program-card-full-body-foundations").click();
  await expect(page).toHaveURL(/\/programs\/full-body-foundations$/);

  // Save enables once the exercise library (and thus the preview) has loaded.
  const save = page.getByTestId("save-program-btn");
  await expect(save).toBeEnabled();
  await save.click();

  // Lands on the Routines page with the program's folder.
  await expect(page).toHaveURL(/\/routines$/);
  await expect(
    page.getByTestId("folder-Full Body Foundations").first(),
  ).toBeVisible();

  // Server-side: an active library program tied to a folder of routines.
  const programs = await count(page, async () => {
    const { count } = await window.__frog.supabase
      .from("programs")
      .select("id", { count: "exact", head: true })
      .eq("source", "library")
      .eq("active", true)
      .is("deleted_at", null);
    return count ?? 0;
  });
  expect(programs).toBeGreaterThan(0);

  const routines = await page.evaluate(async () => {
    const s = window.__frog.supabase;
    const f = await s
      .from("routine_folders")
      .select("id")
      .eq("name", "Full Body Foundations")
      .is("deleted_at", null)
      // Newest first: saving the same catalog program twice is legal, and this
      // test is about the folder it just created, not an older namesake.
      .order("created_at", { ascending: false })
      .limit(1);
    const folderId = f.data?.[0]?.id as string | undefined;
    if (!folderId) return 0;
    const { count } = await s
      .from("routines")
      .select("id", { count: "exact", head: true })
      .eq("folder_id", folderId)
      .is("deleted_at", null);
    return count ?? 0;
  });
  expect(routines).toBeGreaterThan(0);

  // Saving a program re-aims the Home hero at that program's rotation — day
  // one of it, named, rather than a generic Start. A live session deliberately
  // outranks any plan there, so bin one left by an earlier spec first.
  await page.evaluate(async () => {
    const now = Date.now();
    await window.__frog.supabase
      .from("sessions")
      .update({ deleted_at: now, updated_at: now })
      .is("deleted_at", null)
      .is("ended_at", null);
  });
  await page.goto("/");
  const hero = page.getByTestId("home-hero");
  await expect(hero).toContainText("Next in Full Body Foundations");
  await expect(page.getByTestId("hero-plan-name")).not.toBeEmpty();
});
