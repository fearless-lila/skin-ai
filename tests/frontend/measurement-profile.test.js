import assert from "node:assert/strict";
import test from "node:test";

import {
  compareProductMeasurements,
  isUsableMeasurementProfile,
  normalizeMeasurementProfile
} from "../../frontend/measurement-profile.js";

test("requires chest and waist while normalizing optional measurements", () => {
  assert.deepEqual(
    normalizeMeasurementProfile({ chest: "91.24", waist: "78", inside_leg: 76 }),
    { chest: 91, waist: 78, inside_leg: 76 }
  );
  assert.throws(() => normalizeMeasurementProfile({}), /chest and waist/i);
  assert.throws(
    () => normalizeMeasurementProfile({ chest: 91 }),
    /chest and waist/i
  );
  assert.throws(
    () => normalizeMeasurementProfile({ chest: 500 }),
    /between 20 cm and 250 cm/i
  );
});

test("validates only supported measurement profile fields", () => {
  assert.equal(isUsableMeasurementProfile({ chest: 92, waist: 78 }), true);
  assert.equal(isUsableMeasurementProfile({ chest: 92 }), false);
  assert.equal(isUsableMeasurementProfile({ chest: 0 }), false);
  assert.equal(isUsableMeasurementProfile({ diagnosis: 1 }), false);
});

test("compares saved measurements with every documented size", () => {
  const results = compareProductMeasurements(
    { chest: 92, waist: 78, sleeve_length: 60 },
    [
      { size: "S", name: "chest", valueCm: 94 },
      { size: "M", name: "chest", valueCm: 100 },
      { size: "M", name: "waist", valueCm: 86 },
      { size: "M", name: "sleeve_length", valueCm: 62 }
    ]
  );

  assert.equal(results.length, 2);
  assert.equal(results[0].assessment, "needs_more_room");
  assert.equal(results[1].assessment, "alteration_possible");
  assert.equal(results[1].comparisons[0].status, "within_guide");
  assert.equal(results[1].comparisons[2].status, "longer");
});

test("does not invent comparisons for missing user or garment fields", () => {
  assert.deepEqual(
    compareProductMeasurements({ chest: 92, waist: 78, hip: 100 }, [
      { size: "M", name: "sleeve_length", valueCm: 62 }
    ]),
    []
  );
});
