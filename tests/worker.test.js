import assert from "node:assert/strict";
import test from "node:test";

import mockCatalogue from "../data/mock-catalogue.json" with { type: "json" };

import {
  CHAT_API_PATH,
  MAX_CHAT_REQUEST_BYTES,
  TAILORS_API_PATH,
  TRY_ON_TASKS_API_PATH,
  TRY_ON_UPLOAD_API_PATH,
  createWorker
} from "../src/worker.js";

const allowedOrigin = "https://app.skin-ai.example";
const silentLogger = { error() {} };

function validChatRequest(overrides = {}) {
  return {
    conversationId: "conversation-123",
    currentMessage: "What does a full front opening mean?",
    recentMessages: [],
    conversationState: {
      currentRequirements: null,
      lastDisplayedProductIds: [],
      selectedProductId: null
    },
    ...overrides
  };
}

function validTryOnUploadRequest(overrides = {}) {
  return {
    selectedProductId: "mock-dress-001",
    consent: true,
    file: {
      name: "portrait.jpg",
      contentType: "image/jpeg",
      size: 1234
    },
    ...overrides
  };
}

function validTryOnTaskRequest(overrides = {}) {
  return {
    selectedProductId: "mock-dress-001",
    fileId: "uploaded/user+photo/id",
    turnstileToken: "valid-browser-token",
    ...overrides
  };
}

function catalogueWithUnavailableProduct(productId) {
  const catalogue = structuredClone(mockCatalogue);
  const product = catalogue.products.find(({ id }) => id === productId);
  product.virtualTryOn = { status: "unavailable" };
  return catalogue;
}

function request({
  path = CHAT_API_PATH,
  method = "POST",
  body = validChatRequest(),
  origin = allowedOrigin,
  contentType = "application/json"
} = {}) {
  const headers = {};

  if (origin) headers.Origin = origin;
  if (contentType) headers["Content-Type"] = contentType;

  return new Request(`https://api.skin-ai.example${path}`, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body) : undefined
  });
}

function completedOpenAiResponse(output) {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({ result: output })
            }
          ]
        }
      ]
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }
  );
}

function environment(overrides = {}) {
  return {
    OPENAI_API_KEY: "server-side-test-key",
    YOUCAM_API_KEY: "server-side-youcam-key",
    TURNSTILE_SECRET: "server-side-turnstile-secret",
    TURNSTILE_HOSTNAMES: "skin-ai.pages.dev",
    CHAT_RATE_LIMITER: {
      async limit() {
        return { success: true };
      }
    },
    TRY_ON_RATE_LIMITER: {
      async limit() {
        return { success: true };
      }
    },
    OPENAI_MODEL: "test-model",
    ALLOWED_ORIGIN: allowedOrigin,
    ...overrides
  };
}

function completedYouCamFileResponse() {
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
                headers: { "Content-Type": "image/jpg" }
              }
            ]
          }
        ]
      }
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }
  );
}

test("POST /api/chat returns the validated orchestration response", async () => {
  let providerCalls = 0;
  let rateLimitCalls = 0;
  const worker = createWorker({
    logger: silentLogger,
    fetchImpl: async (_url, options) => {
      providerCalls += 1;
      assert.equal(options.headers.Authorization, "Bearer server-side-test-key");

      return completedOpenAiResponse({
        requestStatus: "supported",
        searchReady: false,
        reply: "It means the garment opens completely down the front.",
        requirements: null
      });
    }
  });

  const response = await worker.fetch(
    request(),
    environment({
      CHAT_RATE_LIMITER: {
        async limit({ key }) {
          rateLimitCalls += 1;
          assert.equal(key, "chat:unknown");
          return { success: true };
        }
      }
    })
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), allowedOrigin);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(body.conversationId, "conversation-123");
  assert.equal(body.searchPerformed, false);
  assert.equal(body.results, null);
  assert.equal(providerCalls, 1);
  assert.equal(rateLimitCalls, 1);
});

test("POST /api/chat returns 429 before OpenAI when rate limited", async () => {
  let providerCalls = 0;
  const worker = createWorker({
    logger: silentLogger,
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("OpenAI must not be called");
    }
  });

  const response = await worker.fetch(
    request(),
    environment({
      CHAT_RATE_LIMITER: {
        async limit() {
          return { success: false };
        }
      }
    })
  );
  const body = await response.json();

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(body.error.code, "CHAT_RATE_LIMITED");
  assert.equal(providerCalls, 0);
});

test("GET /api/tailors returns normalized nearby services without OpenAI", async () => {
  let providerCalls = 0;
  let rateLimitCalls = 0;
  const worker = createWorker({
    logger: silentLogger,
    fetchImpl: async (url) => {
      providerCalls += 1;
      assert.match(url, /^https:\/\/overpass-api\.de\/api\/interpreter/);
      return new Response(
        JSON.stringify({
          elements: [
            {
              type: "node",
              id: 42,
              lat: 51.501,
              lon: -0.125,
              tags: { name: "Central Alterations", shop: "tailor" }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  });

  const response = await worker.fetch(
    request({
      path: `${TAILORS_API_PATH}?latitude=51.5007&longitude=-0.1246`,
      method: "GET",
      body: null,
      contentType: null
    }),
    environment({
      CHAT_RATE_LIMITER: {
        async limit({ key }) {
          rateLimitCalls += 1;
          assert.equal(key, "tailors:unknown");
          return { success: true };
        }
      }
    })
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.locationLabel, "your current location");
  assert.equal(body.tailors[0].name, "Central Alterations");
  assert.equal(providerCalls, 1);
  assert.equal(rateLimitCalls, 1);
});

test("POST /api/try-on/upload returns safe temporary upload instructions", async () => {
  let providerCalls = 0;
  const worker = createWorker({
    logger: silentLogger,
    fetchImpl: async (_url, options) => {
      providerCalls += 1;
      assert.equal(options.headers.Authorization, "Bearer server-side-youcam-key");
      assert.deepEqual(JSON.parse(options.body), {
        files: [
          {
            content_type: "image/jpg",
            file_name: "portrait.jpg",
            file_size: 1234
          }
        ]
      });
      return completedYouCamFileResponse();
    }
  });

  const response = await worker.fetch(
    request({ path: TRY_ON_UPLOAD_API_PATH, body: validTryOnUploadRequest() }),
    environment()
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), allowedOrigin);
  assert.deepEqual(body, {
    selectedProductId: "mock-dress-001",
    fileId: "youcam-file-123",
    upload: {
      url: "https://uploads.example/photo?signature=temporary",
      method: "PUT",
      contentType: "image/jpg"
    }
  });
  assert.doesNotMatch(JSON.stringify(body), /server-side-youcam-key/);
  assert.equal(providerCalls, 1);
});

test("try-on upload rejects invalid input and unavailable products before YouCam", async (t) => {
  let providerCalls = 0;
  const worker = createWorker({
    catalogue: catalogueWithUnavailableProduct("mock-dress-002"),
    logger: silentLogger,
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("must not be called");
    }
  });

  await t.test("missing consent", async () => {
    const response = await worker.fetch(
      request({
        path: TRY_ON_UPLOAD_API_PATH,
        body: validTryOnUploadRequest({ consent: false })
      }),
      environment()
    );
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "INVALID_TRY_ON_UPLOAD_REQUEST");
  });

  await t.test("unavailable product", async () => {
    const response = await worker.fetch(
      request({
        path: TRY_ON_UPLOAD_API_PATH,
        body: validTryOnUploadRequest({ selectedProductId: "mock-dress-002" })
      }),
      environment()
    );
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.equal(body.error.code, "VIRTUAL_TRY_ON_UNAVAILABLE");
  });

  assert.equal(providerCalls, 0);
});

test("try-on upload reports missing YouCam configuration safely", async () => {
  const worker = createWorker({ logger: silentLogger });
  const response = await worker.fetch(
    request({ path: TRY_ON_UPLOAD_API_PATH, body: validTryOnUploadRequest() }),
    environment({ YOUCAM_API_KEY: undefined })
  );
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error.code, "TRY_ON_TEMPORARILY_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(body), /API key/);
});

test("POST /api/try-on/tasks creates a task with the trusted garment", async () => {
  let rateLimitCalls = 0;
  const worker = createWorker({
    logger: silentLogger,
    fetchImpl: async (url, options) => {
      if (url.includes("/turnstile/v0/siteverify")) {
        assert.equal(
          options.body.get("secret"),
          "server-side-turnstile-secret"
        );
        assert.equal(options.body.get("response"), "valid-browser-token");
        return new Response(
          JSON.stringify({
            success: true,
            hostname: "skin-ai.pages.dev",
            action: "try_on_generate"
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      assert.match(url, /\/s2s\/v2\.0\/task\/cloth-v3$/);
      assert.equal(options.headers.Authorization, "Bearer server-side-youcam-key");
      assert.deepEqual(JSON.parse(options.body), {
        src_file_id: "uploaded/user+photo/id",
        ref_file_url:
          "https://skin-ai.pages.dev/images/avery-front-zip-dress.png",
        garment_category: "full_body"
      });
      return new Response(
        JSON.stringify({
          status: 200,
          data: { task_id: "youcam_task-123" }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  });

  const response = await worker.fetch(
    request({ path: TRY_ON_TASKS_API_PATH, body: validTryOnTaskRequest() }),
    environment({
      TRY_ON_RATE_LIMITER: {
        async limit({ key }) {
          rateLimitCalls += 1;
          assert.equal(key, "try-on:unknown");
          return { success: true };
        }
      }
    })
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    selectedProductId: "mock-dress-001",
    taskId: "youcam_task-123",
    status: "processing"
  });
  assert.equal(rateLimitCalls, 1);
});

test("GET /api/try-on/tasks/:taskId returns the generated result", async () => {
  const worker = createWorker({
    logger: silentLogger,
    fetchImpl: async (url, options) => {
      assert.match(url, /\/s2s\/v2\.0\/task\/cloth-v3\/youcam_task-123$/);
      assert.equal(options.method, "GET");
      return new Response(
        JSON.stringify({
          status: 200,
          data: {
            task_status: "success",
            error: null,
            results: {
              url: "https://results.example/generated.jpg?temporary=1"
            }
          }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  });

  const response = await worker.fetch(
    request({
      path: `${TRY_ON_TASKS_API_PATH}/youcam_task-123`,
      method: "GET",
      body: null,
      contentType: null
    }),
    environment()
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    taskId: "youcam_task-123",
    status: "succeeded",
    resultUrl: "https://results.example/generated.jpg?temporary=1",
    error: null
  });
});

test("try-on task creation rejects browser-supplied garment data before YouCam", async () => {
  let youCamCalls = 0;
  const worker = createWorker({
    logger: silentLogger,
    fetchImpl: async (url) => {
      if (url.includes("/turnstile/v0/siteverify")) {
        return new Response(
          JSON.stringify({
            success: true,
            hostname: "skin-ai.pages.dev",
            action: "try_on_generate"
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      youCamCalls += 1;
      throw new Error("YouCam must not be called");
    }
  });
  const response = await worker.fetch(
    request({
      path: TRY_ON_TASKS_API_PATH,
      body: {
        ...validTryOnTaskRequest(),
        ref_file_url: "https://attacker.example/garment.png"
      }
    }),
    environment()
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_TRY_ON_TASK_REQUEST");
  assert.equal(youCamCalls, 0);
});

test("try-on task creation requires Turnstile before rate limiting or YouCam", async () => {
  let rateLimitCalls = 0;
  let youCamCalls = 0;
  const worker = createWorker({
    logger: silentLogger,
    fetchImpl: async (url) => {
      if (url.includes("/turnstile/v0/siteverify")) {
        return new Response(
          JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      youCamCalls += 1;
      throw new Error("YouCam must not be called");
    }
  });
  const response = await worker.fetch(
    request({ path: TRY_ON_TASKS_API_PATH, body: validTryOnTaskRequest() }),
    environment({
      TRY_ON_RATE_LIMITER: {
        async limit() {
          rateLimitCalls += 1;
          return { success: true };
        }
      }
    })
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "HUMAN_VERIFICATION_REQUIRED");
  assert.equal(rateLimitCalls, 0);
  assert.equal(youCamCalls, 0);
});

test("try-on task creation returns 429 before YouCam when rate limited", async () => {
  let youCamCalls = 0;
  const worker = createWorker({
    logger: silentLogger,
    fetchImpl: async (url) => {
      if (url.includes("/turnstile/v0/siteverify")) {
        return new Response(
          JSON.stringify({
            success: true,
            hostname: "skin-ai.pages.dev",
            action: "try_on_generate"
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      youCamCalls += 1;
      throw new Error("YouCam must not be called");
    }
  });
  const response = await worker.fetch(
    request({ path: TRY_ON_TASKS_API_PATH, body: validTryOnTaskRequest() }),
    environment({
      TRY_ON_RATE_LIMITER: {
        async limit() {
          return { success: false };
        }
      }
    })
  );

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal((await response.json()).error.code, "TRY_ON_RATE_LIMITED");
  assert.equal(youCamCalls, 0);
});

test("rejects invalid chat data before calling OpenAI", async () => {
  let providerCalls = 0;
  const worker = createWorker({
    logger: silentLogger,
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("must not be called");
    }
  });
  const response = await worker.fetch(
    request({ body: validChatRequest({ currentMessage: "" }) }),
    environment()
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "INVALID_CHAT_REQUEST");
  assert.equal(providerCalls, 0);
});

test("handles CORS preflight for the configured frontend", async () => {
  const worker = createWorker({ logger: silentLogger });
  const response = await worker.fetch(
    request({ method: "OPTIONS", body: null }),
    environment()
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), allowedOrigin);
  assert.equal(
    response.headers.get("Access-Control-Allow-Methods"),
    "GET, POST, OPTIONS"
  );
});

test("rejects browser requests from an unconfigured origin", async () => {
  const worker = createWorker({ logger: silentLogger });
  const response = await worker.fetch(
    request({ origin: "https://untrusted.example" }),
    environment()
  );
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(body.error.code, "ORIGIN_NOT_ALLOWED");
});

test("returns controlled HTTP errors for routing and body failures", async (t) => {
  const worker = createWorker({ logger: silentLogger });

  await t.test("unknown route", async () => {
    const response = await worker.fetch(request({ path: "/missing" }), environment());
    assert.equal(response.status, 404);
  });

  await t.test("wrong method", async () => {
    const response = await worker.fetch(
      request({ method: "GET", body: null }),
      environment()
    );
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "POST, OPTIONS");
  });

  await t.test("wrong content type", async () => {
    const response = await worker.fetch(
      request({ contentType: "text/plain" }),
      environment()
    );
    assert.equal(response.status, 415);
  });

  await t.test("malformed JSON", async () => {
    const malformedRequest = new Request(
      `https://api.skin-ai.example${CHAT_API_PATH}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: allowedOrigin
        },
        body: "{not-json"
      }
    );
    const response = await worker.fetch(malformedRequest, environment());
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "INVALID_JSON");
  });

  await t.test("oversized body", async () => {
    const response = await worker.fetch(
      request({
        body: validChatRequest({
          currentMessage: "x".repeat(MAX_CHAT_REQUEST_BYTES)
        })
      }),
      environment()
    );
    const body = await response.json();

    assert.equal(response.status, 413);
    assert.equal(body.error.code, "REQUEST_TOO_LARGE");
  });
});

test("does not expose provider failure details", async () => {
  const worker = createWorker({
    logger: silentLogger,
    fetchImpl: async () => {
      throw new Error("private provider and network details");
    }
  });

  const response = await worker.fetch(request(), environment());
  const responseText = await response.text();

  assert.equal(response.status, 503);
  assert.match(responseText, /CHAT_TEMPORARILY_UNAVAILABLE/);
  assert.doesNotMatch(responseText, /private provider/);
});

test("reports missing browser-origin configuration without calling OpenAI", async () => {
  let providerCalls = 0;
  const worker = createWorker({
    logger: silentLogger,
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("must not be called");
    }
  });
  const response = await worker.fetch(
    request(),
    environment({ ALLOWED_ORIGIN: undefined })
  );
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error.code, "SERVER_MISCONFIGURED");
  assert.equal(providerCalls, 0);
});
