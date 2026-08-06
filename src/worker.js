import mockCatalogue from "../data/mock-catalogue.json" with { type: "json" };

import {
  ChatWorkflowError,
  handleChatTurn
} from "./chat/handle-chat-turn.js";
import {
  DEFAULT_OPENAI_MODEL,
  createOpenAiInterpreter
} from "./chat/openai-interpret-message.js";
import {
  ChatRequestValidationError,
  LlmResponseValidationError
} from "./chat/validate-chat-contracts.js";
import { ChatResponseValidationError } from "./chat/build-chat-response.js";

export const CHAT_API_PATH = "/api/chat";
export const MAX_CHAT_REQUEST_BYTES = 32 * 1024;

/**
 * Build a Worker around injectable boundaries so the HTTP behaviour can be
 * tested without a live OpenAI request.
 */
export function createWorker({
  catalogue = mockCatalogue,
  fetchImpl = globalThis.fetch,
  logger = console
} = {}) {
  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);

      if (url.pathname !== CHAT_API_PATH) {
        return jsonResponse(
          404,
          publicError("NOT_FOUND", "This API route does not exist.")
        );
      }

      const cors = resolveCors(request, env.ALLOWED_ORIGIN);

      if (!cors.allowed) {
        return jsonResponse(
          cors.missingConfiguration ? 500 : 403,
          publicError(
            cors.missingConfiguration
              ? "SERVER_MISCONFIGURED"
              : "ORIGIN_NOT_ALLOWED",
            cors.missingConfiguration
              ? "The chat service is not configured for browser requests."
              : "This website is not allowed to call the chat service."
          ),
          cors.headers
        );
      }

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: cors.headers
        });
      }

      if (request.method !== "POST") {
        return jsonResponse(
          405,
          publicError("METHOD_NOT_ALLOWED", "Use POST for this API route."),
          {
            ...cors.headers,
            Allow: "POST, OPTIONS"
          }
        );
      }

      if (!isJsonRequest(request)) {
        return jsonResponse(
          415,
          publicError(
            "UNSUPPORTED_MEDIA_TYPE",
            "Send the request body as application/json."
          ),
          cors.headers
        );
      }

      let chatRequest;

      try {
        chatRequest = await readJsonRequest(request);
      } catch (error) {
        const tooLarge = error instanceof RequestTooLargeError;

        return jsonResponse(
          tooLarge ? 413 : 400,
          publicError(
            tooLarge ? "REQUEST_TOO_LARGE" : "INVALID_JSON",
            tooLarge
              ? "The chat request is too large."
              : "The request body is not valid JSON."
          ),
          cors.headers
        );
      }

      try {
        const interpretMessage = createOpenAiInterpreter({
          apiKey: env.OPENAI_API_KEY,
          model: env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
          fetchImpl
        });
        const response = await handleChatTurn(chatRequest, {
          catalogue,
          interpretMessage
        });

        return jsonResponse(200, response, cors.headers);
      } catch (error) {
        logOperationalError(logger, error);
        const mapped = mapPublicError(error);

        return jsonResponse(
          mapped.status,
          publicError(mapped.code, mapped.message),
          cors.headers
        );
      }
    }
  };
}

export default createWorker();

class RequestTooLargeError extends Error {}

async function readJsonRequest(request) {
  const declaredLength = Number(request.headers.get("Content-Length"));

  if (Number.isFinite(declaredLength) && declaredLength > MAX_CHAT_REQUEST_BYTES) {
    throw new RequestTooLargeError();
  }

  const body = await request.text();
  const actualLength = new TextEncoder().encode(body).byteLength;

  if (actualLength > MAX_CHAT_REQUEST_BYTES) {
    throw new RequestTooLargeError();
  }

  return JSON.parse(body);
}

function isJsonRequest(request) {
  return (
    request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() ===
    "application/json"
  );
}

function resolveCors(request, configuredOrigins) {
  const requestOrigin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };

  // Non-browser callers do not send Origin and are not governed by CORS.
  if (!requestOrigin) {
    return { allowed: true, headers };
  }

  const allowedOrigins = String(configuredOrigins ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (allowedOrigins.length === 0) {
    return { allowed: false, missingConfiguration: true, headers };
  }

  if (!allowedOrigins.includes(requestOrigin)) {
    return { allowed: false, missingConfiguration: false, headers };
  }

  return {
    allowed: true,
    headers: {
      ...headers,
      "Access-Control-Allow-Origin": requestOrigin
    }
  };
}

function mapPublicError(error) {
  if (error instanceof ChatRequestValidationError) {
    return {
      status: 400,
      code: "INVALID_CHAT_REQUEST",
      message: "The chat request contains invalid or missing fields."
    };
  }

  if (
    error instanceof ChatWorkflowError &&
    error.code === "UNKNOWN_PRODUCT_REFERENCE"
  ) {
    return {
      status: 400,
      code: "UNKNOWN_PRODUCT_REFERENCE",
      message: "The conversation references a product that is no longer available."
    };
  }

  if (
    error instanceof ChatWorkflowError &&
    error.code === "INTERPRETATION_FAILED"
  ) {
    return {
      status: 503,
      code: "CHAT_TEMPORARILY_UNAVAILABLE",
      message: "I cannot process that message right now. Please try again."
    };
  }

  if (
    error instanceof LlmResponseValidationError ||
    error instanceof ChatResponseValidationError
  ) {
    return {
      status: 502,
      code: "INVALID_SERVICE_RESPONSE",
      message: "The chat service produced an invalid response. Please try again."
    };
  }

  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "The chat service could not complete the request."
  };
}

function logOperationalError(logger, error) {
  if (typeof logger?.error !== "function") {
    return;
  }

  logger.error("Chat request failed", {
    name: error?.name ?? "Error",
    code: error?.code ?? "UNEXPECTED_ERROR",
    step: error?.step ?? null,
    status: error?.status ?? null
  });
}

function publicError(code, message) {
  return {
    error: {
      code,
      message
    }
  };
}

function jsonResponse(status, body, additionalHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...additionalHeaders
    }
  });
}
