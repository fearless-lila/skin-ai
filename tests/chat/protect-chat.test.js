import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatProtectionError,
  enforceChatRateLimit
} from "../../src/chat/protect-chat.js";

test("passes the visitor key to the configured chat rate limiter", async () => {
  let receivedKey;

  await enforceChatRateLimit({
    limiter: {
      async limit({ key }) {
        receivedKey = key;
        return { success: true };
      }
    },
    key: "chat:192.0.2.1"
  });

  assert.equal(receivedKey, "chat:192.0.2.1");
});

test("rejects chat requests when the visitor exceeds the limit", async () => {
  await assert.rejects(
    enforceChatRateLimit({
      limiter: { async limit() { return { success: false }; } },
      key: "chat:192.0.2.1"
    }),
    (error) =>
      error instanceof ChatProtectionError &&
      error.code === "CHAT_RATE_LIMITED"
  );
});

test("fails closed when the chat limiter is not configured", async () => {
  await assert.rejects(
    enforceChatRateLimit({ limiter: undefined, key: "chat:192.0.2.1" }),
    (error) =>
      error instanceof ChatProtectionError &&
      error.code === "RATE_LIMITER_MISCONFIGURED"
  );
});
