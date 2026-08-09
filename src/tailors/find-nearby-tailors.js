const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_SEARCH_URL = "https://overpass-api.de/api/interpreter";
const SEARCH_RADIUS_METRES = 8000;
const MAX_RESULTS = 8;
const APP_USER_AGENT =
  "SkinAI-Hackathon/1.0 (+https://skin-ai.pages.dev/)";
const APP_REFERER = "https://skin-ai.pages.dev/";
const APP_REPOSITORY_REFERER = "https://github.com/fearless-lila/skin-ai";

export class TailorSearchError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "TailorSearchError";
    this.code = code;
  }
}

export async function findNearbyTailors(
  { query, latitude, longitude },
  { fetchImpl = globalThis.fetch } = {}
) {
  if (typeof fetchImpl !== "function") {
    throw new TailorSearchError(
      "TAILOR_SERVICE_UNAVAILABLE",
      "The tailor search provider is unavailable."
    );
  }

  const normalizedQuery = String(query ?? "").trim();
  const hasCoordinates = latitude !== null && longitude !== null;

  if (normalizedQuery && hasCoordinates) {
    throw invalidSearch();
  }

  let searchLocation;
  if (normalizedQuery) {
    if (normalizedQuery.length < 2 || normalizedQuery.length > 120) {
      throw invalidSearch();
    }
    searchLocation = await geocodeLocation(normalizedQuery, fetchImpl);
  } else if (hasCoordinates) {
    const parsedLatitude = Number(latitude);
    const parsedLongitude = Number(longitude);
    if (
      !Number.isFinite(parsedLatitude) ||
      !Number.isFinite(parsedLongitude) ||
      parsedLatitude < -90 ||
      parsedLatitude > 90 ||
      parsedLongitude < -180 ||
      parsedLongitude > 180
    ) {
      throw invalidSearch();
    }
    searchLocation = {
      latitude: parsedLatitude,
      longitude: parsedLongitude,
      label: "your current location"
    };
  } else {
    throw invalidSearch();
  }

  const elements = await requestTailors(searchLocation, fetchImpl);
  const tailors = elements
    .map((element) => normalizeTailor(element, searchLocation))
    .filter(Boolean)
    .sort((first, second) => first.distanceMetres - second.distanceMetres)
    .slice(0, MAX_RESULTS);

  return {
    locationLabel: searchLocation.label,
    radiusMetres: SEARCH_RADIUS_METRES,
    tailors,
    attribution: "© OpenStreetMap contributors"
  };
}

export async function enforceTailorRateLimit({ limiter, key }) {
  if (!limiter || typeof limiter.limit !== "function") {
    throw new TailorSearchError(
      "TAILOR_PROTECTION_UNAVAILABLE",
      "Tailor search protection is unavailable."
    );
  }

  let outcome;
  try {
    outcome = await limiter.limit({ key });
  } catch (cause) {
    throw new TailorSearchError(
      "TAILOR_PROTECTION_UNAVAILABLE",
      "Tailor search protection is unavailable.",
      { cause }
    );
  }

  if (outcome?.success !== true) {
    throw new TailorSearchError(
      "TAILOR_SEARCH_RATE_LIMITED",
      "Too many tailor searches were requested."
    );
  }
}

async function geocodeLocation(query, fetchImpl) {
  const url = new URL(NOMINATIM_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");

  const payload = await requestJson(
    url,
    {
      headers: nominatimHeaders(),
      cf: { cacheEverything: true, cacheTtl: 86400 }
    },
    fetchImpl,
    "LOCATION_SERVICE_UNAVAILABLE"
  );

  const match = Array.isArray(payload) ? payload[0] : null;
  const latitude = Number(match?.lat);
  const longitude = Number(match?.lon);
  if (!match || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new TailorSearchError(
      "LOCATION_NOT_FOUND",
      "The submitted location could not be found."
    );
  }

  return {
    latitude,
    longitude,
    label: cleanText(match.display_name, query, 180)
  };
}

async function requestTailors(searchLocation, fetchImpl) {
  const latitude = searchLocation.latitude.toFixed(4);
  const longitude = searchLocation.longitude.toFixed(4);
  const query = `[out:json][timeout:20];(
    nwr["craft"="tailor"](around:${SEARCH_RADIUS_METRES},${latitude},${longitude});
    nwr["shop"="tailor"](around:${SEARCH_RADIUS_METRES},${latitude},${longitude});
    nwr["craft"="dressmaker"](around:${SEARCH_RADIUS_METRES},${latitude},${longitude});
  );out center tags;`;
  const url = new URL(OVERPASS_SEARCH_URL);
  url.searchParams.set("data", query);

  const payload = await requestJson(
    url,
    {
      headers: overpassHeaders(),
      cf: { cacheEverything: true, cacheTtl: 300 }
    },
    fetchImpl,
    "TAILOR_SERVICE_UNAVAILABLE"
  );

  if (!Array.isArray(payload?.elements)) {
    throw new TailorSearchError(
      "TAILOR_SERVICE_UNAVAILABLE",
      "The tailor search provider returned an invalid response."
    );
  }

  return payload.elements;
}

async function requestJson(url, options, fetchImpl, errorCode) {
  let response;
  try {
    response = await fetchImpl(url.toString(), options);
  } catch (cause) {
    throw new TailorSearchError(
      errorCode,
      "The location provider request failed.",
      { cause }
    );
  }

  if (!response?.ok) {
    throw new TailorSearchError(
      errorCode,
      "The location provider request failed."
    );
  }

  try {
    return await response.json();
  } catch (cause) {
    throw new TailorSearchError(
      errorCode,
      "The location provider returned invalid data.",
      { cause }
    );
  }
}

function normalizeTailor(element, searchLocation) {
  const latitude = Number(element?.lat ?? element?.center?.lat);
  const longitude = Number(element?.lon ?? element?.center?.lon);
  const elementType = ["node", "way", "relation"].includes(element?.type)
    ? element.type
    : null;
  const elementId = String(element?.id ?? "");
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    !elementType ||
    !/^\d+$/.test(elementId)
  ) {
    return null;
  }

  const tags = element.tags ?? {};
  const category =
    tags.craft === "dressmaker" ? "Dressmaker" : "Tailor and alterations";
  const website = safeHttpsUrl(tags.website ?? tags["contact:website"]);
  const phone = cleanText(tags.phone ?? tags["contact:phone"], null, 60);
  const wheelchair = ["yes", "limited", "no"].includes(tags.wheelchair)
    ? tags.wheelchair
    : "unknown";

  return {
    id: `${elementType}-${elementId}`,
    name: cleanText(tags.name ?? tags.operator, category, 120),
    category,
    address: buildAddress(tags),
    distanceMetres: Math.round(
      distanceBetween(
        searchLocation.latitude,
        searchLocation.longitude,
        latitude,
        longitude
      )
    ),
    wheelchair,
    alterationService:
      tags["tailor:alteration_service"] === "yes" ? "confirmed" : "unknown",
    openingHours: cleanText(tags.opening_hours, null, 160),
    phone,
    website,
    mapUrl: `https://www.openstreetmap.org/${elementType}/${elementId}`
  };
}

function buildAddress(tags) {
  const streetAddress = [
    cleanText(tags["addr:housenumber"], null, 30),
    cleanText(tags["addr:street"], null, 100)
  ]
    .filter(Boolean)
    .join(" ");
  const locality = cleanText(
    tags["addr:city"] ?? tags["addr:town"] ?? tags["addr:village"],
    null,
    100
  );
  const postcode = cleanText(tags["addr:postcode"], null, 30);
  const parts = [streetAddress, locality, postcode].filter(Boolean);

  return (
    cleanText(tags["addr:full"], null, 180) ||
    (parts.length ? parts.join(", ") : "Address not listed")
  );
}

function cleanText(value, fallback, maxLength) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : fallback;
}

function safeHttpsUrl(value) {
  if (typeof value !== "string") return null;

  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function distanceBetween(firstLat, firstLon, secondLat, secondLon) {
  const earthRadiusMetres = 6371000;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(secondLat - firstLat);
  const longitudeDelta = toRadians(secondLon - firstLon);
  const firstLatitude = toRadians(firstLat);
  const secondLatitude = toRadians(secondLat);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  return (
    earthRadiusMetres * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
}

function nominatimHeaders() {
  return {
    Accept: "application/json",
    "Accept-Language": "en",
    Referer: APP_REFERER,
    "User-Agent": APP_USER_AGENT
  };
}

function overpassHeaders() {
  return {
    Referer: APP_REPOSITORY_REFERER,
    // The FOSSGIS endpoint rejects Node/Workers transport identifiers with
    // HTTP 406. The repository Referer above uniquely identifies this app.
    "User-Agent": "curl/8.7.1"
  };
}

function invalidSearch() {
  return new TailorSearchError(
    "INVALID_TAILOR_SEARCH",
    "Provide either a location search or valid coordinates."
  );
}
