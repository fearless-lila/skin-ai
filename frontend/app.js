import {
  applyChatResponse,
  buildChatRequest,
  clearChatSession,
  loadChatSession,
  saveChatSession
} from "./chat-state.js";

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

    session = applyChatResponse(session, currentMessage, body);
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
  const card = document.createElement("article");
  card.className = "product-card";

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

  content.append(badge, name, retailer, price, sizes);
  if (facts.childElementCount) content.append(facts);
  content.append(link);
  card.append(imageFrame, content);
  return card;
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
