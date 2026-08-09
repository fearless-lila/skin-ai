export const TURNSTILE_SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_TRY_ON_ACTION = "try_on_generate";

export class TryOnProtectionError extends Error {
  constructor({ code, message, cause = null }) {
    super(message, cause ? { cause } : undefined);
    this.name = "TryOnProtectionError";
    this.code = code;
  }
}

export function createTurnstileVerifier({
  secret,
  expectedHostnames,
  fetchImpl = globalThis.fetch
} = {}) {
  const hostnames = new Set(
    String(expectedHostnames ?? "")
      .split(",")
      .map((hostname) => hostname.trim().toLowerCase())
      .filter(Boolean)
  );

  if (
    typeof secret !== "string" ||
    secret.length === 0 ||
    hostnames.size === 0
  ) {
    throw new TryOnProtectionError({
      code: "TURNSTILE_MISCONFIGURED",
      message: "Turnstile protection is not configured."
    });
  }

  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function.");
  }

  return async function verifyTurnstile({ token, remoteIp = "" }) {
    if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
      throw rejectedTurnstile();
    }

    let response;

    try {
      response = await fetchImpl(TURNSTILE_SITEVERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret,
          response: token,
          remoteip: remoteIp
        })
      });
    } catch (cause) {
      throw new TryOnProtectionError({
        code: "TURNSTILE_UNAVAILABLE",
        message: "Turnstile verification could not be reached.",
        cause
      });
    }

    if (!response.ok) {
      throw new TryOnProtectionError({
        code: "TURNSTILE_UNAVAILABLE",
        message: "Turnstile verification returned an HTTP error."
      });
    }

    let result;

    try {
      result = await response.json();
    } catch (cause) {
      throw new TryOnProtectionError({
        code: "TURNSTILE_UNAVAILABLE",
        message: "Turnstile verification returned invalid JSON.",
        cause
      });
    }

    if (
      result?.success !== true ||
      result.action !== TURNSTILE_TRY_ON_ACTION ||
      typeof result.hostname !== "string" ||
      !hostnames.has(result.hostname.toLowerCase())
    ) {
      throw rejectedTurnstile();
    }

    return { verified: true };
  };
}

export async function enforceTryOnRateLimit({ limiter, key }) {
  if (typeof limiter?.limit !== "function") {
    throw new TryOnProtectionError({
      code: "RATE_LIMITER_MISCONFIGURED",
      message: "The try-on rate limiter is not configured."
    });
  }

  let result;

  try {
    result = await limiter.limit({ key });
  } catch (cause) {
    throw new TryOnProtectionError({
      code: "RATE_LIMITER_UNAVAILABLE",
      message: "The try-on rate limiter could not be reached.",
      cause
    });
  }

  if (result?.success !== true) {
    throw new TryOnProtectionError({
      code: "TRY_ON_RATE_LIMITED",
      message: "The try-on generation rate limit was exceeded."
    });
  }
}

function rejectedTurnstile() {
  return new TryOnProtectionError({
    code: "TURNSTILE_REJECTED",
    message: "Turnstile did not accept the browser token."
  });
}
