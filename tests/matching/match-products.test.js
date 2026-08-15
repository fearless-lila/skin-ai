import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MATCH_STATUS,
  matchProduct,
  matchProducts
} from "../../src/matching/match-products.js";

const catalogue = JSON.parse(
  readFileSync(
    new URL("../../data/mock-catalogue.json", import.meta.url),
    "utf8"
  )
);

const products = catalogue.products;

function requirements({
  garmentTypes,
  requiredAccess = {},
  excludedAccess = {},
  preferredAccess = {},
  requiredMeasurements = []
}) {
  return {
    garmentTypes,
    requiredAccess,
    excludedAccess,
    preferredAccess,
    requiredMeasurements
  };
}

function findProduct(id) {
  const product = products.find((candidate) => candidate.id === id);
  assert.ok(product, `Expected mock product ${id} to exist.`);
  return product;
}

function findResult(groups, id) {
  return [
    ...groups.compatibleProducts,
    ...groups.productsWithMissingInformation,
    ...groups.rejectedProducts
  ].find((result) => result.productId === id);
}

test("matches confirmed front-opening dresses and rejects back fastenings", () => {
  const result = matchProducts(
    requirements({
      garmentTypes: ["dress"],
      requiredAccess: {
        closureLocation: ["front"]
      },
      excludedAccess: {
        closureLocation: ["back"]
      }
    }),
    products
  );

  assert.equal(
    findResult(result, "mock-dress-001").status,
    MATCH_STATUS.COMPATIBLE
  );
  assert.equal(
    findResult(result, "mock-dress-003").status,
    MATCH_STATUS.COMPATIBLE
  );

  const backZip = findResult(result, "mock-dress-002");
  assert.equal(backZip.status, MATCH_STATUS.CONFLICT);
  assert.ok(
    backZip.conflicts.some(
      ({ reason }) => reason === "required_value_not_met"
    )
  );
  assert.ok(
    backZip.conflicts.some(
      ({ reason }) => reason === "excluded_value_present"
    )
  );
});

test("rejects products with the wrong garment type", () => {
  const result = matchProduct(
    requirements({ garmentTypes: ["dress"] }),
    findProduct("mock-shirt-001")
  );

  assert.equal(result.status, MATCH_STATUS.CONFLICT);
  assert.equal(result.conflicts[0].reason, "wrong_garment_type");
});

test("rejects a confirmed excluded fastening type", () => {
  const result = matchProduct(
    requirements({
      garmentTypes: ["shirt"],
      excludedAccess: {
        closureType: ["buttons"]
      }
    }),
    findProduct("mock-shirt-001")
  );

  assert.equal(result.status, MATCH_STATUS.CONFLICT);
  assert.ok(
    result.conflicts.some(
      ({ field, reason }) =>
        field === "access.closureType" && reason === "excluded_value_present"
    )
  );
});

test("treats an unknown required product fact as missing information", () => {
  const result = matchProduct(
    requirements({
      garmentTypes: ["blouse"],
      requiredAccess: {
        closureLocation: ["front"]
      }
    }),
    findProduct("mock-blouse-001")
  );

  assert.equal(result.status, MATCH_STATUS.MISSING_INFORMATION);
  assert.deepEqual(result.conflicts, []);
  assert.ok(
    result.missingInformation.some(
      ({ reason }) => reason === "unknown_product_fact"
    )
  );
});

test("treats an unknown excluded product fact as missing information", () => {
  const result = matchProduct(
    requirements({
      garmentTypes: ["blouse"],
      excludedAccess: {
        closureType: ["buttons"]
      }
    }),
    findProduct("mock-blouse-001")
  );

  assert.equal(result.status, MATCH_STATUS.MISSING_INFORMATION);
  assert.ok(
    result.missingInformation.some(
      ({ reason }) => reason === "cannot_verify_exclusion"
    )
  );
});

test("ranks compatible products by confirmed preferences", () => {
  const result = matchProducts(
    requirements({
      garmentTypes: ["dress"],
      requiredAccess: {
        closureLocation: ["front"]
      },
      preferredAccess: {
        dressingMethod: ["wrap"]
      }
    }),
    products
  );

  assert.equal(result.compatibleProducts[0].productId, "mock-dress-003");
  assert.equal(result.compatibleProducts[0].preferenceScore, 1);
  assert.equal(
    findResult(result, "mock-dress-001").preferenceScore,
    0
  );
});

test("does not let a preference override a hard conflict", () => {
  const result = matchProduct(
    requirements({
      garmentTypes: ["dress"],
      excludedAccess: {
        closureType: ["wrap_tie"]
      },
      preferredAccess: {
        dressingMethod: ["wrap"]
      }
    }),
    findProduct("mock-dress-003")
  );

  assert.equal(result.preferenceScore, 1);
  assert.equal(result.status, MATCH_STATUS.CONFLICT);
});

test("confirms a compatible documented measurement and reports its size", () => {
  const result = matchProduct(
    requirements({
      garmentTypes: ["dress"],
      requiredMeasurements: [
        {
          name: "chest",
          minimumCm: 98,
          maximumCm: 102
        }
      ]
    }),
    findProduct("mock-dress-001")
  );

  assert.equal(result.status, MATCH_STATUS.COMPATIBLE);
  assert.deepEqual(result.compatibleSizes, ["M"]);
  assert.ok(
    result.confirmedMatches.some(({ field }) => field === "measurements")
  );
});

test("reports missing information when unmeasured sizes could still match", () => {
  const product = structuredClone(findProduct("mock-dress-001"));
  product.measurements = product.measurements.filter(({ size }) => size === "M");

  const result = matchProduct(
    requirements({
      garmentTypes: ["dress"],
      requiredMeasurements: [
        {
          name: "chest",
          minimumCm: 110
        }
      ]
    }),
    product
  );

  assert.equal(result.status, MATCH_STATUS.MISSING_INFORMATION);
  assert.ok(
    result.missingInformation.some(
      ({ reason }) => reason === "insufficient_measurement_data"
    )
  );
});

test("conflicts when every documented size is complete and out of range", () => {
  const product = structuredClone(findProduct("mock-dress-001"));
  product.sizes = ["M"];

  const result = matchProduct(
    requirements({
      garmentTypes: ["dress"],
      requiredMeasurements: [
        {
          name: "chest",
          minimumCm: 110
        }
      ]
    }),
    product
  );

  assert.equal(result.status, MATCH_STATUS.CONFLICT);
  assert.ok(
    result.conflicts.some(
      ({ reason }) => reason === "all_documented_sizes_out_of_range"
    )
  );
});

test("rejects contradictory access requirements before matching", () => {
  assert.throws(
    () =>
      matchProducts(
        requirements({
          garmentTypes: ["dress"],
          requiredAccess: {
            closureType: ["zip"]
          },
          excludedAccess: {
            closureType: ["zip"]
          }
        }),
        products
      ),
    /both required and excluded/
  );
});

test("rejects an inverted measurement range before matching", () => {
  assert.throws(
    () =>
      matchProducts(
        requirements({
          garmentTypes: ["dress"],
          requiredMeasurements: [
            {
              name: "waist",
              minimumCm: 90,
              maximumCm: 80
            }
          ]
        }),
        products
      ),
    /minimumCm exceeds maximumCm/
  );
});
