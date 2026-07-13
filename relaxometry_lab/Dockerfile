# ── Stage 1: build the React + Vite + Tailwind frontend ─────────────────────
FROM node:20-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Python runtime ──────────────────────────────────────────────────
FROM python:3.12-slim AS runtime

# Chromium powers the headless --print-to-pdf report endpoint
# (api/output_routes.py); --no-sandbox is already passed there, which is what
# lets Chromium run as root inside a container.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .
COPY api/ ./api/
COPY static/ ./static/
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

EXPOSE 8001

# Not `python3 server.py` — that hardcodes 127.0.0.1 (unreachable from
# outside the container) and enables uvicorn's --reload (dev-only).
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8001"]
