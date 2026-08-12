#!/usr/bin/env bash
# Start the API and the dev server together, and wait until the API answers
# before opening the app — the first run downloads the ephemeris and builds the
# shadow path, which takes a few seconds.
set -euo pipefail
cd "$(dirname "$0")"

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if [ ! -d frontend/node_modules ]; then
  echo "installing frontend dependencies…"
  (cd frontend && npm install)
fi

if [ ! -f backend/data/places_es.json ]; then
  echo "building the town search index (one-off, ~3 MB download)…"
  uv run python -m backend.scripts.build_places
fi

if [ ! -f backend/data/ldem_16.img ]; then
  echo "fetching lunar limb data for Baily's beads (one-off, ~35 MB)…"
  uv run python -m backend.scripts.fetch_lunar
fi

echo "starting API on :8000…"
uv run uvicorn backend.app.main:app --port 8000 &

for _ in $(seq 1 90); do
  if curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
    echo "API ready."
    break
  fi
  sleep 1
done

if ! curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
  echo "API did not come up — check the output above." >&2
  exit 1
fi

echo "starting frontend on :5173…"
(cd frontend && npm run dev)
