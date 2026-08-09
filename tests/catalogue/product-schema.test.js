import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
const expectedGarmentCategories = {
  "mock-dress-001": "full_body",
  "mock-dress-002": "full_body",
  "mock-shirt-001": "upper_body",
  "mock-dress-003": "full_body",
  "mock-trousers-001": "lower_body",
  "mock-cardigan-001": "upper_body",
  "mock-blouse-001": "upper_body",
  "mock-jumpsuit-001": "full_body"
};

test("every mock product has valid explicit virtual-try-on metadata", () => {
  for (const product of catalogue.products) {
    assert.equal(
      validateProduct(product),
      true,
      `${product.id}: ${ajv.errorsText(validateProduct.errors)}`
    );
  }
});

test("every mock product image is a deployed frontend asset", () => {
  for (const product of catalogue.products) {
    for (const imageUrl of product.imageUrls) {
      const parsedUrl = new URL(imageUrl);
      const assetUrl = new URL(`../../frontend${parsedUrl.pathname}`, import.meta.url);

      assert.equal(parsedUrl.origin, "https://skin-ai.pages.dev", product.id);
      assert.equal(
        existsSync(assetUrl),
        true,
        `${product.id}: missing ${parsedUrl.pathname}`
      );
    }
  }
});

test("every mock product has a trusted reference for its YouCam region", () => {
  assert.equal(catalogue.products.length, 8);

  for (const product of catalogue.products) {
    assert.equal(product.virtualTryOn.status, "ready", product.id);
    assert.equal(
      product.virtualTryOn.garmentCategory,
      expectedGarmentCategories[product.id],
      product.id
    );
    assert.ok(
      product.imageUrls[product.virtualTryOn.referenceImageIndex],
      `${product.id}: missing trusted reference image`
    );
  }
});

test("a ready product requires complete trusted YouCam configuration", () => {
  const product = structuredClone(catalogue.products[0]);
  delete product.virtualTryOn.garmentCategory;

  assert.equal(validateProduct(product), false);
});

test("a ready product rejects an unsupported YouCam garment region", () => {
  const product = structuredClone(catalogue.products[0]);
  product.virtualTryOn.garmentCategory = "auto";

  assert.equal(validateProduct(product), false);
});

test("an unavailable product cannot carry provider configuration", () => {
  const product = structuredClone(catalogue.products[1]);
  product.virtualTryOn = {
    status: "unavailable",
    provider: "youcam_clothes_v3"
  };

  assert.equal(validateProduct(product), false);
});
