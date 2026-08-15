import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { MOCK_PRODUCT_MEASUREMENTS } from "../../frontend/mock-product-measurements.js";

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

test("the deployed measurement illustration is the exact supplied asset", () => {
  const suppliedAsset = readFileSync(
    new URL("../../public/measurement.png", import.meta.url)
  );
  const deployedAsset = readFileSync(
    new URL("../../frontend/images/measurement.png", import.meta.url)
  );

  assert.deepEqual(deployedAsset, suppliedAsset);
});

test("the alteration support cards use the exact supplied image assets", () => {
  const assetNames = [
    "accessible_sewing_studio_consultation.png",
    "collaborative_sewing_studio_fitting.png",
    "welcoming_inclusive_sewing_boutique.png",
    "accessible_sewing_consultation_at_home.png"
  ];

  for (const assetName of assetNames) {
    const suppliedAsset = readFileSync(
      new URL(`../../public/${assetName}`, import.meta.url)
    );
    const deployedAsset = readFileSync(
      new URL(`../../frontend/images/${assetName}`, import.meta.url)
    );

    assert.deepEqual(deployedAsset, suppliedAsset, assetName);
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

test("every available mock size has documented garment measurements", () => {
  for (const product of catalogue.products) {
    const measuredSizes = new Set(
      product.measurements.map((measurement) => measurement.size)
    );
    const measurementKeys = product.measurements.map(
      ({ size, name }) => `${size}:${name}`
    );

    assert.deepEqual([...measuredSizes], product.sizes, product.id);
    assert.equal(
      new Set(measurementKeys).size,
      measurementKeys.length,
      `${product.id}: duplicate size measurement`
    );
  }
});

test("bundled mock measurement fallback matches the trusted catalogue", () => {
  for (const product of catalogue.products) {
    assert.deepEqual(
      MOCK_PRODUCT_MEASUREMENTS[product.id],
      product.measurements.map(({ size, name, valueCm }) => ({
        size,
        name,
        valueCm
      })),
      product.id
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
