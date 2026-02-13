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

const scenesPayload = {
  items: [{ id: "scene1", name: "回家", description: "回家场景" }],
  count: 1
};

test.describe("automation editor", () => {
  test.beforeEach(async ({ page }) => {
    const automations: any[] = [];

    await page.route("**/api/devices", (route) => route.fulfill({ json: devicesPayload }));
    await page.route("**/api/scenes", (route) => route.fulfill({ json: scenesPayload }));

    await page.route("**/api/automations", async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        route.fulfill({ json: { items: automations, count: automations.length } });
        return;
      }
      if (method === "POST") {
        const body = JSON.parse(route.request().postData() || "{}");
        automations.push(body);
        route.fulfill({ json: body });
        return;
      }
      route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
    });

    await page.route("**/api/automations/*", async (route) => {
      const method = route.request().method();
      if (method !== "GET") {
        route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
        return;
      }
      const url = route.request().url();
      const id = decodeURIComponent(url.split("/api/automations/")[1] || "");
      const found = automations.find((a) => a.id === id);
      if (!found) {
        route.fulfill({ status: 404, json: { error: "automation_not_found" } });
        return;
      }
      route.fulfill({ json: found });
    });
  });

  test("can create a new automation that runs a scene", async ({ page }) => {
    await page.goto("/automations");
    await expect(page.getByTestId("automations-page")).toBeVisible();

    await page.getByTestId("automation-new").click();
    await page.getByTestId("automation-id").fill("auto1");

    await page.getByTestId("automation-add-scene-action").click();
    await expect(page.getByTestId("automation-action-0")).toBeVisible();

    await page.getByTestId("automation-save").click();
    await expect(page.getByTestId("automation-item-auto1")).toBeVisible();
  });
});
