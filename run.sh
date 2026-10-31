#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v gcc >/dev/null 2>&1; then
    echo "Error: gcc is required. Install GCC and rerun ./run.sh." >&2
    exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
    echo "Error: Python 3 is required. Install Python 3 and rerun ./run.sh." >&2
    exit 1
fi

mkdir -p engine
gcc -O2 -Wall -Wextra -Wpedantic -std=c11 engine/benchmark.c -o engine/benchmark

if [[ ! -x .venv/bin/python ]]; then
    python3 -m venv .venv
fi
.venv/bin/python -m pip install -r backend/requirements.txt

echo "CacheSense will be available at http://localhost:8000"
exec .venv/bin/python -m uvicorn backend.main:app \
    --host 0.0.0.0 --port 8000 --reload
