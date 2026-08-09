import {
  activateProductResults,
  addTryOnResultMessage,
  applyChatResponse,
  buildChatRequest,
  clearChatSession,
  loadChatSession,
  saveChatSession,
  selectProductForTryOn
} from "./chat-state.js";
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
const tailorFinderContainer = document.querySelector(
  "#tailor-finder-container"
);
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
queueMicrotask(scrollConversationToBottom);

form.addEventListener("submit", handleSubmit);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});
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

  const requestBody = buildChatRequest(session, currentMessage);
  appendMessage("user", currentMessage);
  scrollConversationToBottom();
  input.value = "";
  setBusy(true);
  setStatus("Looking at your request…");

  try {
    const response = await fetch(CHAT_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });
    const body = await response.json();

    if (!response.ok) {
      throw new Error(
        body?.error?.message ?? "The clothing assistant is unavailable right now."
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
    setStatus(body.searchPerformed ? "Search complete." : "Reply received.");
  } catch (error) {
    appendError(
      error instanceof Error
        ? error.message
        : "The clothing assistant is unavailable right now."
    );
    setStatus("The request could not be completed.");
  } finally {
    setBusy(false);
    input.focus();
  }
}

function renderConversation() {
  removeTurnstileWidget();
  messageList.replaceChildren();

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

  const label = document.createElement("p");
  label.className = "message-label";
  label.textContent = role === "assistant" ? "Skin AI" : "You";

  const text = document.createElement("p");
  text.textContent = content;

  message.append(label, text);

  if (attachment?.type === "product_results") {
    message.classList.add("has-product-results");
    message.append(
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
      "AI-generated visual approximation only. It does not confirm measurements, comfort or physical fit.";
    figure.append(image, fallback, caption);
    message.append(figure);
  }

  messageList.append(message);
  return message;
}

function appendError(content) {
  const error = document.createElement("article");
  error.className = "message error-message";

  const label = document.createElement("p");
  label.className = "message-label";
  label.textContent = "Something went wrong";

  const text = document.createElement("p");
  text.textContent = content;
  error.append(label, text);
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
  container.setAttribute("aria-label", "Clothing matches");
  const header = document.createElement("div");
  header.className = "results-header";

  const heading = document.createElement("h3");
  heading.textContent = "Clothing matches";
  header.append(heading);

  if (results.notice) {
    const notice = document.createElement("p");
    notice.className = "catalogue-notice";
    notice.textContent = results.notice;
    header.append(notice);
  }

  container.append(header);
  appendProductGroup(
    container,
    "Confirmed matches",
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
      "No catalogue items met these requirements. Try changing one preference or requirement.";
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
  if (tailorSearchResults) {
    finder.append(buildTailorResults(tailorSearchResults));
  }
  tailorFinderContainer.replaceChildren(finder);
}

function buildTailorFinder() {
  const panel = document.createElement("section");
  panel.className = "tailor-finder";
  panel.setAttribute("aria-label", "Tailor location search controls");

  const currentLocationButton = document.createElement("button");
  currentLocationButton.className = "location-button";
  currentLocationButton.type = "button";
  currentLocationButton.textContent = "Use my current location";

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
    "Precise coordinates are sent through Skin AI to OpenStreetMap only for this search; they are not saved or sent to the LLM. The location label and shop results stay in this browser tab.";

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
  progress.textContent = "Looking for nearby tailor shops…";
  setStatus("Looking for nearby tailor shops…");

  try {
    const url = new URL(TAILORS_API_URL);
    for (const [key, value] of Object.entries(parameters)) {
      url.searchParams.set(key, String(value));
    }
    const response = await fetch(url);
    const body = await response.json();

    if (!response.ok) {
      throw new Error(
        body?.error?.message ?? "Nearby tailor search is unavailable right now."
      );
    }

    tailorSearchResults = body;
    renderTailorFinder();
    setStatus("Nearby tailor search complete.");
  } catch (error) {
    setTailorFinderBusy(panel, false);
    showTailorSearchError(
      progress,
      error instanceof Error
        ? error.message
        : "Nearby tailor search is unavailable right now."
    );
    setStatus("The nearby tailor search could not be completed.");
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
  heading.textContent = `Tailors near ${attachment.locationLabel}`;

  const radius = document.createElement("p");
  radius.className = "tailor-radius";
  radius.textContent = `Showing OpenStreetMap listings within ${formatDistance(
    attachment.radiusMetres
  )}. Call ahead to confirm services and accessibility.`;
  section.append(heading, radius);

  if (attachment.tailors.length > 0) {
    const list = document.createElement("div");
    list.className = "tailor-grid";
    for (const tailor of attachment.tailors) {
      list.append(buildTailorCard(tailor));
    }
    section.append(list);
  } else {
    const empty = document.createElement("p");
    empty.className = "empty-results";
    empty.textContent =
      "No listed tailor was found nearby. Try searching another location.";
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

function buildTailorCard(tailor) {
  const card = document.createElement("article");
  card.className = "tailor-card";

  const category = document.createElement("p");
  category.className = "tailor-category";
  category.textContent = tailor.category;
  const name = document.createElement("h4");
  name.textContent = tailor.name;
  const distance = document.createElement("p");
  distance.className = "tailor-distance";
  distance.textContent = formatDistance(tailor.distanceMetres);
  const address = document.createElement("p");
  address.className = "tailor-address";
  address.textContent = tailor.address;

  const access = document.createElement("p");
  access.className = `tailor-access ${tailor.wheelchair}`;
  access.textContent = formatWheelchairAccess(tailor.wheelchair);

  card.append(category, name, distance, address, access);

  if (tailor.alterationService === "confirmed") {
    const alterations = document.createElement("p");
    alterations.className = "tailor-alterations";
    alterations.textContent = "Alteration service listed";
    card.append(alterations);
  }

  if (tailor.openingHours) {
    const openingHours = document.createElement("p");
    openingHours.className = "tailor-hours";
    openingHours.textContent = `Opening hours: ${tailor.openingHours}`;
    card.append(openingHours);
  }

  const actions = document.createElement("div");
  actions.className = "tailor-actions";
  actions.append(buildExternalLink("View on map", tailor.mapUrl));
  if (tailor.website) {
    actions.append(buildExternalLink("Website", tailor.website));
  }
  if (tailor.phone) {
    const phone = document.createElement("a");
    phone.href = `tel:${tailor.phone.replace(/[^+\d]/g, "")}`;
    phone.textContent = "Call";
    actions.append(phone);
  }
  card.append(actions);
  return card;
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
  if (value === "yes") return "Wheelchair access listed";
  if (value === "limited") return "Limited wheelchair access listed";
  if (value === "no") return "Listed as not wheelchair accessible";
  return "Wheelchair access not listed";
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
  badge.textContent = kind === "compatible" ? "Confirmed match" : "Check details";

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
  sizes.textContent = compatibility.compatibleSizes?.length
    ? `Compatible sizes: ${compatibility.compatibleSizes.join(", ")}`
    : `Available sizes: ${product.sizes.join(", ")}`;

  const facts = document.createElement("ul");
  facts.className = "evidence-list";
  const evidence =
    kind === "compatible"
      ? compatibility.confirmedMatches.slice(0, 3)
      : compatibility.missingInformation.slice(0, 3);

  for (const fact of evidence) {
    const item = document.createElement("li");
    item.textContent = formatEvidence(fact, kind);
    facts.append(item);
  }

  const link = document.createElement("a");
  link.className = "product-link";
  link.href = product.productUrl;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "View product details";

  const actions = document.createElement("div");
  actions.className = "product-actions";
  actions.append(link);

  if (product.virtualTryOnAvailable === true) {
    const tryOnButton = document.createElement("button");
    tryOnButton.className = "try-on-button";
    tryOnButton.type = "button";
    tryOnButton.setAttribute("aria-pressed", String(isSelected));
    tryOnButton.textContent = isSelected ? "Selected for try-on" : "Try this on";
    tryOnButton.addEventListener("click", () =>
      handleTryOnSelection(product, resultSet)
    );
    actions.append(tryOnButton);
  }

  content.append(badge, name, retailer, price, sizes);
  if (facts.childElementCount) content.append(facts);
  content.append(actions);
  card.append(imageFrame, content);
  return card;
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
    setStatus(`${product.name} selected for virtual try-on.`);
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
  label.textContent = "Selected for virtual try-on";

  const heading = document.createElement("h3");
  heading.id = "try-on-selection-heading";
  heading.textContent = selectedResult.product.name;

  const explanation = document.createElement("p");
  explanation.textContent =
    "Choose a photograph and review the consent statement. The photograph is uploaded only when you select Upload photograph.";

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
    "Virtual try-on will provide a visual preview only, not proof of physical fit.";

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
    "I consent to this photograph being sent to YouCam for this virtual try-on preview.";
  consentRow.append(consent, consentLabel);

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

  form.append(preview, consentRow, confirm);

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
    ? "Your virtual try-on preview"
    : "Generate the preview";
  panel.append(heading);

  if (photoSelection.resultUrl) {
    const confirmation = document.createElement("p");
    confirmation.className = "generation-complete";
    confirmation.textContent =
      "The generated image has been added to the conversation above, where it stays with your recent messages.";
    panel.append(confirmation);
    return panel;
  }

  const explanation = document.createElement("p");
  explanation.textContent =
    "Generating pairs the uploaded photograph with this garment and starts one YouCam processing task.";

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
          ? "Try generation again"
          : "Generate virtual try-on";
  generateButton.addEventListener("click", () => {
    void handleTryOnGeneration(selectedProduct);
  });
  panel.append(explanation, generateButton);

  if (photoSelection.generationStatus === "processing") {
    const progress = document.createElement("p");
    progress.className = "generation-progress";
    progress.setAttribute("role", "status");
    progress.textContent =
      "YouCam is generating the preview. This can take a little while.";
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
  tryOnTaskController = controller;
  photoSelection.generationStatus = "processing";
  photoSelection.generationError = null;
  renderConversation();
  setStatus("Creating the virtual try-on preview…");

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
    renderConversation();
    scrollConversationToBottom({ smooth: true });
    setStatus("Virtual try-on preview generated.");
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
        : "The virtual try-on could not be generated. Please try again.";
    setStatus("The virtual try-on preview could not be completed.");
  } finally {
    if (tryOnTaskController === controller) {
      tryOnTaskController = null;
      renderConversation();
      document.querySelector(
        photoSelection.generationError
          ? "#generation-error"
          : "#try-on-selection"
      )?.focus();
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

function formatEvidence(fact, kind) {
  const field = String(fact.field ?? "information").replaceAll("_", " ");
  if (kind === "missing") return `Missing: ${field}`;

  const values = Array.isArray(fact.actualValues) ? fact.actualValues.join(" · ") : "";
  return values ? `${field}: ${values}` : field;
}

function setBusy(isBusy) {
  input.disabled = isBusy;
  sendButton.disabled = isBusy;
  clearButton.disabled = isBusy;
  sendButton.querySelector("span").textContent = isBusy ? "Sending" : "Send";
}

function setStatus(message) {
  statusRegion.textContent = message;
}

function scrollConversationToBottom({ smooth = false } = {}) {
  messageList.scrollTo({
    top: messageList.scrollHeight,
    behavior: smooth ? "smooth" : "auto"
  });
}
