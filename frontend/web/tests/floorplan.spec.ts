import { expect, test } from "@playwright/test";

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
    protocol: "zigbee",
    bindings: {
      ha: { entity_id: "light.living_room_main" },
      zigbee2mqtt: { topic: "zigbee2mqtt/light1" }
    },
    placement: { room: "living_room" },
    traits: { switch: { state: "off" } },
    capabilities: [{ action: "turn_on" }, { action: "turn_off" }]
  },
  {
    id: "plug1",
    name: "玄关插座",
    protocol: "zigbee",
    bindings: {
      ha: { entity_id: "switch.entry_plug" },
      zigbee2mqtt: { topic: "zigbee2mqtt/plug1" }
    },
    placement: { room: "entryway", zone: "north_wall" },
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

function buildFloorplanSummary(plan: any) {
  return {
    id: plan.id,
    name: plan.name,
    image: plan.image,
    model: plan.model,
    roomCount: Array.isArray(plan.rooms) ? plan.rooms.length : 0,
    deviceCount: Array.isArray(plan.devices) ? plan.devices.length : 0
  };
}

async function openFloorplanEditor(page: any, id = "floor1") {
  await page.goto("/floorplan");
  await page.getByTestId(`select-floorplan-${id}`).click();
  await expect(page.getByTestId("floorplan-stage-editor")).toBeVisible();
}

async function clickCanvasPoint(page: any, xRatio: number, yRatio: number) {
  const canvas = page.getByTestId("floorplan-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("floorplan canvas not visible");
  await canvas.dispatchEvent("pointerdown", {
    bubbles: true,
    clientX: box.x + box.width * xRatio,
    clientY: box.y + box.height * yRatio,
    pointerType: "mouse",
    isPrimary: true
  });
  await canvas.dispatchEvent("pointerup", {
    bubbles: true,
    clientX: box.x + box.width * xRatio,
    clientY: box.y + box.height * yRatio,
    pointerType: "mouse",
    isPrimary: true
  });
}

test.describe("floorplan editor", () => {
  test.beforeEach(async ({ page }) => {
    page.on("dialog", (dialog) => dialog.accept());

    const floorplanStore: Record<string, any> = {
      floor1: JSON.parse(JSON.stringify(floorplanDetail))
    };
    let floorplanOrder = ["floor1"];
    const devices = [...baseDevices];
    const deviceOverrides: Record<string, any> = {};
    const modelTemplates: any[] = JSON.parse(JSON.stringify(virtualModels));
    const virtualConfig: any = {
      enabled: true,
      defaults: { latency_ms: 120, failure_rate: 0 },
      devices: []
    };

    await page.route("**/api/floorplans", async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        route.fulfill({
          json: {
            items: floorplanOrder.map((id) => buildFloorplanSummary(floorplanStore[id])),
            count: floorplanOrder.length
          }
        });
        return;
      }
      if (method === "POST") {
        const body = JSON.parse(route.request().postData() || "{}");
        floorplanStore[body.id] = body;
        floorplanOrder = [...floorplanOrder, body.id];
        route.fulfill({ status: 200, json: body });
        return;
      }
      route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
    });
    await page.route("**/api/floorplans/*", async (route) => {
      const method = route.request().method();
      const url = route.request().url();
      const id = decodeURIComponent(url.split("/api/floorplans/")[1] || "");
      if (method === "GET") {
        const found = floorplanStore[id];
        route.fulfill(found ? { status: 200, json: found } : { status: 404, json: { error: "floorplan_not_found" } });
        return;
      }
      if (method === "PUT") {
        const body = JSON.parse(route.request().postData() || "{}");
        floorplanStore[id] = body;
        if (!floorplanOrder.includes(id)) floorplanOrder = [...floorplanOrder, id];
        route.fulfill({ status: 200, json: body });
        return;
      }
      if (method === "DELETE") {
        delete floorplanStore[id];
        floorplanOrder = floorplanOrder.filter((item) => item !== id);
        route.fulfill({ status: 200, json: { status: "deleted", removed: id } });
        return;
      }
      route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
    });
    await page.route("**/api/devices", (route) => route.fulfill({ json: { items: devices } }));
    await page.route("**/api/scenes", (route) => route.fulfill({ json: scenesPayload }));
    await page.route("**/api/scenes/scene1/expanded", (route) => route.fulfill({ json: expandedScene }));
    await page.route("**/api/assets", (route) =>
      route.fulfill({
        status: 200,
        json: {
          assetId: `asset_${Date.now()}`,
          url: "/assets/floorplans/uploaded.png",
          width: 100,
          height: 80,
          kind: "floorplan_image"
        }
      })
    );
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
    await page.route("**/api/device-overrides/*", (route) => {
      const url = route.request().url();
      const id = decodeURIComponent(url.split("/api/device-overrides/")[1] || "");
      if (route.request().method() === "GET") {
        if (!deviceOverrides[id]) {
          route.fulfill({ status: 404, json: { error: "device_override_not_found" } });
          return;
        }
        route.fulfill({ status: 200, json: deviceOverrides[id] });
        return;
      }
      if (route.request().method() === "PUT") {
        const body = JSON.parse(route.request().postData() || "{}");
        deviceOverrides[id] = body;
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

  test("loads browse stage, enters editor, zooms canvas, and toggles modes", async ({ page }) => {
    await page.goto("/floorplan");
    await expect(page.getByTestId("floorplan-page")).toBeVisible();
    await expect(page.getByTestId("floorplan-stage-browse")).toBeVisible();
    await expect(page.getByTestId("browse-select")).toBeVisible();
    await page.getByTestId("select-floorplan-floor1").click();
    await expect(page.getByTestId("floorplan-stage-editor")).toBeVisible();
    await expect(page.getByTestId("create-floorplan-form")).toHaveCount(0);

    await page.getByTestId("canvas-zoom-in").click();
    await expect
      .poll(async () =>
        page.getByTestId("canvas-scroll-region").evaluate((node) => node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight)
      )
      .toBe(true);

    await page.getByTestId("mode-devices").click();
    await expect(page.getByTestId("virtual-enabled")).toBeVisible();

    await page.getByTestId("mode-rooms").click();
    await expect(page.getByTestId("start-room-drawing")).toBeVisible();

    await page.getByTestId("mode-view").click();
    await page.getByTestId("scene-select").selectOption("scene1");
    await expect(page.getByText("开启")).toBeVisible();
    await page.getByTestId("scene-run").click();
    await expect(page.getByTestId("scene-run-status")).toContainText("status=ok");
  });

  test("can create a floorplan and enter editor directly", async ({ page }) => {
    await page.goto("/floorplan");
    await page.getByTestId("browse-create").click();
    await expect(page.getByTestId("create-floorplan-form")).toBeVisible();
    await page.getByPlaceholder("例如：一层").fill("二层");
    await page.getByTestId("create-floorplan-form").locator('input[type="file"]').first().setInputFiles({
      name: "floor2.png",
      mimeType: "image/png",
      buffer: Buffer.from(tinyPngBase64, "base64")
    });
    await page.getByRole("button", { name: "创建户型并进入编辑" }).click();
    await expect(page.getByTestId("floorplan-stage-editor")).toBeVisible();
    await expect(page.getByText("二层")).toBeVisible();
  });

  test("can delete current floorplan and return to browse stage", async ({ page }) => {
    await openFloorplanEditor(page);
    await page.getByTestId("delete-floorplan").click();
    await expect(page.getByTestId("floorplan-stage-browse")).toBeVisible();
    await expect(page.getByTestId("select-floorplan-floor1")).toHaveCount(0);
  });

  test("can undo room drawing points step by step", async ({ page }) => {
    await openFloorplanEditor(page);
    await page.getByTestId("mode-rooms").click();
    await page.getByTestId("start-room-drawing").click();
    await clickCanvasPoint(page, 0.2, 0.2);
    await expect(page.getByTestId("room-point-count")).toContainText("已选择 1 个点");
    await clickCanvasPoint(page, 0.45, 0.2);
    await expect(page.getByTestId("room-point-count")).toContainText("已选择 2 个点");
    await clickCanvasPoint(page, 0.45, 0.45);
    await expect(page.getByTestId("room-point-count")).toContainText("已选择 3 个点");
    await page.getByTestId("undo-room-point").click();
    await expect(page.getByTestId("room-point-count")).toContainText("已选择 2 个点");
    await page.getByTestId("undo-room-point").click();
    await expect(page.getByTestId("room-point-count")).toContainText("已选择 1 个点");
  });

  test("can define image scale and persist it after save", async ({ page }) => {
    await openFloorplanEditor(page);
    await page.getByTestId("start-image-scale").click();
    await clickCanvasPoint(page, 0.2, 0.25);
    await expect(page.getByTestId("scale-point-count")).toContainText("1/2");
    await clickCanvasPoint(page, 0.65, 0.25);
    await expect(page.getByTestId("scale-point-count")).toContainText("2/2");
    await page.getByTestId("image-scale-distance").fill("3.5");
    await page.getByTestId("image-scale-save").click();
    await expect(page.getByText("比例尺参考线 3.5 米")).toBeVisible();
    await page.getByTestId("save-floorplan").click();
    await page.getByTestId("back-to-browser").click();
    await page.getByTestId("select-floorplan-floor1").click();
    await expect(page.getByText("比例尺参考线 3.5 米")).toBeVisible();
  });

  test("can save device override from floorplan device panel", async ({ page }) => {
    await openFloorplanEditor(page);
    await page.getByTestId("mode-devices").click();
    await page.getByTestId("floorplan-device-light1").click();

    await expect(page.getByTestId("device-override-save")).toBeVisible();
    await page.getByPlaceholder("客厅灯").fill("客厅灯(测试)");
    await page.getByTestId("device-override-save").click();
    await expect(page.getByText("已保存（约 1~2 秒后生效）")).toBeVisible();
  });

  test("can place a real device from the placement list and see it on canvas", async ({ page }) => {
    await openFloorplanEditor(page);
    await page.getByTestId("mode-devices").click();
    await expect(page.getByTestId("start-place-plug1")).toBeVisible();
    await expect(page.getByTestId("placement-device-summary")).toContainText("待布点 1 个");
    await page.getByTestId("start-place-plug1").click();
    await expect(page.getByTestId("placing-device-banner")).toContainText("当前待放置：玄关插座");
    await clickCanvasPoint(page, 0.62, 0.48);
    await expect(page.getByTestId("floorplan-device-plug1")).toBeVisible();
    await expect(page.getByText("当前选中：玄关插座")).toBeVisible();
    await expect(page.getByTestId("placement-empty")).toBeVisible();
  });

  test("selected placed device exposes HA and Zigbee2MQTT links", async ({ page }) => {
    await openFloorplanEditor(page);
    await page.getByTestId("mode-devices").click();
    await page.getByTestId("floorplan-device-light1").click();
    await expect(page.getByTestId("floorplan-open-ha")).toHaveAttribute("href", "http://ha.local/history?entity_id=light.living_room_main");
    await expect(page.getByTestId("floorplan-open-z2m")).toHaveAttribute("href", "http://z2m.local");
  });

  test("can place a device inside an already defined room area", async ({ page }) => {
    await openFloorplanEditor(page);
    await page.getByTestId("mode-rooms").click();
    await page.getByTestId("start-room-drawing").click();
    await clickCanvasPoint(page, 0.2, 0.2);
    await clickCanvasPoint(page, 0.5, 0.2);
    await clickCanvasPoint(page, 0.5, 0.5);
    await clickCanvasPoint(page, 0.2, 0.5);
    await page.getByRole("button", { name: "完成房间" }).click();

    await page.getByTestId("mode-devices").click();
    await page.getByTestId("start-place-plug1").click();
    await clickCanvasPoint(page, 0.32, 0.32);

    await expect(page.getByTestId("floorplan-device-plug1")).toBeVisible();
    await expect(page.getByText("当前选中：玄关插座")).toBeVisible();
  });

  test("can create simulated device in floorplan editor", async ({ page }) => {
    await openFloorplanEditor(page);
    await page.getByTestId("mode-devices").click();
    await page.getByTestId("virtual-model-select").selectOption("light.dimmer.v1");
    await page.getByTestId("virtual-new").click();
    await expect(page.getByTestId("virtual-actions")).toHaveValue("turn_on, turn_off, set_brightness");
    await page.getByTestId("virtual-id").fill("sim_light_lr");
    await page.getByTestId("virtual-save").click();
    await page.getByTestId("virtual-select").selectOption("sim_light_lr");
    await expect(page.getByTestId("virtual-id")).toHaveValue("sim_light_lr");
  });

  test("new simulated device can be saved into placement list from step 2", async ({ page }) => {
    await openFloorplanEditor(page);
    await page.getByTestId("mode-devices").click();
    await page.getByTestId("virtual-model-select").selectOption("light.dimmer.v1");
    await page.getByTestId("virtual-new").click();
    await page.getByTestId("virtual-id").fill("sim_step2_list");
    await expect(page.getByTestId("pending-virtual-placement-card")).toBeVisible();
    await page.getByTestId("virtual-save-to-placement").click();
    await expect(page.getByTestId("start-place-sim_step2_list")).toBeVisible();
  });

  test("can save a simulated device and enter placement mode immediately", async ({ page }) => {
    await openFloorplanEditor(page);
    await page.getByTestId("mode-devices").click();
    await page.getByTestId("virtual-model-select").selectOption("light.dimmer.v1");
    await page.getByTestId("virtual-new").click();
    await page.getByTestId("virtual-id").fill("sim_light_entry");
    await page.getByTestId("virtual-save-and-place").click();
    await expect(page.getByTestId("placing-device-banner")).toContainText("当前待放置：可调光灯");
    await clickCanvasPoint(page, 0.52, 0.55);
    await expect(page.getByTestId("floorplan-device-sim_light_entry")).toBeVisible();
    await expect(page.getByText("当前选中：可调光灯")).toBeVisible();
  });

  test("can manage virtual model templates in floorplan editor", async ({ page }) => {
    await openFloorplanEditor(page);
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
