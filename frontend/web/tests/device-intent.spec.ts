import { expect, test } from "@playwright/test";

const devicesPayload = {
  items: [
    {
      id: "light1",
      name: "客厅灯",
      protocol: "zigbee",
      bindings: {
        ha: { entity_id: "light.living_room_main" },
        zigbee2mqtt: { topic: "zigbee2mqtt/light1" }
      },
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

const floorplansPayload = {
  items: [
    {
      id: "floor1",
      name: "一层",
      image: { url: "/assets/floorplans/floor1.png", width: 100, height: 80 },
      roomCount: 1,
      deviceCount: 1
    }
  ],
  count: 1
};

const floorplanDetail = {
  id: "floor1",
  name: "一层",
  image: { url: "/assets/floorplans/floor1.png", width: 100, height: 80 },
  rooms: [
    {
      id: "living",
      name: "客厅",
      polygon: [
        { x: 0.1, y: 0.1 },
        { x: 0.4, y: 0.1 },
        { x: 0.4, y: 0.4 }
      ]
    }
  ],
  devices: [{ deviceId: "light1", x: 0.2, y: 0.2, roomId: "living" }]
};

const scenesPayload = {
  items: [{ id: "scene1", name: "回家", description: "回家场景", scope: { floorplanIds: ["floor1"] } }],
  count: 1
};

test.describe("device dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/floorplans", (route) => route.fulfill({ json: floorplansPayload }));
    await page.route("**/api/floorplans/*", (route) => route.fulfill({ json: floorplanDetail }));
    await page.route("**/api/scenes*", (route) => route.fulfill({ json: scenesPayload }));
    await page.route("**/api/devices*", (route) => route.fulfill({ json: devicesPayload }));
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

  test("shows summary links and can parse and execute intent", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("home-page")).toBeVisible();
    await expect(page.getByTestId("current-floorplan-name")).toContainText("一层");
    await expect(page.getByTestId("summary-total-scenes")).toContainText("1");
    await expect(page.getByTestId("device-summary-card-light1")).toBeVisible();
    await expect(page.getByTestId("summary-ha-bound")).toContainText("1");
    await expect(page.getByTestId("device-open-ha-light1")).toHaveAttribute("href", "http://ha.local/history?entity_id=light.living_room_main");
    await expect(page.getByTestId("device-open-z2m-light1")).toHaveAttribute("href", "http://z2m.local");

    // intent parse + execute
    await page.getByTestId("intent-input").fill("打开客厅灯");
    await page.getByTestId("intent-parse").click();
    await expect(page.getByText("action=turn_on", { exact: false })).toBeVisible();
    await page.getByTestId("intent-exec").click();
    await expect(page.getByText("已下发")).toBeVisible();
  });
});
