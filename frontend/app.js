import {
  activateProductResults,
  addTryOnResultMessage,
  applyChatResponse,
  buildChatRequest,
  clearChatSession,
  loadChatSession,
  resetMeasurementProfile,
  saveChatSession,
  selectProductForTryOn,
  setMeasurementProfile
} from "./chat-state.js";
import {
  MEASUREMENT_FIELDS,
  compareProductMeasurements,
  isUsableMeasurementProfile,
  normalizeMeasurementProfile
} from "./measurement-profile.js";
import { findRecommendedSizeIndex } from "./measurement-tabs.js";
import { MOCK_PRODUCT_MEASUREMENTS } from "./mock-product-measurements.js";
import { hasAlterationIntent } from "./intent-navigation.js";
import { validateTryOnPhoto } from "./photo-selection.js";
import { uploadTryOnPhoto } from "./try-on-upload.js";
import {
  TryOnGenerationError,
  createTryOnTask,
  waitForTryOnResult
} from "./try-on-task.js";

const CHAT_API_URL = "https://skin-ai.lilahu21797.workers.dev/api/chat";
const TRY_ON_UPLOAD_API_URL =
  "https://skin-ai.lilahu21797.workers.dev/api/try-on/upload";
const TRY_ON_TASKS_API_URL =
  "https://skin-ai.lilahu21797.workers.dev/api/try-on/tasks";
const TAILORS_API_URL =
  "https://skin-ai.lilahu21797.workers.dev/api/tailors";
const TURNSTILE_SITE_KEY = "0x4AAAAAAELDn3xUCDGkdmQm";
const TURNSTILE_ACTION = "try_on_generate";

const form = document.querySelector("#chat-form");
const input = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const clearButton = document.querySelector("#clear-chat");
const messageList = document.querySelector("#message-list");
const starterPrompts = document.querySelector("#starter-prompts");
const tailorFinderContainer = document.querySelector(
  "#tailor-finder-container"
);
const tailorResultsContainer = document.querySelector(
  "#tailor-results-container"
);
const alterationSection = document.querySelector(".alteration-section");
const journeyNav = document.querySelector("#journey-nav");
const pageProgressBar = document.querySelector("#page-progress-bar");
const statusRegion = document.querySelector("#request-status");
const welcomeTemplate = document.querySelector("#welcome-template");

let session = loadChatSession();
let photoSelection = emptyPhotoSelection();
let photoValidationGeneration = 0;
let photoUploadController = null;
let tryOnTaskController = null;
let turnstileWidgetId = null;
let turnstileToken = null;
let turnstileRenderTimer = null;
let tailorSearchResults = null;

renderConversation();
renderTailorFinder();
setupScrollInteractions();
setupJourneyNavigation();
queueMicrotask(scrollConversationToBottom);

form.addEventListener("submit", handleSubmit);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});
input.addEventListener("input", resizeComposerInput);
for (const promptButton of starterPrompts.querySelectorAll("button")) {
  promptButton.addEventListener("click", () => {
    input.value = promptButton.textContent.trim();
    resizeComposerInput();
    input.focus();
  });
}
clearButton.addEventListener("click", () => {
  resetPhotoSelection();
  tailorSearchResults = null;
  session = clearChatSession();
  renderConversation();
  renderTailorFinder();
  setStatus("Conversation cleared.");
  input.focus();
});

async function handleSubmit(event) {
  event.preventDefault();

  const currentMessage = input.value.trim();
  if (!currentMessage) return;

  const shouldGuideToAlterations = hasAlterationIntent(currentMessage);
  let responseReceived = false;
  const requestBody = buildChatRequest(session, currentMessage);
  appendMessage("user", currentMessage);
  scrollConversationToBottom();
  input.value = "";
  resizeComposerInput();
  setBusy(true);
  setStatus("Checking your access needs and clothing request…");

  try {
    const response = await fetch(CHAT_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });
    const body = await response.json();

    if (!response.ok) {
      throw new Error(
        body?.error?.message ?? "AccessWear is unavailable right now."
      );
    }

    const previousSelectedProductId =
      session.conversationState.selectedProductId;
    session = applyChatResponse(session, currentMessage, body);
    if (
      session.conversationState.selectedProductId !== previousSelectedProductId
    ) {
      resetPhotoSelection();
    }
    saveChatSession(session);
    renderConversation();
    scrollConversationToBottom();
    responseReceived = true;
    setStatus(
      body.searchPerformed ? "Accessible clothing search complete." : "Reply received."
    );
  } catch (error) {
    appendError(
      error instanceof Error
        ? error.message
        : "AccessWear is unavailable right now."
    );
    scrollConversationToBottom({ smooth: true });
    setStatus("The request could not be completed.");
  } finally {
    setBusy(false);
    if (responseReceived && shouldGuideToAlterations) {
      setStatus("Alteration support is ready below.");
      guideToAlterationSupport();
    } else {
      input.focus();
    }
  }
}

function renderConversation() {
  removeTurnstileWidget();
  messageList.replaceChildren();
  starterPrompts.hidden = session.recentMessages.length !== 0;

  if (session.recentMessages.length === 0) {
    messageList.append(welcomeTemplate.content.cloneNode(true));
    return;
  }

  const currentResultsMessageIndex = session.recentMessages.findLastIndex(
    (message) =>
      message.attachment?.type === "product_results" &&
      productResultsMatch(message.attachment.results, session.displayResults)
  );

  for (const [index, message] of session.recentMessages.entries()) {
    appendMessage(message.role, message.content, message.attachment, {
      currentProductResults: index === currentResultsMessageIndex
    });
  }
}

function appendMessage(
  role,
  content,
  attachment = null,
  { currentProductResults = false } = {}
) {
  const message = document.createElement("article");
  message.className = `message ${role}-message`;

  const avatar = buildMessageAvatar(role);
  const stack = document.createElement("div");
  stack.className = "message-stack";

  const label = document.createElement("p");
  label.className = "message-label";
  label.textContent = role === "assistant" ? "Clothing Assistant" : "You";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  const text = document.createElement("p");
  text.textContent = content;
  bubble.append(text);

  stack.append(label, bubble);
  message.append(avatar, stack);

  if (attachment?.type === "product_results") {
    message.classList.add("has-product-results");
    stack.append(
      buildProductResults(attachment.results, {
        current: currentProductResults
      })
    );
  } else if (attachment?.type === "try_on_result") {
    const figure = document.createElement("figure");
    figure.className = "message-image-attachment";

    const image = document.createElement("img");
    image.src = attachment.imageUrl;
    image.alt = attachment.alt;
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";

    const fallback = document.createElement("p");
    fallback.className = "message-image-error";
    fallback.hidden = true;
    fallback.textContent =
      "This preview image is no longer available. You can generate a new preview from the selected product.";
    image.addEventListener("error", () => {
      image.remove();
      fallback.hidden = false;
    });

    const caption = document.createElement("figcaption");
    caption.textContent =
      "AI-generated visual preview only. It may change body proportions or physical features and does not confirm measurements, comfort, accessibility or fit.";
    figure.append(image, fallback, caption);
    stack.append(figure);
  }

  messageList.append(message);
  return message;
}

function buildMessageAvatar(role) {
  const avatar = document.createElement("span");
  avatar.className = `message-avatar ${
    role === "assistant" ? "assistant-avatar" : "user-avatar"
  }`;
  avatar.setAttribute("aria-hidden", "true");

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("aria-hidden", "true");

  if (role === "assistant") {
    svg.append(
      buildSvgPath(
        "M12 5.2a2.4 2.4 0 1 1 2.4 2.4c0 1.5-2.4 1.8-2.4 3.1"
      ),
      buildSvgPath("m12 10.7-7.6 5.4a1 1 0 0 0 .6 1.8h14a1 1 0 0 0 .6-1.8Z")
    );
  } else {
    svg.append(
      buildSvgPath("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"),
      buildSvgPath("M4.5 20a7.5 7.5 0 0 1 15 0")
    );
  }

  avatar.append(svg);
  return avatar;
}

function buildSvgPath(pathData) {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathData);
  return path;
}

function appendError(content) {
  const error = document.createElement("article");
  error.className = "message assistant-message error-message";

  const avatar = buildMessageAvatar("assistant");
  const stack = document.createElement("div");
  stack.className = "message-stack";

  const label = document.createElement("p");
  label.className = "message-label";
  label.textContent = "Something went wrong";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  const text = document.createElement("p");
  text.textContent = content;
  bubble.append(text);
  stack.append(label, bubble);
  error.append(avatar, stack);
  messageList.append(error);
}

function productResultsMatch(first, second) {
  if (!first || !second) return false;

  const collectIds = (results) => [
    ...(results.compatibleProducts ?? []),
    ...(results.productsWithMissingInformation ?? [])
  ].map(({ product }) => product.id);
  const firstIds = collectIds(first);
  const secondIds = collectIds(second);

  return (
    firstIds.length === secondIds.length &&
    firstIds.every((productId, index) => productId === secondIds[index])
  );
}

function buildProductResults(results, { current }) {
  const container = document.createElement("section");
  container.className = "message-results";
  container.setAttribute("aria-label", "Accessible clothing matches");
  const header = document.createElement("div");
  header.className = "results-header";

  const titleRow = document.createElement("div");
  titleRow.className = "results-title-row";
  const titleIcon = document.createElement("span");
  titleIcon.className = "results-title-icon";
  titleIcon.setAttribute("aria-hidden", "true");
  titleIcon.textContent = "✦";
  const titleCopy = document.createElement("div");

  const heading = document.createElement("h3");
  heading.textContent = "Accessible clothing matches";
  const description = document.createElement("p");
  description.textContent = "Here’s what I found based on your request.";
  titleCopy.append(heading, description);
  titleRow.append(titleIcon, titleCopy);
  header.append(titleRow);

  if (results.notice) {
    const notice = document.createElement("details");
    notice.className = "catalogue-notice";
    const summary = document.createElement("summary");
    const noticeIcon = document.createElement("span");
    noticeIcon.setAttribute("aria-hidden", "true");
    noticeIcon.textContent = "i";
    const noticeCopy = document.createElement("span");
    const noticeHeading = document.createElement("strong");
    noticeHeading.textContent = "Demo product";
    const noticeDescription = document.createElement("span");
    noticeDescription.textContent =
      "Fictional product used for local development and matching tests.";
    noticeCopy.append(noticeHeading, noticeDescription);
    summary.append(noticeIcon, noticeCopy);
    const fullNotice = document.createElement("p");
    fullNotice.textContent = results.notice;
    notice.append(summary, fullNotice);
    header.append(notice);
  }

  if (current && isUsableMeasurementProfile(session.measurementProfile)) {
    header.append(buildMeasurementProfileSummary());
  }

  container.append(header);
  appendProductGroup(
    container,
    "Documented matches",
    results.compatibleProducts,
    "compatible",
    { current, resultSet: results }
  );
  appendProductGroup(
    container,
    "More information needed",
    results.productsWithMissingInformation,
    "missing",
    { current, resultSet: results }
  );

  if (
    results.compatibleProducts.length === 0 &&
    results.productsWithMissingInformation.length === 0
  ) {
    const empty = document.createElement("p");
    empty.className = "empty-results";
    empty.textContent =
      "No catalogue items met these access needs. You can change a preference, but you do not need to remove a requirement that is essential for you.";
    container.append(empty);
  }

  if (current) {
    const tryOnSelection = buildTryOnSelection(results);
    if (tryOnSelection) container.append(tryOnSelection);
  }

  return container;
}

function renderTailorFinder() {
  const finder = buildTailorFinder();
  tailorFinderContainer.replaceChildren(finder);

  if (tailorSearchResults) {
    tailorResultsContainer.replaceChildren(
      buildTailorResults(tailorSearchResults)
    );
  } else {
    tailorResultsContainer.replaceChildren();
  }
}

function buildTailorFinder() {
  const panel = document.createElement("section");
  panel.className = "tailor-finder";
  panel.setAttribute("aria-label", "Alteration service location search controls");

  const currentLocationButton = document.createElement("button");
  currentLocationButton.className = "location-button";
  currentLocationButton.type = "button";
  const locationIcon = document.createElement("span");
  locationIcon.className = "location-button-icon";
  locationIcon.setAttribute("aria-hidden", "true");
  locationIcon.textContent = "⌖";
  const locationButtonLabel = document.createElement("span");
  locationButtonLabel.textContent = "Use my current location";
  currentLocationButton.append(locationIcon, locationButtonLabel);

  const divider = document.createElement("p");
  divider.className = "tailor-divider";
  divider.textContent = "or search a location";

  const searchForm = document.createElement("form");
  searchForm.className = "tailor-search-form";
  const label = document.createElement("label");
  label.htmlFor = "tailor-location-query";
  label.textContent = "Town, city or postcode";
  const row = document.createElement("div");
  row.className = "tailor-search-row";
  const searchInput = document.createElement("input");
  searchInput.id = "tailor-location-query";
  searchInput.name = "location";
  searchInput.type = "search";
  searchInput.minLength = 2;
  searchInput.maxLength = 120;
  searchInput.placeholder = "For example: Leeds or LS1 3AD";
  searchInput.required = true;
  const searchButton = document.createElement("button");
  searchButton.type = "submit";
  searchButton.textContent = "Search";
  row.append(searchInput, searchButton);
  searchForm.append(label, row);

  const privacy = document.createElement("p");
  privacy.className = "tailor-privacy";
  privacy.textContent =
    "Your location is used only for this search. It is not saved or added to your clothing conversation.";

  const progress = document.createElement("p");
  progress.className = "tailor-search-progress";
  progress.setAttribute("role", "status");
  progress.setAttribute("aria-live", "polite");

  currentLocationButton.addEventListener("click", () => {
    void searchFromCurrentLocation(panel, progress);
  });
  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void requestTailorSearch(
      { query: searchInput.value.trim() },
      panel,
      progress
    );
  });

  panel.append(
    currentLocationButton,
    divider,
    searchForm,
    privacy,
    progress
  );
  return panel;
}

async function searchFromCurrentLocation(panel, progress) {
  if (typeof navigator.geolocation?.getCurrentPosition !== "function") {
    showTailorSearchError(
      progress,
      "Current location is unavailable in this browser. Search using a town or postcode instead."
    );
    return;
  }

  setTailorFinderBusy(panel, true);
  progress.removeAttribute("data-state");
  progress.textContent = "Waiting for location permission…";

  try {
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 300000
      });
    });
    await requestTailorSearch(
      {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude
      },
      panel,
      progress,
      { alreadyBusy: true }
    );
  } catch (error) {
    setTailorFinderBusy(panel, false);
    showTailorSearchError(
      progress,
      error?.code === 1
        ? "Location permission was not granted. Search using a town or postcode instead."
        : "Your current location could not be read. Search using a town or postcode instead."
    );
    setStatus("The current location could not be used.");
  }
}

async function requestTailorSearch(
  parameters,
  panel,
  progress,
  { alreadyBusy = false } = {}
) {
  if (!alreadyBusy) setTailorFinderBusy(panel, true);
  progress.removeAttribute("data-state");
  progress.textContent = "Looking for nearby alteration services…";
  setStatus("Looking for nearby alteration services…");

  try {
    const url = new URL(TAILORS_API_URL);
    for (const [key, value] of Object.entries(parameters)) {
      url.searchParams.set(key, String(value));
    }
    const response = await fetch(url);
    const body = await response.json();

    if (!response.ok) {
      throw new Error(
        body?.error?.message ??
          "Nearby alteration service search is unavailable right now."
      );
    }

    tailorSearchResults = body;
    renderTailorFinder();
    setStatus("Nearby alteration service search complete.");
  } catch (error) {
    setTailorFinderBusy(panel, false);
    showTailorSearchError(
      progress,
      error instanceof Error
        ? error.message
        : "Nearby alteration service search is unavailable right now."
    );
    setStatus("The nearby alteration service search could not be completed.");
  }
}

function showTailorSearchError(progress, message) {
  progress.dataset.state = "error";
  progress.textContent = message;
}

function setTailorFinderBusy(panel, busy) {
  for (const control of panel.querySelectorAll("button, input")) {
    control.disabled = busy;
  }
}

function buildTailorResults(attachment) {
  const section = document.createElement("section");
  section.className = "tailor-results";

  const heading = document.createElement("h3");
  heading.textContent = `Alteration services near ${attachment.locationLabel}`;

  const radius = document.createElement("p");
  radius.className = "tailor-radius";
  radius.textContent = `Showing OpenStreetMap listings within ${formatDistance(
    attachment.radiusMetres
  )}. Call ahead to confirm services and accessibility.`;
  section.append(heading, radius);

  if (attachment.tailors.length > 0) {
    const list = document.createElement("div");
    list.className = "tailor-grid";
    for (const [index, tailor] of attachment.tailors.entries()) {
      list.append(buildTailorCard(tailor, index));
    }
    section.append(list);
  } else {
    const empty = document.createElement("p");
    empty.className = "empty-results";
    empty.textContent =
      "No listed alteration service was found nearby. Try searching another location.";
    section.append(empty);
  }

  const attribution = document.createElement("a");
  attribution.className = "map-attribution";
  attribution.href = "https://www.openstreetmap.org/copyright";
  attribution.target = "_blank";
  attribution.rel = "noreferrer";
  attribution.textContent = attachment.attribution;
  section.append(attribution);
  return section;
}

function buildTailorCard(tailor, index) {
  const card = document.createElement("article");
  card.className = "tailor-card";

  const visual = document.createElement("div");
  visual.className = `tailor-card-visual identity-${index % 4}`;
  visual.setAttribute("aria-hidden", "true");
  const icon = document.createElement("span");
  icon.className = "tailor-card-icon";
  icon.textContent = "✂";
  const initials = document.createElement("strong");
  initials.className = "tailor-card-initials";
  initials.textContent = businessInitials(tailor.name);
  visual.append(icon, initials);

  const content = document.createElement("div");
  content.className = "tailor-card-content";

  const category = document.createElement("p");
  category.className = "tailor-category";
  category.textContent =
    tailor.category === "Dressmaker" ? "Dressmaker" : "Tailor & alterations";
  const name = document.createElement("h4");
  name.textContent = tailor.name;
  const distance = document.createElement("p");
  distance.className = "tailor-distance";
  distance.textContent = `${formatDistance(tailor.distanceMetres)} away`;
  const address = document.createElement("p");
  address.className = "tailor-address";
  address.textContent = tailor.address;

  const access = document.createElement("p");
  access.className = `tailor-access ${tailor.wheelchair}`;
  const accessIcon = document.createElement("span");
  accessIcon.setAttribute("aria-hidden", "true");
  accessIcon.textContent = "♿";
  const accessLabel = document.createElement("span");
  accessLabel.textContent = formatWheelchairAccess(tailor.wheelchair);
  access.append(accessIcon, accessLabel);

  content.append(name, category, distance, address, access);

  if (tailor.alterationService === "confirmed") {
    const alterations = document.createElement("p");
    alterations.className = "tailor-alterations";
    const alterationsIcon = document.createElement("span");
    alterationsIcon.setAttribute("aria-hidden", "true");
    alterationsIcon.textContent = "✓";
    const alterationsLabel = document.createElement("span");
    alterationsLabel.textContent = "Alteration service documented";
    alterations.append(alterationsIcon, alterationsLabel);
    content.append(alterations);
  }

  if (tailor.openingHours) {
    const openingHours = document.createElement("p");
    openingHours.className = "tailor-hours";
    openingHours.textContent = `Opening hours: ${tailor.openingHours}`;
    content.append(openingHours);
  }

  const actions = document.createElement("div");
  actions.className = "tailor-actions";
  actions.append(buildExternalLink("View on map →", tailor.mapUrl));
  if (tailor.website) {
    actions.append(buildExternalLink("Website", tailor.website));
  }
  if (tailor.phone) {
    const phone = document.createElement("a");
    phone.href = `tel:${tailor.phone.replace(/[^+\d]/g, "")}`;
    phone.textContent = "Call";
    actions.append(phone);
  }
  content.append(actions);
  card.append(visual, content);
  return card;
}

function businessInitials(name) {
  const words = String(name)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("") || "TA";
}

function buildExternalLink(label, href) {
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = label;
  return link;
}

function formatWheelchairAccess(value) {
  if (value === "yes") return "Wheelchair access documented";
  if (value === "limited") return "Limited wheelchair access documented";
  if (value === "no") return "Listed as not wheelchair accessible";
  return "Wheelchair access not documented";
}

function formatDistance(metres) {
  if (metres < 1000) return `${Math.max(1, Math.round(metres))} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

function appendProductGroup(
  container,
  title,
  products,
  kind,
  { current, resultSet }
) {
  if (!products?.length) return;

  const section = document.createElement("section");
  section.className = "product-group";

  const heading = document.createElement("h3");
  heading.textContent = `${title} (${products.length})`;

  const grid = document.createElement("div");
  grid.className = "product-grid";
  for (const result of products) {
    grid.append(createProductCard(result, kind, { current, resultSet }));
  }

  section.append(heading, grid);
  container.append(section);
}

function createProductCard(result, kind, { current, resultSet }) {
  const { product, compatibility } = result;
  const isSelected =
    current && session.conversationState.selectedProductId === product.id;
  const card = document.createElement("article");
  card.className = "product-card";
  card.classList.toggle("selected", isSelected);

  const imageFrame = document.createElement("div");
  imageFrame.className = "product-image-frame";

  const fallback = document.createElement("span");
  fallback.className = "image-fallback";
  fallback.textContent = product.name.charAt(0).toUpperCase();
  fallback.setAttribute("aria-hidden", "true");

  const image = document.createElement("img");
  image.src = product.imageUrl;
  image.alt = product.name;
  image.loading = "lazy";
  image.addEventListener("error", () => image.remove());
  imageFrame.append(fallback, image);

  const content = document.createElement("div");
  content.className = "product-content";

  const badge = document.createElement("p");
  badge.className = `match-badge ${kind}`;
  badge.textContent =
    kind === "compatible" ? "✓ Documented match" : "ⓘ Check missing details";

  const name = document.createElement("h4");
  name.textContent = product.name;

  const retailer = document.createElement("p");
  retailer.className = "retailer";
  retailer.textContent = product.retailer.name;

  const price = document.createElement("p");
  price.className = "price";
  price.textContent = formatPrice(product.price);

  const sizes = document.createElement("p");
  sizes.className = "sizes";
  sizes.textContent = `Available sizes: ${product.sizes.join(", ")}`;

  const facts = document.createElement("dl");
  facts.className = "product-feature-grid";
  const evidence =
    kind === "compatible"
      ? compatibility.confirmedMatches.slice(0, 3)
      : compatibility.missingInformation.slice(0, 3);

  for (const fact of evidence) {
    facts.append(buildProductFeature(fact, kind));
  }

  const link = document.createElement("a");
  link.className = "product-link";
  link.href = product.productUrl;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "View product details →";

  const actions = document.createElement("div");
  actions.className = "product-actions";

  if (product.virtualTryOnAvailable === true) {
    const tryOnButton = document.createElement("button");
    tryOnButton.className = "try-on-button";
    tryOnButton.type = "button";
    tryOnButton.setAttribute("aria-pressed", String(isSelected));
    const tryOnIcon = document.createElement("span");
    tryOnIcon.setAttribute("aria-hidden", "true");
    tryOnIcon.textContent = "♧";
    const tryOnLabel = document.createElement("span");
    tryOnLabel.textContent = isSelected ? "Selected to try on" : "Try it on";
    tryOnButton.append(tryOnIcon, tryOnLabel);
    tryOnButton.addEventListener("click", () =>
      handleTryOnSelection(product, resultSet)
    );
    actions.append(tryOnButton);
  }

  const measurementButton = document.createElement("button");
  measurementButton.className = "measurement-button";
  measurementButton.type = "button";
  const measurementIcon = document.createElement("span");
  measurementIcon.setAttribute("aria-hidden", "true");
  measurementIcon.textContent = "↔";
  const measurementLabel = document.createElement("span");
  measurementLabel.textContent = isUsableMeasurementProfile(
    session.measurementProfile
  )
    ? "Check my measurements"
    : "Add measurements";
  measurementButton.append(measurementIcon, measurementLabel);
  measurementButton.addEventListener("click", () => {
    openMeasurementDialog(product);
  });
  actions.append(measurementButton, link);

  content.append(badge, name, retailer, price, sizes);
  if (facts.childElementCount) content.append(facts);
  content.append(actions);
  card.append(imageFrame, content);
  return card;
}

function buildMeasurementProfileSummary() {
  const summary = document.createElement("div");
  summary.className = "measurement-profile-summary";

  const copy = document.createElement("p");
  const count = Object.keys(session.measurementProfile).length;
  copy.textContent = `${count} body measurement${count === 1 ? "" : "s"} saved for this conversation.`;

  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Reset measurements";
  reset.addEventListener("click", () => {
    session = resetMeasurementProfile(session);
    saveChatSession(session);
    renderConversation();
    setStatus("Saved measurements reset.");
  });

  summary.append(copy, reset);
  return summary;
}

function openMeasurementDialog(product) {
  const dialog = document.createElement("dialog");
  dialog.className = "measurement-dialog";
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (dialog.dataset.measurementsChanged === "true") renderConversation();
  });
  document.body.append(dialog);

  if (isUsableMeasurementProfile(session.measurementProfile)) {
    renderMeasurementComparison(dialog, product);
  } else {
    renderMeasurementForm(dialog, product);
  }
  dialog.showModal();
}

function renderMeasurementForm(dialog, product) {
  dialog.classList.add("measurement-entry-dialog");
  const shell = document.createElement("div");
  shell.className = "measurement-dialog-shell";

  const heading = document.createElement("h2");
  heading.id = "measurement-dialog-heading";
  heading.textContent = "Add your measurements once";
  dialog.setAttribute("aria-labelledby", heading.id);

  const intro = document.createElement("p");
  intro.textContent =
    "Chest and waist are required. Add any other body measurements you know in centimetres. They stay in this browser conversation and are not sent to the clothing assistant or YouCam.";

  const form = document.createElement("form");
  form.className = "measurement-form";
  form.noValidate = true;
  const grid = document.createElement("div");
  grid.className = "measurement-field-grid";

  for (const field of MEASUREMENT_FIELDS) {
    const isRequired = ["chest", "waist"].includes(field.name);
    const group = document.createElement("div");
    group.className = "measurement-field";
    const label = document.createElement("label");
    label.htmlFor = `measurement-${field.name}`;
    label.textContent = `${field.label} (cm) — ${isRequired ? "required" : "optional"}`;
    const help = document.createElement("span");
    help.id = `measurement-${field.name}-help`;
    help.textContent = field.help;
    const input = document.createElement("input");
    input.id = `measurement-${field.name}`;
    input.name = field.name;
    input.type = "number";
    input.inputMode = "decimal";
    input.min = "20";
    input.max = "250";
    input.step = "0.5";
    input.required = isRequired;
    if (Number.isFinite(session.measurementProfile?.[field.name])) {
      input.value = String(session.measurementProfile[field.name]);
    }
    input.setAttribute("aria-describedby", help.id);
    group.append(label, help, input);
    grid.append(group);
  }

  const error = document.createElement("p");
  error.className = "measurement-form-error";
  error.setAttribute("role", "alert");

  const actions = document.createElement("div");
  actions.className = "measurement-dialog-actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Save and compare";
  const cancel = document.createElement("button");
  cancel.className = "secondary-button";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => dialog.close());
  actions.append(save, cancel);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const values = Object.fromEntries(new FormData(form));
      const profile = normalizeMeasurementProfile(values);
      session = setMeasurementProfile(session, profile);
      saveChatSession(session);
      dialog.dataset.measurementsChanged = "true";
      renderMeasurementComparison(dialog, product);
      setStatus("Measurements saved for this conversation.");
    } catch (caught) {
      error.textContent =
        caught instanceof Error ? caught.message : "Check your measurements.";
      const firstMissingRequiredInput = [...form.querySelectorAll("input[required]")]
        .find((field) => field.value.trim() === "");
      (firstMissingRequiredInput ?? form.querySelector("input"))?.focus();
    }
  });

  form.append(grid, error, actions);
  shell.append(heading, intro, form);
  dialog.replaceChildren(shell);
}

function renderMeasurementComparison(dialog, product) {
  dialog.classList.remove("measurement-entry-dialog");
  const shell = document.createElement("div");
  shell.className = "measurement-dialog-shell measurement-comparison-shell";

  const header = document.createElement("header");
  header.className = "measurement-comparison-header";
  const headerCopy = document.createElement("div");

  const eyebrow = document.createElement("p");
  eyebrow.className = "selection-label";
  eyebrow.textContent = "Your saved measurements";
  const heading = document.createElement("h2");
  heading.id = "measurement-dialog-heading";
  heading.textContent = product.name;
  dialog.setAttribute("aria-labelledby", heading.id);

  const intro = document.createElement("p");
  intro.textContent =
    "This comparison uses documented garment measurements. It is a starting point for alteration questions, not a fit guarantee.";
  headerCopy.append(eyebrow, heading, intro);
  header.append(headerCopy, buildMeasurementDialogCloseButton(dialog));
  shell.append(header);

  const garmentMeasurements = resolveProductMeasurements(product);
  const comparisons = compareProductMeasurements(
    session.measurementProfile,
    garmentMeasurements
  );
  if (comparisons.length === 0) {
    const unavailable = document.createElement("p");
    unavailable.className = "measurement-unavailable";
    unavailable.textContent = garmentMeasurements.length
      ? "The listed garment measurements do not overlap with the body measurements you saved."
      : "The retailer has not supplied garment measurements for this product, so AccessWear cannot calculate an adjustment.";
    shell.append(unavailable);
  } else {
    shell.append(buildMeasurementSizeTabs(comparisons));
  }

  const footer = document.createElement("footer");
  footer.className = "measurement-dialog-footer";
  const unitNote = document.createElement("p");
  unitNote.className = "measurement-unit-note";
  const unitIcon = document.createElement("span");
  unitIcon.setAttribute("aria-hidden", "true");
  unitIcon.textContent = "↔";
  const unitCopy = document.createElement("span");
  unitCopy.textContent =
    "Measurements are in centimetres (cm). Saved values are body measurements. Confirm ease, stretch and seam allowance before altering.";
  unitNote.append(unitIcon, unitCopy);

  const reset = document.createElement("button");
  reset.className = "measurement-reset-button";
  reset.type = "button";
  reset.textContent = "Reset measurements";
  reset.addEventListener("click", () => {
    session = resetMeasurementProfile(session);
    saveChatSession(session);
    dialog.dataset.measurementsChanged = "true";
    renderMeasurementForm(dialog, product);
    setStatus("Saved measurements reset.");
  });
  footer.append(unitNote, reset);
  shell.append(footer);
  dialog.replaceChildren(shell);
}

function buildMeasurementDialogCloseButton(dialog) {
  const close = document.createElement("button");
  close.className = "measurement-dialog-close";
  close.type = "button";
  close.setAttribute("aria-label", "Close measurement comparison");
  close.textContent = "×";
  close.addEventListener("click", () => dialog.close());
  return close;
}

function resolveProductMeasurements(product) {
  const bundledMockMeasurements = MOCK_PRODUCT_MEASUREMENTS[product.id];
  if (Array.isArray(bundledMockMeasurements)) return bundledMockMeasurements;

  if (Array.isArray(product.measurements)) return product.measurements;

  return [];
}

function buildMeasurementSizeTabs(sizeResults) {
  const recommendedIndex = findRecommendedSizeIndex(sizeResults);
  let selectedIndex = recommendedIndex;
  const component = document.createElement("section");
  component.className = "measurement-size-comparison";

  const tabList = document.createElement("div");
  tabList.className = "measurement-size-tabs";
  tabList.setAttribute("role", "tablist");
  tabList.setAttribute("aria-label", "Compare available garment sizes");
  const panel = document.createElement("div");
  panel.id = "measurement-size-panel";
  panel.className = "measurement-size-panel";
  panel.setAttribute("role", "tabpanel");
  panel.tabIndex = 0;

  const tabs = sizeResults.map((sizeResult, index) => {
    const tab = document.createElement("button");
    tab.id = `measurement-size-tab-${index}`;
    tab.className = "measurement-size-tab";
    tab.type = "button";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panel.id);

    const label = document.createElement("strong");
    label.textContent = `Size ${sizeResult.size}`;
    tab.append(label);
    if (index === recommendedIndex) {
      const recommended = document.createElement("span");
      recommended.className = "recommended-tab-label";
      recommended.textContent = "Recommended";
      tab.append(recommended);
    }

    tab.addEventListener("click", () => selectTab(index));
    tab.addEventListener("keydown", (event) => {
      let nextIndex = null;
      if (["ArrowRight", "ArrowDown"].includes(event.key)) {
        nextIndex = (index + 1) % tabs.length;
      } else if (["ArrowLeft", "ArrowUp"].includes(event.key)) {
        nextIndex = (index - 1 + tabs.length) % tabs.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = tabs.length - 1;
      }

      if (nextIndex === null) return;
      event.preventDefault();
      selectTab(nextIndex, { moveFocus: true });
    });
    tabList.append(tab);
    return tab;
  });

  function selectTab(index, { moveFocus = false } = {}) {
    selectedIndex = index;
    for (const [tabIndex, tab] of tabs.entries()) {
      const selected = tabIndex === selectedIndex;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    panel.setAttribute("aria-labelledby", tabs[selectedIndex].id);
    renderMeasurementTabPanel(
      panel,
      sizeResults[selectedIndex],
      sizeResults[recommendedIndex],
      selectedIndex === recommendedIndex
    );
    if (moveFocus) tabs[selectedIndex].focus();
  }

  component.append(tabList, panel);
  selectTab(selectedIndex);
  return component;
}

function renderMeasurementTabPanel(
  panel,
  selectedSize,
  recommendedSize,
  isRecommended
) {
  const status = document.createElement("section");
  status.className = `measurement-fit-status ${
    isRecommended ? "recommended" : "comparison"
  }`;
  const statusIcon = document.createElement("span");
  statusIcon.className = "measurement-fit-status-icon";
  statusIcon.setAttribute("aria-hidden", "true");
  statusIcon.textContent = isRecommended ? "★" : "↔";
  const statusCopy = document.createElement("div");
  const statusHeading = document.createElement("h3");
  statusHeading.textContent = isRecommended
    ? selectedSize.assessment === "within_guide"
      ? "Best starting fit"
      : "Best available starting point"
    : `Comparing Size ${selectedSize.size}`;
  const statusDescription = document.createElement("p");
  statusDescription.textContent = isRecommended
    ? `Size ${selectedSize.size} offers the most balanced ease based on your saved measurements.`
    : `Size ${recommendedSize.size} is the recommended starting point. Review Size ${selectedSize.size}'s measurements and alteration notes below.`;
  statusCopy.append(statusHeading, statusDescription);
  status.append(statusIcon, statusCopy);

  const cards = document.createElement("div");
  cards.className = "measurement-detail-list";
  for (const comparison of selectedSize.comparisons) {
    cards.append(buildMeasurementDetailCard(comparison));
  }

  panel.replaceChildren(status, cards);
}

function buildMeasurementDetailCard(comparison) {
  const card = document.createElement("article");
  card.className = `measurement-detail-card ${comparison.status}`;

  const identity = document.createElement("div");
  identity.className = "measurement-detail-identity";
  const icon = buildMeasurementIllustration(comparison.name);
  const titleCopy = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = measurementLabel(comparison.name);
  const help = document.createElement("p");
  help.textContent = measurementHelp(comparison.name);
  titleCopy.append(heading, help);
  identity.append(icon, titleCopy);

  const values = document.createElement("dl");
  values.className = "measurement-value-grid";
  values.append(
    buildMeasurementValue("You", comparison.bodyValueCm),
    buildMeasurementValue("Garment", comparison.garmentValueCm, "accent"),
    buildMeasurementValue(
      isCircumferenceMeasurement(comparison.name) ? "Total room" : "Difference",
      comparison.differenceCm,
      "accent"
    )
  );

  const assessment = document.createElement("p");
  assessment.className = "measurement-assessment";
  const assessmentIcon = document.createElement("span");
  assessmentIcon.setAttribute("aria-hidden", "true");
  assessmentIcon.textContent = comparison.status === "within_guide" ? "✓" : "i";
  const assessmentCopy = document.createElement("span");
  assessmentCopy.textContent =
    comparison.status === "within_guide"
      ? "Within the starting ease guide for this measurement."
      : comparison.guidance;
  assessment.append(assessmentIcon, assessmentCopy);

  card.append(identity, values, assessment);
  return card;
}

function buildMeasurementValue(label, value, className = "") {
  const group = document.createElement("div");
  if (className) group.className = className;
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  const number = document.createElement("strong");
  number.textContent = formatMeasurementNumber(value);
  const unit = document.createElement("span");
  unit.textContent = "cm";
  detail.append(number, unit);
  group.append(term, detail);
  return group;
}

function measurementIcon(name) {
  if (["chest", "shoulder_width"].includes(name)) return "↔";
  if (["waist", "hip"].includes(name)) return "⌒";
  return "↕";
}

function buildMeasurementIllustration(name) {
  const icon = document.createElement("span");
  icon.className = "measurement-detail-icon";
  icon.setAttribute("aria-hidden", "true");

  if (["chest", "waist"].includes(name)) {
    icon.classList.add("has-illustration", name);
    const image = document.createElement("img");
    image.src = "/images/measurement.png";
    image.alt = "";
    image.className = "measurement-illustration-image";
    image.addEventListener("error", () => {
      icon.classList.remove("has-illustration", "chest", "waist");
      image.remove();
      icon.textContent = measurementIcon(name);
    });
    icon.append(image);
  } else {
    icon.textContent = measurementIcon(name);
  }

  return icon;
}

function measurementHelp(name) {
  return MEASUREMENT_FIELDS.find((field) => field.name === name)?.help ??
    "Your saved value compared with the documented garment measurement.";
}

function isCircumferenceMeasurement(name) {
  return ["chest", "waist", "hip"].includes(name);
}

function measurementLabel(name) {
  return MEASUREMENT_FIELDS.find((field) => field.name === name)?.label ?? name;
}

function formatMeasurementNumber(value) {
  if (value < 0) {
    const absolute = Math.abs(value);
    return `−${Number.isInteger(absolute) ? absolute : absolute.toFixed(1)}`;
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function handleTryOnSelection(product, resultSet) {
  try {
    if (
      session.conversationState.selectedProductId !== product.id ||
      !productResultsMatch(session.displayResults, resultSet)
    ) {
      resetPhotoSelection();
    }
    session = activateProductResults(session, resultSet);
    session = selectProductForTryOn(session, product);
    saveChatSession(session);
    renderConversation();
    setStatus(`${product.name} selected for a virtual preview.`);
    document.querySelector("#try-on-selection")?.focus();
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "This product could not be selected."
    );
  }
}

function buildTryOnSelection(results) {
  const selectedProductId = session.conversationState.selectedProductId;
  if (!selectedProductId) return null;

  const selectedResult = [
    ...(results.compatibleProducts ?? []),
    ...(results.productsWithMissingInformation ?? [])
  ].find(({ product }) => product.id === selectedProductId);

  if (!selectedResult?.product.virtualTryOnAvailable) return null;

  const panel = document.createElement("section");
  panel.id = "try-on-selection";
  panel.className = "try-on-selection";
  panel.tabIndex = -1;
  panel.setAttribute("aria-labelledby", "try-on-selection-heading");

  const label = document.createElement("p");
  label.className = "selection-label";
  label.textContent = "Selected for a virtual preview";

  const heading = document.createElement("h3");
  heading.id = "try-on-selection-heading";
  heading.textContent = selectedResult.product.name;

  const explanation = document.createElement("p");
  explanation.textContent =
    "A virtual preview may help you decide whether a physical try-on is worth the effort. Choose a photograph and review the consent statement. Your photograph is uploaded only when you select Upload photograph.";

  const guidance = document.createElement("ul");
  guidance.id = "try-on-photo-guidance";
  guidance.className = "photo-guidance";
  for (const instruction of [
    "Use a JPG or PNG smaller than 10 MB.",
    "Include one person, facing forward, with the full body clearly visible.",
    "Use a clear, well-lit photograph without major obstructions."
  ]) {
    const item = document.createElement("li");
    item.textContent = instruction;
    guidance.append(item);
  }

  const disclaimer = document.createElement("p");
  disclaimer.className = "selection-disclaimer";
  disclaimer.textContent =
    "AI warning: this preview may change body proportions or physical features. It is only a clothing visualization and cannot confirm fit, comfort, ease of dressing or accessibility.";

  const form = buildPhotoPreparationForm(selectedResult.product);
  panel.append(label, heading, explanation, guidance, form, disclaimer);
  return panel;
}

function buildPhotoPreparationForm(selectedProduct) {
  const form = document.createElement("form");
  form.className = "photo-form";

  const inputLabel = document.createElement("label");
  inputLabel.htmlFor = "try-on-photo";
  inputLabel.textContent = photoSelection.file
    ? "Choose a different photograph"
    : "Choose your photograph";

  const input = document.createElement("input");
  input.id = "try-on-photo";
  input.className = "photo-input";
  input.type = "file";
  input.accept = "image/jpeg,image/png";
  input.setAttribute("aria-describedby", "try-on-photo-guidance photo-error");
  input.addEventListener("change", () => {
    void handlePhotoChange(input.files?.[0] ?? null);
  });

  form.append(inputLabel, input);

  if (photoSelection.error) {
    const error = document.createElement("p");
    error.id = "photo-error";
    error.className = "photo-error";
    error.tabIndex = -1;
    error.setAttribute("role", "alert");
    error.textContent = photoSelection.error;
    form.append(error);
  } else {
    const emptyError = document.createElement("span");
    emptyError.id = "photo-error";
    emptyError.hidden = true;
    form.append(emptyError);
  }

  if (!photoSelection.file) return form;

  const preview = document.createElement("div");
  preview.className = "photo-preview";

  const image = document.createElement("img");
  image.src = photoSelection.previewUrl;
  image.alt = "Preview of the selected virtual try-on photograph";

  const details = document.createElement("div");
  const filename = document.createElement("p");
  filename.className = "photo-filename";
  filename.textContent = photoSelection.file.name;
  const metadata = document.createElement("p");
  metadata.className = "photo-metadata";
  metadata.textContent = `${photoSelection.width} × ${photoSelection.height} pixels · ${formatFileSize(photoSelection.file.size)}`;
  details.append(filename, metadata);
  preview.append(image, details);

  const consentRow = document.createElement("div");
  consentRow.className = "consent-row";
  const consent = document.createElement("input");
  consent.id = "try-on-consent";
  consent.type = "checkbox";
  consent.checked = photoSelection.consentGiven;
  consent.disabled = photoSelection.uploading || photoSelection.uploaded;
  const consentLabel = document.createElement("label");
  consentLabel.htmlFor = "try-on-consent";
  consentLabel.textContent =
    "I confirm that I am the person shown in this photograph, or I have their permission, and I agree to send it to YouCam to create my virtual clothing preview.";
  consentRow.append(consent, consentLabel);

  const photoDataNotice = document.createElement("p");
  photoDataNotice.className = "photo-data-notice";
  photoDataNotice.append(
    "YouCam processes the photograph for this optional preview. Read ",
    buildExternalLink("AccessWear’s privacy notice", "./privacy.html"),
    " and the ",
    buildExternalLink(
      "YouCam privacy policy",
      "https://www.perfectcorp.com/perfectbeauty/youcam/privacy-policy"
    ),
    "."
  );

  const confirm = document.createElement("button");
  confirm.className = "confirm-photo-button";
  confirm.type = "submit";
  confirm.disabled =
    !photoSelection.consentGiven ||
    photoSelection.uploading ||
    photoSelection.uploaded;
  confirm.textContent = photoSelection.uploading
    ? "Uploading photograph…"
    : photoSelection.uploaded
      ? "Photograph uploaded"
      : "Upload photograph";

  consent.addEventListener("change", () => {
    photoSelection.consentGiven = consent.checked;
    photoSelection.uploaded = false;
    photoSelection.fileId = null;
    resetGenerationState();
    confirm.disabled = !consent.checked;
    confirm.textContent = "Upload photograph";
    form.querySelector(".photo-ready")?.remove();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await handlePhotoUpload();
  });

  form.append(preview, consentRow, photoDataNotice, confirm);

  if (photoSelection.uploaded) {
    const ready = document.createElement("p");
    ready.className = "photo-ready";
    ready.textContent =
      "Photograph uploaded securely. It is ready to be paired with the selected garment.";
    form.append(ready);
    form.append(buildGenerationPanel(selectedProduct));
  }

  return form;
}

async function handlePhotoChange(file) {
  resetPhotoSelection();
  const validationGeneration = photoValidationGeneration;
  if (!file) {
    renderConversation();
    return;
  }

  setStatus("Checking the selected photograph…");
  const validation = await validateTryOnPhoto(file);

  if (validationGeneration !== photoValidationGeneration) return;

  if (!validation.valid) {
    photoSelection.error = validation.error;
    renderConversation();
    setStatus("The selected photograph cannot be used.");
    document.querySelector("#photo-error")?.focus();
    return;
  }

  photoSelection = {
    file,
    previewUrl: URL.createObjectURL(file),
    width: validation.width,
    height: validation.height,
    consentGiven: false,
    uploading: false,
    uploaded: false,
    fileId: null,
    taskId: null,
    generationStatus: "idle",
    generationError: null,
    resultUrl: null,
    error: null
  };
  renderConversation();
  setStatus("Photograph selected. Review the consent statement to continue.");
  document.querySelector("#try-on-selection")?.focus();
}

function emptyPhotoSelection() {
  return {
    file: null,
    previewUrl: null,
    width: null,
    height: null,
    consentGiven: false,
    uploading: false,
    uploaded: false,
    fileId: null,
    taskId: null,
    generationStatus: "idle",
    generationError: null,
    resultUrl: null,
    error: null
  };
}

function resetPhotoSelection() {
  photoValidationGeneration += 1;
  photoUploadController?.abort();
  photoUploadController = null;
  tryOnTaskController?.abort();
  tryOnTaskController = null;
  if (photoSelection.previewUrl) {
    URL.revokeObjectURL(photoSelection.previewUrl);
  }
  photoSelection = emptyPhotoSelection();
}

function resetGenerationState() {
  tryOnTaskController?.abort();
  tryOnTaskController = null;
  photoSelection.taskId = null;
  photoSelection.generationStatus = "idle";
  photoSelection.generationError = null;
  photoSelection.resultUrl = null;
  removeTurnstileWidget();
}

async function handlePhotoUpload() {
  const selectedProductId = session.conversationState.selectedProductId;
  if (
    !selectedProductId ||
    !photoSelection.file ||
    !photoSelection.consentGiven ||
    photoSelection.uploading ||
    photoSelection.uploaded
  ) {
    return;
  }

  const controller = new AbortController();
  photoUploadController = controller;
  photoSelection.uploading = true;
  photoSelection.error = null;
  renderConversation();
  setStatus("Creating a secure upload and sending the photograph…");

  try {
    const result = await uploadTryOnPhoto({
      apiUrl: TRY_ON_UPLOAD_API_URL,
      selectedProductId,
      file: photoSelection.file,
      consent: true,
      signal: controller.signal
    });

    if (photoUploadController !== controller) return;

    photoSelection.uploaded = true;
    photoSelection.fileId = result.fileId;
    setStatus("Photograph uploaded securely.");
  } catch (error) {
    if (error?.name === "AbortError" || photoUploadController !== controller) {
      return;
    }

    photoSelection.error =
      error instanceof Error
        ? error.message
        : "The photograph could not be uploaded. Please try again.";
    setStatus("The photograph could not be uploaded.");
  } finally {
    if (photoUploadController === controller) {
      photoSelection.uploading = false;
      photoUploadController = null;
      renderConversation();
      document.querySelector(
        photoSelection.error ? "#photo-error" : "#try-on-selection"
      )?.focus();
    }
  }
}

function buildGenerationPanel(selectedProduct) {
  const panel = document.createElement("section");
  panel.className = "generation-panel";
  panel.setAttribute("aria-labelledby", "generation-heading");

  const heading = document.createElement("h4");
  heading.id = "generation-heading";
  heading.textContent = photoSelection.resultUrl
    ? "Your virtual clothing preview"
    : "Create your virtual clothing preview";
  panel.append(heading);

  if (photoSelection.resultUrl) {
    const confirmation = document.createElement("p");
    confirmation.className = "generation-complete";
    confirmation.textContent =
      "Your preview is ready and has been added as the newest message. The conversation will move to it automatically.";
    panel.append(confirmation);
    return panel;
  }

  const explanation = document.createElement("p");
  explanation.textContent =
    "AccessWear will pair your uploaded photograph with this garment to create one visual preview.";

  const requiresHumanVerification = !photoSelection.taskId;

  if (requiresHumanVerification) {
    const verificationLabel = document.createElement("p");
    verificationLabel.className = "turnstile-label";
    verificationLabel.textContent =
      "Complete the security check before starting the generation.";

    const turnstileContainer = document.createElement("div");
    turnstileContainer.id = "try-on-turnstile";
    turnstileContainer.className = "turnstile-container";

    const turnstileStatus = document.createElement("p");
    turnstileStatus.id = "turnstile-status";
    turnstileStatus.className = "turnstile-status";
    turnstileStatus.setAttribute("role", "status");
    turnstileStatus.textContent = "Loading security check…";
    panel.append(verificationLabel, turnstileContainer, turnstileStatus);
    queueMicrotask(renderTurnstileWidget);
  }

  const generateButton = document.createElement("button");
  generateButton.id = "generate-try-on";
  generateButton.className = "generate-try-on-button";
  generateButton.type = "button";
  generateButton.disabled =
    photoSelection.generationStatus === "processing" ||
    (requiresHumanVerification && !turnstileToken);
  generateButton.textContent =
    photoSelection.generationStatus === "processing"
      ? "Generating preview…"
      : photoSelection.taskId
        ? "Check result again"
        : photoSelection.generationStatus === "failed"
          ? "Try creating the preview again"
          : "Create my virtual preview";
  generateButton.addEventListener("click", () => {
    void handleTryOnGeneration(selectedProduct);
  });
  panel.append(explanation, generateButton);

  if (photoSelection.generationStatus === "processing") {
    const progress = document.createElement("p");
    progress.className = "generation-progress";
    progress.setAttribute("role", "status");
    progress.textContent =
      "Your virtual clothing preview is being created. This can take a little while.";
    panel.append(progress);
  }

  if (photoSelection.generationError) {
    const error = document.createElement("p");
    error.id = "generation-error";
    error.className = "generation-error";
    error.tabIndex = -1;
    error.setAttribute("role", "alert");
    error.textContent = photoSelection.generationError;
    panel.append(error);
  }

  return panel;
}

async function handleTryOnGeneration(selectedProduct) {
  const selectedProductId = session.conversationState.selectedProductId;
  const taskRequiresVerification = !photoSelection.taskId;
  const tokenForRequest = turnstileToken;
  if (
    !selectedProductId ||
    !photoSelection.uploaded ||
    !photoSelection.fileId ||
    photoSelection.generationStatus === "processing" ||
    photoSelection.resultUrl ||
    (taskRequiresVerification && !tokenForRequest)
  ) {
    return;
  }

  const controller = new AbortController();
  let resultMessageAdded = false;
  tryOnTaskController = controller;
  photoSelection.generationStatus = "processing";
  photoSelection.generationError = null;
  renderConversation();
  setStatus("Creating your virtual clothing preview…");

  try {
    if (!photoSelection.taskId) {
      const createdTask = await createTryOnTask({
        tasksApiUrl: TRY_ON_TASKS_API_URL,
        selectedProductId,
        fileId: photoSelection.fileId,
        turnstileToken: tokenForRequest,
        signal: controller.signal
      });

      if (tryOnTaskController !== controller) return;
      photoSelection.taskId = createdTask.taskId;
    }

    const result = await waitForTryOnResult({
      tasksApiUrl: TRY_ON_TASKS_API_URL,
      taskId: photoSelection.taskId,
      signal: controller.signal
    });

    if (tryOnTaskController !== controller) return;

    photoSelection.generationStatus = "succeeded";
    photoSelection.resultUrl = result.resultUrl;
    session = addTryOnResultMessage(session, {
      taskId: photoSelection.taskId,
      productId: selectedProduct.id,
      productName: selectedProduct.name,
      resultUrl: result.resultUrl
    });
    saveChatSession(session);
    resultMessageAdded = true;
    setStatus("Your virtual clothing preview is ready.");
  } catch (error) {
    if (error?.name === "AbortError" || tryOnTaskController !== controller) {
      return;
    }

    if (error instanceof TryOnGenerationError && error.terminal) {
      photoSelection.taskId = null;
    }
    photoSelection.generationStatus = "failed";
    photoSelection.generationError =
      error instanceof Error
        ? error.message
        : "The virtual clothing preview could not be created. Please try again.";
    setStatus("The virtual clothing preview could not be completed.");
  } finally {
    if (tryOnTaskController === controller) {
      tryOnTaskController = null;
      renderConversation();
      if (resultMessageAdded) {
        scrollConversationToBottom({ smooth: true, waitForImage: true });
      } else {
        document.querySelector(
          photoSelection.generationError
            ? "#generation-error"
            : "#try-on-selection"
        )?.focus();
      }
    }
  }
}

function renderTurnstileWidget() {
  const container = document.querySelector("#try-on-turnstile");
  if (!container || turnstileWidgetId !== null) return;

  if (typeof globalThis.turnstile?.render !== "function") {
    turnstileRenderTimer = setTimeout(renderTurnstileWidget, 150);
    return;
  }

  try {
    turnstileWidgetId = globalThis.turnstile.render(container, {
      sitekey: TURNSTILE_SITE_KEY,
      action: TURNSTILE_ACTION,
      theme: "light",
      size: "flexible",
      callback(token) {
        turnstileToken = token;
        const button = document.querySelector("#generate-try-on");
        if (button) button.disabled = false;
        setTurnstileStatus("Security check complete.");
      },
      "expired-callback"() {
        turnstileToken = null;
        const button = document.querySelector("#generate-try-on");
        if (button) button.disabled = true;
        setTurnstileStatus("Security check expired. Complete it again.");
      },
      "error-callback"() {
        turnstileToken = null;
        const button = document.querySelector("#generate-try-on");
        if (button) button.disabled = true;
        setTurnstileStatus(
          "The security check could not load. Check your connection and try again."
        );
      }
    });
  } catch {
    setTurnstileStatus(
      "The security check could not start. Refresh the page and try again."
    );
  }
}

function removeTurnstileWidget() {
  if (turnstileRenderTimer !== null) {
    clearTimeout(turnstileRenderTimer);
    turnstileRenderTimer = null;
  }

  if (
    turnstileWidgetId !== null &&
    typeof globalThis.turnstile?.remove === "function"
  ) {
    try {
      globalThis.turnstile.remove(turnstileWidgetId);
    } catch {
      // The containing UI may already have been replaced.
    }
  }

  turnstileWidgetId = null;
  turnstileToken = null;
}

function setTurnstileStatus(message) {
  const status = document.querySelector("#turnstile-status");
  if (status) status.textContent = message;
}

function formatFileSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatPrice(price) {
  if (!price) return "Price unavailable";

  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: price.currency
    }).format(price.amount);
  } catch {
    return `${price.amount} ${price.currency}`;
  }
}

function buildProductFeature(fact, kind) {
  const feature = document.createElement("div");
  feature.className = `product-feature ${kind}`;
  const presentation = productFeaturePresentation(fact.field);

  const icon = document.createElement("span");
  icon.className = "product-feature-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = presentation.icon;

  const copy = document.createElement("div");
  const term = document.createElement("dt");
  term.textContent = presentation.label;
  const description = document.createElement("dd");
  description.textContent =
    kind === "missing"
      ? "Not documented"
      : formatProductFeatureValues(fact.field, fact.actualValues);
  copy.append(term, description);
  feature.append(icon, copy);
  return feature;
}

function productFeaturePresentation(field) {
  const presentations = {
    garmentType: { label: "Garment type", icon: "◇" },
    "access.closureType": { label: "Fastening", icon: "◉" },
    "access.closureLocation": { label: "Closure", icon: "↔" },
    "access.dressingMethod": { label: "Dressing feature", icon: "♡" },
    "access.gripFeature": { label: "Grip feature", icon: "○" },
    "access.openingExtent": { label: "Opening extent", icon: "↕" },
    measurements: { label: "Measurements", icon: "⌁" }
  };

  return presentations[field] ?? { label: "Product detail", icon: "i" };
}

function formatProductFeatureValues(field, values) {
  if (!Array.isArray(values) || values.length === 0) return "Documented";

  return values
    .map((value) => humanizeProductFeatureValue(field, value))
    .join(" · ");
}

function humanizeProductFeatureValue(field, value) {
  const raw = String(value);
  if (field === "measurements") {
    return raw.replace(/^([a-z_]+):/i, (_, name) =>
      `${humanizeWords(name)}:`
    );
  }

  const normalized = raw.toLowerCase();
  const specialValues = {
    "access.closureLocation:front": "Front opening",
    "access.closureLocation:back": "Back fastening",
    "access.closureLocation:side": "Side opening",
    "access.dressingMethod:full_front_opening": "Full front opening",
    "access.dressingMethod:pull_on": "Pull-on",
    "access.dressingMethod:wrap": "Wrap opening"
  };
  return specialValues[`${field}:${normalized}`] ?? humanizeWords(raw);
}

function humanizeWords(value) {
  const words = String(value).replaceAll("_", " ").trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Documented";
}

function setBusy(isBusy) {
  input.disabled = isBusy;
  sendButton.disabled = isBusy;
  clearButton.disabled = isBusy;
  sendButton.querySelector("span:last-child").textContent = isBusy
    ? "Sending"
    : "Send";
}

function setStatus(message) {
  statusRegion.textContent = message;
}

function resizeComposerInput() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function setupScrollInteractions() {
  const revealTargets = document.querySelectorAll(
    ".chat-panel, .alteration-section"
  );
  if (
    prefersReducedMotion() ||
    typeof IntersectionObserver !== "function"
  ) {
    for (const target of revealTargets) target.classList.add("is-visible");
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -8%" }
  );

  for (const target of revealTargets) {
    target.classList.add("scroll-reveal");
    observer.observe(target);
  }
}

function guideToAlterationSupport() {
  if (!alterationSection) return;

  const reducedMotion = prefersReducedMotion();
  alterationSection.classList.add("intent-guided");
  alterationSection.scrollIntoView({
    behavior: reducedMotion ? "auto" : "smooth",
    block: "start"
  });

  const focusDelay = reducedMotion ? 0 : 700;
  window.setTimeout(() => {
    tailorFinderContainer.querySelector("button")?.focus({
      preventScroll: true
    });
    alterationSection.classList.remove("intent-guided");
  }, focusDelay);
}

function setupJourneyNavigation() {
  if (!journeyNav || !pageProgressBar || !alterationSection) return;

  const hero = document.querySelector(".hero");
  const navigationLinks = [...journeyNav.querySelectorAll("a[data-section]")];
  let frameRequested = false;

  function updateJourneyNavigation() {
    frameRequested = false;
    const documentHeight = document.documentElement.scrollHeight;
    const scrollableDistance = Math.max(1, documentHeight - window.innerHeight);
    const progress = Math.min(1, Math.max(0, window.scrollY / scrollableDistance));
    pageProgressBar.style.transform = `scaleX(${progress})`;

    const revealPoint = hero
      ? hero.offsetTop + hero.offsetHeight * 0.55
      : window.innerHeight * 0.55;
    journeyNav.classList.toggle("is-visible", window.scrollY > revealPoint);

    const activeSection =
      window.scrollY + window.innerHeight * 0.42 >= alterationSection.offsetTop
        ? "alteration-support"
        : "clothing-assistant";
    for (const link of navigationLinks) {
      if (link.dataset.section === activeSection) {
        link.setAttribute("aria-current", "location");
      } else {
        link.removeAttribute("aria-current");
      }
    }
  }

  function requestJourneyUpdate() {
    if (frameRequested) return;
    frameRequested = true;
    window.requestAnimationFrame(updateJourneyNavigation);
  }

  window.addEventListener("scroll", requestJourneyUpdate, { passive: true });
  window.addEventListener("resize", requestJourneyUpdate);
  updateJourneyNavigation();
}

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function scrollConversationToBottom({
  smooth = false,
  waitForImage = false
} = {}) {
  const behavior = smooth && !prefersReducedMotion() ? "smooth" : "auto";
  const scrollToLatest = () => {
    messageList.scrollTo({
      top: messageList.scrollHeight,
      behavior
    });
  };

  window.requestAnimationFrame(scrollToLatest);

  if (!waitForImage) return;

  const latestImage = messageList.querySelector(
    ".message:last-child .message-image-attachment img"
  );
  if (latestImage && !latestImage.complete) {
    latestImage.addEventListener("load", scrollToLatest, { once: true });
    latestImage.addEventListener("error", scrollToLatest, { once: true });
  }
}
