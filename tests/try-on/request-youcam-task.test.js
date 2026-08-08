import assert from "node:assert/strict";
import test from "node:test";

import {
  YOUCAM_CLOTHES_TASK_PATH,
  YouCamTaskProviderError,
  createYouCamTaskClient
} from "../../src/try-on/request-youcam-task.js";
import { YOUCAM_API_BASE_URL } from "../../src/try-on/request-youcam-upload.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("creates a clothes task using trusted user and garment references", async () => {
  let capturedUrl;
  let capturedOptions;
  const client = createYouCamTaskClient({
    apiKey: "private-youcam-key",
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return jsonResponse({
        status: 200,
        data: { task_id: "youcam_task-123" }
      });
    }
  });

  const result = await client.createTask({
    fileId: "uploaded/user+photo/id",
    referenceImageUrl:
      "https://skin-ai.pages.dev/images/avery-front-zip-dress.png",
    garmentCategory: "full_body"
  });

  assert.equal(
    capturedUrl,
    `${YOUCAM_API_BASE_URL}${YOUCAM_CLOTHES_TASK_PATH}`
  );
  assert.equal(capturedOptions.method, "POST");
  assert.equal(capturedOptions.headers.Authorization, "Bearer private-youcam-key");
  assert.deepEqual(JSON.parse(capturedOptions.body), {
    src_file_id: "uploaded/user+photo/id",
    ref_file_url:
      "https://skin-ai.pages.dev/images/avery-front-zip-dress.png",
    garment_category: "full_body"
  });
  assert.deepEqual(result, { taskId: "youcam_task-123" });
});

test("normalizes running, successful and failed task status", async (t) => {
  const cases = [
    {
      name: "running",
      providerData: { task_status: "running" },
      expected: { status: "processing", resultUrl: null, errorCode: null }
    },
    {
      name: "success",
      providerData: {
        task_status: "success",
        error: null,
        results: { url: "https://results.example/generated.jpg?temporary=1" }
      },
      expected: {
        status: "succeeded",
        resultUrl: "https://results.example/generated.jpg?temporary=1",
        errorCode: null
      }
    },
    {
      name: "error",
      providerData: { task_status: "error", error: "error_pose" },
      expected: {
        status: "failed",
        resultUrl: null,
        errorCode: "error_pose"
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let capturedUrl;
      const client = createYouCamTaskClient({
        apiKey: "test-key",
        fetchImpl: async (url, options) => {
          capturedUrl = url;
          assert.equal(options.method, "GET");
          return jsonResponse({ status: 200, data: testCase.providerData });
        }
      });

      assert.deepEqual(await client.getTask("task_abc-123"), testCase.expected);
      assert.equal(
        capturedUrl,
        `${YOUCAM_API_BASE_URL}${YOUCAM_CLOTHES_TASK_PATH}/task_abc-123`
      );
    });
  }
});

test("rejects invalid or unsafe provider task responses", async (t) => {
  await t.test("unexpected status", async () => {
    const client = createYouCamTaskClient({
      apiKey: "test-key",
      fetchImpl: async () =>
        jsonResponse({ status: 200, data: { task_status: "unknown" } })
    });

    await assert.rejects(
      client.getTask("task-123"),
      (error) =>
        error instanceof YouCamTaskProviderError &&
        error.code === "INVALID_YOUCAM_RESPONSE"
    );
  });

  await t.test("non-HTTPS result", async () => {
    const client = createYouCamTaskClient({
      apiKey: "test-key",
      fetchImpl: async () =>
        jsonResponse({
          status: 200,
          data: {
            task_status: "success",
            results: { url: "http://results.example/generated.jpg" }
          }
        })
    });

    await assert.rejects(client.getTask("task-123"), YouCamTaskProviderError);
  });
});

test("does not expose provider HTTP response details", async () => {
  const client = createYouCamTaskClient({
    apiKey: "test-key",
    fetchImpl: async () =>
      new Response("private billing or provider details", { status: 402 })
  });

  await assert.rejects(
    client.createTask({
      fileId: "file-id",
      referenceImageUrl: "https://images.example/dress.png",
      garmentCategory: "full_body"
    }),
    (error) =>
      error instanceof YouCamTaskProviderError &&
      error.status === 402 &&
      !error.message.includes("private billing")
  );
});
