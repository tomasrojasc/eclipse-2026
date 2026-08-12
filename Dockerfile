# One image serving both the API and the built app, so this deploys as a single
# unit. Defaults target Hugging Face Spaces (port 7860, non-root uid 1000), but
# nothing here is Spaces-specific: any container host will run it.
#
# The data sets are fetched during the build rather than committed: the LOLA
# shape model, the JPL ephemeris and the town index come to ~55 MB together.

FROM node:22-slim AS web
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npx tsc -b && npx vite build

FROM python:3.13-slim
WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
ENV UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv

COPY pyproject.toml uv.lock* ./
RUN uv sync --no-dev

COPY backend/ ./backend/
COPY --from=web /app/frontend/dist ./frontend/dist

# Fetch the ephemeris, lunar shape model, town index and shadow path. Each step
# verifies what it downloaded, so a truncated fetch fails the build instead of
# producing an app that quietly computes the wrong thing.
RUN uv run python -m backend.scripts.build_places \
 && uv run python -m backend.scripts.fetch_lunar \
 && uv run python -c "from backend.app.path import build; build()"

# Spaces runs containers as uid 1000, and the saved-shot database needs a
# writable home wherever this ends up.
ENV ECLIPSE_DB=/tmp/eclipse_plan.db \
    PORT=7860
RUN chown -R 1000:1000 /app
USER 1000

EXPOSE 7860
CMD ["sh", "-c", "uv run uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-7860}"]
