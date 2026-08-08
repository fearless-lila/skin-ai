export const YOUCAM_API_BASE_URL = "https://yce-api-01.makeupar.com";
export const YOUCAM_CLOTHES_FILE_PATH = "/s2s/v2.0/file/cloth-v3";

const PROVIDER_CONTENT_TYPES = new Set([
  "image/jpg",
  "image/jpeg",
  "image/png"
]);

export class YouCamUploadError extends Error {
  constructor({ code, message, status = null, cause = null }) {
    super(message, cause ? { cause } : undefined);
    this.name = "YouCamUploadError";
    this.code = code;
    this.status = status;
  }
}

export function createYouCamUploadRequester({
  apiKey,
  fetchImpl = globalThis.fetch,
  baseUrl = YOUCAM_API_BASE_URL
} = {}) {
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new YouCamUploadError({
      code: "MISSING_YOUCAM_API_KEY",
      message: "The YouCam API key is not configured."
    });
  }

  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function.");
  }

  return async function requestYouCamUpload({ file }) {
    const providerContentType =
      file.contentType === "image/jpeg" ? "image/jpg" : file.contentType;
    let response;

    try {
      response = await fetchImpl(`${baseUrl}${YOUCAM_CLOTHES_FILE_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          files: [
            {
              content_type: providerContentType,
              file_name: file.name,
              file_size: file.size
            }
          ]
        })
      });
    } catch (cause) {
      throw new YouCamUploadError({
        code: "YOUCAM_NETWORK_ERROR",
        message: "The YouCam upload service could not be reached.",
        cause
      });
    }

    if (!response.ok) {
      throw new YouCamUploadError({
        code: "YOUCAM_HTTP_ERROR",
        message: "The YouCam upload service rejected the request.",
        status: response.status
      });
    }

    let body;

    try {
      body = await response.json();
    } catch (cause) {
      throw new YouCamUploadError({
        code: "INVALID_YOUCAM_RESPONSE",
        message: "The YouCam upload service returned invalid JSON.",
        cause
      });
    }

    return normalizeYouCamUploadResponse(body);
  };
}

function normalizeYouCamUploadResponse(body) {
  const providerFile = body?.data?.files?.[0];
  const providerRequest = providerFile?.requests?.find(
    (request) => String(request?.method).toUpperCase() === "PUT"
  );
  const uploadUrl = providerRequest?.url;
  const contentType = findHeader(providerRequest?.headers, "Content-Type");

  if (
    body?.status !== 200 ||
    typeof providerFile?.file_id !== "string" ||
    providerFile.file_id.length === 0 ||
    typeof uploadUrl !== "string" ||
    !isHttpsUrl(uploadUrl) ||
    !PROVIDER_CONTENT_TYPES.has(contentType)
  ) {
    throw new YouCamUploadError({
      code: "INVALID_YOUCAM_RESPONSE",
      message: "The YouCam upload service returned incomplete instructions."
    });
  }

  return {
    fileId: providerFile.file_id,
    upload: {
      url: uploadUrl,
      method: "PUT",
      contentType
    }
  };
}

function findHeader(headers, expectedName) {
  if (!headers || typeof headers !== "object") return null;

  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === expectedName.toLowerCase()
  );
  return entry ? String(entry[1]).toLowerCase() : null;
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
