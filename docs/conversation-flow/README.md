# Skin AI Conversation Flow

This document explains how a new message moves from the user interface to the backend and the LLM, how follow-up messages receive conversational context, when state changes, and what each schema protects.

It focuses on the conversational search flow. Product matching and virtual try-on are downstream workflows with their own rules.

## Current implementation status

The repository currently contains the schemas and mock catalogue, but it does not yet contain a frontend chat component, a `/api/chat` backend handler, an LLM API call, or a conversation database.

The persistence described below is therefore the planned MVP behaviour:

- Recent messages and conversation state live temporarily in frontend memory while the page remains open.
- Closing or refreshing the page loses that temporary state.
- Durable backend persistence by `conversationId` is a later improvement.

The schemas define the contracts that the future frontend and backend code must follow. A schema validates data; it does not store, transform, or send data by itself.

## Mental model

```text
User speaks naturally
        ↓
Frontend remembers the visible conversation
        ↓
Backend validates and adds trusted context
        ↓
LLM interprets the language and proposes structured output
        ↓
Backend validates and decides whether matching may run
        ↓
Frontend displays the reply and any grounded results
```

The responsibilities remain separate:

```text
Frontend remembers and displays.
Backend controls and executes.
LLM interprets and proposes.
Catalogue supplies product truth.
Schemas define and validate the boundaries.
```

## What is each schema for?

| Schema | Direction | Purpose | Is it supplied to the LLM? |
| --- | --- | --- | --- |
| [`chat-request.schema.json`](../../schemas/chat-request.schema.json) | Frontend → backend | Validates the newest message, recent visible messages, current requirements, and product ID references. | No. The backend uses it before constructing the model input. |
| [`user-requirements.schema.json`](../../schemas/user-requirements.schema.json) | Shared nested structure | Defines the controlled clothing vocabulary used for matching. It is referenced by the chat request and LLM response schemas. | Indirectly. It is resolved into the complete output contract. |
| [`llm-response.schema.json`](../../schemas/llm-response.schema.json) | LLM → backend | Restricts the LLM to `requestStatus`, `searchReady`, `reply`, and `requirements`, including the rules connecting those fields. | Yes. The backend supplies a resolved version as the required output shape and validates the returned JSON again. |
| [`product.schema.json`](../../schemas/product.schema.json) | Catalogue → backend | Defines trusted product records, measurements, accessibility facts, and evidence states. | Not for ordinary language interpretation. The backend may supply selected verified facts when they are necessary to answer a product question. |

The schema files do not perform conversion. Future backend code will perform the conversion:

```text
Schema = blueprint and validator
Backend handler = transformer and orchestrator
```

## What conversation state do we need?

The frontend needs two related forms of state.

### Visible message history

This is the text shown in the chat interface:

```json
[
  {
    "role": "user",
    "content": "Find me a front-opening dress."
  },
  {
    "role": "assistant",
    "content": "I’ll look for dresses with documented front openings."
  }
]
```

Only visible `user` and `assistant` messages belong here. Private system instructions, API keys, schema definitions, catalogue records, and raw LLM JSON do not belong in frontend message history.

The MVP sends no more than the 12 most recent completed messages. Keeping the history bounded controls request size and avoids sending an unlimited transcript to the model.

### Structured conversation state

This holds data needed for controlled follow-ups:

```json
{
  "currentRequirements": {
    "garmentTypes": ["dress"],
    "requiredAccess": {
      "closureLocation": ["front"]
    },
    "excludedAccess": {},
    "preferredAccess": {},
    "requiredMeasurements": []
  },
  "lastDisplayedProductIds": [
    "mock-dress-001",
    "mock-dress-003"
  ],
  "selectedProductId": null
}
```

Messages provide conversational wording. Structured state provides stable machine-readable memory. The model should not have to recover the current requirements by rereading the whole conversation on every turn.

Product IDs are references, not product facts. The browser may say that `mock-dress-001` was displayed, but the backend must load its name, fastening, measurements, and evidence from the trusted catalogue.

## How are user and assistant messages persisted?

The planned frontend chat component keeps a message array and structured state in JavaScript memory:

```js
let messages = [];

let conversationState = {
  currentRequirements: null,
  lastDisplayedProductIds: [],
  selectedProductId: null
};
```

For each successful turn:

1. The frontend reads the messages already displayed.
2. The user submits a new message.
3. The frontend shows the user's message, usually as a pending message.
4. The frontend sends the previous completed messages separately from the new `currentMessage` so the new message is not duplicated.
5. After the backend returns a validated response, the frontend records the assistant's `reply` text.
6. If the response contains a requirements object, the current requirements are replaced with that complete object.
7. If the response contains `requirements: null`, the previous requirements remain unchanged.
8. If matching runs, the frontend records the product IDs actually returned by the backend.

Conceptually:

```text
Before turn 1: []

Send A using recentMessages: []
Receive B
Stored history: [A, B]

Send C using recentMessages: [A, B]
Receive D
Stored history: [A, B, C, D]
```

This is temporary memory, not durable persistence. The project should not place photographs, API keys, or unprotected sensitive measurements into browser storage. If the product later needs conversations to survive refreshes or work across devices, the backend should store state by `conversationId`, apply retention rules, and let the frontend send only the ID and newest message.

## What is the complete flow for a new message?

### Stage 1: the user submits text

Suppose the visible history is empty and the user writes:

> Find me a dress with a front opening. I cannot reach a back zip.

The frontend keeps that text as the current message. It does not attempt to translate “front opening” or “cannot reach” into catalogue fields.

### Stage 2: the frontend builds the chat request

The frontend creates an object that follows the chat-request schema:

```json
{
  "conversationId": null,
  "currentMessage": "Find me a dress with a front opening. I cannot reach a back zip.",
  "recentMessages": [],
  "conversationState": {
    "currentRequirements": null,
    "lastDisplayedProductIds": [],
    "selectedProductId": null
  }
}
```

This object will be sent to the planned `POST /api/chat` backend route.

### Stage 3: the backend validates the chat request

The backend checks the object with `chat-request.schema.json` before calling the LLM. Among other rules, it verifies:

- `currentMessage` is a non-empty string no longer than 2,000 characters.
- There are no more than 12 recent messages.
- Message roles are only `user` or `assistant`.
- Current requirements use the approved vocabulary.
- Product ID references have a valid shape.
- No unexpected fields or browser-supplied product facts were inserted.

Invalid input stops here and receives a controlled error. It is not forwarded to the model.

### Stage 4: the backend enriches the runtime context

Runtime enrichment means adding trusted information needed for this turn. It is different from retailer catalogue enrichment.

```text
Retailer catalogue enrichment
→ records and verifies garment facts before users search

Conversation context enrichment
→ loads already trusted facts needed for the current turn
```

For a first request there may be no product context to add. For a later product question, the backend uses `lastDisplayedProductIds` or `selectedProductId` to reload the relevant product records from the catalogue. It never accepts product descriptions, measurements, or accessibility claims from the browser as truth.

### Stage 5: the backend constructs the model input

The backend converts the validated request into the provider's message format. The model input contains:

```text
Private system instructions
+ approved vocabulary and interpretation rules
+ bounded recent visible messages
+ current normalized requirements
+ trusted product facts when relevant
+ newest user message
```

Conceptually:

```text
SYSTEM:
Interpret functional clothing requirements. Do not infer needs from a diagnosis.
Use only the approved vocabulary. Do not claim unsupplied product facts.

CURRENT REQUIREMENTS:
None yet.

RECENT CONVERSATION:
None yet.

NEW USER MESSAGE:
Find me a dress with a front opening. I cannot reach a back zip.
```

The backend also supplies the resolved LLM-response schema as the required output format. The chat-request schema is not sent as the model's output format.

### Stage 6: the LLM returns a structured proposal

The expected response is:

```json
{
  "requestStatus": "supported",
  "searchReady": true,
  "reply": "I’ll look for dresses with documented front openings and exclude back fastenings.",
  "requirements": {
    "garmentTypes": ["dress"],
    "requiredAccess": {
      "closureLocation": ["front"]
    },
    "excludedAccess": {
      "closureLocation": ["back"]
    },
    "preferredAccess": {},
    "requiredMeasurements": []
  }
}
```

The LLM interprets language, but it does not execute a search. The response is an untrusted proposal even though it follows the requested JSON shape.

### Stage 7: the backend validates the LLM response

The backend validates the response with `llm-response.schema.json` and the nested user-requirements schema. Important rules include:

```text
unsupported
→ searchReady must be false
→ requirements must be null

searchReady true
→ status must be supported or mixed
→ complete valid requirements must be present

requirements object
→ complete replacement for current requirements

requirements null
→ keep current requirements unchanged
```

The backend also applies business rules that JSON Schema cannot fully express, including contradiction checks and execution limits. An invalid response is not executed. The frontend receives a tested fallback or controlled error.

### Stage 8: the backend decides whether to match products

The backend always returns a valid contextual reply. It only runs deterministic catalogue matching when the validated response contains `searchReady: true`.

```text
searchReady false
→ return the reply
→ do not search

searchReady true
→ use the validated requirements
→ run deterministic matching against trusted products
→ return the reply and grounded results
```

The LLM does not decide which product is compatible. Matching code compares the normalized requirements with verified facts from records that follow `product.schema.json`.

### Stage 9: the frontend records the completed turn

After the backend succeeds, the frontend:

- Adds the user's message and the assistant's `reply` to visible history.
- Replaces `currentRequirements` if a new complete requirements object was returned.
- Keeps the previous requirements if the response used `null`.
- Records only the product IDs returned by the backend as the latest displayed results.
- Renders the reply and any result explanations.

These values become the context for the next user message.

## How can the user follow up?

The model has no automatic memory of an earlier API call. A follow-up works because the next request includes relevant visible messages and structured state.

### Follow-up that changes the search

Previous requirement:

```text
Dress with a front opening; avoid a back fastening.
```

New message:

> Actually, I cannot use zips either.

The frontend sends the new message with recent history and the existing complete requirements. The LLM should return a complete replacement rather than a partial patch:

```json
{
  "requestStatus": "supported",
  "searchReady": true,
  "reply": "Understood. I’ll keep the front-opening requirement and exclude both zips and back fastenings.",
  "requirements": {
    "garmentTypes": ["dress"],
    "requiredAccess": {
      "closureLocation": ["front"]
    },
    "excludedAccess": {
      "closureType": ["zip"],
      "closureLocation": ["back"]
    },
    "preferredAccess": {},
    "requiredMeasurements": []
  }
}
```

The backend validates the full replacement and runs matching again.

### Follow-up that asks for an explanation

New message:

> What does a full front opening mean?

The requirements do not need to change, and no new search is required:

```json
{
  "requestStatus": "supported",
  "searchReady": false,
  "reply": "It means the garment opens completely down the front instead of opening only at the neckline.",
  "requirements": null
}
```

The frontend displays and records the reply. The backend retains the existing requirements.

### Follow-up about a displayed product

New message:

> Why did this dress match?

The request contains only product ID references. The backend reloads their verified catalogue records before constructing the LLM context. The model may explain only facts supplied by the backend. If the product reference is missing or ambiguous, the reply should ask the user to identify the product rather than inventing an answer.

### Irrelevant request

New message:

> Book me a flight.

The LLM can still produce a conversational boundary response:

```json
{
  "requestStatus": "unsupported",
  "searchReady": false,
  "reply": "I can’t book flights, but I can help with clothing searches and dressing requirements.",
  "requirements": null
}
```

The backend displays the reply and does not search the catalogue. Existing requirements remain in application state unless the product deliberately implements a separate “start over” control.

## What is sent at each stage?

| Stage | Sender → receiver | Data sent | Schema or control |
| --- | --- | --- | --- |
| User input | User → frontend | New natural-language message | Frontend length and empty-input checks |
| Chat API request | Frontend → backend | Current message, recent visible messages, current requirements, recent product IDs | `chat-request.schema.json` |
| Trusted lookup | Backend → catalogue | Product IDs only | Backend authorization and catalogue lookup rules |
| Model input | Backend → LLM | Private instructions, bounded history, current requirements, trusted product context, newest message | Backend prompt builder; input is not controlled by the LLM-response schema |
| Model output contract | Backend → LLM | Resolved allowed output structure | `llm-response.schema.json` plus `user-requirements.schema.json` |
| Model response | LLM → backend | Status, readiness, reply, requirements or `null` | Same response schemas are used again for server validation |
| Matching input | Backend → matcher | Validated requirements and trusted product records | `user-requirements.schema.json` and `product.schema.json` |
| UI result | Backend → frontend | Validated reply, authoritative current state, and grounded results when applicable | A dedicated backend-response schema has not yet been created |
| Next turn | Frontend → backend | Updated bounded history and state plus the next message | The loop returns to `chat-request.schema.json` |

## Sequence diagram

```mermaid
sequenceDiagram
    actor User
    participant Frontend as Frontend / browser
    participant Backend as Backend / chat handler
    participant Catalogue as Trusted catalogue
    participant LLM as LLM API

    User->>Frontend: Submit newest message
    Frontend->>Frontend: Read previous completed messages and state
    Frontend->>Backend: Chat request JSON
    Backend->>Backend: Validate with chat-request schema
    opt Product IDs are relevant
        Backend->>Catalogue: Load records by ID
        Catalogue-->>Backend: Return verified facts
    end
    Backend->>Backend: Build bounded model context
    Backend->>LLM: Context + required LLM-response schema
    LLM-->>Backend: Structured response proposal
    Backend->>Backend: Validate response and business rules
    alt searchReady is true
        Backend->>Catalogue: Match validated requirements
        Catalogue-->>Backend: Grounded results and evidence
    else searchReady is false
        Backend->>Backend: Skip catalogue matching
    end
    Backend-->>Frontend: Valid reply, state update, optional results
    Frontend->>Frontend: Record completed user and assistant messages
    Frontend-->>User: Display reply and optional shortlist
```

## How do the schemas help together?

Without the chat-request schema, malformed or oversized browser context could reach the backend logic or model. Without the LLM-response schema, the model could return arbitrary fields or an unusable response. Without the user-requirements schema, the model and matcher might use incompatible words for the same need. Without the product schema, unknown or weakly evidenced product claims could be treated as confirmed facts.

Together they form a controlled chain:

```text
Natural language
        ↓
Validated conversational input
        ↓
Structured and validated requirements
        ↓
Deterministic comparison with evidenced product facts
        ↓
Explainable result
```

The schemas reduce ambiguity, but the backend still remains responsible for transformation, trusted lookups, business-rule validation, execution limits, state updates, and error recovery.

## Remaining implementation work

This document describes the target MVP flow. The next code tasks are:

1. Build and test deterministic product matching.
2. Define the backend-to-frontend chat response contract.
3. Implement the frontend in-memory conversation state.
4. Implement `POST /api/chat` as the backend orchestrator.
5. Build and test the model-context formatter.
6. Connect the LLM with the resolved response schema.
7. Add controlled fallbacks and conversation error recovery.
8. Decide later whether durable backend conversation storage is needed.
