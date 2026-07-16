import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFloorplanCoordinateMap,
  buildFloorplanPlacementMap,
  calculateFloorplanDeviceCoordinates,
  getFloorplanScaleMetrics
} from "../src/floorplan-coordinates.js";

test("floorplan scale converts normalized image positions to meters", () => {
  const plan = {
    id: "floor1",
    image: { width: 1000, height: 500 },
    imageScale: {
      points: [
        { x: 0.1, y: 0.2 },
        { x: 0.4, y: 0.6 }
      ],
      distanceMeters: 5
    }
  };

  const metrics = getFloorplanScaleMetrics(plan);
  assert.ok(metrics);
  assert.equal(metrics.pixelDistance, Math.hypot(300, 200));

  const coordinates = calculateFloorplanDeviceCoordinates(plan, { x: 0.5, y: 0.25, height: 1.3 });
  assert.ok(coordinates);
  assert.ok(Math.abs(coordinates.x - 500 * metrics.metersPerPixel) < 1e-12);
  assert.ok(Math.abs(coordinates.y - 125 * metrics.metersPerPixel) < 1e-12);
  assert.equal(coordinates.z, 1.3);
  assert.deepEqual(
    { unit: coordinates.unit, frame: coordinates.frame, floorplanId: coordinates.floorplanId, source: coordinates.source },
    { unit: "m", frame: "floorplan_image", floorplanId: "floor1", source: "floorplan" }
  );
});

test("coordinate map skips unscaled legacy floorplans", () => {
  const coordinates = buildFloorplanCoordinateMap([
    { id: "legacy", image: { width: 100, height: 80 }, rooms: [], devices: [{ deviceId: "light1", x: 0.2, y: 0.3 }] }
  ]);
  assert.equal(coordinates.size, 0);
});

test("placement map resolves floorplan room ids to room names", () => {
  const placements = buildFloorplanPlacementMap([
    {
      id: "floor1",
      image: { width: 1000, height: 500 },
      imageScale: {
        points: [
          { x: 0.1, y: 0.2 },
          { x: 0.4, y: 0.2 }
        ],
        distanceMeters: 3
      },
      rooms: [{ id: "living", name: "客厅" }],
      devices: [{ deviceId: "light1", x: 0.2, y: 0.3, roomId: "living" }]
    }
  ]);

  assert.equal(placements.get("light1").room, "客厅");
  assert.equal(placements.get("light1").roomId, "living");
  assert.equal(placements.get("light1").floorplanId, "floor1");
  assert.equal(placements.get("light1").coordinates.floorplanId, "floor1");
});
