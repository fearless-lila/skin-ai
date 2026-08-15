import assert from "node:assert/strict";
import test from "node:test";

import { findRecommendedSizeIndex } from "../../frontend/measurement-tabs.js";

test("recommends the first size with the strongest existing assessment", () => {
  const sizeResults = [
    { size: "S", assessment: "needs_more_room" },
    { size: "M", assessment: "within_guide" },
    { size: "L", assessment: "alteration_possible" }
  ];

  assert.equal(findRecommendedSizeIndex(sizeResults), 1);
});

test("keeps product order when size assessments are tied", () => {
  assert.equal(
    findRecommendedSizeIndex([
      { size: "S", assessment: "within_guide" },
      { size: "M", assessment: "within_guide" }
    ]),
    0
  );
});

test("requires at least one dynamic size result", () => {
  assert.throws(() => findRecommendedSizeIndex([]), /at least one size/i);
});
