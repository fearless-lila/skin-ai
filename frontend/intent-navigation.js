const DIRECT_ALTERATION_INTENT =
  /\b(tailou?r|tailoring|alterations?|dressmaker|seamstress|hem|hemmed|hemming)\b/i;
const ALTERATION_ACTION =
  /\b(alter|adjust|resize|shorten|shorter|lengthen|longer|take in|taken in|taking in|let out|repair|replace)\b/i;
const CLOTHING_DETAIL =
  /\b(clothes?|clothing|garment|dress|shirt|blouse|trousers|pants|skirt|jacket|coat|sleeves?|waist|hem|zip|zipper|fastening|buttons?|fit|measurements?)\b/i;

export function hasAlterationIntent(message) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return false;

  return (
    DIRECT_ALTERATION_INTENT.test(text) ||
    (ALTERATION_ACTION.test(text) && CLOTHING_DETAIL.test(text))
  );
}
