import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import chatRequestSchema from "../../schemas/chat-request.schema.json" with {
  type: "json"
};
import llmResponseSchema from "../../schemas/llm-response.schema.json" with {
  type: "json"
};
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

const validateChatRequest = ajv.compile(chatRequestSchema);
const validateLlmResponse = ajv.compile(llmResponseSchema);

export class ChatRequestValidationError extends Error {
  constructor(errors) {
    super("The chat request failed schema validation.");
    this.name = "ChatRequestValidationError";
    this.code = "INVALID_CHAT_REQUEST";
    this.step = "validate_request";
    this.errors = errors ? structuredClone(errors) : [];
  }
}

export class LlmResponseValidationError extends Error {
  constructor(errors) {
    super("The LLM response failed schema validation.");
    this.name = "LlmResponseValidationError";
    this.code = "INVALID_LLM_RESPONSE";
    this.step = "validate_interpretation";
    this.errors = errors ? structuredClone(errors) : [];
  }
}

export function assertValidChatRequest(chatRequest) {
  if (!validateChatRequest(chatRequest)) {
    throw new ChatRequestValidationError(validateChatRequest.errors);
  }

  return chatRequest;
}

export function assertValidLlmResponse(llmResponse) {
  if (!validateLlmResponse(llmResponse)) {
    throw new LlmResponseValidationError(validateLlmResponse.errors);
  }

  return llmResponse;
}
