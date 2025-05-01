# llmaniac MVP

**llmaniac** is a lightweight backend service designed to capture messages from chat applications, classify them into predefined events using the OpenAI API based on container-specific configuration, and facilitate analytics integration via Google Tag Manager (GTM) dataLayer pushes.

This version is deployed on Google Cloud Run and integrates with LangSmith for observability.

## Features

*   **Container-Specific Configuration:** Loads event definitions (`events.json`) and settings (`settings.json`, including `allowed_domains`) from a directory specific to the `containerId` (e.g., `client_configs/llm-000/`).
*   **OpenAI Classification:** Uses the OpenAI API (specifically `gpt-3.5-turbo` by default) to classify messages based on event descriptions and examples provided in `events.json`. Includes the previous message for context.
*   **Domain Validation:** Verifies the request's `Origin` header against the `allowed_domains` specified in the container's `settings.json`. Returns 403 Forbidden if the origin is not allowed.
*   **LangSmith Observability:** Automatically traces OpenAI API calls to LangSmith when configured.
*   **Google Secret Manager Integration:** Securely loads API keys (OpenAI, LangSmith) from GCP Secret Manager when running on Cloud Run.
*   **Environment Variable Fallback:** Reads configuration (API keys, LangSmith settings) from environment variables or a `.env` file for local development.
*   **Standardized DataLayer Events:** Pushes a consistent `llmaniac_event` to `dataLayer`, with the specific classified event name included in the `action` property.
*   **Cloud Run Deployment:** Includes `Dockerfile`, `.dockerignore`, `.gcloudignore`, and `cloudbuild.yaml` for easy deployment and CI/CD on Google Cloud Run.
*   **CI/CD:** Configured via Cloud Build trigger to automatically build and deploy on pushes to the `main` branch.
*   **Client-Side Snippet:** Provides a universal JavaScript client (`snippets/llmaniac-client.js`) served by the backend, loadable via a small loader snippet.

## Architecture (Cloud Run)

1.  **Frontend Application:** Hosts the `index.html` (or similar) with the chat interface.
2.  **Loader Snippet (in Frontend):** Loads `llmaniac-client.js` from the Cloud Run service URL.
3.  **`llmaniac-client.js`:**
    *   Listens for chat messages (via standard `llmChatLogEvent` or platform APIs).
    *   Sends classification requests (`text`, `sender`, `containerId`) to the `/classify` endpoint on Cloud Run.
    *   Receives classification results.
    *   Pushes standardized `llmaniac_event` to the `dataLayer`.
4.  **Cloud Run Service (`llmaniac`):
    *   Runs the FastAPI application (`main.py`).
    *   Loads API keys from GCP Secret Manager.
    *   Loads LangSmith config from environment variables.
    *   Serves the `/classify` endpoint.
    *   Serves the `/snippets/llmaniac-client.js` static file.
    *   Handles classification logic by calling the OpenAI API (potentially traced by LangSmith).
    *   Maintains a simple in-memory history of the last message per container for context.
5.  **GCP Secret Manager:** Stores `OPENAI_API_KEY` and `LANGSMITH_API_KEY` securely.
6.  **Cloud Build:** Builds the Docker image and deploys new revisions to Cloud Run automatically on `git push` to `main`.
7.  **Google Container Registry (GCR):** Stores the Docker images.
8.  **LangSmith:** Receives traces of OpenAI calls for monitoring and debugging.

## Project Structure

```
/llmaniac
├── client_configs/         <-- Root directory for container configurations
│   └── llm-000/            <-- Example: Directory for container 'llm-000'
│       ├── events.json     <-- Event definitions for this container
│       └── settings.json   <-- Settings (e.g., allowed domains)
├── snippets/
│   └── llmaniac-client.js  <-- Universal client library (served by backend)
├── .env.example            <-- Example environment file for local dev
├── .dockerignore           <-- Files to ignore for Docker build context
├── .gcloudignore           <-- Files to ignore for gcloud source upload
├── .gitignore
├── cloudbuild.yaml         <-- Cloud Build CI/CD configuration
├── Dockerfile              <-- Docker image definition
├── main.py                 <-- FastAPI application
├── requirements.txt
└── README.md
```

## Configuration

Configuration relies on environment variables, secrets, and container-specific JSON files.

### 1. Backend Configuration (Cloud Run / Local)

The backend (`main.py`) requires the following configuration, loaded differently depending on the environment:

*   **`OPENAI_API_KEY`** (Secret):
    *   **Cloud Run:** Loaded from GCP Secret Manager (Secret ID: `openai-api-key`). Must be created beforehand.
    *   **Local:** Loaded from `.env` file or system environment variable `OPENAI_API_KEY`.
*   **`LANGSMITH_API_KEY`** (Secret, Optional):
    *   **Cloud Run:** Loaded from GCP Secret Manager (Secret ID: `langsmith-api-key`). Must be created beforehand if tracing is enabled.
    *   **Local:** Loaded from `.env` file or system environment variable `LANGSMITH_API_KEY`.
*   **`LANGSMITH_TRACING`** (Environment Variable, Optional):
    *   **Cloud Run:** Set via `--set-env-vars` in `cloudbuild.yaml` (e.g., `LANGSMITH_TRACING=true`).
    *   **Local:** Set in `.env` file or system environment variable (e.g., `LANGSMITH_TRACING=true`). If set to `"true"`, tracing is enabled.
*   **`LANGSMITH_PROJECT`** (Environment Variable, Optional):
    *   **Cloud Run:** Set via `--set-env-vars` in `cloudbuild.yaml` (e.g., `LANGSMITH_PROJECT=llmaniac`).
    *   **Local:** Set in `.env` file or system environment variable. Defaults to `"default"` if not set.
*   **`GOOGLE_CLOUD_PROJECT`** (Environment Variable):
    *   **Cloud Run:** Automatically set by the Cloud Run environment.
    *   **Local:** Not typically needed unless directly interacting with GCP services that require it.

**`.env` File (for Local Development):**

Create a `.env` file in the project root (copy from `.env.example`):

```dotenv
# .env file for local development

# Required
OPENAI_API_KEY=sk-...

# Optional - LangSmith
LANGSMITH_API_KEY=ls__...
LANGSMITH_TRACING=true
LANGSMITH_PROJECT=llmaniac-local # Use a different project for local traces

# GOOGLE_CLOUD_PROJECT=your-gcp-project-id # Only needed if testing secret manager locally
```

### 2. Container Configuration (`client_configs/`)

*   Place configuration files for each client/container in `client_configs/<your-container-id>/`.
*   **`events.json`**: A JSON list of event objects. Each object should have:
    *   `name`: (String) Unique name for the event (e.g., `provided_email`).
    *   `description`: (String) Description used in the OpenAI prompt.
    *   `examples`: (List[String]) Examples used in the OpenAI prompt.
    *   `sender`: (String) `"human"` or `"ai"`. The event will only be considered for messages from this sender.
    *   `threshold`: (Float, Optional) Currently **not used** for decision making with OpenAI classification, but kept for potential future use or informational purposes.
*   **`settings.json`**: Container-specific settings.
    *   `allowed_domains`: (List[String], Required) List of allowed origin hostnames (e.g., `["localhost", "yourdomain.com"]`). Required for the `/classify` endpoint to accept requests.

### 3. Frontend Snippet Configuration

In your frontend HTML (e.g., `index.html`), configure the loader snippet:

```html
<!-- llmaniac Loader Snippet -->
<script>
  // --- llmaniac Configuration (Set BEFORE the snippet) ---
  window.llmaniacConfig = {
    // apiUrl: 'https://YOUR_CUSTOM_DOMAIN/classify', // Default: https://llmaniac-249969218520.europe-central2.run.app/classify
    chatPlatform: 'standard', // Options: 'standard', 'intercom', 'drift', 'zendesk'
    containerId: 'llm-000',   // *** REQUIRED: Set your specific Container ID here ***
    // customEventName: 'myCustomChatEvent', // Optional: Name for the standard event
    // logLevel: 'info',     // Optional: 'debug', 'info', 'warn', 'error', 'none'
    // enableDataLayerPush: true, // Optional: Set to false to disable dataLayer pushes (when not using postMessage)
    // --- Options for iframe integration ---
    // sendViaPostMessage: false, // Optional: Set to true if llmaniac-client.js runs inside an iframe
    // parentOrigin: null       // Optional: Required if sendViaPostMessage is true. Set to the origin of the parent window (e.g., 'https://yourdomain.com')
  };
  // --------------------------------------------------------

  (function(w, d, s, o, f, js, fjs) {
      f = 'llmaniac-client.js';
      js = d.createElement(s);
      fjs = d.getElementsByTagName(s)[0];
      js.id = 'llmaniac-client-script';
      js.async = 1;
      // --- Point to your deployed Cloud Run service URL --- 
      js.src = 'https://llmaniac-249969218520.europe-central2.run.app/snippets/' + f; 
      // ---------------------------------------------------
      fjs.parentNode.insertBefore(js, fjs);
  }(window, document, 'script', 'llmaniacConfig'));
</script>
<!-- End llmaniac Loader Snippet -->
```

**Key Frontend Points:**

*   Set `window.llmaniacConfig.containerId` correctly.
*   Set `js.src` to point to the `/snippets/llmaniac-client.js` path on your **deployed Cloud Run service URL**.
*   If using `chatPlatform: 'standard'`, ensure your application dispatches the `llmChatLogEvent` (see client library code for details).

## Client-Side Integration

Integrating `llmaniac` into your frontend application uses a simple loader snippet, similar to Google Tag Manager. This snippet loads the main `llmaniac-client.js` library, which handles message capturing and classification based on your configuration.

**Two Main Integration Methods:**

1.  **Standard Event (`llmChatLogEvent`)**: You configure the loader snippet with `chatPlatform: 'standard'` (or leave it as default). Your application **must** dispatch the `llmChatLogEvent` (or the event name specified in `customEventName` config) for each message.
2.  **Platform-Specific API**: You configure the loader snippet with `chatPlatform` set to `'intercom'`, `'drift'`, or `'zendesk'`. The `llmaniac-client.js` library will automatically use the respective platform's client-side API to listen for messages. Your application **does not** need to dispatch `llmChatLogEvent` in this case.

### 1. (If using Standard Event) Implement the Standard Event Dispatch

If you set `chatPlatform: 'standard'`, your application needs to trigger a `CustomEvent` named `llmChatLogEvent` (or the name specified in `customEventName` config) on the `document` object for each message.

**`llmChatLogEvent` Standard Specification (MVP):**

*   **Event Name:** `llmChatLogEvent` (configurable via `customEventName` in `window.llmaniacConfig`)
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
// Use the configured event name, default is 'llmChatLogEvent'
const eventName = window.llmaniacConfig?.customEventName || 'llmChatLogEvent'; 
const chatEvent = new CustomEvent(eventName, { detail: messageDetails });
document.dispatchEvent(chatEvent);
```

### 2. Add the llmaniac Loader Snippet

Place the following snippet just before the closing `</body>` tag in your HTML. **Crucially, set the `containerId` in `window.llmaniacConfig`.**

```html
<!-- llmaniac Loader Snippet -->
<script>
  // --- llmaniac Configuration (Set BEFORE the snippet) ---
  window.llmaniacConfig = {
    // apiUrl: 'https://YOUR_CUSTOM_DOMAIN/classify', // Default: https://llmaniac-249969218520.europe-central2.run.app/classify
    chatPlatform: 'standard', // Options: 'standard', 'intercom', 'drift', 'zendesk'
    containerId: 'llm-000',   // *** REQUIRED: Set your specific Container ID here ***
    // customEventName: 'myCustomChatEvent', // Optional: Name for the standard event
    // logLevel: 'info',     // Optional: 'debug', 'info', 'warn', 'error', 'none'
    // enableDataLayerPush: true, // Optional: Set to false to disable dataLayer pushes (when not using postMessage)
    // --- Options for iframe integration ---
    // sendViaPostMessage: false, // Optional: Set to true if llmaniac-client.js runs inside an iframe
    // parentOrigin: null       // Optional: Required if sendViaPostMessage is true. Set to the origin of the parent window (e.g., 'https://yourdomain.com')
  };
  // --------------------------------------------------------

  (function(w, d, s, o, f, js, fjs) {
      // Config object (o) is already initialized above as window.llmaniacConfig
      f = 'llmaniac-client.js';
      js = d.createElement(s);
      fjs = d.getElementsByTagName(s)[0];
      js.id = 'llmaniac-client-script';
      js.async = 1;
      // --- Point to your deployed Cloud Run service URL --- 
      js.src = 'https://llmaniac-249969218520.europe-central2.run.app/snippets/' + f; 
      // ---------------------------------------------------
      fjs.parentNode.insertBefore(js, fjs);
  }(window, document, 'script', 'llmaniacConfig'));
</script>
<!-- End llmaniac Loader Snippet -->
```

**Explanation:**

*   **Configuration (`window.llmaniacConfig`):** The `containerId` **must** be set correctly. The `chatPlatform` selects the integration method. `apiUrl` can be set if the backend is hosted elsewhere (defaults to the Cloud Run service URL). `logLevel`, `enableDataLayerPush` (used when `sendViaPostMessage` is false), and `customEventName` are optional.
*   **Iframe Integration:** If `llmaniac-client.js` runs inside an iframe, set `sendViaPostMessage: true` and provide the parent window's origin in `parentOrigin`. This makes the script send results using `window.parent.postMessage()` instead of directly pushing to `dataLayer`. See the section below on handling these messages.
*   **Loading `llmaniac-client.js`:** Loads the main library from the deployed Cloud Run service URL.
*   **Functionality:** The library sends the configured `containerId` to `/classify`. The backend validates the origin based on settings for that `containerId`.

### 3. Handling postMessage (if using iframe)

If you set `sendViaPostMessage: true` in the configuration (because `llmaniac-client.js` is loaded within an iframe), the script will send classification results to the parent window using `window.parent.postMessage()`. The parent window (where your GTM container is loaded) needs to listen for these messages and push them to the `dataLayer`.

Add the following code as a "Custom HTML" tag in your GTM container, triggered on page load (e.g., "DOM Ready" or "Window Loaded"). This code is written in ES5 to ensure compatibility with GTM's environment.

**GTM Custom HTML Tag Code:**

```html
<script>
  (function() {
    window.addEventListener('message', function(event) {
      // --- IMPORTANT: Set the expected origin of the iframe ---
      var expectedOrigin = 'https://URL-OF-YOUR-CHAT-IFRAME.com'; // <-- Replace with the actual origin!

      // Verify the message origin for security
      if (event.origin !== expectedOrigin) {
        // Optional: Log unexpected origins for debugging
        // console.warn('Received message from unexpected origin:', event.origin);
        return;
      }

      var messageData = event.data;

      // Check if it's the message type sent by llmaniac-client.js
      if (messageData && messageData.type === 'llmaniacClassification' && messageData.data) {
        console.log('Received llmaniac classification from iframe:', messageData.data);

        var classificationResult = messageData.data; // This contains { event, confidence, sender, containerId, chat_platform, ... }

        // Ensure dataLayer exists
        window.dataLayer = window.dataLayer || [];

        // Prepare the payload for dataLayer (matches the direct push format)
        var dataLayerPayload = {
            'event': 'llmaniac_event', // Standard GTM event name
            'action': classificationResult.event,
            'confidence': classificationResult.confidence,
            'message_sender_type': classificationResult.sender,
            'llm_container_id': classificationResult.containerId,
            'chat_platform': classificationResult.chat_platform
            // Add other relevant fields if they are sent in messageData.data
        };

        // Push to dataLayer
        try {
            window.dataLayer.push(dataLayerPayload);
            console.log('Pushed llmaniac event from iframe to dataLayer:', dataLayerPayload);
        } catch (e) {
            console.error('Error pushing received message to dataLayer:', e);
        }
      }
    });

    console.log('Parent window listener for llmaniac iframe messages is ready (ES5 compatible).');
  })();
</script>
```

**Key Points for the Parent Page Listener:**

*   **`expectedOrigin`:** You **must** replace `'https://URL-OF-YOUR-CHAT-IFRAME.com'` with the actual origin (protocol + domain + port) from which your chat iframe is served. This is crucial for security.
*   **Message Structure:** The listener expects messages with `event.data.type === 'llmaniacClassification'` and the actual classification details within `event.data.data`.
*   **`dataLayer` Push:** The listener constructs the `dataLayerPayload` using the received data and pushes it to the parent window's `dataLayer`.

## Local Development

1.  Create and activate a Python virtual environment: `python3 -m venv venv && source venv/bin/activate`.
2.  Install dependencies: `pip install -r requirements.txt`.
3.  Create a `.env` file and add your `OPENAI_API_KEY` and optionally LangSmith keys/settings.
4.  Ensure you have configuration files in `client_configs/your-container-id/`.
5.  Run the FastAPI server: `uvicorn main:app --reload --port 8001` (or another port).
6.  Ensure your frontend HTML uses `http://localhost:8001` (or your chosen port) for the `apiUrl` in `classifyMessage` and the `js.src` in the loader snippet (or configure `window.llmaniacConfig.apiUrl`).

## Deployment (Cloud Run)

Deployment is handled automatically via CI/CD configured in `cloudbuild.yaml` and triggered by pushes to the `main` branch on GitHub.

**Prerequisites:**

*   GCP Project created (`ai-match-439212` in this case).
*   Billing enabled for the project.
*   `gcloud` CLI installed and authenticated (`gcloud auth login`).
*   Required APIs enabled: Cloud Build, Cloud Run, Secret Manager, Artifact Registry (`gcloud services enable ...`).
*   Secrets created in Secret Manager: `openai-api-key`, `langsmith-api-key`.
*   Cloud Build Trigger configured to point to the GitHub repo (`mbrucki/llmaniac`) and use `cloudbuild.yaml`.
*   The Cloud Build service account might need the "Secret Manager Secret Accessor" and "Cloud Run Admin" roles if not granted by default.

**Manual Deployment (if needed):**

1.  Build the image: `gcloud builds submit . --tag gcr.io/ai-match-439212/llmaniac:latest`
2.  Deploy to Cloud Run (use the command from `cloudbuild.yaml` as a template):
    ```bash
    gcloud run deploy llmaniac \
      --image gcr.io/ai-match-439212/llmaniac:latest \
      --platform managed \
      --region europe-central2 \
      --allow-unauthenticated \
      --set-secrets=OPENAI_API_KEY=openai-api-key:latest,LANGSMITH_API_KEY=langsmith-api-key:latest \
      --set-env-vars=LANGSMITH_TRACING=true,LANGSMITH_PROJECT=llmaniac \
      --memory=256Mi \
      --cpu=1 \
      --cpu-throttling \
      --min-instances=0 \
      --max-instances=5 \
      --concurrency=80
    ```

## CI/CD

*   A Cloud Build trigger is set up to monitor the `main` branch of the `mbrucki/llmaniac` GitHub repository.
*   On push to `main`, the trigger executes the steps defined in `cloudbuild.yaml`:
    1.  Builds the Docker image using the latest code.
    2.  Pushes the image to Google Container Registry with tags `:latest` and `:$SHORT_SHA` (commit hash).
    3.  Deploys the newly built image (tagged with commit SHA) to the `llmaniac` Cloud Run service.

## Testing the Deployed Service

Use the public URL provided after deployment (e.g., `https://llmaniac-249969218520.europe-central2.run.app`).

Ensure your frontend application points to this URL for both the `/classify` API calls and loading the `llmaniac-client.js` snippet.

Use `curl` or similar tools to test the `/classify` endpoint, making sure to include a valid `Origin` header that matches one of the `allowed_domains` for your `containerId`:

```bash
curl -X POST https://llmaniac-249969218520.europe-central2.run.app/classify \
-H "Content-Type: application/json" \
-H "Origin: <YOUR_ALLOWED_FRONTEND_DOMAIN>" \
-d '{
  "text": "Test message from deployment",
  "sender": "human",
  "containerId": "llm-000"
}'
```

Check LangSmith project (`llmaniac`) for traces if enabled.