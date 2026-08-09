import assert from "node:assert/strict";
import test from "node:test";

import {
  YOUCAM_CLOTHES_GARMENT_CATEGORIES,
  hasReadyTryOnConfiguration,
  isSupportedYouCamGarmentCategory
} from "../../src/try-on/virtual-try-on-config.js";

function readyProduct(overrides = {}) {
  return {
    imageUrls: ["https://skin-ai.pages.dev/images/reference.png"],
    virtualTryOn: {
      status: "ready",
      provider: "youcam_clothes_v3",
      referenceImageIndex: 0,
      garmentCategory: "upper_body"
    },
    ...overrides
  };
}

test("defines the three trusted YouCam clothing regions", () => {
  assert.deepEqual(YOUCAM_CLOTHES_GARMENT_CATEGORIES, [
    "upper_body",
    "lower_body",
    "full_body"
  ]);

  for (const category of YOUCAM_CLOTHES_GARMENT_CATEGORIES) {
    assert.equal(isSupportedYouCamGarmentCategory(category), true);
  }
  assert.equal(isSupportedYouCamGarmentCategory("auto"), false);
});

test("requires a complete ready configuration and HTTPS reference", () => {
  assert.equal(hasReadyTryOnConfiguration(readyProduct()), true);
  assert.equal(
    hasReadyTryOnConfiguration(
      readyProduct({
        virtualTryOn: {
          status: "ready",
          provider: "youcam_clothes_v3",
          referenceImageIndex: 0,
          garmentCategory: "auto"
        }
      })
    ),
    false
  );
  assert.equal(
    hasReadyTryOnConfiguration(
      readyProduct({ imageUrls: ["http://unsafe.example/reference.png"] })
    ),
    false
  );
});
