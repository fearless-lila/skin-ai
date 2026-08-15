import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_RECENT_MESSAGES,
  SESSION_STORAGE_KEY,
  activateProductResults,
  addTryOnResultMessage,
  applyChatResponse,
  buildChatRequest,
  clearChatSession,
  createEmptyChatSession,
  loadChatSession,
  resetMeasurementProfile,
  saveChatSession,
  selectProductForTryOn,
  setMeasurementProfile
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

test("records a try-on image in local history without sending image data to the backend", () => {
  const session = addTryOnResultMessage(createEmptyChatSession(), {
    taskId: "task-123",
    productId: "mock-dress-001",
    productName: "Avery Front-Zip Dress",
    resultUrl: "https://example.com/generated-preview.jpg"
  });

  assert.deepEqual(session.recentMessages[0], {
    role: "assistant",
    content:
      "Here is your virtual clothing preview with Avery Front-Zip Dress. This may help you decide whether a physical try-on is worth the effort.",
    attachment: {
      type: "try_on_result",
      taskId: "task-123",
      productId: "mock-dress-001",
      imageUrl: "https://example.com/generated-preview.jpg",
      alt: "AI-generated virtual clothing preview using Avery Front-Zip Dress"
    }
  });

  assert.deepEqual(buildChatRequest(session, "Does this colour suit me?"), {
    conversationId: null,
    currentMessage: "Does this colour suit me?",
    recentMessages: [
      {
        role: "assistant",
        content:
          "Here is your virtual clothing preview with Avery Front-Zip Dress. This may help you decide whether a physical try-on is worth the effort."
      }
    ],
    conversationState: {
      currentRequirements: null,
      lastDisplayedProductIds: [],
      selectedProductId: null
    }
  });
});

test("restores try-on image messages and does not record the same task twice", () => {
  const storage = memoryStorage();
  const first = addTryOnResultMessage(createEmptyChatSession(), {
    taskId: "task-123",
    productId: "mock-dress-001",
    productName: "Avery Front-Zip Dress",
    resultUrl: "https://example.com/generated-preview.jpg"
  });
  const duplicate = addTryOnResultMessage(first, {
    taskId: "task-123",
    productId: "mock-dress-001",
    productName: "Avery Front-Zip Dress",
    resultUrl: "https://example.com/generated-preview.jpg"
  });

  saveChatSession(duplicate, storage);

  assert.equal(duplicate, first);
  assert.deepEqual(loadChatSession(storage), first);
  assert.equal(first.recentMessages.length, 1);
});

test("removes previously saved tailor results from chat history", () => {
  const session = createEmptyChatSession();
  session.recentMessages = [
    { role: "user", content: "Find a front-opening dress" },
    {
      role: "assistant",
      content: "I found 1 nearby tailor shop.",
      attachment: {
        type: "tailor_results",
        locationLabel: "Leeds, West Yorkshire, United Kingdom",
        radiusMetres: 8000,
        attribution: "© OpenStreetMap contributors",
        tailors: [
          {
            id: "node-42",
            name: "City Alterations",
            address: "1 Sample Street, Leeds",
            distanceMetres: 430,
            mapUrl: "https://www.openstreetmap.org/node/42"
          }
        ]
      }
    }
  ];
  const storage = memoryStorage();
  saveChatSession(session, storage);

  const restored = loadChatSession(storage);
  assert.deepEqual(restored.recentMessages, [
    { role: "user", content: "Find a front-opening dress" }
  ]);
});

test("applies a response and records bounded conversation context", () => {
  const oldMessages = Array.from({ length: MAX_RECENT_MESSAGES }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Message ${index}`
  }));
  const session = createEmptyChatSession();
  session.recentMessages = oldMessages;

  const chatResponse = response();
  const next = applyChatResponse(
    session,
    "Find a front-opening dress",
    chatResponse
  );

  assert.equal(next.conversationId, "conversation-456");
  assert.equal(next.recentMessages.length, MAX_RECENT_MESSAGES);
  assert.deepEqual(next.recentMessages.at(-2), {
    role: "user",
    content: "Find a front-opening dress"
  });
  assert.deepEqual(next.recentMessages.at(-1), {
    role: "assistant",
    content: "I found a front-opening option.",
    attachment: {
      type: "product_results",
      results: chatResponse.results
    }
  });
  assert.deepEqual(next.conversationState.lastDisplayedProductIds, [
    "mock-dress-001"
  ]);
});

test("keeps product cards with their assistant message but strips them from the next request", () => {
  const chatResponse = response();
  const session = applyChatResponse(
    createEmptyChatSession(),
    "Find a front-opening dress",
    chatResponse
  );
  const storage = memoryStorage();

  saveChatSession(session, storage);
  const restored = loadChatSession(storage);
  const request = buildChatRequest(restored, "Show me a cardigan instead");

  assert.deepEqual(
    restored.recentMessages.at(-1).attachment.results,
    chatResponse.results
  );
  assert.deepEqual(request.recentMessages.at(-1), {
    role: "assistant",
    content: "I found a front-opening option."
  });
  assert.equal("attachment" in request.recentMessages.at(-1), false);
});

test("moves legacy bottom-of-page results into the saved assistant message", () => {
  const storage = memoryStorage();
  const legacySession = createEmptyChatSession();
  legacySession.recentMessages = [
    { role: "user", content: "Find a front-opening dress" },
    { role: "assistant", content: "I found a front-opening option." }
  ];
  legacySession.displayResults = response().results;
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(legacySession));

  const restored = loadChatSession(storage);

  assert.equal(
    restored.recentMessages.at(-1).attachment.type,
    "product_results"
  );
  assert.deepEqual(
    restored.recentMessages.at(-1).attachment.results,
    legacySession.displayResults
  );
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

test("keeps a measurement profile for the conversation and can reset it", () => {
  const storage = memoryStorage();
  const session = setMeasurementProfile(createEmptyChatSession(), {
    chest: 92,
    waist: 78
  });

  saveChatSession(session, storage);
  assert.deepEqual(loadChatSession(storage).measurementProfile, {
    chest: 92,
    waist: 78
  });

  const reset = resetMeasurementProfile(session);
  assert.equal(reset.measurementProfile, null);
  assert.deepEqual(session.measurementProfile, { chest: 92, waist: 78 });
});

test("does not send the local measurement profile to chat", () => {
  const session = setMeasurementProfile(createEmptyChatSession(), { chest: 92 });
  const request = buildChatRequest(session, "Find me a dress");

  assert.equal("measurementProfile" in request, false);
  assert.equal("measurementProfile" in request.conversationState, false);
});

test("keeps the saved measurement profile after a chat turn", () => {
  const session = setMeasurementProfile(createEmptyChatSession(), { chest: 92 });
  const next = applyChatResponse(session, "Find me a dress", response());

  assert.deepEqual(next.measurementProfile, { chest: 92 });
});

test("ignores corrupted or unusable stored data", () => {
  const storage = memoryStorage();
  storage.setItem(SESSION_STORAGE_KEY, "not-json");
  assert.deepEqual(loadChatSession(storage), createEmptyChatSession());

  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ recentMessages: "wrong" }));
  assert.deepEqual(loadChatSession(storage), createEmptyChatSession());
});

test("selects a displayed product that is ready for virtual try-on", () => {
  const session = createEmptyChatSession();
  session.conversationState.lastDisplayedProductIds = ["mock-dress-001"];

  const next = selectProductForTryOn(session, {
    id: "mock-dress-001",
    virtualTryOnAvailable: true
  });

  assert.equal(next.conversationState.selectedProductId, "mock-dress-001");
  assert.equal(session.conversationState.selectedProductId, null);
});

test("rejects unavailable or undisplayed try-on selections", () => {
  const session = createEmptyChatSession();
  session.conversationState.lastDisplayedProductIds = ["mock-dress-001"];

  assert.throws(
    () =>
      selectProductForTryOn(session, {
        id: "mock-dress-001",
        virtualTryOnAvailable: false
      }),
    /not available/
  );
  assert.throws(
    () =>
      selectProductForTryOn(session, {
        id: "mock-dress-999",
        virtualTryOnAvailable: true
      }),
    /not in the current results/
  );
});

test("reactivates an older result set before selecting its product", () => {
  const session = createEmptyChatSession();
  session.conversationState.lastDisplayedProductIds = ["mock-dress-001"];
  session.displayResults = response().results;
  const olderResults = {
    ...response().results,
    compatibleProducts: [
      {
        product: { id: "mock-cardigan-001", virtualTryOnAvailable: true },
        compatibility: {}
      }
    ]
  };

  const activated = activateProductResults(session, olderResults);
  const selected = selectProductForTryOn(
    activated,
    olderResults.compatibleProducts[0].product
  );

  assert.deepEqual(activated.conversationState.lastDisplayedProductIds, [
    "mock-cardigan-001"
  ]);
  assert.equal(activated.displayResults, olderResults);
  assert.equal(selected.conversationState.selectedProductId, "mock-cardigan-001");
});
