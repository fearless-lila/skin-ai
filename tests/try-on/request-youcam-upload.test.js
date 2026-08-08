import assert from "node:assert/strict";
import test from "node:test";

import {
  YOUCAM_API_BASE_URL,
  YOUCAM_CLOTHES_FILE_PATH,
  YouCamUploadError,
  createYouCamUploadRequester
} from "../../src/try-on/request-youcam-upload.js";

function successfulProviderResponse(overrides = {}) {
  return new Response(
    JSON.stringify({
      status: 200,
      data: {
        files: [
          {
            file_id: "youcam-file-123",
            requests: [
              {
                method: "PUT",
                url: "https://uploads.example/photo?signature=temporary",
                headers: {
                  "Content-Length": "1234",
                  "Content-Type": "image/jpg"
                }
              }
            ]
          }
        ]
      },
      ...overrides
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }
  );
}

test("requests a YouCam signed upload without exposing the API key", async () => {
  let capturedUrl;
  let capturedOptions;
  const requestUpload = createYouCamUploadRequester({
    apiKey: "private-youcam-key",
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return successfulProviderResponse();
    }
  });

  const result = await requestUpload({
    file: {
      name: "portrait.jpg",
      contentType: "image/jpeg",
      size: 1234
    }
  });

  assert.equal(
    capturedUrl,
    `${YOUCAM_API_BASE_URL}${YOUCAM_CLOTHES_FILE_PATH}`
  );
  assert.equal(capturedOptions.method, "POST");
  assert.equal(capturedOptions.headers.Authorization, "Bearer private-youcam-key");
  assert.deepEqual(JSON.parse(capturedOptions.body), {
    files: [
      {
        content_type: "image/jpg",
        file_name: "portrait.jpg",
        file_size: 1234
      }
    ]
  });
  assert.deepEqual(result, {
    fileId: "youcam-file-123",
    upload: {
      url: "https://uploads.example/photo?signature=temporary",
      method: "PUT",
      contentType: "image/jpg"
    }
  });
  assert.doesNotMatch(JSON.stringify(result), /private-youcam-key/);
});

test("requires a server-side YouCam API key", () => {
  assert.throws(
    () => createYouCamUploadRequester({ apiKey: "" }),
    (error) =>
      error instanceof YouCamUploadError &&
      error.code === "MISSING_YOUCAM_API_KEY"
  );
});

test("rejects unsafe or incomplete provider upload instructions", async (t) => {
  await t.test("non-HTTPS signed URL", async () => {
    const requestUpload = createYouCamUploadRequester({
      apiKey: "test-key",
      fetchImpl: async () =>
        successfulProviderResponse({
          data: {
            files: [
              {
                file_id: "file-123",
                requests: [
                  {
                    method: "PUT",
                    url: "http://uploads.example/photo",
                    headers: { "Content-Type": "image/png" }
                  }
                ]
              }
            ]
          }
        })
    });

    await assert.rejects(
      requestUpload({
        file: { name: "photo.png", contentType: "image/png", size: 100 }
      }),
      (error) =>
        error instanceof YouCamUploadError &&
        error.code === "INVALID_YOUCAM_RESPONSE"
    );
  });

  await t.test("malformed request entry", async () => {
    const requestUpload = createYouCamUploadRequester({
      apiKey: "test-key",
      fetchImpl: async () =>
        successfulProviderResponse({
          data: {
            files: [{ file_id: "file-123", requests: [null] }]
          }
        })
    });

    await assert.rejects(
      requestUpload({
        file: { name: "photo.png", contentType: "image/png", size: 100 }
      }),
      (error) => error instanceof YouCamUploadError
    );
  });
});

test("turns provider HTTP failures into a controlled error", async () => {
  const requestUpload = createYouCamUploadRequester({
    apiKey: "test-key",
    fetchImpl: async () => new Response("private provider detail", { status: 401 })
  });

  await assert.rejects(
    requestUpload({
      file: { name: "photo.png", contentType: "image/png", size: 100 }
    }),
    (error) =>
      error instanceof YouCamUploadError &&
      error.code === "YOUCAM_HTTP_ERROR" &&
      error.status === 401 &&
      !error.message.includes("private provider detail")
  );
});
