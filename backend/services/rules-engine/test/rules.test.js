import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRules } from "../src/rules.js";

const rules = [
  {
    id: "r1",
    when: { deviceId: "d1", traitPath: "traits.switch.state", equals: "on" },
    then: { action: "turn_off" }
  }
];

test("evaluateRules matches rule and emits action", () => {
  const actions = [];
  const matched = evaluateRules(
    { id: "d1", traits: { switch: { state: "on" } } },
    rules,
    (action) => actions.push(action)
  );
  assert.deepEqual(matched, ["r1"]);
  assert.equal(actions[0].action, "turn_off");
});

test("evaluateRules skips when condition not met", () => {
  const actions = [];
  const matched = evaluateRules(
    { id: "d1", traits: { switch: { state: "off" } } },
    rules,
    (action) => actions.push(action)
  );
  assert.equal(matched.length, 0);
  assert.equal(actions.length, 0);
});
