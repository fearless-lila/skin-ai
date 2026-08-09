import assert from "node:assert/strict";
import test from "node:test";

import mockCatalogue from "../../data/mock-catalogue.json" with { type: "json" };
import {
  TryOnTaskError,
  handleTryOnTaskCreate,
  handleTryOnTaskStatus
} from "../../src/try-on/handle-try-on-task.js";

function validRequest(overrides = {}) {
  return {
    selectedProductId: "mock-dress-001",
    fileId: "uploaded/user+photo/id",
    turnstileToken: "verified-in-worker-before-orchestration",
    ...overrides
  };
}

test("creates a task with the trusted catalogue garment configuration", async () => {
  let received;
  const result = await handleTryOnTaskCreate(validRequest(), {
    catalogue: mockCatalogue,
    createProviderTask: async (task) => {
      received = task;
      return { taskId: "youcam_task-123" };
    }
  });

  assert.deepEqual(received, {
    fileId: "uploaded/user+photo/id",
    referenceImageUrl:
      "https://skin-ai.pages.dev/images/avery-front-zip-dress.png",
    garmentCategory: "full_body"
  });
  assert.deepEqual(result, {
    selectedProductId: "mock-dress-001",
    taskId: "youcam_task-123",
    status: "processing"
  });
});

test("rejects untrusted task fields and unavailable products before YouCam", async (t) => {
  let providerCalls = 0;
  const dependencies = {
    catalogue: mockCatalogue,
    createProviderTask: async () => {
      providerCalls += 1;
    }
  };

  await t.test("browser-supplied garment URL", async () => {
    await assert.rejects(
      handleTryOnTaskCreate(
        {
          ...validRequest(),
          referenceImageUrl: "https://attacker.example/image.png"
        },
        dependencies
      ),
      (error) =>
        error instanceof TryOnTaskError &&
        error.code === "INVALID_TRY_ON_TASK_REQUEST"
    );
  });

  await t.test("unavailable product", async () => {
    await assert.rejects(
      handleTryOnTaskCreate(
        validRequest({ selectedProductId: "mock-dress-002" }),
        dependencies
      ),
      (error) =>
        error instanceof TryOnTaskError &&
        error.code === "VIRTUAL_TRY_ON_UNAVAILABLE"
    );
  });

  assert.equal(providerCalls, 0);
});

test("maps provider statuses to validated public responses", async (t) => {
  await t.test("processing", async () => {
    const result = await handleTryOnTaskStatus("task-123", {
      getProviderTask: async () => ({
        status: "processing",
        resultUrl: null,
        errorCode: null
      })
    });

    assert.deepEqual(result, {
      taskId: "task-123",
      status: "processing",
      resultUrl: null,
      error: null
    });
  });

  await t.test("success", async () => {
    const result = await handleTryOnTaskStatus("task-123", {
      getProviderTask: async () => ({
        status: "succeeded",
        resultUrl: "https://results.example/generated.jpg",
        errorCode: null
      })
    });

    assert.equal(result.status, "succeeded");
    assert.equal(result.resultUrl, "https://results.example/generated.jpg");
    assert.equal(result.error, null);
  });

  await t.test("known photo error", async () => {
    const result = await handleTryOnTaskStatus("task-123", {
      getProviderTask: async () => ({
        status: "failed",
        resultUrl: null,
        errorCode: "error_pose"
      })
    });

    assert.deepEqual(result.error, {
      code: "PHOTO_POSE_NOT_DETECTED",
      message:
        "We could not detect a suitable forward-facing pose. Try a clear photograph showing one person."
    });
  });
});

test("rejects malformed task IDs before checking YouCam", async () => {
  let providerCalls = 0;

  await assert.rejects(
    handleTryOnTaskStatus("../../private", {
      getProviderTask: async () => {
        providerCalls += 1;
      }
    }),
    (error) =>
      error instanceof TryOnTaskError &&
      error.code === "INVALID_TRY_ON_TASK_ID"
  );
  assert.equal(providerCalls, 0);
});
