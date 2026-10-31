# CacheSense

CacheSense is an interactive CPU cache and memory latency profiler for OS Mini
Project evaluation. A native C pointer-chasing engine measures dependent-load
latency, FastAPI streams each measurement using Server-Sent Events, and a
Chart.js dashboard displays the results live.

## Architecture

```text
Browser: frontend/index.html + app.js
            | REST: /api/system-info
            | SSE:  /api/benchmark/stream
            v
FastAPI: backend/main.py
            | launches fixed native executable with validated arguments
            v
Native engine: engine/benchmark.c
            | one JSON object per completed measurement
            v
Live Chart.js plot + average latency table
```

The backend validates query parameters and invokes the executable without a
shell. Closing or cancelling the browser request terminates the benchmark
process. Each engine measurement is a JSON line on stdout; diagnostics go to
stderr.

## Operating-system and architecture concepts

### Locality of reference

**Spatial locality** means data near a recently used address is likely to be
used soon. Cache hardware fetches memory in cache-line units, so a load can
bring neighboring bytes into a cache. **Temporal locality** means recently
used data is likely to be accessed again. CacheSense varies working-set size
to observe how repeated dependent loads behave as the data footprint changes.

### Pointer chasing and prefetching

A predictable sequential scan is easy for stream prefetchers to recognize.
CacheSense constructs a randomized circular permutation so each loaded
pointer determines the next address. The dependency serializes loads and
limits how far ordinary stream prefetchers and out-of-order execution can get
ahead. It reduces prefetch effects but cannot eliminate every
microarchitectural influence.

### Cache lines and strides

The default strides are 16, 64, 256, and 4096 bytes. A 16-byte stride may
reuse a 64-byte cache line; 64 bytes commonly selects one address per line on
many x86/ARM CPUs; 256 bytes skips several such lines. Actual line and cache
sizes are hardware-specific. Detected L1/L2/L3 sizes are shown in the header
and overlaid as vertical chart guides.

### TLB and virtual memory

A 4096-byte stride selects one address per usual 4 KB virtual-memory page and
can increase Translation Lookaside Buffer (TLB) pressure. On a TLB miss, the
CPU may walk page tables, whose entries may themselves be cached. A 4 KB
stride does **not** guarantee a TLB miss or page-table walk on each load:
page size, huge pages, TLB capacity, and CPU behavior all matter.

Measurements are nanoseconds per dependent access, not memory bandwidth.
Cache boundaries and the dashboard's average-by-tier ranges are approximate;
run multiple trials and avoid background load when drawing conclusions.

## Requirements

- Linux / GitHub Codespaces: GCC and Python 3 with `venv`.
- Windows: MinGW-w64 GCC or MSVC in a Developer PowerShell, plus Python 3.
- A modern browser with Chart.js CDN access.

## Run on Linux or GitHub Codespaces

From the repository root:

```bash
chmod +x run.sh
./run.sh
```

The script compiles the C engine, creates `.venv`, installs FastAPI/Uvicorn,
and runs the server on `http://localhost:8000`. In Codespaces, forward port
8000 if VS Code does not forward it automatically. Stop the foreground server
with Ctrl+C.

## Deploy a public web app on Render

The project includes a Docker image and Render Blueprint at
[`render.yaml`](./render.yaml). To create a public service, push this
repository to GitHub, sign in to Render, choose **New → Blueprint**, and
select the repository. Render builds the native engine into the container
and starts the web server; visitors open the service URL without running a
local start command. The service may take a short time to wake up on Render's
free plan.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/kanchanghode/OS-mini-project)

The hosted service reports and benchmarks the **Render server's** hardware,
not the hardware of each visitor's device. To benchmark a visitor's own CPU,
the native app must run locally on that device.

The header identifies whether cache sizes were read from Linux sysfs or
include fallback estimates. On Windows, L1 is currently shown as a standard
estimate because the backend's Windows query retrieves L2 and L3 only.

You can run each step manually:

```bash
gcc -O2 -Wall -Wextra -Wpedantic -std=c11 engine/benchmark.c -o engine/benchmark
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
.venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

## Run on Windows

Open PowerShell with GCC on `PATH`, or use a **Developer PowerShell for
Visual Studio** for MSVC. From the repository root run:

```powershell
.\run.ps1
```

This compiles `engine\benchmark.exe`, prepares the local Python environment,
starts Uvicorn, and opens `http://localhost:8000`. The script prints the
server process ID; stop it with the displayed `Stop-Process` command.

## Dashboard controls

- Select one or more strides to compare.
- Set the maximum working-set size, from 4 KB to 64 MB.
- Choose 1, 5, or 10 million timed accesses for each point.
- Press **Run benchmark** to stream results into the chart and tier table.
- Press **Cancel** to stop the active run.
- A server accepts one benchmark at a time; while it is busy, another request
  receives a retryable `409` response.

The native engine supports:

```text
benchmark [min_kb max_kb stride1,stride2,... iterations]
```

With no arguments it runs from 4 KB through 64 MB, using strides
`16,64,256,4096` and five million timed accesses. It emits one JSON object per
completed measurement, flushing stdout each time.

## Viva defense questions and answers

1. **Why use pointer chasing rather than a sequential scan?**
   The address for each load depends on the value from the previous load.
   This serializes requests, limits memory-level parallelism, and makes
   sequential stream prefetching less effective, exposing dependent-load
   latency.

2. **Why does latency change as the working set grows?**
   A larger set can exceed a cache's effective capacity and cause accesses to
   be served from a slower cache level or memory. The actual transition points
   depend on CPU topology and other active workloads.

3. **What does the 4096-byte stride test?**
   It visits one address per typical 4 KB page, potentially stressing the TLB
   and page-table walker. It does not force a TLB miss per access because TLB
   capacity, page sizes, and page-table caching affect outcomes.

4. **Who manages CPU caches: the OS or the hardware?**
   Cache lookup, replacement, and line fills are mainly hardware-managed.
   The OS affects mappings, scheduling, and page-size policy, which can
   indirectly influence cache and TLB behavior.

5. **How does the backend stream results, and what happens on cancel?**
   The C process flushes each JSON measurement line. FastAPI reads stdout and
   sends each point as an SSE event. If the request is cancelled or the client
   disconnects, the async stream terminates and reaps the child process.
