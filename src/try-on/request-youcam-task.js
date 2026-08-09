import {
  YOUCAM_API_BASE_URL
} from "./request-youcam-upload.js";
import { isSupportedYouCamGarmentCategory } from "./virtual-try-on-config.js";

export const YOUCAM_CLOTHES_TASK_PATH = "/s2s/v2.0/task/cloth-v3";

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/;

export class YouCamTaskProviderError extends Error {
  constructor({ code, message, status = null, cause = null }) {
    super(message, cause ? { cause } : undefined);
    this.name = "YouCamTaskProviderError";
    this.code = code;
    this.status = status;
  }
}

export function createYouCamTaskClient({
  apiKey,
  fetchImpl = globalThis.fetch,
  baseUrl = YOUCAM_API_BASE_URL
} = {}) {
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new YouCamTaskProviderError({
      code: "MISSING_YOUCAM_API_KEY",
      message: "The YouCam API key is not configured."
    });
  }

  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function.");
  }

  return {
    async createTask({ fileId, referenceImageUrl, garmentCategory }) {
      if (
        typeof fileId !== "string" ||
        fileId.length === 0 ||
        !isHttpsUrl(referenceImageUrl) ||
        !isSupportedYouCamGarmentCategory(garmentCategory)
      ) {
        throw new TypeError("Trusted YouCam task inputs are invalid.");
      }

      const body = await requestJson(
        `${baseUrl}${YOUCAM_CLOTHES_TASK_PATH}`,
        {
          method: "POST",
          headers: providerHeaders(apiKey),
          body: JSON.stringify({
            src_file_id: fileId,
            ref_file_url: referenceImageUrl,
            garment_category: garmentCategory
          })
        },
        fetchImpl
      );
      const taskId = body?.data?.task_id;

      if (body?.status !== 200 || !TASK_ID_PATTERN.test(taskId)) {
        throw invalidProviderResponse();
      }

      return { taskId };
    },

    async getTask(taskId) {
      if (!TASK_ID_PATTERN.test(taskId)) {
        throw new TypeError("The YouCam task ID is invalid.");
      }

      const body = await requestJson(
        `${baseUrl}${YOUCAM_CLOTHES_TASK_PATH}/${encodeURIComponent(taskId)}`,
        {
          method: "GET",
          headers: providerHeaders(apiKey)
        },
        fetchImpl
      );

      return normalizeTaskStatus(body);
    }
  };
}

async function requestJson(url, options, fetchImpl) {
  let response;

  try {
    response = await fetchImpl(url, options);
  } catch (cause) {
    throw new YouCamTaskProviderError({
      code: "YOUCAM_NETWORK_ERROR",
      message: "The YouCam task service could not be reached.",
      cause
    });
  }

  if (!response.ok) {
    throw new YouCamTaskProviderError({
      code: "YOUCAM_HTTP_ERROR",
      message: "The YouCam task service rejected the request.",
      status: response.status
    });
  }

  try {
    return await response.json();
  } catch (cause) {
    throw new YouCamTaskProviderError({
      code: "INVALID_YOUCAM_RESPONSE",
      message: "The YouCam task service returned invalid JSON.",
      cause
    });
  }
}

function normalizeTaskStatus(body) {
  const taskStatus = body?.data?.task_status;

  if (body?.status !== 200 || typeof taskStatus !== "string") {
    throw invalidProviderResponse();
  }

  if (taskStatus === "success") {
    const resultUrl = body?.data?.results?.url;
    if (!isHttpsUrl(resultUrl)) throw invalidProviderResponse();

    return { status: "succeeded", resultUrl, errorCode: null };
  }

  if (taskStatus === "error") {
    return {
      status: "failed",
      resultUrl: null,
      errorCode: normalizeErrorCode(body.data.error)
    };
  }

  if (taskStatus === "running") {
    return { status: "processing", resultUrl: null, errorCode: null };
  }

  throw invalidProviderResponse();
}

function normalizeErrorCode(value) {
  const rawCode =
    typeof value === "string"
      ? value
      : typeof value?.code === "string"
        ? value.code
        : "unknown_internal_error";

  return /^[a-z0-9_]{1,120}$/i.test(rawCode)
    ? rawCode.toLowerCase()
    : "unknown_internal_error";
}

function providerHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
}

function invalidProviderResponse() {
  return new YouCamTaskProviderError({
    code: "INVALID_YOUCAM_RESPONSE",
    message: "The YouCam task service returned incomplete task information."
  });
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
