import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import { handleChatTurn } from "../../src/chat/handle-chat-turn.js";
import {
  DEFAULT_OPENAI_MODEL,
  OPENAI_RESPONSES_ENDPOINT,
  OpenAiInterpretationError,
  buildOpenAiRequest,
  createOpenAiInterpreter
} from "../../src/chat/openai-interpret-message.js";
import openAiLlmResponseSchema from "../../schemas/openai-llm-response.schema.json" with {
  type: "json"
};

const catalogue = JSON.parse(
  readFileSync(
    new URL("../../data/mock-catalogue.json", import.meta.url),
    "utf8"
  )
);
const validateOpenAiOutput = new Ajv2020({ strict: true }).compile(
  openAiLlmResponseSchema
);

function context({
  currentMessage = "Find me a front-opening dress.",
  recentMessages = [],
  currentRequirements = null,
  referencedProducts = []
} = {}) {
  return {
    conversationId: "conversation-123",
    currentMessage,
    recentMessages,
    currentRequirements,
    referencedProducts
  };
}

function completedResponse(output) {
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

function completeRequirements(overrides = {}) {
  return {
    garmentTypes: ["dress"],
    occasion: null,
    requiredAccess: {
      closureType: [],
      closureLocation: ["front"],
      dressingMethod: [],
      gripFeature: [],
      openingExtent: []
    },
    excludedAccess: {
      closureType: [],
      closureLocation: [],
      dressingMethod: [],
      gripFeature: [],
      openingExtent: []
    },
    preferredAccess: {
      closureType: [],
      closureLocation: [],
      dressingMethod: [],
      gripFeature: [],
      openingExtent: []
    },
    requiredMeasurements: [],
    ...overrides
  };
}

test("builds one strict Responses API request with bounded conversation context", () => {
  const request = buildOpenAiRequest(
    context({
      currentMessage: "Actually, exclude zips.",
      recentMessages: [
        { role: "user", content: "Find me a dress." },
        { role: "assistant", content: "What access needs should I consider?" }
      ],
      currentRequirements: {
        garmentTypes: ["dress"],
        requiredAccess: {},
        excludedAccess: {},
        preferredAccess: {},
        requiredMeasurements: []
      },
      referencedProducts: [{ id: "mock-dress-001", name: "Demo dress" }]
    })
  );

  assert.equal(request.model, DEFAULT_OPENAI_MODEL);
  assert.equal(request.store, false);
  assert.deepEqual(request.reasoning, { effort: "none" });
  assert.equal(request.text.verbosity, "low");
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.schema.type, "object");
  assert.deepEqual(request.text.format.schema.required, ["result"]);
  assert.equal(
    request.text.format.schema.properties.result.anyOf.length,
    3
  );
  assert.deepEqual(
    request.input.map(({ role }) => role),
    ["developer", "user", "assistant", "user"]
  );
  assert.equal(
    request.input.filter(({ content }) =>
      content.includes("Actually, exclude zips.")
    ).length,
    1
  );
  assert.match(request.input[0].content, /mock-dress-001/);
  assert.doesNotMatch(JSON.stringify(request), /api-key-for-test/);
});

test("generation variants reject combinations outside the allowed matrix", () => {
  assert.equal(
    validateOpenAiOutput({
      result: {
        requestStatus: "unsupported",
        searchReady: false,
        reply: "I can help with clothing requests.",
        requirements: null
      }
    }),
    true
  );

  assert.equal(
    validateOpenAiOutput({
      result: {
        requestStatus: "unsupported",
        searchReady: true,
        reply: "I will search.",
        requirements: null
      }
    }),
    false
  );

  assert.equal(
    validateOpenAiOutput({
      result: {
        requestStatus: "supported",
        searchReady: true,
        reply: "I will search.",
        requirements: null
      }
    }),
    false
  );
});

test("calls the Responses API and normalizes nullable schema fields", async () => {
  let receivedUrl;
  let receivedOptions;
  let requestCount = 0;
  const interpreter = createOpenAiInterpreter({
    apiKey: "api-key-for-test",
    fetchImpl: async (url, options) => {
      requestCount += 1;
      receivedUrl = url;
      receivedOptions = options;

      return completedResponse({
        requestStatus: "supported",
        searchReady: true,
        reply: "I’ll look for front-opening dresses in your requested range.",
        requirements: completeRequirements({
          requiredMeasurements: [
            {
              name: "chest",
              minimumCm: 98,
              maximumCm: null
            }
          ]
        })
      });
    }
  });

  const result = await interpreter(context());
  const body = JSON.parse(receivedOptions.body);

  assert.equal(receivedUrl, OPENAI_RESPONSES_ENDPOINT);
  assert.equal(receivedOptions.method, "POST");
  assert.equal(
    receivedOptions.headers.Authorization,
    "Bearer api-key-for-test"
  );
  assert.doesNotMatch(receivedOptions.body, /api-key-for-test/);
  assert.equal(body.model, DEFAULT_OPENAI_MODEL);
  assert.equal(requestCount, 1);
  assert.equal(result.requirements.occasion, undefined);
  assert.deepEqual(result.requirements.requiredMeasurements[0], {
    name: "chest",
    minimumCm: 98
  });
});

test("returns null requirements unchanged for a conversational response", async () => {
  const interpreter = createOpenAiInterpreter({
    apiKey: "api-key-for-test",
    fetchImpl: async () =>
      completedResponse({
        requestStatus: "supported",
        searchReady: false,
        reply: "A full front opening separates completely down the front.",
        requirements: null
      })
  });

  const result = await interpreter(context());

  assert.equal(result.requirements, null);
  assert.equal(result.searchReady, false);
});

test("makes one correction attempt after deeper backend validation fails", async () => {
  const requestBodies = [];
  let requestCount = 0;
  const interpreter = createOpenAiInterpreter({
    apiKey: "api-key-for-test",
    fetchImpl: async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      requestCount += 1;

      if (requestCount === 1) {
        return completedResponse({
          requestStatus: "supported",
          searchReady: true,
          reply: "I’ll look for dresses with zips while excluding zips.",
          requirements: completeRequirements({
            requiredAccess: {
              closureType: ["zip"],
              closureLocation: [],
              dressingMethod: [],
              gripFeature: [],
              openingExtent: []
            },
            excludedAccess: {
              closureType: ["zip"],
              closureLocation: [],
              dressingMethod: [],
              gripFeature: [],
              openingExtent: []
            }
          })
        });
      }

      return completedResponse({
        requestStatus: "supported",
        searchReady: true,
        reply: "I’ll look for dresses and exclude zip fastenings.",
        requirements: completeRequirements({
          requiredAccess: {
            closureType: [],
            closureLocation: [],
            dressingMethod: [],
            gripFeature: [],
            openingExtent: []
          },
          excludedAccess: {
            closureType: ["zip"],
            closureLocation: [],
            dressingMethod: [],
            gripFeature: [],
            openingExtent: []
          }
        })
      });
    }
  });

  const result = await interpreter(context());

  assert.equal(requestCount, 2);
  assert.deepEqual(result.requirements.excludedAccess.closureType, ["zip"]);
  assert.deepEqual(result.requirements.requiredAccess.closureType, []);
  assert.equal(requestBodies[1].input.at(-1).role, "developer");
  assert.match(requestBodies[1].input.at(-1).content, /CORRECTION REQUIRED/);
  assert.match(
    requestBodies[1].input.at(-1).content,
    /both required and excluded/
  );
});

test("stops after one unsuccessful correction attempt", async () => {
  let requestCount = 0;
  const contradictoryOutput = {
    requestStatus: "supported",
    searchReady: true,
    reply: "I’ll search using contradictory requirements.",
    requirements: completeRequirements({
      requiredAccess: {
        closureType: ["zip"],
        closureLocation: [],
        dressingMethod: [],
        gripFeature: [],
        openingExtent: []
      },
      excludedAccess: {
        closureType: ["zip"],
        closureLocation: [],
        dressingMethod: [],
        gripFeature: [],
        openingExtent: []
      }
    })
  };
  const interpreter = createOpenAiInterpreter({
    apiKey: "api-key-for-test",
    fetchImpl: async () => {
      requestCount += 1;
      return completedResponse(contradictoryOutput);
    }
  });

  await assert.rejects(
    () => interpreter(context()),
    (error) => {
      assert.ok(error instanceof OpenAiInterpretationError);
      assert.equal(error.code, "OPENAI_INVALID_INTERPRETATION");
      return true;
    }
  );
  assert.equal(requestCount, 2);
});

test("plugs into handleChatTurn and reaches deterministic product matching", async () => {
  const interpreter = createOpenAiInterpreter({
    apiKey: "api-key-for-test",
    fetchImpl: async () =>
      completedResponse({
        requestStatus: "supported",
        searchReady: true,
        reply: "I’ll look for dresses with documented front openings.",
        requirements: completeRequirements()
      })
  });

  const response = await handleChatTurn(
    {
      conversationId: "conversation-123",
      currentMessage: "Find me a front-opening dress.",
      recentMessages: [],
      conversationState: {
        currentRequirements: null,
        lastDisplayedProductIds: [],
        selectedProductId: null
      }
    },
    {
      catalogue,
      interpretMessage: interpreter
    }
  );

  assert.equal(response.searchPerformed, true);
  assert.ok(response.results.compatibleProducts.length > 0);
  assert.equal(
    response.results.compatibleProducts[0].product.imageUrl,
    "https://demo.skin-ai.example/images/mock-dress-001.jpg"
  );
});

test("reports HTTP failures without exposing the provider response body", async () => {
  const interpreter = createOpenAiInterpreter({
    apiKey: "api-key-for-test",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ error: { message: "private provider details" } }),
        {
          status: 429,
          headers: { "Content-Type": "application/json" }
        }
      )
  });

  await assert.rejects(
    () => interpreter(context()),
    (error) => {
      assert.ok(error instanceof OpenAiInterpretationError);
      assert.equal(error.code, "OPENAI_HTTP_ERROR");
      assert.equal(error.status, 429);
      assert.doesNotMatch(error.message, /private provider/);
      return true;
    }
  );
});

test("detects an explicit model refusal", async () => {
  const interpreter = createOpenAiInterpreter({
    apiKey: "api-key-for-test",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "refusal", refusal: "Cannot assist." }]
            }
          ]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
  });

  await assert.rejects(
    () => interpreter(context()),
    (error) => {
      assert.equal(error.code, "OPENAI_REFUSAL");
      return true;
    }
  );
});

test("rejects malformed structured output text", async () => {
  const interpreter = createOpenAiInterpreter({
    apiKey: "api-key-for-test",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "not-json" }]
            }
          ]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
  });

  await assert.rejects(
    () => interpreter(context()),
    (error) => {
      assert.equal(error.code, "OPENAI_INVALID_JSON");
      return true;
    }
  );
});

test("requires a backend API key when creating the interpreter", () => {
  assert.throws(
    () => createOpenAiInterpreter({ apiKey: "" }),
    /apiKey must be a non-empty string/
  );
});
