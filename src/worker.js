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
import {
  ChatProtectionError,
  enforceChatRateLimit
} from "./chat/protect-chat.js";
import {
  TryOnUploadError,
  handleTryOnUpload
} from "./try-on/handle-try-on-upload.js";
import {
  YouCamUploadError,
  createYouCamUploadRequester
} from "./try-on/request-youcam-upload.js";
import {
  TryOnTaskError,
  handleTryOnTaskCreate,
  handleTryOnTaskStatus
} from "./try-on/handle-try-on-task.js";
import {
  YouCamTaskProviderError,
  createYouCamTaskClient
} from "./try-on/request-youcam-task.js";
import {
  TryOnProtectionError,
  createTurnstileVerifier,
  enforceTryOnRateLimit
} from "./try-on/protect-try-on-task.js";
import {
  TailorSearchError,
  enforceTailorRateLimit,
  findNearbyTailors
} from "./tailors/find-nearby-tailors.js";

export const CHAT_API_PATH = "/api/chat";
export const TRY_ON_UPLOAD_API_PATH = "/api/try-on/upload";
export const TRY_ON_TASKS_API_PATH = "/api/try-on/tasks";
export const TAILORS_API_PATH = "/api/tailors";
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
      const route = resolveApiRoute(url.pathname);

      if (!route) {
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
              ? "The API service is not configured for browser requests."
              : "This website is not allowed to call the API service."
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

      if (!route.methods.includes(request.method)) {
        const expectedMethod = route.methods[0];
        return jsonResponse(
          405,
          publicError(
            "METHOD_NOT_ALLOWED",
            `Use ${expectedMethod} for this API route.`
          ),
          {
            ...cors.headers,
            Allow: `${route.methods.join(", ")}, OPTIONS`
          }
        );
      }

      if (request.method === "POST" && !isJsonRequest(request)) {
        return jsonResponse(
          415,
          publicError(
            "UNSUPPORTED_MEDIA_TYPE",
            "Send the request body as application/json."
          ),
          cors.headers
        );
      }

      let requestBody = null;

      if (request.method === "POST") {
        try {
          requestBody = await readJsonRequest(request);
        } catch (error) {
          const tooLarge = error instanceof RequestTooLargeError;

          return jsonResponse(
            tooLarge ? 413 : 400,
            publicError(
              tooLarge ? "REQUEST_TOO_LARGE" : "INVALID_JSON",
              tooLarge
                ? "The request is too large."
                : "The request body is not valid JSON."
            ),
            cors.headers
          );
        }
      }

      try {
        if (route.kind === "tailors") {
          await enforceTailorRateLimit({
            limiter: env.CHAT_RATE_LIMITER,
            key: `tailors:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`
          });
          const response = await findNearbyTailors(
            {
              query: url.searchParams.get("query"),
              latitude: url.searchParams.get("latitude"),
              longitude: url.searchParams.get("longitude")
            },
            { fetchImpl }
          );

          return jsonResponse(200, response, cors.headers);
        }

        if (route.kind === "try-on-upload") {
          const requestProviderUpload = createYouCamUploadRequester({
            apiKey: env.YOUCAM_API_KEY,
            fetchImpl
          });
          const response = await handleTryOnUpload(requestBody, {
            catalogue,
            requestProviderUpload
          });

          return jsonResponse(200, response, cors.headers);
        }

        if (route.kind === "try-on-task-create") {
          const verifyTurnstile = createTurnstileVerifier({
            secret: env.TURNSTILE_SECRET,
            expectedHostnames: env.TURNSTILE_HOSTNAMES,
            fetchImpl
          });
          await verifyTurnstile({
            token: requestBody?.turnstileToken,
            remoteIp: request.headers.get("CF-Connecting-IP") ?? ""
          });
          await enforceTryOnRateLimit({
            limiter: env.TRY_ON_RATE_LIMITER,
            key: `try-on:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`
          });

          const youCamTaskClient = createYouCamTaskClient({
            apiKey: env.YOUCAM_API_KEY,
            fetchImpl
          });
          const response = await handleTryOnTaskCreate(requestBody, {
            catalogue,
            createProviderTask: youCamTaskClient.createTask
          });

          return jsonResponse(200, response, cors.headers);
        }

        if (route.kind === "try-on-task-status") {
          const youCamTaskClient = createYouCamTaskClient({
            apiKey: env.YOUCAM_API_KEY,
            fetchImpl
          });
          const response = await handleTryOnTaskStatus(route.taskId, {
            getProviderTask: youCamTaskClient.getTask
          });

          return jsonResponse(200, response, cors.headers);
        }

        await enforceChatRateLimit({
          limiter: env.CHAT_RATE_LIMITER,
          key: `chat:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`
        });

        const interpretMessage = createOpenAiInterpreter({
          apiKey: env.OPENAI_API_KEY,
          model: env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
          fetchImpl
        });
        const response = await handleChatTurn(requestBody, {
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
          { ...cors.headers, ...mapped.headers }
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

function resolveApiRoute(pathname) {
  if (pathname === CHAT_API_PATH) {
    return { kind: "chat", methods: ["POST"] };
  }

  if (pathname === TRY_ON_UPLOAD_API_PATH) {
    return { kind: "try-on-upload", methods: ["POST"] };
  }

  if (pathname === TRY_ON_TASKS_API_PATH) {
    return { kind: "try-on-task-create", methods: ["POST"] };
  }

  if (pathname === TAILORS_API_PATH) {
    return { kind: "tailors", methods: ["GET"] };
  }

  const statusMatch = pathname.match(
    /^\/api\/try-on\/tasks\/([A-Za-z0-9_-]{1,1024})$/
  );

  return statusMatch
    ? {
        kind: "try-on-task-status",
        methods: ["GET"],
        taskId: statusMatch[1]
      }
    : null;
}

function mapPublicError(error) {
  if (
    error instanceof TailorSearchError &&
    error.code === "INVALID_TAILOR_SEARCH"
  ) {
    return {
      status: 400,
      code: "INVALID_TAILOR_SEARCH",
      message: "Enter a town or postcode, or allow access to your current location."
    };
  }

  if (
    error instanceof TailorSearchError &&
    error.code === "LOCATION_NOT_FOUND"
  ) {
    return {
      status: 404,
      code: "LOCATION_NOT_FOUND",
      message: "That location could not be found. Try a town, city or postcode."
    };
  }

  if (
    error instanceof TailorSearchError &&
    error.code === "TAILOR_SEARCH_RATE_LIMITED"
  ) {
    return {
      status: 429,
      code: "TAILOR_SEARCH_RATE_LIMITED",
      message: "Too many location searches were requested. Please wait and try again.",
      headers: { "Retry-After": "60" }
    };
  }

  if (error instanceof TailorSearchError) {
    return {
      status: 503,
      code: "TAILOR_SEARCH_UNAVAILABLE",
      message: "Nearby tailor search is temporarily unavailable. Please try again."
    };
  }

  if (
    error instanceof ChatProtectionError &&
    error.code === "CHAT_RATE_LIMITED"
  ) {
    return {
      status: 429,
      code: "CHAT_RATE_LIMITED",
      message: "Ten chat messages are allowed per minute. Please wait and try again.",
      headers: { "Retry-After": "60" }
    };
  }

  if (error instanceof ChatProtectionError) {
    return {
      status: 503,
      code: "CHAT_PROTECTION_UNAVAILABLE",
      message: "Chat is temporarily unavailable. Please try again."
    };
  }

  if (
    error instanceof TryOnProtectionError &&
    error.code === "TURNSTILE_REJECTED"
  ) {
    return {
      status: 403,
      code: "HUMAN_VERIFICATION_REQUIRED",
      message: "Complete the security check again before generating the preview."
    };
  }

  if (
    error instanceof TryOnProtectionError &&
    error.code === "TRY_ON_RATE_LIMITED"
  ) {
    return {
      status: 429,
      code: "TRY_ON_RATE_LIMITED",
      message: "Two generation attempts are allowed per minute. Please wait and try again.",
      headers: { "Retry-After": "60" }
    };
  }

  if (error instanceof TryOnProtectionError) {
    return {
      status: 503,
      code: "TRY_ON_PROTECTION_UNAVAILABLE",
      message: "The virtual try-on security check is unavailable. Please try again."
    };
  }

  if (
    error instanceof TryOnTaskError &&
    ["INVALID_TRY_ON_TASK_REQUEST", "INVALID_TRY_ON_TASK_ID"].includes(
      error.code
    )
  ) {
    return {
      status: 400,
      code: error.code,
      message: "The virtual try-on task request is invalid."
    };
  }

  if (
    error instanceof TryOnTaskError &&
    error.code === "UNKNOWN_PRODUCT_REFERENCE"
  ) {
    return {
      status: 400,
      code: "UNKNOWN_PRODUCT_REFERENCE",
      message: "The selected product is no longer available."
    };
  }

  if (
    error instanceof TryOnTaskError &&
    error.code === "VIRTUAL_TRY_ON_UNAVAILABLE"
  ) {
    return {
      status: 409,
      code: "VIRTUAL_TRY_ON_UNAVAILABLE",
      message: "This product is not available for virtual try-on."
    };
  }

  if (
    error instanceof YouCamTaskProviderError ||
    (error instanceof TryOnTaskError &&
      ["TASK_PROVIDER_FAILED", "INVALID_TASK_PROVIDER_RESPONSE"].includes(
        error.code
      ))
  ) {
    return {
      status: 503,
      code: "TRY_ON_TEMPORARILY_UNAVAILABLE",
      message: "The virtual try-on service is unavailable. Please try again."
    };
  }

  if (
    error instanceof TryOnUploadError &&
    error.code === "INVALID_TRY_ON_UPLOAD_REQUEST"
  ) {
    return {
      status: 400,
      code: "INVALID_TRY_ON_UPLOAD_REQUEST",
      message: "The virtual try-on upload request contains invalid or missing fields."
    };
  }

  if (
    error instanceof TryOnUploadError &&
    error.code === "UNKNOWN_PRODUCT_REFERENCE"
  ) {
    return {
      status: 400,
      code: "UNKNOWN_PRODUCT_REFERENCE",
      message: "The selected product is no longer available."
    };
  }

  if (
    error instanceof TryOnUploadError &&
    error.code === "VIRTUAL_TRY_ON_UNAVAILABLE"
  ) {
    return {
      status: 409,
      code: "VIRTUAL_TRY_ON_UNAVAILABLE",
      message: "This product is not available for virtual try-on."
    };
  }

  if (
    error instanceof YouCamUploadError ||
    (error instanceof TryOnUploadError &&
      ["UPLOAD_PROVIDER_FAILED", "INVALID_UPLOAD_PROVIDER_RESPONSE"].includes(
        error.code
      ))
  ) {
    return {
      status: 503,
      code: "TRY_ON_TEMPORARILY_UNAVAILABLE",
      message: "The virtual try-on upload service is unavailable. Please try again."
    };
  }

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

  logger.error("API request failed", {
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
