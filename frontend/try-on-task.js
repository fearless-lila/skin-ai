export const DEFAULT_TRY_ON_POLL_INTERVAL_MS = 3000;
export const DEFAULT_TRY_ON_POLL_ATTEMPTS = 40;

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/;

export class TryOnGenerationError extends Error {
  constructor(code, message, { terminal = false } = {}) {
    super(message);
    this.name = "TryOnGenerationError";
    this.code = code;
    this.terminal = terminal;
  }
}

export async function createTryOnTask(
  { tasksApiUrl, selectedProductId, fileId, signal },
  { fetchImpl = globalThis.fetch } = {}
) {
  const body = await requestJson(
    tasksApiUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedProductId, fileId }),
      signal
    },
    fetchImpl
  );

  if (
    body?.selectedProductId !== selectedProductId ||
    body?.status !== "processing" ||
    !TASK_ID_PATTERN.test(body?.taskId)
  ) {
    throw invalidServiceResponse();
  }

  return body;
}

export async function checkTryOnTask(
  { tasksApiUrl, taskId, signal },
  { fetchImpl = globalThis.fetch } = {}
) {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new TypeError("The virtual try-on task ID is invalid.");
  }

  const body = await requestJson(
    `${tasksApiUrl}/${encodeURIComponent(taskId)}`,
    { method: "GET", signal },
    fetchImpl
  );

  if (body?.taskId !== taskId) throw invalidServiceResponse();

  if (
    body.status === "processing" &&
    body.resultUrl === null &&
    body.error === null
  ) {
    return body;
  }

  if (
    body.status === "succeeded" &&
    isHttpsUrl(body.resultUrl) &&
    body.error === null
  ) {
    return body;
  }

  if (
    body.status === "failed" &&
    body.resultUrl === null &&
    typeof body.error?.code === "string" &&
    typeof body.error?.message === "string"
  ) {
    return body;
  }

  throw invalidServiceResponse();
}

export async function waitForTryOnResult(
  {
    tasksApiUrl,
    taskId,
    signal,
    maxAttempts = DEFAULT_TRY_ON_POLL_ATTEMPTS,
    pollIntervalMs = DEFAULT_TRY_ON_POLL_INTERVAL_MS
  },
  { fetchImpl = globalThis.fetch, wait = waitForDelay } = {}
) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) await wait(pollIntervalMs, signal);

    const status = await checkTryOnTask(
      { tasksApiUrl, taskId, signal },
      { fetchImpl }
    );

    if (status.status === "succeeded") return status;

    if (status.status === "failed") {
      throw new TryOnGenerationError(status.error.code, status.error.message, {
        terminal: true
      });
    }
  }

  throw new TryOnGenerationError(
    "TRY_ON_STILL_PROCESSING",
    "The preview is still processing. Select Check result again in a moment."
  );
}

async function requestJson(url, options, fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function.");
  }

  let response;

  try {
    response = await fetchImpl(url, options);
  } catch (cause) {
    rethrowAbort(cause);
    throw new TryOnGenerationError(
      "TRY_ON_SERVICE_UNAVAILABLE",
      "The virtual try-on service could not be reached. Please try again."
    );
  }

  let body;

  try {
    body = await response.json();
  } catch {
    throw invalidServiceResponse();
  }

  if (!response.ok) {
    throw new TryOnGenerationError(
      body?.error?.code ?? "TRY_ON_SERVICE_UNAVAILABLE",
      body?.error?.message ??
        "The virtual try-on service is unavailable. Please try again."
    );
  }

  return body;
}

function waitForDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timeoutId);
      const error = new Error("The virtual try-on request was cancelled.");
      error.name = "AbortError";
      reject(error);
    };
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });
  });
}

function invalidServiceResponse() {
  return new TryOnGenerationError(
    "INVALID_TRY_ON_RESPONSE",
    "The virtual try-on service returned an unexpected response. Please try again."
  );
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
