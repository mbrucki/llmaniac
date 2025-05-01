import json
import logging
import re
import os
from pathlib import Path
from typing import Literal, Dict, List, Any, Optional, Tuple
from urllib.parse import urlparse
from fastapi import FastAPI, HTTPException, Request, Header
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from openai import OpenAI, AsyncOpenAI
from dotenv import load_dotenv
from langsmith.wrappers import wrap_openai
from google.cloud import secretmanager
from google.api_core.exceptions import NotFound

# --- Wczytaj zmienne środowiskowe z pliku .env (dla lokalnego dev) ---
load_dotenv()
# ---------------------------------------------------------------------

# --- Configuration & Setup ---

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- Funkcja pomocnicza do pobierania sekretów z GCP Secret Manager ---
def get_secret(project_id: str, secret_id: str, version_id: str = "latest") -> str | None:
    """Pobiera wartość sekretu z Google Secret Manager."""
    try:
        client = secretmanager.SecretManagerServiceClient()
        name = f"projects/{project_id}/secrets/{secret_id}/versions/{version_id}"
        response = client.access_secret_version(request={"name": name})
        payload = response.payload.data.decode("UTF-8")
        logger.info(f"Successfully retrieved secret: {secret_id}")
        return payload
    except NotFound:
        logger.error(f"Secret not found: {secret_id} in project {project_id}")
        return None
    except Exception as e:
        logger.error(f"Error retrieving secret {secret_id}: {e}", exc_info=True)
        return None
# ----------------------------------------------------------------------

# --- Klucze API i Konfiguracja LangSmith (z obsługą GCP Secret Manager) ---
# Sprawdź, czy działamy w środowisku GCP (np. Cloud Run)
IS_GCP_ENVIRONMENT = os.getenv("K_SERVICE") is not None
GCP_PROJECT_ID = os.getenv("GOOGLE_CLOUD_PROJECT")

openai_api_key = None
langsmith_api_key = None

if IS_GCP_ENVIRONMENT:
    logger.info("Detected GCP environment. Attempting to load secrets from Secret Manager.")
    if GCP_PROJECT_ID:
        openai_api_key = get_secret(GCP_PROJECT_ID, "openai-api-key")
        langsmith_api_key = get_secret(GCP_PROJECT_ID, "langsmith-api-key")
    else:
        logger.error("Running in GCP, but GOOGLE_CLOUD_PROJECT env var not set. Cannot fetch secrets.")
else:
    logger.info("Not running in GCP environment. Loading secrets from environment variables / .env file.")

# Fallback do zmiennych środowiskowych / .env, jeśli nie w GCP lub secret nie został znaleziony
if not openai_api_key:
    openai_api_key = os.getenv("OPENAI_API_KEY")
    if openai_api_key:
        logger.info("Loaded OpenAI API key from environment variable / .env.")
    else:
         logger.error("CRITICAL: OpenAI API key not found in Secret Manager or environment variables.")

if not langsmith_api_key:
    langsmith_api_key = os.getenv("LANGSMITH_API_KEY")
    if langsmith_api_key:
         logger.info("Loaded Langsmith API key from environment variable / .env.")

# Konfiguracja LangSmith pozostaje oparta o zmienne środowiskowe (mogą być ustawione w Cloud Run)
langsmith_tracing_enabled = os.getenv("LANGSMITH_TRACING") == "true"
langsmith_project = os.getenv("LANGSMITH_PROJECT") or "default"

if langsmith_tracing_enabled and not langsmith_api_key:
     logger.error("CRITICAL: LangSmith tracing is enabled, but Langsmith API key was not loaded.")
# --------------------------------------------------------------------------

# --- Klient OpenAI (opcjonalnie owinięty przez LangSmith) --- 
# Używa kluczy wczytanych powyżej
raw_aclient = AsyncOpenAI(api_key=openai_api_key)

if langsmith_tracing_enabled and langsmith_api_key: # Sprawdź, czy klucz Langsmith faktycznie jest
    logger.info(f"LangSmith tracing enabled. Wrapping OpenAI client. Project: {langsmith_project}")
    os.environ["LANGCHAIN_TRACING_V2"] = "true"
    os.environ["LANGCHAIN_API_KEY"] = langsmith_api_key
    os.environ["LANGCHAIN_PROJECT"] = langsmith_project
    aclient = wrap_openai(raw_aclient)
else:
    if langsmith_tracing_enabled and not langsmith_api_key:
        logger.warning("LangSmith tracing was enabled but API key is missing. Using raw OpenAI client.")
    else:
        logger.info("LangSmith tracing is disabled. Using raw OpenAI client.")
    aclient = raw_aclient 

OPENAI_MODEL = "gpt-3.5-turbo"
# ---------------------------------------------------------

app = FastAPI(
    title="llmaniac MVP",
    description="Classify user messages based on client-specific events and settings using OpenAI, with LangSmith observability.",
    version="0.6.0", # Version bump for LangSmith integration
)

# --- Add CORS Middleware ---
origins = [
    "*"
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)
logger.info(f"CORS Middleware enabled. Allowed origins: {origins}")
# ---------------------------

# --- Config Paths ---
CONFIG_BASE_DIR = Path("client_configs")
SNIPPETS_DIR = Path("snippets")

# --- Mount Static Files Directory ---
if SNIPPETS_DIR.is_dir():
    app.mount("/snippets", StaticFiles(directory=SNIPPETS_DIR), name="snippets")
    logger.info(f"Mounted static files directory: {SNIPPETS_DIR} at /snippets")
else:
    logger.warning(f"Snippets directory {SNIPPETS_DIR} not found. Client library will not be served.")
# ---------------------------------

# --- Data Models ---

class Event(BaseModel):
    name: str
    description: str
    examples: list[str]
    threshold: Optional[float] = Field(None, ge=0.0, le=1.0)
    sender: Literal["human", "ai"]

class ClientSettings(BaseModel):
    allowed_domains: List[str] = []

class ClientConfig(BaseModel):
    events: List[Event]
    settings: ClientSettings

class ClassifyRequest(BaseModel):
    text: str
    sender: Literal["human", "ai"]
    containerId: str
    sessionId: Optional[str] = None  # Dodano opcjonalne pole sessionId

class ClassifyResponse(BaseModel):
    event: str | None
    confidence: float | None
    shouldPush: bool
    sender: Literal["human", "ai"]

class PushRequest(BaseModel):
    event: str
    properties: dict
    sender: Literal["human", "ai"]

class PushResponse(BaseModel):
    status: str
    event_data: PushRequest

# --- Global Variables / State ---
push_log: list[PushRequest] = []
client_config_cache: Dict[str, ClientConfig] = {}
# Zmodyfikowano strukturę historii wiadomości, aby przechowywać per containerId+sessionId
message_history: Dict[str, Tuple[str, Literal['human', 'ai']]] = {}

# --- Helper Functions ---

SAFE_CONTAINER_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")
SAFE_SESSION_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_\-\.]+$")  # Dodano wzorzec dla sessionId

def sanitize_container_id(container_id: str) -> str | None:
    """Basic sanitization to prevent path traversal."""
    if SAFE_CONTAINER_ID_PATTERN.match(container_id):
        return container_id
    logger.warning(f"Invalid containerId format attempted: {container_id}")
    return None

DEFAULT_THRESHOLD = 0.7

def get_history_key(container_id: str, session_id: Optional[str]) -> str:
    """Generuje klucz do przechowywania historii, bazując na containerId i opcjonalnym sessionId."""
    if session_id and SAFE_SESSION_ID_PATTERN.match(session_id):
        return f"{container_id}:{session_id}"
    return container_id  # Fallback na stary format, jeśli sessionId nie podany lub niepoprawny

def load_client_config(container_id: str) -> ClientConfig | None:
    """Ładuje konfigurację klienta (eventy i ustawienia) z plików."""

    sanitized_id = sanitize_container_id(container_id)
    if not sanitized_id:
        return None

    if sanitized_id in client_config_cache:
        logger.debug(f"Using cached config for containerId: {sanitized_id}")
        return client_config_cache[sanitized_id]

    logger.info(f"Loading config for containerId: {sanitized_id}")
    client_dir = CONFIG_BASE_DIR / sanitized_id
    events_path = client_dir / "events.json"
    settings_path = client_dir / "settings.json"

    if not client_dir.is_dir():
        logger.error(f"Config directory not found for containerId: {sanitized_id}")
        return None

    loaded_events: List[Event] = []

    try:
        if not events_path.is_file():
            logger.error(f"events.json not found for containerId: {sanitized_id}")
            raise FileNotFoundError
        with open(events_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            if not isinstance(data, list):
                 raise ValueError("events.json should contain a list.")
            for item in data:
                try:
                    event = Event(**item)
                    loaded_events.append(event)
                    logger.debug(f"Loaded event: {event.name} (Sender: {event.sender}, Threshold: {event.threshold})")
                except Exception as e:
                    logger.warning(f"Skipping invalid event item for {sanitized_id}: {item}. Error: {e}")
        if not loaded_events:
            logger.warning(f"No valid events loaded from {events_path}")

    except (FileNotFoundError, json.JSONDecodeError, ValueError) as e:
        logger.error(f"Failed to load or parse {events_path}: {e}")
        return None
    except Exception as e:
        logger.error(f"Unexpected error loading events for {sanitized_id}: {e}", exc_info=True)
        return None

    loaded_settings = ClientSettings()
    try:
        if settings_path.is_file():
            with open(settings_path, "r", encoding="utf-8") as f:
                settings_data = json.load(f)
                loaded_settings = ClientSettings(**settings_data)
        else:
            logger.warning(f"settings.json not found for {sanitized_id}, using defaults.")
    except (json.JSONDecodeError, ValueError) as e:
         logger.error(f"Failed to load or parse {settings_path}: {e}. Using default settings.")
    except Exception as e:
         logger.error(f"Unexpected error loading settings for {sanitized_id}: {e}. Using default settings.", exc_info=True)

    config = ClientConfig(
        events=loaded_events,
        settings=loaded_settings
    )
    client_config_cache[sanitized_id] = config
    logger.info(f"Successfully loaded and cached config for {sanitized_id}.")
    return config

# --- Application Startup ---

@app.on_event("startup")
async def startup_event():
    """Loguje informacje startowe, sprawdza klucze API i status LangSmith."""
    logger.info("Application starting up...")
    if not CONFIG_BASE_DIR.is_dir():
        logger.warning(f"Base config directory '{CONFIG_BASE_DIR}' not found. Client configs cannot be loaded.")
    # Sprawdzenie klucza OpenAI
    if not openai_api_key:
        logger.error("CRITICAL: OPENAI_API_KEY is not set. Classification endpoint will fail.")
    else:
        logger.info("OpenAI API key found.")
    # Sprawdzenie konfiguracji LangSmith
    if langsmith_tracing_enabled:
        if langsmith_api_key:
            logger.info(f"LangSmith tracing is ENABLED. Project: '{langsmith_project}'. API Key found.")
        else:
            logger.error("CRITICAL: LangSmith tracing is ENABLED but LANGSMITH_API_KEY is not set.")
    else:
        logger.info("LangSmith tracing is DISABLED.")

# --- Funkcja klasyfikacji OpenAI (z kontekstem poprzedniej wiadomości) ---
async def classify_with_openai(
    text: str, 
    sender: Literal['human', 'ai'], 
    available_events: List[Event],
    previous_message_text: Optional[str] = None, # Dodano poprzednią wiadomość
    previous_message_sender: Optional[Literal['human', 'ai']] = None # Dodano nadawcę poprzedniej wiadomości
) -> str | None:
    """Klasyfikuje tekst używając API OpenAI, uwzględniając poprzednią wiadomość jako kontekst."""
    if not aclient.api_key: 
        logger.error("OpenAI API key not configured. Cannot classify.")
        return None

    # 1. Filtruj eventy pasujące do *aktualnego* nadawcy
    sender_events = [event for event in available_events if event.sender == sender]
    if not sender_events:
        logger.warning(f"No events defined for sender '{sender}'. Cannot classify.")
        return None

    # 2. Zbuduj prompt dla LLM (z przykładami i kontekstem)
    prompt_lines = [
        f"Twoim zadaniem jest sklasyfikowanie wiadomości od '{sender}' na podstawie zdefiniowanych eventów.",
        "Odpowiedz TYLKO nazwą eventu, który najlepiej pasuje do OSTATNIEJ wiadomości, lub 'None', jeśli żaden nie pasuje.",
        "Nie dodawaj żadnych wyjaśnień ani dodatkowego tekstu.",
        "Użyj poprzedniej wiadomości jako kontekstu, jeśli to pomoże.",
        "",
        f"Dostępne eventy dla '{sender}':",
    ]
    for event in sender_events:
        prompt_lines.append(f"- Nazwa: {event.name}")
        prompt_lines.append(f"  Opis: {event.description}")
        if event.examples:
            formatted_examples = "\n".join([f"    - {ex}" for ex in event.examples])
            prompt_lines.append(f"  Przykłady:\n{formatted_examples}")
    prompt_lines.append("")
    
    # --- Dodanie kontekstu poprzedniej wiadomości --- START
    if previous_message_text and previous_message_sender:
        prompt_lines.append(f"Poprzednia wiadomość w konwersacji ({previous_message_sender}):")
        prompt_lines.append("```")
        prompt_lines.append(previous_message_text)
        prompt_lines.append("```")
        prompt_lines.append("")
    # --- Dodanie kontekstu poprzedniej wiadomości --- END
    
    prompt_lines.append(f"Wiadomość do sklasyfikowania ({sender}):")
    prompt_lines.append("```")
    prompt_lines.append(text)
    prompt_lines.append("```")
    prompt_lines.append("")
    prompt_lines.append("Najlepiej pasujący event (lub None):")

    system_prompt = "\n".join(prompt_lines)
    logger.debug(f"--- OpenAI Prompt ---\n{system_prompt}\n--------------------")

    try:
        response = await aclient.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[{"role": "system", "content": system_prompt}],
            temperature=0,
            max_tokens=50
        )
        
        result_text = response.choices[0].message.content.strip()
        logger.info(f"OpenAI raw response: '{result_text}'")

        if result_text == "None":
            return None
        if any(event.name == result_text for event in sender_events):
            return result_text
        else:
            logger.warning(f"OpenAI returned an unexpected event name: '{result_text}'. Allowed: {[e.name for e in sender_events]}. Returning None.")
            return None

    except Exception as e:
        logger.error(f"Error calling OpenAI API: {e}", exc_info=True)
        return None

# --- API Endpoints ---

@app.post("/classify", response_model=ClassifyResponse)
async def classify_message(request_body: ClassifyRequest, request: Request):
    """
    Klasyfikuje tekst wejściowy używając API OpenAI, po walidacji domeny.
    """
    container_id = request_body.containerId
    session_id = request_body.sessionId
    history_key = get_history_key(container_id, session_id)
    
    logger.info(f"Received classify request for containerId='{container_id}', sessionId='{session_id}', sender='{request_body.sender}', text='{request_body.text[:50]}...'")
    client_config = load_client_config(container_id)
    if not client_config:
        logger.error(f"Configuration not found or invalid for containerId: {container_id}")
        raise HTTPException(status_code=400, detail=f"Invalid or missing configuration for container ID: {container_id}")
    origin = request.headers.get("origin")
    origin_domain = None
    if origin:
        try:
            parsed_origin = urlparse(origin)
            origin_domain = parsed_origin.hostname
        except Exception:
            logger.warning(f"Could not parse Origin header: {origin}")
    logger.debug(f"Request origin header: {origin}, parsed domain: {origin_domain}")
    allowed = False
    if client_config.settings.allowed_domains:
        if origin_domain and origin_domain in client_config.settings.allowed_domains:
             allowed = True
    elif not origin_domain:
        allowed = True
    if not allowed:
        logger.warning(f"Origin '{origin_domain or origin}' is not in allowed domains for containerId '{container_id}': {client_config.settings.allowed_domains}")
        raise HTTPException(status_code=403, detail="Origin not allowed")
    logger.debug(f"Origin '{origin_domain}' validated successfully for containerId '{container_id}'")

    # 3. Pobierz poprzednią wiadomość z historii dla tego klucza (containerId+sessionId)
    prev_text: Optional[str] = None
    prev_sender: Optional[Literal["human", "ai"]] = None
    if history_key in message_history:
        prev_text, prev_sender = message_history[history_key]
        logger.debug(f"Found previous message for context (Key: {history_key}, Sender: {prev_sender}): {prev_text[:50]}...")
    else:
        logger.debug(f"No previous message found in history for this key: {history_key}")

    # 4. Klasyfikacja za pomocą OpenAI (z kontekstem)
    classified_event_name: str | None = None
    try:
        classified_event_name = await classify_with_openai(
            text=request_body.text,
            sender=request_body.sender,
            available_events=client_config.events,
            previous_message_text=prev_text,       # Przekaż poprzednią wiadomość
            previous_message_sender=prev_sender      # Przekaż nadawcę poprzedniej wiadomości
        )
        logger.info(f"OpenAI classification result: '{classified_event_name}'")

    except Exception as e:
        logger.error(f"Exception during OpenAI classification call for {container_id}: {e}")
        raise HTTPException(status_code=500, detail="Error during classification process.")

    # 5. Zaktualizuj historię ostatnią wiadomością, używając klucza zawierającego sessionId
    message_history[history_key] = (request_body.text, request_body.sender)
    logger.debug(f"Updated message history for key: {history_key}")

    # 6. Zastosuj Próg (logika bez zmian, tylko informacyjnie)
    should_push = classified_event_name is not None
    final_event_obj = next((evt for evt in client_config.events if evt.name == classified_event_name), None)
    threshold = DEFAULT_THRESHOLD
    if final_event_obj and final_event_obj.threshold is not None:
        threshold = final_event_obj.threshold
    logger.info(f"Event classified: '{classified_event_name}'. Threshold (informational): {threshold:.2f}. Should push: {should_push}")

    # 7. Zwróć wynik (bez zmian)
    return ClassifyResponse(
        event=classified_event_name,
        confidence=None,
        shouldPush=should_push,
        sender=request_body.sender
    )

@app.post("/push", response_model=PushResponse)
async def push_event(request: PushRequest):
    """Placeholder endpoint to acknowledge event push."""
    logger.info(f"Received push request: Event='{request.event}', Sender='{request.sender}', Properties={request.properties}")
    push_log.append(request)
    response_data = PushResponse(status="received", event_data=request)
    return response_data

@app.get("/health", status_code=200)
async def health_check():
    """Simple health check endpoint."""
    openai_status = "available" if aclient.api_key else "unavailable (OpenAI API key missing)"
    langsmith_status = "unknown"
    if langsmith_tracing_enabled:
        langsmith_status = "enabled (API key found)" if langsmith_api_key else "enabled (API key missing)"
    else:
        langsmith_status = "disabled"
    return {
        "status": "ok",
        "openai_model_status": openai_status,
        "langsmith_tracing_status": langsmith_status,
        "langsmith_project": langsmith_project if langsmith_tracing_enabled else None
    }

# --- Add instructions for running ---
# To run the server:
# pip install -r requirements.txt
# uvicorn main:app --reload --port 8000
# Remember to install PyTorch compatible with your system (CPU/GPU) if needed.
# Check transformers library documentation for model caching behavior.

# --- Add instructions for running ---
# To run the server:
# uvicorn main:app --reload 