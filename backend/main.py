"""FastAPI API and SSE bridge to the native CacheSense benchmark."""

import asyncio
import json
import os
import re
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

try:
    from .system_info import get_cpu_cache_info
except ImportError:
    from system_info import get_cpu_cache_info


PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"
ENGINE_PATH = PROJECT_ROOT / "engine" / (
    "benchmark.exe" if os.name == "nt" else "benchmark"
)
STRIDE_PATTERN = re.compile(r"^[0-9]+(?:,[0-9]+)*$")
ALLOWED_STRIDES = {16, 64, 256, 4096}
MAX_ITERATIONS = 10000000
BENCHMARK_LOCK = asyncio.Lock()

app = FastAPI(title="CacheSense", version="1.0.0")
app.mount("/frontend", StaticFiles(directory=FRONTEND_DIR), name="frontend")


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/api/system-info")
async def system_info():
    return get_cpu_cache_info()


def _validate_strides(raw_strides):
    if not STRIDE_PATTERN.fullmatch(raw_strides):
        raise HTTPException(
            status_code=400,
            detail="strides must be a comma-separated list such as 16,64,256,4096",
        )
    strides = [int(value) for value in raw_strides.split(",")]
    if (
        not strides
        or len(strides) > 4
        or len(set(strides)) != len(strides)
        or any(stride not in ALLOWED_STRIDES for stride in strides)
    ):
        raise HTTPException(
            status_code=400,
            detail="supported unique strides are 16, 64, 256, and 4096 bytes",
        )
    return strides


@app.get("/api/benchmark/stream")
async def benchmark_stream(
    min_kb: int = Query(default=4, ge=4, le=65536),
    max_kb: int = Query(default=65536, ge=4, le=65536),
    strides: str = Query(default="16,64,256,4096"),
    iterations: int = Query(default=5000000, ge=1, le=MAX_ITERATIONS),
):
    if min_kb > max_kb:
        raise HTTPException(status_code=400, detail="min_kb must not exceed max_kb")
    selected_strides = _validate_strides(strides)
    if BENCHMARK_LOCK.locked():
        raise HTTPException(
            status_code=409,
            detail="A benchmark is already running. Try again when it completes.",
        )
    await BENCHMARK_LOCK.acquire()
    if not ENGINE_PATH.is_file():
        BENCHMARK_LOCK.release()
        raise HTTPException(
            status_code=503,
            detail="Benchmark executable is missing. Run the project start script to compile it.",
        )

    command = [
        str(ENGINE_PATH),
        str(min_kb),
        str(max_kb),
        ",".join(str(value) for value in selected_strides),
        str(iterations),
    ]

    async def stream_results():
        process = None
        stderr_task = None
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            async def forward_stderr():
                if process.stderr is None:
                    return
                while line := await process.stderr.readline():
                    print(
                        f"[benchmark] {line.decode(errors='replace').rstrip()}",
                        file=sys.stderr,
                    )

            stderr_task = asyncio.create_task(forward_stderr())
            while process.stdout is not None:
                line = await process.stdout.readline()
                if not line:
                    break
                try:
                    measurement = json.loads(line)
                except json.JSONDecodeError:
                    yield "event: error\ndata: {\"detail\":\"Benchmark returned invalid JSON.\"}\n\n"
                    break
                yield f"event: measurement\ndata: {json.dumps(measurement)}\n\n"

            if process.returncode is None:
                try:
                    await asyncio.wait_for(process.wait(), timeout=0.25)
                except asyncio.TimeoutError:
                    pass
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=2)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
            await stderr_task
            if process.returncode == 0:
                yield "event: complete\ndata: {}\n\n"
            elif process.returncode is not None:
                yield (
                    "event: error\ndata: "
                    + json.dumps(
                        {"detail": f"Benchmark process exited with status {process.returncode}."}
                    )
                    + "\n\n"
                )
        except asyncio.CancelledError:
            if process is not None and process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=2)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
            raise
        except OSError as error:
            yield "event: error\ndata: " + json.dumps({"detail": str(error)}) + "\n\n"
        finally:
            if process is not None and process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=2)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
            if stderr_task is not None and not stderr_task.done():
                await stderr_task
            BENCHMARK_LOCK.release()

    return StreamingResponse(
        stream_results(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
