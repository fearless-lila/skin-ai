import {
  applyChatResponse,
  buildChatRequest,
  clearChatSession,
  loadChatSession,
  saveChatSession,
  selectProductForTryOn
} from "./chat-state.js";
import { validateTryOnPhoto } from "./photo-selection.js";

const CHAT_API_URL = "https://skin-ai.lilahu21797.workers.dev/api/chat";

const form = document.querySelector("#chat-form");
const input = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const clearButton = document.querySelector("#clear-chat");
const messageList = document.querySelector("#message-list");
const resultsRegion = document.querySelector("#results");
const statusRegion = document.querySelector("#request-status");
const welcomeTemplate = document.querySelector("#welcome-template");

let session = loadChatSession();
let photoSelection = emptyPhotoSelection();
let photoValidationGeneration = 0;

renderConversation();
renderResults(session.displayResults);

form.addEventListener("submit", handleSubmit);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});
clearButton.addEventListener("click", () => {
  resetPhotoSelection();
  session = clearChatSession();
  renderConversation();
  renderResults(null);
  setStatus("Conversation cleared.");
  input.focus();
});

async function handleSubmit(event) {
  event.preventDefault();

  const currentMessage = input.value.trim();
  if (!currentMessage) return;

  const requestBody = buildChatRequest(session, currentMessage);
  appendMessage("user", currentMessage);
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
    appendMessage("assistant", body.reply);
    renderResults(session.displayResults);
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
  messageList.replaceChildren();

  if (session.recentMessages.length === 0) {
    messageList.append(welcomeTemplate.content.cloneNode(true));
    return;
  }

  for (const message of session.recentMessages) {
    appendMessage(message.role, message.content);
  }
}

function appendMessage(role, content) {
  const message = document.createElement("article");
  message.className = `message ${role}-message`;

  const label = document.createElement("p");
  label.className = "message-label";
  label.textContent = role === "assistant" ? "Skin AI" : "You";

  const text = document.createElement("p");
  text.textContent = content;

  message.append(label, text);
  messageList.append(message);
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

function renderResults(results) {
  resultsRegion.replaceChildren();
  if (!results) return;

  const header = document.createElement("div");
  header.className = "results-header";

  const heading = document.createElement("h2");
  heading.textContent = "Clothing matches";
  header.append(heading);

  if (results.notice) {
    const notice = document.createElement("p");
    notice.className = "catalogue-notice";
    notice.textContent = results.notice;
    header.append(notice);
  }

  resultsRegion.append(header);
  appendProductGroup("Confirmed matches", results.compatibleProducts, "compatible");
  appendProductGroup(
    "More information needed",
    results.productsWithMissingInformation,
    "missing"
  );

  if (
    results.compatibleProducts.length === 0 &&
    results.productsWithMissingInformation.length === 0
  ) {
    const empty = document.createElement("p");
    empty.className = "empty-results";
    empty.textContent =
      "No catalogue items met these requirements. Try changing one preference or requirement.";
    resultsRegion.append(empty);
  }

  appendTryOnSelection(results);
}

function appendProductGroup(title, products, kind) {
  if (!products?.length) return;

  const section = document.createElement("section");
  section.className = "product-group";

  const heading = document.createElement("h3");
  heading.textContent = `${title} (${products.length})`;

  const grid = document.createElement("div");
  grid.className = "product-grid";
  for (const result of products) grid.append(createProductCard(result, kind));

  section.append(heading, grid);
  resultsRegion.append(section);
}

function createProductCard(result, kind) {
  const { product, compatibility } = result;
  const isSelected =
    session.conversationState.selectedProductId === product.id;
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
    tryOnButton.addEventListener("click", () => handleTryOnSelection(product));
    actions.append(tryOnButton);
  }

  content.append(badge, name, retailer, price, sizes);
  if (facts.childElementCount) content.append(facts);
  content.append(actions);
  card.append(imageFrame, content);
  return card;
}

function handleTryOnSelection(product) {
  try {
    if (session.conversationState.selectedProductId !== product.id) {
      resetPhotoSelection();
    }
    session = selectProductForTryOn(session, product);
    saveChatSession(session);
    renderResults(session.displayResults);
    setStatus(`${product.name} selected for virtual try-on.`);
    document.querySelector("#try-on-selection")?.focus();
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "This product could not be selected."
    );
  }
}

function appendTryOnSelection(results) {
  const selectedProductId = session.conversationState.selectedProductId;
  if (!selectedProductId) return;

  const selectedResult = [
    ...(results.compatibleProducts ?? []),
    ...(results.productsWithMissingInformation ?? [])
  ].find(({ product }) => product.id === selectedProductId);

  if (!selectedResult?.product.virtualTryOnAvailable) return;

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
    "Choose a photograph to prepare this virtual try-on. The file stays in this browser tab until a later step explicitly uploads it.";

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

  const form = buildPhotoPreparationForm();
  panel.append(label, heading, explanation, guidance, form, disclaimer);
  resultsRegion.append(panel);
}

function buildPhotoPreparationForm() {
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
  const consentLabel = document.createElement("label");
  consentLabel.htmlFor = "try-on-consent";
  consentLabel.textContent =
    "I consent to this photograph being sent to YouCam for the virtual try-on when I continue to the upload step.";
  consentRow.append(consent, consentLabel);

  const confirm = document.createElement("button");
  confirm.className = "confirm-photo-button";
  confirm.type = "submit";
  confirm.disabled = !photoSelection.consentGiven;
  confirm.textContent = photoSelection.confirmed
    ? "Photo confirmed"
    : "Confirm photo";

  consent.addEventListener("change", () => {
    photoSelection.consentGiven = consent.checked;
    photoSelection.confirmed = false;
    confirm.disabled = !consent.checked;
    confirm.textContent = "Confirm photo";
    form.querySelector(".photo-ready")?.remove();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!photoSelection.file || !photoSelection.consentGiven) return;

    photoSelection.confirmed = true;
    renderResults(session.displayResults);
    setStatus("Photo confirmed. It has not been uploaded.");
    document.querySelector("#try-on-selection")?.focus();
  });

  form.append(preview, consentRow, confirm);

  if (photoSelection.confirmed) {
    const ready = document.createElement("p");
    ready.className = "photo-ready";
    ready.textContent =
      "Photo ready for the next step. It remains only in this open browser tab and has not been uploaded.";
    form.append(ready);
  }

  return form;
}

async function handlePhotoChange(file) {
  resetPhotoSelection();
  const validationGeneration = photoValidationGeneration;
  if (!file) {
    renderResults(session.displayResults);
    return;
  }

  setStatus("Checking the selected photograph…");
  const validation = await validateTryOnPhoto(file);

  if (validationGeneration !== photoValidationGeneration) return;

  if (!validation.valid) {
    photoSelection.error = validation.error;
    renderResults(session.displayResults);
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
    confirmed: false,
    error: null
  };
  renderResults(session.displayResults);
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
    confirmed: false,
    error: null
  };
}

function resetPhotoSelection() {
  photoValidationGeneration += 1;
  if (photoSelection.previewUrl) {
    URL.revokeObjectURL(photoSelection.previewUrl);
  }
  photoSelection = emptyPhotoSelection();
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
