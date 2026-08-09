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
    recentMessages: session.recentMessages.map(({ role, content }) => ({
      role,
      content
    })),
    conversationState: session.conversationState
  };
}

export function addTryOnResultMessage(
  session,
  { taskId, productId, productName, resultUrl }
) {
  const normalizedTaskId = String(taskId ?? "").trim();
  const normalizedProductId = String(productId ?? "").trim();
  const normalizedProductName = String(productName ?? "").trim();
  const normalizedResultUrl = String(resultUrl ?? "").trim();

  if (
    !normalizedTaskId ||
    !normalizedProductId ||
    !normalizedProductName ||
    !normalizedResultUrl
  ) {
    throw new TypeError("A complete virtual try-on result is required.");
  }

  const resultAlreadyRecorded = session.recentMessages.some(
    (message) =>
      message.attachment?.type === "try_on_result" &&
      message.attachment.taskId === normalizedTaskId
  );
  if (resultAlreadyRecorded) return session;

  const resultMessage = {
    role: "assistant",
    content: `Here is your virtual clothing preview with ${normalizedProductName}. This may help you decide whether a physical try-on is worth the effort.`,
    attachment: {
      type: "try_on_result",
      taskId: normalizedTaskId,
      productId: normalizedProductId,
      imageUrl: normalizedResultUrl,
      alt: `AI-generated virtual clothing preview using ${normalizedProductName}`
    }
  };

  return {
    ...session,
    recentMessages: appendBoundedMessages(session.recentMessages, [resultMessage])
  };
}

export function applyChatResponse(session, currentMessage, response) {
  assertChatResponseShape(response);

  const assistantMessage = {
    role: "assistant",
    content: response.reply,
    ...(response.searchPerformed
      ? {
          attachment: {
            type: "product_results",
            results: response.results
          }
        }
      : {})
  };
  const recentMessages = appendBoundedMessages(session.recentMessages, [
    { role: "user", content: String(currentMessage).trim() },
    assistantMessage
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
    return isUsableSession(session)
      ? migrateLegacyProductResults(removeLegacyTailorResults(session))
      : createEmptyChatSession();
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

export function selectProductForTryOn(session, product) {
  if (!product || product.virtualTryOnAvailable !== true) {
    throw new TypeError("This product is not available for virtual try-on.");
  }

  if (!session.conversationState.lastDisplayedProductIds.includes(product.id)) {
    throw new TypeError("The selected product is not in the current results.");
  }

  return {
    ...session,
    conversationState: {
      ...session.conversationState,
      selectedProductId: product.id
    }
  };
}

export function activateProductResults(session, results) {
  if (
    !results ||
    typeof results !== "object" ||
    !Array.isArray(results.compatibleProducts) ||
    !Array.isArray(results.productsWithMissingInformation)
  ) {
    throw new TypeError("A complete product result set is required.");
  }

  const displayedProductIds = collectDisplayedProductIds(results);
  const selectedProductId = displayedProductIds.includes(
    session.conversationState.selectedProductId
  )
    ? session.conversationState.selectedProductId
    : null;

  return {
    ...session,
    conversationState: {
      ...session.conversationState,
      lastDisplayedProductIds: displayedProductIds,
      selectedProductId
    },
    displayResults: results
  };
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
      session.recentMessages.every(isUsableMessage) &&
      session.conversationState &&
      typeof session.conversationState === "object" &&
      Array.isArray(session.conversationState.lastDisplayedProductIds)
  );
}

function isUsableMessage(message) {
  if (
    !message ||
    typeof message !== "object" ||
    !["user", "assistant"].includes(message.role) ||
    typeof message.content !== "string"
  ) {
    return false;
  }

  if (message.attachment === undefined) return true;

  const attachment = message.attachment;
  if (
    message.role !== "assistant" ||
    !attachment ||
    typeof attachment !== "object"
  ) {
    return false;
  }

  if (attachment.type === "try_on_result") {
    return Boolean(
      typeof attachment.taskId === "string" &&
        typeof attachment.productId === "string" &&
        typeof attachment.imageUrl === "string" &&
        typeof attachment.alt === "string"
    );
  }

  if (attachment.type === "product_results") {
    return Boolean(
      attachment.results &&
        typeof attachment.results === "object" &&
        Array.isArray(attachment.results.compatibleProducts) &&
        Array.isArray(attachment.results.productsWithMissingInformation)
    );
  }

  if (attachment.type === "tailor_results") {
    return isUsableTailorResults(attachment);
  }

  return false;
}

function isUsableTailorResults(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.locationLabel === "string" &&
      Number.isFinite(value.radiusMetres) &&
      Array.isArray(value.tailors) &&
      value.tailors.length <= 8 &&
      typeof value.attribution === "string" &&
      value.tailors.every(
        (tailor) =>
          tailor &&
          typeof tailor === "object" &&
          typeof tailor.id === "string" &&
          typeof tailor.name === "string" &&
          typeof tailor.address === "string" &&
          Number.isFinite(tailor.distanceMetres) &&
          typeof tailor.mapUrl === "string"
      )
  );
}

function migrateLegacyProductResults(session) {
  if (
    !session.displayResults ||
    session.recentMessages.some(
      (message) => message.attachment?.type === "product_results"
    )
  ) {
    return session;
  }

  const messageIndex = session.recentMessages.findLastIndex(
    (message) => message.role === "assistant" && message.attachment === undefined
  );
  if (messageIndex < 0) return session;

  const recentMessages = [...session.recentMessages];
  recentMessages[messageIndex] = {
    ...recentMessages[messageIndex],
    attachment: {
      type: "product_results",
      results: session.displayResults
    }
  };

  return {
    ...session,
    recentMessages
  };
}

function removeLegacyTailorResults(session) {
  return {
    ...session,
    recentMessages: session.recentMessages.filter(
      (message) => message.attachment?.type !== "tailor_results"
    )
  };
}
