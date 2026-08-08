import assert from "node:assert/strict";
import test from "node:test";

import {
  TryOnPhotoUploadError,
  uploadTryOnPhoto
} from "../../frontend/try-on-upload.js";

const apiUrl = "https://api.skin-ai.example/api/try-on/upload";

function photo() {
  return {
    name: "portrait.jpg",
    type: "image/jpeg",
    size: 1234
  };
}

function instructionsResponse(overrides = {}) {
  return new Response(
    JSON.stringify({
      selectedProductId: "mock-dress-001",
      fileId: "youcam-file-123",
      upload: {
        url: "https://uploads.example/photo?signature=temporary",
        method: "PUT",
        contentType: "image/jpg"
      },
      ...overrides
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }
  );
}

test("requests signed instructions then uploads the photo directly", async () => {
  const selectedPhoto = photo();
  const calls = [];
  const result = await uploadTryOnPhoto(
    {
      apiUrl,
      selectedProductId: "mock-dress-001",
      file: selectedPhoto,
      consent: true
    },
    {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return calls.length === 1
          ? instructionsResponse()
          : new Response(null, { status: 200 });
      }
    }
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, apiUrl);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    selectedProductId: "mock-dress-001",
    consent: true,
    file: {
      name: "portrait.jpg",
      contentType: "image/jpeg",
      size: 1234
    }
  });
  assert.equal(
    calls[1].url,
    "https://uploads.example/photo?signature=temporary"
  );
  assert.equal(calls[1].options.method, "PUT");
  assert.equal(calls[1].options.headers["Content-Type"], "image/jpg");
  assert.equal(calls[1].options.body, selectedPhoto);
  assert.equal(calls[1].options.credentials, "omit");
  assert.deepEqual(result, {
    selectedProductId: "mock-dress-001",
    fileId: "youcam-file-123"
  });
});

test("does not upload when the Worker rejects the metadata", async () => {
  let calls = 0;

  await assert.rejects(
    uploadTryOnPhoto(
      {
        apiUrl,
        selectedProductId: "mock-dress-001",
        file: photo(),
        consent: true
      },
      {
        fetchImpl: async () => {
          calls += 1;
          return new Response(
            JSON.stringify({
              error: {
                code: "VIRTUAL_TRY_ON_UNAVAILABLE",
                message: "This product is not available for virtual try-on."
              }
            }),
            {
              status: 409,
              headers: { "Content-Type": "application/json" }
            }
          );
        }
      }
    ),
    (error) =>
      error instanceof TryOnPhotoUploadError &&
      error.code === "VIRTUAL_TRY_ON_UNAVAILABLE"
  );
  assert.equal(calls, 1);
});

test("rejects unsafe signed instructions before uploading photo bytes", async () => {
  let calls = 0;

  await assert.rejects(
    uploadTryOnPhoto(
      {
        apiUrl,
        selectedProductId: "mock-dress-001",
        file: photo(),
        consent: true
      },
      {
        fetchImpl: async () => {
          calls += 1;
          return instructionsResponse({
            upload: {
              url: "http://uploads.example/photo",
              method: "PUT",
              contentType: "image/jpg"
            }
          });
        }
      }
    ),
    (error) =>
      error instanceof TryOnPhotoUploadError &&
      error.code === "INVALID_UPLOAD_INSTRUCTIONS"
  );
  assert.equal(calls, 1);
});

test("returns a controlled error when direct photo upload fails", async () => {
  let calls = 0;

  await assert.rejects(
    uploadTryOnPhoto(
      {
        apiUrl,
        selectedProductId: "mock-dress-001",
        file: photo(),
        consent: true
      },
      {
        fetchImpl: async () => {
          calls += 1;
          return calls === 1
            ? instructionsResponse()
            : new Response("private storage details", { status: 403 });
        }
      }
    ),
    (error) =>
      error instanceof TryOnPhotoUploadError &&
      error.code === "PHOTO_UPLOAD_FAILED" &&
      !error.message.includes("private storage details")
  );
  assert.equal(calls, 2);
});
