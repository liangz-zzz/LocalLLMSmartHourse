import { expect, test } from "@playwright/test";

const floorplanList = {
  items: [
    {
      id: "floor1",
      name: "一层",
      image: { url: "/assets/floorplans/floor1.png", width: 100, height: 80 }
    }
  ],
  count: 1
};

const floorplanDetail = {
  id: "floor1",
  name: "一层",
  image: { url: "/assets/floorplans/floor1.png", width: 100, height: 80 },
  rooms: [],
  devices: [{ deviceId: "light1", x: 0.2, y: 0.2, height: 1, rotation: 0, scale: 1 }]
};

const baseDevices = [
  {
    id: "light1",
    name: "客厅灯",
    placement: { room: "living_room" },
    traits: { switch: { state: "off" } },
    capabilities: [{ action: "turn_on" }, { action: "turn_off" }]
  }
];

const scenesPayload = {
  items: [{ id: "scene1", name: "回家", description: "回家场景" }],
  count: 1
};

const virtualModels = [
  {
    id: "plug.switch.v1",
    name: "智能插座（开关）",
    traits: { switch: { state: "off" } },
    capabilities: [{ action: "turn_on" }, { action: "turn_off" }]
  },
  {
    id: "light.dimmer.v1",
    name: "可调光灯",
    traits: { switch: { state: "off" }, dimmer: { state: "off", brightness: 0 } },
    capabilities: [
      { action: "turn_on" },
      { action: "turn_off" },
      {
        action: "set_brightness",
        parameters: [{ name: "brightness", type: "number", minimum: 0, maximum: 100, required: true }]
      }
    ]
  }
];

const expandedScene = {
  id: "scene1",
  steps: [{ type: "device", deviceId: "light1", action: "turn_on", params: {} }],
  count: 1
};

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAJk3nSAAAAAASUVORK5CYII=";

test.describe("floorplan editor", () => {
  test.beforeEach(async ({ page }) => {
    const devices = [...baseDevices];
    const modelTemplates: any[] = JSON.parse(JSON.stringify(virtualModels));
    const virtualConfig: any = {
      enabled: true,
      defaults: { latency_ms: 120, failure_rate: 0 },
      devices: []
    };

    await page.route("**/api/floorplans", (route) => route.fulfill({ json: floorplanList }));
    await page.route("**/api/floorplans/floor1", (route) => route.fulfill({ json: floorplanDetail }));
    await page.route("**/api/devices", (route) => route.fulfill({ json: { items: devices } }));
    await page.route("**/api/scenes", (route) => route.fulfill({ json: scenesPayload }));
    await page.route("**/api/scenes/scene1/expanded", (route) => route.fulfill({ json: expandedScene }));
    await page.route("**/api/virtual-devices/models", (route) =>
      route.fulfill({
        status: 200,
        json: { items: modelTemplates, count: modelTemplates.length }
      })
    );
    await page.route("**/api/virtual-devices/models/*", (route) => {
      const method = route.request().method();
      const url = route.request().url();
      const modelId = decodeURIComponent(url.split("/api/virtual-devices/models/")[1] || "");
      if (method === "PUT") {
        const body = JSON.parse(route.request().postData() || "{}");
        const index = modelTemplates.findIndex((item: any) => item.id === modelId);
        if (index >= 0) modelTemplates[index] = body;
        else modelTemplates.push(body);
        route.fulfill({ status: 200, json: body });
        return;
      }
      if (method === "DELETE") {
        const index = modelTemplates.findIndex((item: any) => item.id === modelId);
        if (index >= 0) modelTemplates.splice(index, 1);
        route.fulfill({ status: 200, json: { status: "deleted", removed: modelId } });
        return;
      }
      route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
    });
    await page.route("**/api/scenes/scene1/run", (route) =>
      route.fulfill({
        json: {
          runId: "scene_run_test_1",
          sceneId: "scene1",
          status: "ok",
          durationMs: 22,
          steps: [{ index: 0, deviceId: "light1", action: "turn_on", status: "ok" }]
        }
      })
    );
    await page.route("**/api/virtual-devices/config", (route) => {
      if (route.request().method() === "GET") {
        route.fulfill({ status: 200, json: virtualConfig });
        return;
      }
      if (route.request().method() === "PUT") {
        const body = JSON.parse(route.request().postData() || "{}");
        if (typeof body.enabled === "boolean") virtualConfig.enabled = body.enabled;
        if (body.defaults && typeof body.defaults === "object") {
          virtualConfig.defaults = { ...virtualConfig.defaults, ...body.defaults };
        }
        route.fulfill({ status: 200, json: virtualConfig });
        return;
      }
      route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
    });
    await page.route("**/api/virtual-devices/*", (route) => {
      const method = route.request().method();
      const url = route.request().url();
      const id = decodeURIComponent(url.split("/api/virtual-devices/")[1] || "");
      if (id === "models" && method === "GET") {
        route.fulfill({ status: 200, json: { items: modelTemplates, count: modelTemplates.length } });
        return;
      }
      if (id === "config") {
        if (method === "GET") {
          route.fulfill({ status: 200, json: virtualConfig });
          return;
        }
        if (method === "PUT") {
          const body = JSON.parse(route.request().postData() || "{}");
          if (typeof body.enabled === "boolean") virtualConfig.enabled = body.enabled;
          if (body.defaults && typeof body.defaults === "object") {
            virtualConfig.defaults = { ...virtualConfig.defaults, ...body.defaults };
          }
          route.fulfill({ status: 200, json: virtualConfig });
          return;
        }
      }
      if (method === "PUT") {
        const body = JSON.parse(route.request().postData() || "{}");
        const index = virtualConfig.devices.findIndex((item: any) => item.id === id);
        if (index >= 0) virtualConfig.devices[index] = body;
        else virtualConfig.devices.push(body);
        const existingIndex = devices.findIndex((item: any) => item.id === id);
        const asDevice = {
          id: body.id,
          name: body.name,
          placement: body.placement || {},
          traits: body.traits || {},
          capabilities: body.capabilities || []
        };
        if (existingIndex >= 0) devices[existingIndex] = asDevice;
        else devices.push(asDevice);
        route.fulfill({ status: 200, json: body });
        return;
      }
      if (method === "DELETE") {
        virtualConfig.devices = virtualConfig.devices.filter((item: any) => item.id !== id);
        const existingIndex = devices.findIndex((item: any) => item.id === id);
        if (existingIndex >= 0) devices.splice(existingIndex, 1);
        route.fulfill({ status: 200, json: { status: "deleted", removed: id } });
        return;
      }
      route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
    });
    await page.route("**/api/device-overrides/light1", (route) => {
      if (route.request().method() === "GET") {
        route.fulfill({ status: 404, json: { error: "device_override_not_found" } });
        return;
      }
      if (route.request().method() === "PUT") {
        const body = JSON.parse(route.request().postData() || "{}");
        route.fulfill({ status: 200, json: body });
        return;
      }
      route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
    });
    await page.route("**/api/assets/**", (route) =>
      route.fulfill({
        status: 200,
        headers: { "Content-Type": "image/png" },
        body: Buffer.from(tinyPngBase64, "base64")
      })
    );
  });

  test("loads floorplan and toggles modes", async ({ page }) => {
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto("/floorplan");
    await expect(page.getByTestId("floorplan-page")).toBeVisible();
    await expect(page.getByText("一层")).toBeVisible();

    await page.getByTestId("mode-devices").click();
    await expect(page.getByTestId("virtual-enabled")).toBeVisible();

    await page.getByTestId("mode-rooms").click();
    await expect(page.getByText("新建房间")).toBeVisible();

    await page.getByTestId("mode-view").click();
    await page.getByTestId("scene-select").selectOption("scene1");
    await expect(page.getByText("开启")).toBeVisible();
    await page.getByTestId("scene-run").click();
    await expect(page.getByTestId("scene-run-status")).toContainText("status=ok");
  });

  test("can save device override from floorplan device panel", async ({ page }) => {
    await page.goto("/floorplan");
    await page.getByTestId("mode-devices").click();
    await page.getByTestId("floorplan-device-light1").click();

    await expect(page.getByTestId("device-override-save")).toBeVisible();
    await page.getByPlaceholder("客厅灯").fill("客厅灯(测试)");
    await page.getByTestId("device-override-save").click();
    await expect(page.getByText("已保存（约 1~2 秒后生效）")).toBeVisible();
  });

  test("can create simulated device in floorplan editor", async ({ page }) => {
    await page.goto("/floorplan");
    await page.getByTestId("mode-devices").click();
    await page.getByTestId("virtual-model-select").selectOption("light.dimmer.v1");
    await page.getByTestId("virtual-new").click();
    await expect(page.getByTestId("virtual-actions")).toHaveValue("turn_on, turn_off, set_brightness");
    await page.getByTestId("virtual-id").fill("sim_light_lr");
    await page.getByTestId("virtual-save").click();
    await page.getByTestId("virtual-select").selectOption("sim_light_lr");
    await expect(page.getByTestId("virtual-id")).toHaveValue("sim_light_lr");
  });

  test("can manage virtual model templates in floorplan editor", async ({ page }) => {
    await page.goto("/floorplan");
    await page.getByTestId("mode-devices").click();
    await page.getByTestId("virtual-model-new").click();
    await page.getByTestId("virtual-model-id").fill("light.rgb.v1");
    await page.getByTestId("virtual-model-actions").fill("turn_on, turn_off, set_color");
    await page.getByTestId("virtual-model-traits").fill(`{"switch":{"state":"off"},"color":{"r":255,"g":255,"b":255}}`);
    await page.getByTestId("virtual-model-save").click();

    await expect(page.getByTestId("virtual-model-edit-select").locator('option[value="light.rgb.v1"]')).toHaveCount(1);
    await page.getByTestId("virtual-model-select").selectOption("light.rgb.v1");
    await page.getByTestId("virtual-new").click();
    await expect(page.getByTestId("virtual-actions")).toHaveValue("turn_on, turn_off, set_color");
  });
});
