# Użyj oficjalnego obrazu Python jako obrazu bazowego
FROM python:3.11-slim

# Ustaw katalog roboczy w kontenerze
WORKDIR /app

# Skopiuj plik zależności i zainstaluj je
# --no-cache-dir zmniejsza rozmiar obrazu
COPY requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Skopiuj resztę kodu aplikacji do katalogu roboczego
COPY . .

# Poinformuj Docker, że kontener nasłuchuje na porcie podanym przez Cloud Run
# Cloud Run automatycznie ustawi zmienną środowiskową PORT
# Nie używamy EXPOSE, ponieważ Uvicorn będzie uruchamiany na porcie $PORT
# EXPOSE 8001 # Już niepotrzebne, użyjemy $PORT

# Uruchom aplikację używając Uvicorn (forma shell dla interpretacji $PORT).
CMD uvicorn main:app --host 0.0.0.0 --port $PORT 