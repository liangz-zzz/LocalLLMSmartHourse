import { expect, test } from "@playwright/test";

const devicesPayload = {
  items: [
    {
      id: "light1",
      name: "客厅灯",
      placement: { room: "living_room" },
      traits: { switch: { state: "off" } },
      capabilities: [{ action: "turn_on" }, { action: "turn_off" }]
    }
  ]
};

test.describe("scene editor", () => {
  test.beforeEach(async ({ page }) => {
    const scenes: any[] = [{ id: "scene1", name: "回家", description: "回家场景", steps: [] }];

    await page.route("**/api/devices", (route) => route.fulfill({ json: devicesPayload }));

    await page.route("**/api/scenes", async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        route.fulfill({ json: { items: scenes.map(({ id, name, description }) => ({ id, name, description })), count: scenes.length } });
        return;
      }
      if (method === "POST") {
        const body = JSON.parse(route.request().postData() || "{}");
        scenes.push(body);
        route.fulfill({ json: body });
        return;
      }
      route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
    });

    await page.route("**/api/scenes/*", async (route) => {
      const method = route.request().method();
      if (method !== "GET") {
        route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
        return;
      }
      const url = route.request().url();
      const id = decodeURIComponent(url.split("/api/scenes/")[1] || "");
      const found = scenes.find((s) => s.id === id);
      if (!found) {
        route.fulfill({ status: 404, json: { error: "scene_not_found" } });
        return;
      }
      route.fulfill({ json: found });
    });
  });

  test("can create a new scene with a device step", async ({ page }) => {
    await page.goto("/scenes");
    await expect(page.getByTestId("scenes-page")).toBeVisible();

    await page.getByTestId("scene-new").click();
    await page.getByTestId("scene-id").fill("sleep");
    await page.getByTestId("scene-name").fill("睡觉");

    await page.getByTestId("scene-add-device-step").click();
    await expect(page.getByTestId("scene-step-0")).toBeVisible();

    await page.getByTestId("scene-save").click();
    await expect(page.getByTestId("scene-item-sleep")).toBeVisible();
  });
});
