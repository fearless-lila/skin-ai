import { buildChatResponse } from "./build-chat-response.js";
import {
  assertValidChatRequest,
  assertValidLlmResponse
} from "./validate-chat-contracts.js";
import { matchProducts } from "../matching/match-products.js";

export const CHAT_WORKFLOW_STEP = Object.freeze({
  VALIDATE_REQUEST: "validate_request",
  LOAD_TRUSTED_CONTEXT: "load_trusted_context",
  INTERPRET_MESSAGE: "interpret_message",
  VALIDATE_INTERPRETATION: "validate_interpretation",
  MATCH_CATALOGUE: "match_catalogue",
  BUILD_RESPONSE: "build_response"
});

export class ChatWorkflowError extends Error {
  constructor({ code, step, message, cause }) {
    super(message, cause ? { cause } : undefined);
    this.name = "ChatWorkflowError";
    this.code = code;
    this.step = step;
  }
}

/**
 * Run one deterministic chat turn.
 *
 * `interpretMessage` is injected so tests can use a fake LLM and production can
 * later supply the real provider call without changing the workflow.
 */
export async function handleChatTurn(
  chatRequest,
  {
    catalogue,
    interpretMessage,
    createConversationId = defaultCreateConversationId,
    runMatcher = matchProducts,
    assembleResponse = buildChatResponse,
    onStep = null
  } = {}
) {
  assertWorkflowDependencies({
    catalogue,
    interpretMessage,
    createConversationId,
    runMatcher,
    assembleResponse,
    onStep
  });

  let state = {
    chatRequest,
    catalogue,
    conversationId: null,
    trustedProducts: [],
    llmResponse: null,
    matchResults: null,
    response: null
  };

  state = runNode(
    CHAT_WORKFLOW_STEP.VALIDATE_REQUEST,
    state,
    validateRequestNode,
    onStep
  );
  state = runNode(
    CHAT_WORKFLOW_STEP.LOAD_TRUSTED_CONTEXT,
    state,
    (currentState) =>
      loadTrustedContextNode(currentState, createConversationId),
    onStep
  );
  state = await runAsyncNode(
    CHAT_WORKFLOW_STEP.INTERPRET_MESSAGE,
    state,
    (currentState) => interpretMessageNode(currentState, interpretMessage),
    onStep
  );
  state = runNode(
    CHAT_WORKFLOW_STEP.VALIDATE_INTERPRETATION,
    state,
    validateInterpretationNode,
    onStep
  );

  if (state.llmResponse.searchReady) {
    state = runNode(
      CHAT_WORKFLOW_STEP.MATCH_CATALOGUE,
      state,
      (currentState) => matchCatalogueNode(currentState, runMatcher),
      onStep
    );
  }

  state = runNode(
    CHAT_WORKFLOW_STEP.BUILD_RESPONSE,
    state,
    (currentState) => buildResponseNode(currentState, assembleResponse),
    onStep
  );

  return state.response;
}

function validateRequestNode(state) {
  assertValidChatRequest(state.chatRequest);
  return state;
}

function loadTrustedContextNode(state, createConversationId) {
  const conversationId =
    state.chatRequest.conversationId ?? createConversationId();

  if (
    typeof conversationId !== "string" ||
    conversationId.length < 1 ||
    conversationId.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(conversationId)
  ) {
    throw new ChatWorkflowError({
      code: "CONVERSATION_ID_FAILED",
      step: CHAT_WORKFLOW_STEP.LOAD_TRUSTED_CONTEXT,
      message: "The backend did not produce a valid conversation ID."
    });
  }

  const productsById = indexCatalogueProducts(state.catalogue);
  const referencedIds = uniqueProductReferences(
    state.chatRequest.conversationState
  );
  const trustedProducts = referencedIds.map((productId) => {
    const product = productsById.get(productId);

    if (!product) {
      throw new ChatWorkflowError({
        code: "UNKNOWN_PRODUCT_REFERENCE",
        step: CHAT_WORKFLOW_STEP.LOAD_TRUSTED_CONTEXT,
        message: `The chat request referenced unknown product ID: ${productId}.`
      });
    }

    return product;
  });

  return {
    ...state,
    conversationId,
    trustedProducts
  };
}

async function interpretMessageNode(state, interpretMessage) {
  let llmResponse;

  try {
    llmResponse = await interpretMessage({
      conversationId: state.conversationId,
      currentMessage: state.chatRequest.currentMessage,
      recentMessages: state.chatRequest.recentMessages,
      currentRequirements:
        state.chatRequest.conversationState.currentRequirements,
      referencedProducts: state.trustedProducts
    });
  } catch (cause) {
    throw new ChatWorkflowError({
      code: "INTERPRETATION_FAILED",
      step: CHAT_WORKFLOW_STEP.INTERPRET_MESSAGE,
      message: "The language interpretation service failed.",
      cause
    });
  }

  return {
    ...state,
    llmResponse
  };
}

function validateInterpretationNode(state) {
  assertValidLlmResponse(state.llmResponse);
  return state;
}

function matchCatalogueNode(state, runMatcher) {
  let matchResults;

  try {
    matchResults = runMatcher(
      state.llmResponse.requirements,
      state.catalogue.products
    );
  } catch (cause) {
    throw new ChatWorkflowError({
      code: "MATCHING_FAILED",
      step: CHAT_WORKFLOW_STEP.MATCH_CATALOGUE,
      message: "Catalogue matching failed.",
      cause
    });
  }

  return {
    ...state,
    matchResults
  };
}

function buildResponseNode(state, assembleResponse) {
  let response;

  try {
    response = assembleResponse({
      conversationId: state.conversationId,
      llmResponse: state.llmResponse,
      previousRequirements:
        state.chatRequest.conversationState.currentRequirements,
      matchResults: state.matchResults,
      catalogue: state.llmResponse.searchReady ? state.catalogue : null
    });
  } catch (cause) {
    throw new ChatWorkflowError({
      code: "RESPONSE_BUILD_FAILED",
      step: CHAT_WORKFLOW_STEP.BUILD_RESPONSE,
      message: "The final chat response could not be assembled.",
      cause
    });
  }

  return {
    ...state,
    response
  };
}

function runNode(step, state, node, onStep) {
  recordStep(onStep, step);
  return node(state);
}

async function runAsyncNode(step, state, node, onStep) {
  recordStep(onStep, step);
  return node(state);
}

function recordStep(onStep, step) {
  if (onStep) {
    onStep(step);
  }
}

function indexCatalogueProducts(catalogue) {
  const productsById = new Map();

  for (const product of catalogue.products) {
    if (!product || typeof product !== "object" || !product.id) {
      throw new ChatWorkflowError({
        code: "INVALID_CATALOGUE",
        step: CHAT_WORKFLOW_STEP.LOAD_TRUSTED_CONTEXT,
        message: "The catalogue contains a product without a valid ID."
      });
    }

    if (productsById.has(product.id)) {
      throw new ChatWorkflowError({
        code: "INVALID_CATALOGUE",
        step: CHAT_WORKFLOW_STEP.LOAD_TRUSTED_CONTEXT,
        message: `The catalogue contains duplicate product ID: ${product.id}.`
      });
    }

    productsById.set(product.id, product);
  }

  return productsById;
}

function uniqueProductReferences(conversationState) {
  const productIds = [...conversationState.lastDisplayedProductIds];

  if (conversationState.selectedProductId) {
    productIds.push(conversationState.selectedProductId);
  }

  return [...new Set(productIds)];
}

function assertWorkflowDependencies({
  catalogue,
  interpretMessage,
  createConversationId,
  runMatcher,
  assembleResponse,
  onStep
}) {
  if (!catalogue || !Array.isArray(catalogue.products)) {
    throw new TypeError("A catalogue with products is required.");
  }

  for (const [name, dependency] of Object.entries({
    interpretMessage,
    createConversationId,
    runMatcher,
    assembleResponse
  })) {
    if (typeof dependency !== "function") {
      throw new TypeError(`${name} must be a function.`);
    }
  }

  if (onStep !== null && typeof onStep !== "function") {
    throw new TypeError("onStep must be a function or null.");
  }
}

function defaultCreateConversationId() {
  if (!globalThis.crypto?.randomUUID) {
    throw new ChatWorkflowError({
      code: "CONVERSATION_ID_FAILED",
      step: CHAT_WORKFLOW_STEP.LOAD_TRUSTED_CONTEXT,
      message: "The runtime could not create a conversation ID."
    });
  }

  return globalThis.crypto.randomUUID();
}
