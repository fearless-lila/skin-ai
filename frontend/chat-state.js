export const MAX_RECENT_MESSAGES = 12;
export const SESSION_STORAGE_KEY = "skin-ai.chat-session.v1";

export function createEmptyChatSession() {
  return {
    conversationId: null,
    recentMessages: [],
    conversationState: {
      currentRequirements: null,
      lastDisplayedProductIds: [],
      selectedProductId: null
    },
    displayResults: null
  };
}

export function buildChatRequest(session, currentMessage) {
  const message = String(currentMessage ?? "").trim();

  if (!message) {
    throw new TypeError("A message is required.");
  }

  return {
    conversationId: session.conversationId,
    currentMessage: message,
    recentMessages: session.recentMessages,
    conversationState: session.conversationState
  };
}

export function applyChatResponse(session, currentMessage, response) {
  assertChatResponseShape(response);

  const recentMessages = appendBoundedMessages(session.recentMessages, [
    { role: "user", content: String(currentMessage).trim() },
    { role: "assistant", content: response.reply }
  ]);
  const searchResultIds = response.searchPerformed
    ? collectDisplayedProductIds(response.results)
    : session.conversationState.lastDisplayedProductIds;
  const selectedProductId = searchResultIds.includes(
    session.conversationState.selectedProductId
  )
    ? session.conversationState.selectedProductId
    : null;

  return {
    conversationId: response.conversationId,
    recentMessages,
    conversationState: {
      currentRequirements: response.currentRequirements,
      lastDisplayedProductIds: searchResultIds,
      selectedProductId
    },
    displayResults: response.searchPerformed ? response.results : session.displayResults
  };
}

export function loadChatSession(storage = globalThis.sessionStorage) {
  if (!storage) return createEmptyChatSession();

  try {
    const saved = storage.getItem(SESSION_STORAGE_KEY);
    if (!saved) return createEmptyChatSession();

    const session = JSON.parse(saved);
    return isUsableSession(session) ? session : createEmptyChatSession();
  } catch {
    return createEmptyChatSession();
  }
}

export function saveChatSession(session, storage = globalThis.sessionStorage) {
  storage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearChatSession(storage = globalThis.sessionStorage) {
  storage?.removeItem(SESSION_STORAGE_KEY);
  return createEmptyChatSession();
}

function appendBoundedMessages(existingMessages, newMessages) {
  return [...existingMessages, ...newMessages].slice(-MAX_RECENT_MESSAGES);
}

function collectDisplayedProductIds(results) {
  if (!results) return [];

  return [
    ...(results.compatibleProducts ?? []),
    ...(results.productsWithMissingInformation ?? [])
  ].map((result) => result.product.id);
}

function assertChatResponseShape(response) {
  if (
    !response ||
    typeof response !== "object" ||
    typeof response.conversationId !== "string" ||
    typeof response.reply !== "string" ||
    typeof response.searchPerformed !== "boolean"
  ) {
    throw new TypeError("The chat service returned an unexpected response.");
  }
}

function isUsableSession(session) {
  return Boolean(
    session &&
      typeof session === "object" &&
      (session.conversationId === null ||
        typeof session.conversationId === "string") &&
      Array.isArray(session.recentMessages) &&
      session.recentMessages.length <= MAX_RECENT_MESSAGES &&
      session.conversationState &&
      typeof session.conversationState === "object" &&
      Array.isArray(session.conversationState.lastDisplayedProductIds)
  );
}
