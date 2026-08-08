const ALLOWED_UPLOAD_CONTENT_TYPES = new Set([
  "image/jpg",
  "image/jpeg",
  "image/png"
]);

export class TryOnPhotoUploadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TryOnPhotoUploadError";
    this.code = code;
  }
}

export async function uploadTryOnPhoto(
  { apiUrl, selectedProductId, file, consent, signal },
  { fetchImpl = globalThis.fetch } = {}
) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function.");
  }

  let instructionsResponse;

  try {
    instructionsResponse = await fetchImpl(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedProductId,
        consent,
        file: {
          name: file.name,
          contentType: file.type,
          size: file.size
        }
      }),
      signal
    });
  } catch (cause) {
    rethrowAbort(cause);
    throw new TryOnPhotoUploadError(
      "UPLOAD_INSTRUCTIONS_UNAVAILABLE",
      "The secure photo upload could not be started. Please try again."
    );
  }

  let instructions;

  try {
    instructions = await instructionsResponse.json();
  } catch {
    throw new TryOnPhotoUploadError(
      "INVALID_UPLOAD_INSTRUCTIONS",
      "The secure photo upload returned an unexpected response. Please try again."
    );
  }

  if (!instructionsResponse.ok) {
    throw new TryOnPhotoUploadError(
      instructions?.error?.code ?? "UPLOAD_INSTRUCTIONS_REJECTED",
      instructions?.error?.message ??
        "The secure photo upload could not be started. Please try again."
    );
  }

  assertSafeUploadInstructions(instructions, selectedProductId);

  let uploadResponse;

  try {
    uploadResponse = await fetchImpl(instructions.upload.url, {
      method: "PUT",
      headers: { "Content-Type": instructions.upload.contentType },
      body: file,
      credentials: "omit",
      signal
    });
  } catch (cause) {
    rethrowAbort(cause);
    throw new TryOnPhotoUploadError(
      "PHOTO_UPLOAD_FAILED",
      "The photograph could not be uploaded. Please try again."
    );
  }

  if (!uploadResponse.ok) {
    throw new TryOnPhotoUploadError(
      "PHOTO_UPLOAD_FAILED",
      "The photograph could not be uploaded. Please try again."
    );
  }

  return {
    selectedProductId: instructions.selectedProductId,
    fileId: instructions.fileId
  };
}

function assertSafeUploadInstructions(instructions, selectedProductId) {
  if (
    !instructions ||
    instructions.selectedProductId !== selectedProductId ||
    typeof instructions.fileId !== "string" ||
    instructions.fileId.length === 0 ||
    instructions.upload?.method !== "PUT" ||
    !ALLOWED_UPLOAD_CONTENT_TYPES.has(instructions.upload?.contentType) ||
    !isHttpsUrl(instructions.upload?.url)
  ) {
    throw new TryOnPhotoUploadError(
      "INVALID_UPLOAD_INSTRUCTIONS",
      "The secure photo upload returned unsafe or incomplete instructions. Please try again."
    );
  }
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function rethrowAbort(error) {
  if (error?.name === "AbortError") throw error;
}
