import { expect, test } from "@playwright/test";

test.describe("HA Hub", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/floorplans", (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: "floor1",
              name: "一层",
              image: { url: "/assets/floorplans/floor1.png" },
              roomCount: 1,
              deviceCount: 1
            }
          ],
          count: 1
        }
      })
    );
    await page.route("**/api/ha/sync", (route) =>
      route.fulfill({
        json: {
          enabled: true,
          running: false,
          lastSuccessAt: "2026-03-19T12:00:00.000Z",
          lastReport: {
            ok: true,
            counts: {
              floorsCreated: 1,
              floorsUpdated: 0,
              areasCreated: 1,
              areasUpdated: 0,
              dashboardsCreated: 1,
              dashboardsUpdated: 0
            }
          }
        }
      })
    );
  });

  test("renders configured HA entries with current floorplan mirror link", async ({ page }) => {
    await page.goto("/ha-hub?floorplanId=floor1");

    await expect(page.getByTestId("ha-hub-page")).toBeVisible();
    await expect(page.getByTestId("ha-root-link")).toHaveAttribute("href", "http://ha.local");
    await expect(page.getByTestId("z2m-root-link")).toHaveAttribute("href", "http://z2m.local");
    await expect(page.getByTestId("ha-current-floorplan-name")).toContainText("一层");
    await expect(page.getByTestId("ha-floorplan-dashboard-link")).toHaveAttribute("href", "http://ha.local/smarthouse-floor1");
    await expect(page.getByTestId("ha-sync-status")).toContainText("Floors 1/0");
    await expect(page.getByTestId("ha-hub-link-scenes")).toHaveAttribute("href", "http://ha.local/config/scene/dashboard");
    await expect(page.getByTestId("ha-hub-link-automations")).toHaveAttribute("href", "http://ha.local/config/automation/dashboard");
  });
});
