export class ChatProtectionError extends Error {
  constructor({ code, message, cause = null }) {
    super(message, cause ? { cause } : undefined);
    this.name = "ChatProtectionError";
    this.code = code;
  }
}

/**
 * Limit calls to the paid chat provider before the OpenAI workflow begins.
 */
export async function enforceChatRateLimit({ limiter, key }) {
  if (typeof limiter?.limit !== "function") {
    throw new ChatProtectionError({
      code: "RATE_LIMITER_MISCONFIGURED",
      message: "The chat rate limiter is not configured."
    });
  }

  let result;

  try {
    result = await limiter.limit({ key });
  } catch (cause) {
    throw new ChatProtectionError({
      code: "RATE_LIMITER_UNAVAILABLE",
      message: "The chat rate limiter could not be reached.",
      cause
    });
  }

  if (result?.success !== true) {
    throw new ChatProtectionError({
      code: "CHAT_RATE_LIMITED",
      message: "The chat rate limit was exceeded."
    });
  }
}
