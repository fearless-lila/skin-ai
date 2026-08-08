import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const productSchema = JSON.parse(
  readFileSync(
    new URL("../../schemas/product.schema.json", import.meta.url),
    "utf8"
  )
);
const catalogue = JSON.parse(
  readFileSync(
    new URL("../../data/mock-catalogue.json", import.meta.url),
    "utf8"
  )
);
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false
});
addFormats(ajv);
const validateProduct = ajv.compile(productSchema);

test("every mock product has valid explicit virtual-try-on metadata", () => {
  for (const product of catalogue.products) {
    assert.equal(
      validateProduct(product),
      true,
      `${product.id}: ${ajv.errorsText(validateProduct.errors)}`
    );
  }
});

test("a ready product requires complete trusted YouCam configuration", () => {
  const product = structuredClone(catalogue.products[0]);
  delete product.virtualTryOn.garmentCategory;

  assert.equal(validateProduct(product), false);
});

test("an unavailable product cannot carry provider configuration", () => {
  const product = structuredClone(catalogue.products[1]);
  product.virtualTryOn.provider = "youcam_clothes_v3";

  assert.equal(validateProduct(product), false);
});
