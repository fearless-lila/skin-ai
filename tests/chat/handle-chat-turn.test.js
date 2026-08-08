import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CHAT_WORKFLOW_STEP,
  ChatWorkflowError,
  handleChatTurn
} from "../../src/chat/handle-chat-turn.js";
import {
  ChatRequestValidationError,
  LlmResponseValidationError
} from "../../src/chat/validate-chat-contracts.js";

const catalogue = JSON.parse(
  readFileSync(
    new URL("../../data/mock-catalogue.json", import.meta.url),
    "utf8"
  )
);

function requirements({
  garmentTypes,
  requiredAccess = {},
  excludedAccess = {},
  preferredAccess = {},
  requiredMeasurements = []
}) {
  return {
    garmentTypes,
    requiredAccess,
    excludedAccess,
    preferredAccess,
    requiredMeasurements
  };
}

function chatRequest({
  conversationId = "conversation-123",
  currentMessage = "Find me a front-opening dress.",
  recentMessages = [],
  currentRequirements = null,
  lastDisplayedProductIds = [],
  selectedProductId = null
} = {}) {
  return {
    conversationId,
    currentMessage,
    recentMessages,
    conversationState: {
      currentRequirements,
      lastDisplayedProductIds,
      selectedProductId
    }
  };
}

test("runs the complete search branch and records its workflow steps", async () => {
  const steps = [];
  const interpretedRequirements = requirements({
    garmentTypes: ["dress"],
    requiredAccess: {
      closureLocation: ["front"]
    },
    excludedAccess: {
      closureLocation: ["back"]
    }
  });
  let interpretationCalls = 0;

  const response = await handleChatTurn(chatRequest(), {
    catalogue,
    interpretMessage: async (context) => {
      interpretationCalls += 1;
      assert.equal(context.currentMessage, "Find me a front-opening dress.");
      assert.deepEqual(context.referencedProducts, []);

      return {
        requestStatus: "supported",
        searchReady: true,
        reply: "I found dresses with documented front openings.",
        requirements: interpretedRequirements
      };
    },
    onStep: (step) => steps.push(step)
  });

  assert.equal(interpretationCalls, 1);
  assert.equal(response.searchPerformed, true);
  assert.equal(response.results.compatibleProducts.length, 2);
  assert.equal(
    response.results.compatibleProducts[0].product.imageUrl,
    "https://skin-ai.pages.dev/images/avery-front-zip-dress.png"
  );
  assert.deepEqual(steps, [
    CHAT_WORKFLOW_STEP.VALIDATE_REQUEST,
    CHAT_WORKFLOW_STEP.LOAD_TRUSTED_CONTEXT,
    CHAT_WORKFLOW_STEP.INTERPRET_MESSAGE,
    CHAT_WORKFLOW_STEP.VALIDATE_INTERPRETATION,
    CHAT_WORKFLOW_STEP.MATCH_CATALOGUE,
    CHAT_WORKFLOW_STEP.BUILD_RESPONSE
  ]);
});

test("skips matching and retains requirements for a conversational reply", async () => {
  const previousRequirements = requirements({ garmentTypes: ["dress"] });
  let matcherCalls = 0;

  const response = await handleChatTurn(
    chatRequest({
      currentMessage: "What does a full front opening mean?",
      currentRequirements: previousRequirements
    }),
    {
      catalogue,
      interpretMessage: async () => ({
        requestStatus: "supported",
        searchReady: false,
        reply: "It means the garment opens completely down the front.",
        requirements: null
      }),
      runMatcher: () => {
        matcherCalls += 1;
        throw new Error("The matcher should not run.");
      }
    }
  );

  assert.equal(matcherCalls, 0);
  assert.equal(response.searchPerformed, false);
  assert.deepEqual(response.currentRequirements, previousRequirements);
  assert.equal(response.results, null);
});

test("creates a conversation ID when the frontend does not have one", async () => {
  const response = await handleChatTurn(
    chatRequest({ conversationId: null }),
    {
      catalogue,
      createConversationId: () => "conversation-created-by-backend",
      interpretMessage: async () => ({
        requestStatus: "supported",
        searchReady: false,
        reply: "Tell me which type of clothing you need.",
        requirements: null
      })
    }
  );

  assert.equal(response.conversationId, "conversation-created-by-backend");
});

test("stops before interpretation when the backend creates an invalid ID", async () => {
  let interpretationCalls = 0;

  await assert.rejects(
    () =>
      handleChatTurn(chatRequest({ conversationId: null }), {
        catalogue,
        createConversationId: () => "invalid conversation id",
        interpretMessage: async () => {
          interpretationCalls += 1;
          return {};
        }
      }),
    (error) => {
      assert.ok(error instanceof ChatWorkflowError);
      assert.equal(error.code, "CONVERSATION_ID_FAILED");
      assert.equal(error.step, CHAT_WORKFLOW_STEP.LOAD_TRUSTED_CONTEXT);
      return true;
    }
  );
  assert.equal(interpretationCalls, 0);
});

test("reloads referenced products from the trusted catalogue", async () => {
  let receivedProducts;

  await handleChatTurn(
    chatRequest({
      currentMessage: "Why did this dress match?",
      lastDisplayedProductIds: ["mock-dress-001", "mock-dress-003"],
      selectedProductId: "mock-dress-001"
    }),
    {
      catalogue,
      interpretMessage: async (context) => {
        receivedProducts = context.referencedProducts;

        return {
          requestStatus: "supported",
          searchReady: false,
          reply: "It has a documented front opening.",
          requirements: null
        };
      }
    }
  );

  assert.deepEqual(
    receivedProducts.map(({ id }) => id),
    ["mock-dress-001", "mock-dress-003"]
  );
  assert.equal(receivedProducts[0].access.closureLocation.value, "front");
});

test("rejects an invalid browser request before calling the interpreter", async () => {
  let interpretationCalls = 0;
  const invalidRequest = chatRequest();
  invalidRequest.unexpected = "not allowed";

  await assert.rejects(
    () =>
      handleChatTurn(invalidRequest, {
        catalogue,
        interpretMessage: async () => {
          interpretationCalls += 1;
          return {};
        }
      }),
    ChatRequestValidationError
  );
  assert.equal(interpretationCalls, 0);
});

test("rejects unknown browser product references before calling the interpreter", async () => {
  let interpretationCalls = 0;

  await assert.rejects(
    () =>
      handleChatTurn(
        chatRequest({ selectedProductId: "invented-product" }),
        {
          catalogue,
          interpretMessage: async () => {
            interpretationCalls += 1;
            return {};
          }
        }
      ),
    (error) => {
      assert.ok(error instanceof ChatWorkflowError);
      assert.equal(error.code, "UNKNOWN_PRODUCT_REFERENCE");
      assert.equal(error.step, CHAT_WORKFLOW_STEP.LOAD_TRUSTED_CONTEXT);
      return true;
    }
  );
  assert.equal(interpretationCalls, 0);
});

test("rejects invalid LLM output before matching", async () => {
  let matcherCalls = 0;

  await assert.rejects(
    () =>
      handleChatTurn(chatRequest(), {
        catalogue,
        interpretMessage: async () => ({
          requestStatus: "supported",
          searchReady: true,
          reply: "I will search without valid requirements.",
          requirements: null
        }),
        runMatcher: () => {
          matcherCalls += 1;
          return {};
        }
      }),
    LlmResponseValidationError
  );
  assert.equal(matcherCalls, 0);
});

test("wraps an LLM service failure with a safe workflow error", async () => {
  const providerError = new Error("private provider failure details");

  await assert.rejects(
    () =>
      handleChatTurn(chatRequest(), {
        catalogue,
        interpretMessage: async () => {
          throw providerError;
        }
      }),
    (error) => {
      assert.ok(error instanceof ChatWorkflowError);
      assert.equal(error.code, "INTERPRETATION_FAILED");
      assert.equal(error.step, CHAT_WORKFLOW_STEP.INTERPRET_MESSAGE);
      assert.equal(error.cause, providerError);
      assert.doesNotMatch(error.message, /private provider/);
      return true;
    }
  );
});

test("wraps deterministic matching failures and does not build a response", async () => {
  let responseBuildCalls = 0;
  const contradictoryRequirements = requirements({
    garmentTypes: ["dress"],
    requiredAccess: { closureType: ["zip"] },
    excludedAccess: { closureType: ["zip"] }
  });

  await assert.rejects(
    () =>
      handleChatTurn(chatRequest(), {
        catalogue,
        interpretMessage: async () => ({
          requestStatus: "supported",
          searchReady: true,
          reply: "I will search for dresses.",
          requirements: contradictoryRequirements
        }),
        assembleResponse: () => {
          responseBuildCalls += 1;
          return {};
        }
      }),
    (error) => {
      assert.ok(error instanceof ChatWorkflowError);
      assert.equal(error.code, "MATCHING_FAILED");
      assert.equal(error.step, CHAT_WORKFLOW_STEP.MATCH_CATALOGUE);
      return true;
    }
  );
  assert.equal(responseBuildCalls, 0);
});
