# llmaniac MVP

**llmaniac** is a lightweight, no-code backend service that captures messages in LLM-powered chats, uses a zero-shot model to classify them into predefined events based on the **container-specific configuration** (events, thresholds, allowed domains), and exposes a simple API for triggering analytics calls.

This MVP provides a local FastAPI-based implementation.

## Features

*   **Container-Specific Configuration:** Loads event definitions (`events.json`) and settings (`settings.json`, including `allowed_domains`) from a directory specific to the `containerId` (e.g., `client_configs/llm-000/`).
*   **Caching:** Container configurations are cached in memory after first load for performance.
*   **Exposes `/classify` endpoint:**
    *   Accepts `text`, `sender`, and `containerId`.
    *   **Domain Validation:** Verifies the request's `Origin` header against the `allowed_domains` specified in the container's `settings.json`. Returns 403 Forbidden if the origin is not allowed.
    *   Classifies the message **only against events matching the specified `sender`** from the container's `events.json`.
    *   Returns the classification result (`event` name, `confidence`, `shouldPush`, `sender`).
*   Exposes `/push` endpoint (unchanged behavior, logs request).
*   Provides a universal client-side JavaScript library (`snippets/llmaniac-client.js`) loadable via a small snippet, configurable via `window.llmaniacConfig` (including `containerId` and `chatPlatform`).
*   Uses local dependencies only.

## Project Structure

```
/llmaniac_project
├── client_configs/         <-- Root directory for container configurations
│   └── llm-000/            <-- Example: Directory for container 'llm-000'
│       ├── events.json     <-- Event definitions for this container
│       └── settings.json   <-- Settings (e.g., allowed domains) for this container
├── snippets/
│   └── llmaniac-client.js  <-- Universal client library
├── main.py                 <-- FastAPI application
├── requirements.txt
└── README.md
```

### Container Configuration Files

*   **`client_configs/<containerId>/events.json`**: List of event objects specific to this container.
*   **`client_configs/<containerId>/settings.json`**: Container-specific settings.
    *   **`allowed_domains`**: (List[str], Required) List of allowed origin hostnames for this `containerId`.

    Example `settings.json`:
    ```json
    {
      "allowed_domains": [ "localhost", "127.0.0.1", "app.example.com" ]
    }
    ```

## Setup

1.  Create the directory structure.
2.  Place `events.json` and `settings.json` for your default container (e.g., `llm-000`) in `client_configs/llm-000/`.
3.  Create venv: `python3 -m venv venv` & `source venv/bin/activate`.
4.  Install deps: `pip install -r requirements.txt`.

## Running the Service

Use Uvicorn to run the FastAPI application:

```bash
uvicorn main:app --reload --port 8000
```

*   `--reload`: Automatically restarts the server when code changes are detected.
*   `--port 8000`: Runs the service on port 8000 (default).

The service will start, load the events, and initialize the transformer model. This might take a moment the first time as the model needs to be downloaded.

## Testing the Endpoints

You can use tools like `curl` or HTTPie to test the API endpoints.

### 1. Classify a Message

Send a POST request to `/classify`, including the `containerId`. The request must originate from an allowed domain.

**Using `curl` (Simulating allowed origin):**

```bash
curl -X POST http://localhost:8000/classify \
-H "Content-Type: application/json" \
-H "Origin: http://localhost" \
-d '{
  "text": "Potrzebuję umówić rozmowę z kimś od sprzedaży",
  "sender": "human",
  "containerId": "llm-000"
}'
```

**Expected Response (Example):**

```json
{
  "event": "schedule_meeting",
  "confidence": 0.951234,
  "shouldPush": true,
  "sender": "human"
}
```

**Using `curl` (Simulating disallowed origin):**

```bash
curl -X POST http://localhost:8000/classify \
-H "Content-Type: application/json" \
-H "Origin: http://evil-domain.com" \
-d '{
  "text": "Test message",
  "sender": "human",
  "containerId": "llm-000"
}'
```

**Expected Response:** `403 Forbidden`

### 2. Simulate an Analytics Push

Send a POST request to `/push`. Include the `sender` and `event`.

**Using `curl`:**

```bash
curl -X POST http://localhost:8000/push \
-H "Content-Type: application/json" \
-d '{
  "event": "schedule_meeting",
  "sender": "human",
  "properties": {
    "container_id_from_config": "llm-000", // Client can add this if desired
    "source": "chat_widget"
  }
}'
```

**Expected Response:**

```json
{
  "status": "logged",
  "event_data": {
    "event": "schedule_meeting",
    "sender": "human",
    "properties": {
      "container_id_from_config": "llm-000",
      "source": "chat_widget"
    }
  }
}
```

The server console will also show log messages for classification and push events.

## Client-Side Integration

Integrating `llmaniac` into your frontend application uses a simple loader snippet, similar to Google Tag Manager. This snippet loads the main `llmaniac-client.js` library, which handles message capturing and classification based on your configuration.

**Two Main Integration Methods:**

1.  **Standard Event (`llmChatLogEvent`)**: You configure the loader snippet with `chatPlatform: 'standard'` (or leave it as default). Your application **must** dispatch the `llmChatLogEvent` for each message.
2.  **Platform-Specific API**: You configure the loader snippet with `chatPlatform` set to `'intercom'`, `'drift'`, or `'zendesk'`. The `llmaniac-client.js` library will automatically use the respective platform's client-side API to listen for messages. Your application **does not** need to dispatch `llmChatLogEvent` in this case.

### 1. (If using Standard Event) Implement the Standard Event Dispatch

If you set `chatPlatform: 'standard'`, your application needs to trigger a `CustomEvent` named `llmChatLogEvent` (or the name specified in `customEventName` config) on the `document` object for each message.

**`llmChatLogEvent` Standard Specification (MVP):**

*   **Event Name:** `llmChatLogEvent` (configurable via `customEventName`)
*   **Target:** `document`
*   **`event.detail` Object Structure:**
    *   `sender`: (String, **Required**) "human" or "ai".
    *   `text`: (String, **Required**) Full message content.

**Example Dispatch Code:**
```javascript
const messageDetails = {
  sender: "human",
  text: "The message text."
};
const chatEvent = new CustomEvent('llmChatLogEvent', { detail: messageDetails });
document.dispatchEvent(chatEvent);
```

### 2. Add the llmaniac Loader Snippet

Place the following snippet just before the closing `</body>` tag in your HTML. **Crucially, set the `containerId` in `window.llmaniacConfig`.**

```html
<!-- llmaniac Loader Snippet -->
<script>
  // --- llmaniac Configuration (Set BEFORE the snippet) ---
  window.llmaniacConfig = {
    // apiUrl: 'http://your-llmaniac-api.com/classify', // Default: http://localhost:8000/classify
    chatPlatform: 'standard', // Options: 'standard', 'intercom', 'drift', 'zendesk'
    containerId: 'llm-000'   // *** REQUIRED: Set your specific Container ID here ***
  };
  // --------------------------------------------------------

  (function(w, d, s, o, f, js, fjs) {
      // Config object (o) is already initialized above
      f = 'llmaniac-client.js';
      js = d.createElement(s);
      fjs = d.getElementsByTagName(s)[0];
      js.id = 'llmaniac-client-script';
      js.async = 1;
      // --- IMPORTANT: Set the correct path to llmaniac-client.js ---
      // For local testing (assuming served from snippets dir):
      js.src = '/snippets/' + f;
      // For production, replace with the URL where you host the file:
      // js.src = 'https://your-cdn.com/path/to/' + f;
      // -----------------------------------------------------------
      fjs.parentNode.insertBefore(js, fjs);
  }(window, document, 'script', 'llmaniacConfig'));
</script>
<!-- End llmaniac Loader Snippet -->
```

**Explanation:**

*   **Configuration (`window.llmaniacConfig`):** The `containerId` **must** be set correctly. The `chatPlatform` selects the integration method. `apiUrl` can be set if the backend is hosted elsewhere.
*   **Loading `llmaniac-client.js`:** Loads the main library. Ensure the `js.src` path is correct.
*   **Functionality:** The library sends the configured `containerId` to `/classify`. The backend validates the origin based on settings for that `containerId`.

**Important Considerations:**

*   **CORS:** Configure CORS in `main.py`.
*   **Hosting `llmaniac-client.js`:** Needs to be hosted accessible to browsers.
*   **Domain Validation:** Relies on the `Origin` header. Ensure your application/proxy sends it correctly. Domains in `settings.json` should be just the hostname (e.g., `example.com`).
*   **Container ID Security:** Treat `containerId` as a public identifier.
*   **User Identification (`userId`):** Still the client application's responsibility to manage and include in `dataLayer` pushes if needed.
*   **Error Handling:** Check browser console logs. 