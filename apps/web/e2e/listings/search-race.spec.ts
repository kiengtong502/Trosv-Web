import { expect, test } from "@playwright/test";
import type { Listing } from "../../src/shared/types/api";

const API = "http://localhost:8000/api";

for (const mobile of [false, true]) {
  test(`map includes rooms beyond the first 50 on ${mobile ? "mobile" : "desktop"}`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const fixture = await request.get(`${API}/listings?per_page=1`);
    expect(fixture.ok()).toBe(true);
    const { data } = (await fixture.json()) as { data: Listing[] };
    expect(data.length).toBeGreaterThan(0);
    const rooms = Array.from({ length: 61 }, (_, index): Listing => ({
      ...data[0]!,
      id: 1001 + index,
      title: index === 60 ? "Beyond room 50" : `Map fixture ${String(index + 1)}`,
      latitude: index === 60 ? 10.9 : 10.77,
      longitude: index === 60 ? 106.9 : 106.66,
    }));
    const mapPages: number[] = [];
    await page.route(/\/api\/listings(?:\?|$)/, async (route) => {
      const params = new URL(route.request().url()).searchParams;
      const currentPage = Number(params.get("page") || 1);
      const perPage = Number(params.get("per_page") || 12);
      if (perPage === 50) mapPages.push(currentPage);
      await route.fulfill({
        json: {
          data: rooms.slice((currentPage - 1) * perPage, currentPage * perPage),
          meta: {
            current_page: currentPage,
            last_page: Math.ceil(rooms.length / perPage),
            total: rooms.length,
            per_page: perPage,
          },
        },
      });
    });
    await page.goto("/rooms");
    if (mobile) await page.getByRole("button", { name: "Xem bản đồ", exact: true }).last().click();
    const pin = page.getByTestId("map-pane").locator('.trosv-pin[aria-label*="Beyond room 50"]');
    await expect(pin).toBeVisible();
    expect(mapPages).toContain(2);
    if (mobile)
      await page.getByRole("button", { name: "Xem danh sách", exact: true }).last().click();
    await page.getByRole("button", { name: "Trang cuối", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Beyond room 50", exact: true })).toBeVisible();
    if (mobile) await page.getByRole("button", { name: "Xem bản đồ", exact: true }).last().click();
    await expect(pin).toBeVisible();
  });
}

test("late search responses cannot replace the latest room list or map", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const fixture = await request.get(`${API}/listings?per_page=1`);
  expect(fixture.ok()).toBe(true);
  const { data } = (await fixture.json()) as { data: Listing[] };
  expect(data.length).toBeGreaterThan(0);
  const room = (id: number, title: string): Listing => ({
    ...data[0]!,
    id,
    title,
    latitude: 10.77 + id / 100000,
    longitude: 106.66,
  });
  let releaseOld!: () => void;
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let oldRequests = 0;
  let oldResponses = 0;
  await page.route(/\/api\/listings(?:\?|$)/, async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    if (query === "race-old") {
      oldRequests += 1;
      await oldGate;
    }
    const rows =
      query === "race-old"
        ? [room(100, "Old result"), room(200, "Another old result")]
        : [room(300, query === "race-new" ? "Latest result" : "Initial result")];
    await route.fulfill({
      json: {
        data: rows,
        meta: {
          current_page: 1,
          last_page: 1,
          total: rows.length,
          per_page: 12,
        },
      },
    });
    if (query === "race-old") oldResponses += 1;
  });
  await page.goto("/rooms");
  await expect(page.getByRole("heading", { name: "Initial result", exact: true })).toBeVisible();
  const input = page.getByLabel("Tìm theo khu vực", { exact: true });
  await input.fill("race-old");
  await expect.poll(() => oldRequests).toBe(2);
  await input.fill("race-new");
  await expect(page.getByRole("heading", { name: "Latest result", exact: true })).toBeVisible();
  releaseOld();
  await expect.poll(() => oldResponses).toBe(2);
  // Wait until Axios/React have had a turn to process both old responses.
  await page.waitForTimeout(100);
  await expect(input).toHaveValue("race-new");
  await expect(page.getByRole("heading", { name: "Latest result", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Old result", exact: true })).toHaveCount(0);
  await expect(page.locator(".trosv-pin-wrap")).toHaveCount(1);
});
