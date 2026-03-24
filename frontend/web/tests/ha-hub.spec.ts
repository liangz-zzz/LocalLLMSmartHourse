import { expect, test, type Page } from "@playwright/test";

function integrationBase(pageUrl: string, port: number) {
  const url = new URL(pageUrl);
  url.port = String(port);
  return url.origin;
}

function trackHydrationErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (!text) return;
    errors.push(text);
  });
  return errors;
}

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
    const runtimeErrors = trackHydrationErrors(page);
    await page.goto("/ha-hub?floorplanId=floor1");
    await page.waitForTimeout(250);

    const haBase = integrationBase(page.url(), 8123);
    const z2mBase = integrationBase(page.url(), 8080);

    await expect(page.getByTestId("ha-hub-page")).toBeVisible();
    expect(runtimeErrors.join("\n")).not.toContain("Hydration failed");
    expect(runtimeErrors.join("\n")).not.toContain("Expected server HTML to contain a matching <a>");
    await expect(page.getByTestId("ha-root-link")).toHaveAttribute("href", haBase);
    await expect(page.getByTestId("z2m-root-link")).toHaveAttribute("href", z2mBase);
    await expect(page.getByTestId("ha-current-floorplan-name")).toContainText("一层");
    await expect(page.getByTestId("ha-floorplan-dashboard-link")).toHaveAttribute("href", `${haBase}/smarthouse-floor1`);
    await expect(page.getByTestId("ha-sync-status")).toContainText("Floors 1/0");
    await expect(page.getByTestId("ha-hub-link-scenes")).toHaveAttribute("href", `${haBase}/config/scene/dashboard`);
    await expect(page.getByTestId("ha-hub-link-automations")).toHaveAttribute("href", `${haBase}/config/automation/dashboard`);
  });
});
