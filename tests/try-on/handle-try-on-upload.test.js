import assert from "node:assert/strict";
import test from "node:test";

import mockCatalogue from "../../data/mock-catalogue.json" with { type: "json" };
import {
  TryOnUploadError,
  handleTryOnUpload
} from "../../src/try-on/handle-try-on-upload.js";

function validUploadRequest(overrides = {}) {
  return {
    selectedProductId: "mock-dress-001",
    consent: true,
    file: {
      name: "photo.jpg",
      contentType: "image/jpeg",
      size: 2048
    },
    ...overrides
  };
}

function validProviderUpload() {
  return {
    fileId: "youcam-file-123",
    upload: {
      url: "https://uploads.example/photo?signature=temporary",
      method: "PUT",
      contentType: "image/jpg"
    }
  };
}

test("validates the product before requesting a temporary upload", async () => {
  let receivedFile;
  const result = await handleTryOnUpload(validUploadRequest(), {
    catalogue: mockCatalogue,
    requestProviderUpload: async ({ file }) => {
      receivedFile = file;
      return validProviderUpload();
    }
  });

  assert.deepEqual(receivedFile, validUploadRequest().file);
  assert.deepEqual(result, {
    selectedProductId: "mock-dress-001",
    ...validProviderUpload()
  });
});

test("requires explicit consent before contacting YouCam", async () => {
  let providerCalls = 0;

  await assert.rejects(
    handleTryOnUpload(validUploadRequest({ consent: false }), {
      catalogue: mockCatalogue,
      requestProviderUpload: async () => {
        providerCalls += 1;
      }
    }),
    (error) =>
      error instanceof TryOnUploadError &&
      error.code === "INVALID_TRY_ON_UPLOAD_REQUEST"
  );
  assert.equal(providerCalls, 0);
});

test("rejects unknown and try-on-unavailable products before contacting YouCam", async (t) => {
  let providerCalls = 0;
  const dependencies = {
    catalogue: mockCatalogue,
    requestProviderUpload: async () => {
      providerCalls += 1;
    }
  };

  await t.test("unknown product", async () => {
    await assert.rejects(
      handleTryOnUpload(
        validUploadRequest({ selectedProductId: "missing-product" }),
        dependencies
      ),
      (error) =>
        error instanceof TryOnUploadError &&
        error.code === "UNKNOWN_PRODUCT_REFERENCE"
    );
  });

  await t.test("unavailable product", async () => {
    await assert.rejects(
      handleTryOnUpload(
        validUploadRequest({ selectedProductId: "mock-dress-002" }),
        dependencies
      ),
      (error) =>
        error instanceof TryOnUploadError &&
        error.code === "VIRTUAL_TRY_ON_UNAVAILABLE"
    );
  });

  assert.equal(providerCalls, 0);
});

test("rejects incomplete upload instructions returned by the provider boundary", async () => {
  await assert.rejects(
    handleTryOnUpload(validUploadRequest(), {
      catalogue: mockCatalogue,
      requestProviderUpload: async () => ({
        fileId: "",
        upload: {
          url: "not-a-url",
          method: "PUT",
          contentType: "image/jpg"
        }
      })
    }),
    (error) =>
      error instanceof TryOnUploadError &&
      error.code === "INVALID_UPLOAD_PROVIDER_RESPONSE"
  );
});
