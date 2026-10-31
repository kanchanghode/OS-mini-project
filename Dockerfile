FROM gcc:14-bookworm AS engine-build
WORKDIR /build
COPY engine/benchmark.c ./benchmark.c
RUN gcc -O2 -Wall -Wextra -Wpedantic -std=c11 benchmark.c -o benchmark

FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app
COPY backend/requirements.txt ./backend/requirements.txt
RUN python -m pip install --no-cache-dir -r backend/requirements.txt
COPY backend ./backend
COPY frontend ./frontend
COPY --from=engine-build /build/benchmark ./engine/benchmark
RUN chmod 755 ./engine/benchmark
EXPOSE 8000
CMD ["sh", "-c", "exec python -m uvicorn backend.main:app --host 0.0.0.0 --port \"${PORT:-8000}\""]
