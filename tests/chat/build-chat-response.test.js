import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ChatResponseValidationError,
  buildChatResponse
} from "../../src/chat/build-chat-response.js";
import { matchProducts } from "../../src/matching/match-products.js";

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

test("joins matcher results with trusted product-card data", () => {
  const currentRequirements = requirements({
    garmentTypes: ["dress"],
    requiredAccess: {
      closureLocation: ["front"]
    },
    excludedAccess: {
      closureLocation: ["back"]
    }
  });
  const matchResults = matchProducts(currentRequirements, catalogue.products);

  const response = buildChatResponse({
    conversationId: "conversation-123",
    llmResponse: {
      requestStatus: "supported",
      searchReady: true,
      reply: "I found dresses with documented front openings.",
      requirements: currentRequirements
    },
    matchResults,
    catalogue
  });

  assert.equal(response.searchPerformed, true);
  assert.equal(response.results.catalogueType, "mock");
  assert.equal(response.results.compatibleProducts.length, 2);
  assert.equal(response.results.rejectedProductCount, 6);

  const avery = response.results.compatibleProducts.find(
    ({ product }) => product.id === "mock-dress-001"
  );
  assert.ok(avery);
  assert.equal(
    avery.product.imageUrl,
    "https://skin-ai.pages.dev/images/avery-front-zip-dress.png"
  );
  assert.equal(avery.product.virtualTryOnAvailable, true);
  assert.equal("virtualTryOn" in avery.product, false);
  assert.equal(avery.product.price.amount, 68);
  assert.deepEqual(
    avery.product.measurements.filter(({ size }) => size === "M"),
    [
      { size: "M", name: "chest", valueCm: 100 },
      { size: "M", name: "waist", valueCm: 86 }
    ]
  );
  assert.equal("sourceUrl" in avery.product.measurements[0], false);
  assert.ok(
    avery.compatibility.confirmedMatches.some(
      ({ field, evidenceStatus }) =>
        field === "access.closureLocation" &&
        evidenceStatus === "retailer_provided"
    )
  );

  const nora = response.results.compatibleProducts.find(
    ({ product }) => product.id === "mock-dress-003"
  );
  assert.ok(nora);
  assert.equal(nora.product.virtualTryOnAvailable, true);
});

test("keeps previous requirements for a conversational follow-up", () => {
  const previousRequirements = requirements({ garmentTypes: ["dress"] });

  const response = buildChatResponse({
    conversationId: "conversation-123",
    llmResponse: {
      requestStatus: "supported",
      searchReady: false,
      reply: "A full front opening separates completely down the front.",
      requirements: null
    },
    previousRequirements
  });

  assert.deepEqual(response.currentRequirements, previousRequirements);
  assert.equal(response.searchPerformed, false);
  assert.equal(response.results, null);
});

test("replaces previous requirements when the LLM supplies a complete update", () => {
  const previousRequirements = requirements({ garmentTypes: ["dress"] });
  const updatedRequirements = requirements({
    garmentTypes: ["dress"],
    excludedAccess: {
      closureType: ["zip"]
    }
  });

  const response = buildChatResponse({
    conversationId: "conversation-123",
    llmResponse: {
      requestStatus: "supported",
      searchReady: false,
      reply: "Understood. I will keep that requirement for the next search.",
      requirements: updatedRequirements
    },
    previousRequirements
  });

  assert.deepEqual(response.currentRequirements, updatedRequirements);
});

test("preserves earlier requirements after an unsupported message", () => {
  const previousRequirements = requirements({ garmentTypes: ["dress"] });

  const response = buildChatResponse({
    conversationId: "conversation-123",
    llmResponse: {
      requestStatus: "unsupported",
      searchReady: false,
      reply: "I cannot book flights, but I can help with clothing.",
      requirements: null
    },
    previousRequirements
  });

  assert.deepEqual(response.currentRequirements, previousRequirements);
  assert.equal(response.results, null);
});

test("joins missing-information results without presenting them as compatible", () => {
  const currentRequirements = requirements({
    garmentTypes: ["blouse"],
    requiredAccess: {
      closureLocation: ["front"]
    }
  });
  const matchResults = matchProducts(currentRequirements, catalogue.products);

  const response = buildChatResponse({
    conversationId: "conversation-123",
    llmResponse: {
      requestStatus: "supported",
      searchReady: true,
      reply: "The blouse is missing fastening-location information.",
      requirements: currentRequirements
    },
    matchResults,
    catalogue
  });

  assert.equal(response.results.compatibleProducts.length, 0);
  assert.equal(response.results.productsWithMissingInformation.length, 1);
  assert.equal(
    response.results.productsWithMissingInformation[0].compatibility.status,
    "missing_information"
  );
});

test("maps compatible measurement evidence into display-safe values", () => {
  const currentRequirements = requirements({
    garmentTypes: ["dress"],
    requiredMeasurements: [
      {
        name: "chest",
        minimumCm: 98,
        maximumCm: 102
      }
    ]
  });
  const matchResults = matchProducts(currentRequirements, catalogue.products);

  const response = buildChatResponse({
    conversationId: "conversation-123",
    llmResponse: {
      requestStatus: "supported",
      searchReady: true,
      reply: "I found a dress with a documented size in that range.",
      requirements: currentRequirements
    },
    matchResults,
    catalogue
  });

  const avery = response.results.compatibleProducts.find(
    ({ product }) => product.id === "mock-dress-001"
  );
  const measurement = avery.compatibility.confirmedMatches.find(
    ({ field }) => field === "measurements"
  );

  assert.deepEqual(measurement.actualValues, ["Size M", "chest: 100 cm"]);
  assert.equal(measurement.evidenceStatus, "retailer_provided");
});

test("rejects matcher IDs that are absent from the trusted catalogue", () => {
  const currentRequirements = requirements({ garmentTypes: ["dress"] });
  const matchResults = matchProducts(currentRequirements, catalogue.products);
  matchResults.compatibleProducts[0].productId = "invented-product";

  assert.throws(
    () =>
      buildChatResponse({
        conversationId: "conversation-123",
        llmResponse: {
          requestStatus: "supported",
          searchReady: true,
          reply: "I found a dress.",
          requirements: currentRequirements
        },
        matchResults,
        catalogue
      }),
    /unknown catalogue product ID/
  );
});

test("rejects final responses that fail the chat-response schema", () => {
  assert.throws(
    () =>
      buildChatResponse({
        conversationId: "invalid conversation id with spaces",
        llmResponse: {
          requestStatus: "supported",
          searchReady: false,
          reply: "This response has an invalid conversation ID.",
          requirements: null
        }
      }),
    ChatResponseValidationError
  );
});
