import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_RECENT_MESSAGES,
  SESSION_STORAGE_KEY,
  applyChatResponse,
  buildChatRequest,
  clearChatSession,
  createEmptyChatSession,
  loadChatSession,
  saveChatSession
} from "../../frontend/chat-state.js";

function response(overrides = {}) {
  return {
    conversationId: "conversation-456",
    requestStatus: "supported",
    reply: "I found a front-opening option.",
    currentRequirements: { garmentTypes: ["dress"] },
    searchPerformed: true,
    results: {
      compatibleProducts: [
        { product: { id: "mock-dress-001" }, compatibility: {} }
      ],
      productsWithMissingInformation: [],
      rejectedProductCount: 0,
      catalogueType: "mock",
      notice: "Fictional catalogue"
    },
    ...overrides
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

test("builds only the backend chat-request fields", () => {
  const session = createEmptyChatSession();
  session.displayResults = { localOnly: true };

  assert.deepEqual(buildChatRequest(session, "  Find a dress  "), {
    conversationId: null,
    currentMessage: "Find a dress",
    recentMessages: [],
    conversationState: {
      currentRequirements: null,
      lastDisplayedProductIds: [],
      selectedProductId: null
    }
  });
});

test("applies a response and records bounded conversation context", () => {
  const oldMessages = Array.from({ length: MAX_RECENT_MESSAGES }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Message ${index}`
  }));
  const session = createEmptyChatSession();
  session.recentMessages = oldMessages;

  const next = applyChatResponse(session, "Find a front-opening dress", response());

  assert.equal(next.conversationId, "conversation-456");
  assert.equal(next.recentMessages.length, MAX_RECENT_MESSAGES);
  assert.deepEqual(next.recentMessages.at(-2), {
    role: "user",
    content: "Find a front-opening dress"
  });
  assert.deepEqual(next.recentMessages.at(-1), {
    role: "assistant",
    content: "I found a front-opening option."
  });
  assert.deepEqual(next.conversationState.lastDisplayedProductIds, [
    "mock-dress-001"
  ]);
});

test("keeps displayed product context when no new search runs", () => {
  const session = createEmptyChatSession();
  session.conversationState.lastDisplayedProductIds = ["mock-dress-001"];
  session.conversationState.selectedProductId = "mock-dress-001";
  session.displayResults = response().results;

  const next = applyChatResponse(
    session,
    "What does full front opening mean?",
    response({
      reply: "It means the garment opens completely down the front.",
      searchPerformed: false,
      results: null,
      currentRequirements: null
    })
  );

  assert.deepEqual(next.conversationState.lastDisplayedProductIds, [
    "mock-dress-001"
  ]);
  assert.equal(next.conversationState.selectedProductId, "mock-dress-001");
  assert.equal(next.displayResults, session.displayResults);
});

test("saves, restores and clears session state", () => {
  const storage = memoryStorage();
  const session = createEmptyChatSession();
  session.conversationId = "conversation-789";

  saveChatSession(session, storage);
  assert.equal(storage.getItem(SESSION_STORAGE_KEY), JSON.stringify(session));
  assert.deepEqual(loadChatSession(storage), session);

  assert.deepEqual(clearChatSession(storage), createEmptyChatSession());
  assert.equal(storage.getItem(SESSION_STORAGE_KEY), null);
});

test("ignores corrupted or unusable stored data", () => {
  const storage = memoryStorage();
  storage.setItem(SESSION_STORAGE_KEY, "not-json");
  assert.deepEqual(loadChatSession(storage), createEmptyChatSession());

  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ recentMessages: "wrong" }));
  assert.deepEqual(loadChatSession(storage), createEmptyChatSession());
});
