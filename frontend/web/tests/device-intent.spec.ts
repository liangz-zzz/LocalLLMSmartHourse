import { expect, test } from "@playwright/test";

const devicesPayload = {
  items: [
    {
      id: "light1",
      name: "客厅灯",
      placement: { room: "living_room" },
      traits: { switch: { state: "off" } },
      capabilities: [
        { action: "turn_on" },
        { action: "turn_off" },
        { action: "set_brightness", parameters: [{ name: "brightness", type: "number", minimum: 0, maximum: 100 }] }
      ]
    }
  ]
};

test.describe("device dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/devices", (route) => route.fulfill({ json: devicesPayload }));
    await page.route("**/api/devices/light1/actions", (route) => {
      // echo back request for assertion
      route.fulfill({ json: { status: "queued", received: JSON.parse(route.request().postData() || "{}") } });
    });
    await page.route("**/api/intent", (route) =>
      route.fulfill({
        json: { intent: { action: "turn_on", deviceId: "light1", confidence: 0.9, summary: "action=turn_on | device=light1" } }
      })
    );
  });

  test("can trigger quick action and param action, parse and execute intent", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("device-card-light1")).toBeVisible();

    // quick action
    await page.getByTestId("quick-light1-turn_on").click();
    await expect(page.getByText("queued", { exact: false })).toBeVisible();

    // param action
    await page.getByTestId("param-light1-set_brightness-brightness").fill("30");
    await page.getByTestId("send-light1-set_brightness").click();
    await expect(page.getByText("queued", { exact: false })).toBeVisible();

    // intent parse + execute
    await page.getByTestId("intent-input").fill("打开客厅灯");
    await page.getByTestId("intent-parse").click();
    await expect(page.getByText("action=turn_on", { exact: false })).toBeVisible();
    await page.getByTestId("intent-exec").click();
    await expect(page.getByText("已下发")).toBeVisible();
  });
});
