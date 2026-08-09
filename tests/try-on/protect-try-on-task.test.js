import assert from "node:assert/strict";
import test from "node:test";

import {
  TURNSTILE_SITEVERIFY_URL,
  TURNSTILE_TRY_ON_ACTION,
  TryOnProtectionError,
  createTurnstileVerifier,
  enforceTryOnRateLimit
} from "../../src/try-on/protect-try-on-task.js";

function verificationResponse(overrides = {}) {
  return new Response(
    JSON.stringify({
      success: true,
      hostname: "skin-ai.pages.dev",
      action: TURNSTILE_TRY_ON_ACTION,
      "error-codes": [],
      ...overrides
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }
  );
}

test("verifies a single-use Turnstile token for the expected action and host", async () => {
  let capturedUrl;
  let capturedOptions;
  const verify = createTurnstileVerifier({
    secret: "private-turnstile-secret",
    expectedHostnames: "skin-ai.pages.dev",
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return verificationResponse();
    }
  });

  assert.deepEqual(
    await verify({ token: "browser-token", remoteIp: "192.0.2.1" }),
    { verified: true }
  );
  assert.equal(capturedUrl, TURNSTILE_SITEVERIFY_URL);
  assert.equal(capturedOptions.method, "POST");
  assert.equal(capturedOptions.body.get("secret"), "private-turnstile-secret");
  assert.equal(capturedOptions.body.get("response"), "browser-token");
  assert.equal(capturedOptions.body.get("remoteip"), "192.0.2.1");
});

test("rejects invalid, wrong-action and wrong-host Turnstile responses", async (t) => {
  for (const testCase of [
    { name: "rejected token", response: { success: false } },
    { name: "wrong action", response: { action: "different_action" } },
    { name: "wrong hostname", response: { hostname: "attacker.example" } }
  ]) {
    await t.test(testCase.name, async () => {
      const verify = createTurnstileVerifier({
        secret: "test-secret",
        expectedHostnames: "skin-ai.pages.dev",
        fetchImpl: async () => verificationResponse(testCase.response)
      });

      await assert.rejects(
        verify({ token: "browser-token" }),
        (error) =>
          error instanceof TryOnProtectionError &&
          error.code === "TURNSTILE_REJECTED"
      );
    });
  }
});

test("requires the private secret and expected hostname configuration", () => {
  assert.throws(
    () =>
      createTurnstileVerifier({
        secret: "",
        expectedHostnames: "skin-ai.pages.dev"
      }),
    (error) =>
      error instanceof TryOnProtectionError &&
      error.code === "TURNSTILE_MISCONFIGURED"
  );
});

test("allows or rejects generation using the configured rate limiter", async () => {
  let receivedKey;
  await enforceTryOnRateLimit({
    limiter: {
      async limit({ key }) {
        receivedKey = key;
        return { success: true };
      }
    },
    key: "try-on:192.0.2.1"
  });
  assert.equal(receivedKey, "try-on:192.0.2.1");

  await assert.rejects(
    enforceTryOnRateLimit({
      limiter: { async limit() { return { success: false }; } },
      key: "try-on:192.0.2.1"
    }),
    (error) =>
      error instanceof TryOnProtectionError &&
      error.code === "TRY_ON_RATE_LIMITED"
  );
});
