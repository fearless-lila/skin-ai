import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import chatResponseSchema from "../../schemas/chat-response.schema.json" with {
  type: "json"
};
import { hasReadyTryOnConfiguration } from "../try-on/virtual-try-on-config.js";
import userRequirementsSchema from "../../schemas/user-requirements.schema.json" with {
  type: "json"
};

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false
});

addFormats(ajv);
ajv.addSchema(userRequirementsSchema);

const validateResponse = ajv.compile(chatResponseSchema);

export class ChatResponseValidationError extends Error {
  constructor(errors) {
    super("The assembled chat response failed schema validation.");
    this.name = "ChatResponseValidationError";
    this.errors = errors ? structuredClone(errors) : [];
  }
}

/**
 * Assemble internal backend results into the safe response displayed by the
 * frontend. This function does not call the LLM, search the catalogue, or
 * decide compatibility.
 */
export function buildChatResponse({
  conversationId,
  llmResponse,
  previousRequirements = null,
  matchResults = null,
  catalogue = null
}) {
  if (!llmResponse || typeof llmResponse !== "object") {
    throw new TypeError("llmResponse must be an object.");
  }

  const currentRequirements =
    llmResponse.requirements ?? previousRequirements ?? null;
  const searchPerformed = llmResponse.searchReady === true;

  const response = {
    conversationId,
    requestStatus: llmResponse.requestStatus,
    reply: llmResponse.reply,
    currentRequirements,
    searchPerformed,
    results: searchPerformed
      ? buildSearchResults({ matchResults, catalogue })
      : null
  };

  return assertValidChatResponse(response);
}

export function assertValidChatResponse(response) {
  if (!validateResponse(response)) {
    throw new ChatResponseValidationError(validateResponse.errors);
  }

  return response;
}

function buildSearchResults({ matchResults, catalogue }) {
  if (!matchResults || typeof matchResults !== "object") {
    throw new TypeError("matchResults are required when a search was performed.");
  }

  if (!catalogue || !Array.isArray(catalogue.products)) {
    throw new TypeError(
      "A catalogue with products is required when a search was performed."
    );
  }

  for (const group of [
    "compatibleProducts",
    "productsWithMissingInformation",
    "rejectedProducts"
  ]) {
    if (!Array.isArray(matchResults[group])) {
      throw new TypeError(`matchResults.${group} must be an array.`);
    }
  }

  const productsById = indexProducts(catalogue.products);

  return {
    catalogueType: catalogue.catalogueType,
    notice: catalogue.notice ?? null,
    compatibleProducts: matchResults.compatibleProducts.map((matchResult) =>
      joinProductResult(matchResult, "compatible", productsById)
    ),
    productsWithMissingInformation:
      matchResults.productsWithMissingInformation.map((matchResult) =>
        joinProductResult(matchResult, "missing_information", productsById)
      ),
    rejectedProductCount: matchResults.rejectedProducts.length
  };
}

function indexProducts(products) {
  const productsById = new Map();

  for (const product of products) {
    if (productsById.has(product.id)) {
      throw new TypeError(`Duplicate catalogue product ID: ${product.id}.`);
    }

    productsById.set(product.id, product);
  }

  return productsById;
}

function joinProductResult(matchResult, expectedStatus, productsById) {
  if (matchResult.status !== expectedStatus) {
    throw new TypeError(
      `Product ${matchResult.productId} is in the wrong matcher result group.`
    );
  }

  const product = productsById.get(matchResult.productId);

  if (!product) {
    throw new TypeError(
      `Matcher returned unknown catalogue product ID: ${matchResult.productId}.`
    );
  }

  return {
    product: buildProductCard(product),
    compatibility: buildCompatibilitySummary(matchResult)
  };
}

function buildProductCard(product) {
  const imageUrl = product.imageUrls?.[0];

  if (!imageUrl) {
    throw new TypeError(`Product ${product.id} has no display image URL.`);
  }

  return {
    id: product.id,
    name: product.name,
    retailer: {
      id: product.retailer.id,
      name: product.retailer.name
    },
    imageUrl,
    productUrl: product.productUrl,
    price: product.price ?? null,
    availability: product.availability ?? "unknown",
    sizes: product.sizes,
    measurements: product.measurements.map(({ size, name, valueCm }) => ({
      size,
      name,
      valueCm
    })),
    virtualTryOnAvailable: hasReadyTryOnConfiguration(product)
  };
}

function buildCompatibilitySummary(matchResult) {
  return {
    status: matchResult.status,
    compatibleSizes: matchResult.compatibleSizes,
    confirmedMatches: matchResult.confirmedMatches.flatMap(mapConfirmedFact),
    missingInformation: matchResult.missingInformation.map(mapMissingFact),
    preferenceMatches: matchResult.preferenceMatches.map(mapPreferenceFact),
    preferenceScore: matchResult.preferenceScore
  };
}

function mapConfirmedFact(fact) {
  if (fact.field === "measurements") {
    return mapConfirmedMeasurements(fact);
  }

  return [
    {
      field: fact.field,
      requirementType: fact.requirementType,
      actualValues: [String(fact.actual)],
      ...mapEvidence(fact.evidence)
    }
  ];
}

function mapConfirmedMeasurements(fact) {
  const mapped = [];

  for (const sizeResult of fact.actual ?? []) {
    for (const measurement of sizeResult.measurements ?? []) {
      mapped.push({
        field: "measurements",
        requirementType: fact.requirementType,
        actualValues: [
          `Size ${sizeResult.size}`,
          `${measurement.name}: ${measurement.valueCm} cm`
        ],
        ...mapEvidence(measurement)
      });
    }
  }

  return mapped;
}

function mapPreferenceFact(fact) {
  return {
    field: fact.field,
    actualValues: [String(fact.actual)],
    ...mapEvidence(fact.evidence)
  };
}

function mapMissingFact(fact) {
  return {
    field: fact.field,
    requirementType: fact.requirementType,
    requestedValues: formatRequestedValues(fact.expected),
    reason: fact.reason
  };
}

function formatRequestedValues(expected) {
  if (!Array.isArray(expected)) {
    return [String(expected)];
  }

  return expected.map((value) => {
    if (value && typeof value === "object" && value.name) {
      return formatMeasurementRequirement(value);
    }

    return String(value);
  });
}

function formatMeasurementRequirement(requirement) {
  const { name, minimumCm, maximumCm } = requirement;

  if (minimumCm !== undefined && maximumCm !== undefined) {
    return `${name}: ${minimumCm}-${maximumCm} cm`;
  }

  if (minimumCm !== undefined) {
    return `${name}: at least ${minimumCm} cm`;
  }

  return `${name}: at most ${maximumCm} cm`;
}

function mapEvidence(evidence) {
  return {
    evidenceStatus: evidence?.status ?? null,
    sourceText: evidence?.sourceText ?? null,
    sourceUrl: evidence?.sourceUrl ?? null,
    verifiedAt: evidence?.verifiedAt ?? null
  };
}
