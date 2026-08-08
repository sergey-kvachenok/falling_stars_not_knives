import assert from "node:assert/strict";
import { test } from "node:test";
import { adjustFairValue, type CalibrationState } from "./calibration.js";

const cal = (n: number, meanErrorPct: number, byClassification?: CalibrationState["byClassification"]): CalibrationState => ({
  n,
  meanErrorPct,
  byClassification,
  updatedAt: "2027-08-08",
});

test("dormant below the sample threshold — raw value stands", () => {
  const a = adjustFairValue(100, cal(5, -30));
  assert.equal(a.active, false);
  assert.equal(a.adjusted, 100);
});

test("active correction scales fair value by the measured bias", () => {
  // fair values ran 25% too hot → realized averaged 25% below fair → ×0.75
  const a = adjustFairValue(100, cal(25, -25));
  assert.equal(a.active, true);
  assert.equal(a.adjusted, 75);
  // bias the other way: fair values were too timid → ×1.10
  assert.equal(adjustFairValue(100, cal(25, 10)).adjusted, 110);
});

test("correction factor is clamped — absurd measured bias never multiplies through", () => {
  assert.equal(adjustFairValue(100, cal(25, -90)).adjusted, 50); // clamped at ×0.5
  assert.equal(adjustFairValue(100, cal(25, 200)).adjusted, 150); // clamped at ×1.5
});

test("per-classification scalar applies when its class has enough samples", () => {
  const state = cal(30, -10, {
    thesis_breaking: { n: 15, meanErrorPct: -40 }, // enough samples → class scalar
    mechanical: { n: 3, meanErrorPct: 50 }, // too few → global scalar
  });
  const cls = adjustFairValue(100, state, "thesis_breaking");
  assert.equal(cls.adjusted, 60);
  assert.equal(cls.scope, "class");
  const fallback = adjustFairValue(100, state, "mechanical");
  assert.equal(fallback.adjusted, 90); // global −10%
  assert.equal(fallback.scope, "global");
});

test("no calibration state at all — raw value stands", () => {
  const a = adjustFairValue(100, null);
  assert.equal(a.active, false);
  assert.equal(a.adjusted, 100);
});
