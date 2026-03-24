import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFloorplanDashboardConfig,
  buildGeneratedSceneEntries,
  buildGeneratedScriptEntries,
  buildManagedDashboardUrlPath,
  mergeManagedNamedEntries,
  mergeManagedSceneList
} from "../src/ha-sync.js";

const devices = [
  {
    id: "light1",
    name: "客厅灯",
    protocol: "zigbee",
    bindings: { ha: { entity_id: "light.living_room_main" } },
    capabilities: [{ action: "turn_on" }, { action: "turn_off" }]
  }
];

const floorplan = {
  id: "Floor 1",
  name: "一层",
  image: { url: "/assets/floorplans/floor1.png" },
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

test("ha sync builds stable dashboard path", () => {
  assert.equal(buildManagedDashboardUrlPath("Floor 1"), "smarthouse-floor-1");
});

test("ha sync exports simple scenes and delegates complex scenes to scripts", () => {
  const scenes = [
    {
      id: "welcome_home",
      name: "欢迎回家",
      description: "简单场景",
      scope: { floorplanIds: ["floor1"] },
      steps: [{ type: "device", deviceId: "light1", action: "turn_on", params: {} }]
    },
    {
      id: "sleep_mode",
      name: "睡眠模式",
      description: "复杂场景",
      scope: { floorplanIds: ["floor1"] },
      steps: [
        {
          type: "device",
          deviceId: "light1",
          action: "turn_off",
          params: {},
          wait_for: {
            traitPath: "traits.switch.state",
            operator: "eq",
            value: "off",
            timeoutMs: 1000
          }
        }
      ]
    }
  ];

  const generatedScenes = buildGeneratedSceneEntries({ scenes, devices });
  const generatedScripts = buildGeneratedScriptEntries({ scenes });

  assert.equal(generatedScenes.length, 1);
  assert.equal(generatedScenes[0].id, "smarthouse__welcome_home");
  assert.equal(Object.keys(generatedScripts).length, 1);
  assert.ok(generatedScripts.smarthouse__sleep_mode);
  assert.equal(generatedScripts.smarthouse__sleep_mode.sequence[0].service, "rest_command.smarthouse_scene_run");
});

test("ha sync merges generated yaml while preserving user entries", () => {
  const mergedScenes = mergeManagedSceneList(
    [
      { id: "manual_scene", name: "手工场景" },
      { id: "smarthouse__old_scene", name: "旧生成场景" }
    ],
    [{ id: "smarthouse__new_scene", name: "新生成场景" }]
  );
  const mergedScripts = mergeManagedNamedEntries(
    {
      manual_script: { alias: "手工脚本" },
      smarthouse__old_script: { alias: "旧生成脚本" }
    },
    {
      smarthouse__new_script: { alias: "新生成脚本" }
    },
    "scripts.yaml"
  );

  assert.deepEqual(
    mergedScenes.map((item) => item.id),
    ["manual_scene", "smarthouse__new_scene"]
  );
  assert.deepEqual(Object.keys(mergedScripts), ["manual_script", "smarthouse__new_script"]);
});

test("ha sync dashboard config includes floorplan image, entities, and scene buttons", () => {
  const scenes = [
    {
      id: "welcome_home",
      name: "欢迎回家",
      description: "简单场景",
      scope: { floorplanIds: ["Floor 1"] },
      steps: [{ type: "device", deviceId: "light1", action: "turn_on", params: {} }]
    }
  ];

  const exportOutcome = {
    sceneEntityIdsBySceneId: {
      welcome_home: "scene.smarthouse__welcome_home"
    },
    scriptEntityIdsBySceneId: {}
  };
  const config = buildFloorplanDashboardConfig({
    floorplan,
    devices,
    scenes,
    publicApiBaseUrl: "http://localhost:4000",
    exportOutcome
  });

  assert.equal(config.views.length, 1);
  assert.equal(config.views[0].cards[0].image, "http://localhost:4000/assets/floorplans/floor1.png");
  assert.ok(config.views[0].cards.some((card) => card.type === "entities"));
  assert.ok(config.views[0].cards.some((card) => card.title === "场景 / Scenes"));
});
