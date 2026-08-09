import assert from "node:assert/strict";
import test from "node:test";

import {
  TryOnGenerationError,
  checkTryOnTask,
  createTryOnTask,
  waitForTryOnResult
} from "../../frontend/try-on-task.js";

const tasksApiUrl = "https://api.skin-ai.example/api/try-on/tasks";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("creates a task using only the selected product and uploaded file ID", async () => {
  let capturedUrl;
  let capturedOptions;
  const result = await createTryOnTask(
    {
      tasksApiUrl,
      selectedProductId: "mock-dress-001",
      fileId: "uploaded/file/id",
      turnstileToken: "browser-turnstile-token"
    },
    {
      fetchImpl: async (url, options) => {
        capturedUrl = url;
        capturedOptions = options;
        return jsonResponse({
          selectedProductId: "mock-dress-001",
          taskId: "task_abc-123",
          status: "processing"
        });
      }
    }
  );

  assert.equal(capturedUrl, tasksApiUrl);
  assert.equal(capturedOptions.method, "POST");
  assert.deepEqual(JSON.parse(capturedOptions.body), {
    selectedProductId: "mock-dress-001",
    fileId: "uploaded/file/id",
    turnstileToken: "browser-turnstile-token"
  });
  assert.equal(result.taskId, "task_abc-123");
});

test("polls an existing task until the generated image succeeds", async () => {
  let checks = 0;
  let waits = 0;
  const result = await waitForTryOnResult(
    {
      tasksApiUrl,
      taskId: "task-123",
      maxAttempts: 3,
      pollIntervalMs: 1
    },
    {
      wait: async () => {
        waits += 1;
      },
      fetchImpl: async () => {
        checks += 1;
        return checks === 1
          ? jsonResponse({
              taskId: "task-123",
              status: "processing",
              resultUrl: null,
              error: null
            })
          : jsonResponse({
              taskId: "task-123",
              status: "succeeded",
              resultUrl: "https://results.example/generated.jpg",
              error: null
            });
      }
    }
  );

  assert.equal(checks, 2);
  assert.equal(waits, 1);
  assert.equal(result.resultUrl, "https://results.example/generated.jpg");
});

test("preserves a running task after the local polling window", async () => {
  await assert.rejects(
    waitForTryOnResult(
      {
        tasksApiUrl,
        taskId: "task-123",
        maxAttempts: 2,
        pollIntervalMs: 1
      },
      {
        wait: async () => {},
        fetchImpl: async () =>
          jsonResponse({
            taskId: "task-123",
            status: "processing",
            resultUrl: null,
            error: null
          })
      }
    ),
    (error) =>
      error instanceof TryOnGenerationError &&
      error.code === "TRY_ON_STILL_PROCESSING" &&
      error.terminal === false
  );
});

test("reports a provider processing failure as terminal", async () => {
  await assert.rejects(
    waitForTryOnResult(
      { tasksApiUrl, taskId: "task-123", maxAttempts: 1 },
      {
        fetchImpl: async () =>
          jsonResponse({
            taskId: "task-123",
            status: "failed",
            resultUrl: null,
            error: {
              code: "PHOTO_POSE_NOT_DETECTED",
              message: "Try another photograph."
            }
          })
      }
    ),
    (error) =>
      error instanceof TryOnGenerationError &&
      error.code === "PHOTO_POSE_NOT_DETECTED" &&
      error.terminal === true
  );
});

test("rejects an unsafe generated result URL", async () => {
  await assert.rejects(
    checkTryOnTask(
      { tasksApiUrl, taskId: "task-123" },
      {
        fetchImpl: async () =>
          jsonResponse({
            taskId: "task-123",
            status: "succeeded",
            resultUrl: "http://results.example/generated.jpg",
            error: null
          })
      }
    ),
    (error) =>
      error instanceof TryOnGenerationError &&
      error.code === "INVALID_TRY_ON_RESPONSE"
  );
});
