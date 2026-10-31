"use strict";

const STRIDE_COLORS = {
  16: "#38bdf8",
  64: "#fbbf24",
  256: "#34d399",
  4096: "#fb7185",
};
const TIER_RANGES = [
  { name: "L1 Cache", range: "4–32 KB", min: 4, max: 32 },
  { name: "L2 Cache", range: ">32–512 KB", min: 33, max: 512 },
  { name: "L3 Cache", range: ">512 KB–16 MB", min: 513, max: 16384 },
  { name: "Main Memory", range: ">16 MB", min: 16385, max: Infinity },
];

let chart;
let controller = null;
let measurements = [];
let expectedPoints = 0;

const elements = {
  cpu: document.getElementById("cpu-model"),
  cacheSource: document.getElementById("cache-source"),
  l1: document.getElementById("l1-size"),
  l2: document.getElementById("l2-size"),
  l3: document.getElementById("l3-size"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  maxSize: document.getElementById("max-size"),
  maxSizeLabel: document.getElementById("max-size-label"),
  iterations: document.getElementById("iterations"),
  runButton: document.getElementById("run-button"),
  runLabel: document.getElementById("run-label"),
  runSpinner: document.getElementById("run-spinner"),
  cancelButton: document.getElementById("cancel-button"),
  progressLabel: document.getElementById("progress-label"),
  progressValue: document.getElementById("progress-value"),
  progressBar: document.getElementById("progress-bar"),
  pointCount: document.getElementById("point-count"),
  summary: document.getElementById("summary-body"),
};

function formatSize(kb) {
  return kb >= 1024 ? `${(kb / 1024).toLocaleString()} MB` : `${kb} KB`;
}

function updateStatus(message, state = "idle") {
  elements.statusText.textContent = message;
  const classes = {
    idle: "bg-slate-500",
    ready: "bg-emerald-400",
    running: "bg-sky-400 animate-pulse",
    error: "bg-rose-400",
  };
  elements.statusDot.className = `h-2 w-2 rounded-full ${classes[state] || classes.idle}`;
}

function createChart() {
  const ctx = document.getElementById("latency-chart");
  chart = new Chart(ctx, {
    type: "line",
    data: { datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: {
        legend: {
          labels: { color: "#cbd5e1", usePointStyle: true, padding: 18 },
        },
        tooltip: {
          callbacks: {
            title: (items) => items.length ? formatSize(items[0].parsed.x) : "",
            label: (context) =>
              `${context.dataset.label}: ${context.parsed.y.toFixed(2)} ns/access`,
          },
        },
        annotation: undefined,
      },
      scales: {
        x: {
          type: "logarithmic",
          min: 4,
          max: 65536,
          afterBuildTicks(scale) {
            scale.ticks = [4, 16, 64, 256, 1024, 4096, 16384, 65536]
              .filter((value) => value >= scale.min && value <= scale.max)
              .map((value) => ({ value }));
          },
          grid: { color: "rgba(148,163,184,.08)" },
          ticks: {
            color: "#64748b",
            callback(value) {
              const known = [4, 16, 64, 256, 1024, 4096, 16384, 65536];
              return known.includes(Number(value)) ? formatSize(Number(value)) : "";
            },
          },
          title: { display: true, text: "Working set (log KB)", color: "#94a3b8" },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(148,163,184,.08)" },
          ticks: { color: "#64748b" },
          title: { display: true, text: "Latency (ns/access)", color: "#94a3b8" },
        },
      },
    },
    plugins: [{
      id: "cacheBoundaries",
      beforeDatasetsDraw(instance) {
        const { ctx: canvas, chartArea, scales } = instance;
        if (!chartArea) return;
        const levels = [
          { kb: Number(elements.l1.textContent), label: "L1", color: "#38bdf8" },
          { kb: Number(elements.l2.textContent), label: "L2", color: "#a78bfa" },
          { kb: Number(elements.l3.textContent), label: "L3", color: "#34d399" },
        ];
        canvas.save();
        levels.forEach(({ kb, label, color }) => {
          if (!Number.isFinite(kb) || kb <= 0) return;
          const x = scales.x.getPixelForValue(kb);
          if (x < chartArea.left || x > chartArea.right) return;
          canvas.setLineDash([6, 5]);
          canvas.strokeStyle = color;
          canvas.globalAlpha = 0.65;
          canvas.beginPath();
          canvas.moveTo(x, chartArea.top);
          canvas.lineTo(x, chartArea.bottom);
          canvas.stroke();
          canvas.setLineDash([]);
          canvas.globalAlpha = 1;
          canvas.fillStyle = color;
          canvas.font = "11px ui-monospace, monospace";
          canvas.fillText(`${label} ${formatSize(kb)}`, x + 5, chartArea.top + 13);
        });
        canvas.restore();
      },
    }],
  });
}

function setHardwareInfo(info) {
  elements.cpu.textContent = info.model || "Unknown CPU";
  elements.l1.textContent = String(info.l1_kb || 32);
  elements.l2.textContent = String(info.l2_kb || 512);
  elements.l3.textContent = String(info.l3_kb || 16384);
  elements.cacheSource.textContent = `Cache sizes: ${info.cache_source || "fallback estimates"}`;
  chart.update("none");
}

async function loadSystemInfo() {
  try {
    const response = await fetch("/api/system-info");
    if (!response.ok) throw new Error(`Host info request failed (${response.status})`);
    setHardwareInfo(await response.json());
    updateStatus("Host detected · ready", "ready");
  } catch (error) {
    elements.cpu.textContent = "Hardware details unavailable";
    elements.cacheSource.textContent = "Cache sizes: fallback estimates";
    updateStatus(error.message, "error");
  }
}

function selectedStrides() {
  return [...document.querySelectorAll(".stride-check:checked")]
    .map((checkbox) => Number(checkbox.value));
}

function datasetFor(stride) {
  let dataset = chart.data.datasets.find((entry) => entry.stride === stride);
  if (!dataset) {
    dataset = {
      stride,
      label: `${stride} B stride`,
      data: [],
      borderColor: STRIDE_COLORS[stride] || "#cbd5e1",
      backgroundColor: STRIDE_COLORS[stride] || "#cbd5e1",
      borderWidth: 2,
      pointRadius: 3,
      pointHoverRadius: 6,
      tension: 0.12,
      parsing: false,
      normalized: true,
    };
    chart.data.datasets.push(dataset);
  }
  return dataset;
}

function clearMeasurements() {
  measurements = [];
  chart.data.datasets = [];
  chart.update("none");
  elements.summary.innerHTML =
    '<tr><td class="px-5 py-3 text-slate-500" colspan="6">Collecting measurements…</td></tr>';
  elements.pointCount.textContent = "0 measurements";
  elements.progressValue.textContent = "0%";
  elements.progressBar.style.width = "0%";
}

function addMeasurement(point) {
  if (
    !Number.isFinite(point.size_kb) ||
    !Number.isFinite(point.stride_bytes) ||
    !Number.isFinite(point.latency_ns)
  ) {
    throw new Error("Benchmark sent a malformed measurement.");
  }
  measurements.push(point);
  datasetFor(point.stride_bytes).data.push({
    x: point.size_kb,
    y: point.latency_ns,
  });
  chart.update("none");
  const completed = measurements.length;
  const percent = expectedPoints ? Math.min(100, (completed / expectedPoints) * 100) : 0;
  elements.pointCount.textContent = `${completed} measurement${completed === 1 ? "" : "s"}`;
  elements.progressLabel.textContent = `Measured ${formatSize(point.size_kb)} · ${point.stride_bytes} B`;
  elements.progressValue.textContent = `${Math.round(percent)}%`;
  elements.progressBar.style.width = `${percent}%`;
  updateSummary();
}

function updateSummary() {
  const values = TIER_RANGES.map((tier) => {
    const row = document.createElement("tr");
    row.className = "hover:bg-white/[0.02]";
    const tierCell = document.createElement("td");
    tierCell.className = "px-5 py-3 font-medium text-slate-200";
    tierCell.textContent = tier.name;
    row.appendChild(tierCell);
    const rangeCell = document.createElement("td");
    rangeCell.className = "px-5 py-3 text-slate-500";
    rangeCell.textContent = tier.range;
    row.appendChild(rangeCell);
    [16, 64, 256, 4096].forEach((stride) => {
      const points = measurements.filter(
        (point) =>
          point.stride_bytes === stride &&
          point.size_kb >= tier.min &&
          point.size_kb <= tier.max,
      );
      const cell = document.createElement("td");
      cell.className = "mono px-5 py-3";
      cell.textContent = points.length
        ? `${(points.reduce((sum, point) => sum + point.latency_ns, 0) / points.length).toFixed(2)} ns`
        : "—";
      row.appendChild(cell);
    });
    return row;
  });
  elements.summary.replaceChildren(...values);
}

function expectedSizeCount(maxKb) {
  const sizes = [4, 8, 16, 32, 48, 64, 96, 128, 256, 512, 1024, 2048,
    4096, 8192, 16384, 32768, 65536];
  return sizes.filter((size) => size <= maxKb).length;
}

function parseSseBlock(block) {
  let event = "message";
  const data = [];
  block.split(/\r?\n/).forEach((line) => {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  });
  return { event, data: data.join("\n") };
}

async function runBenchmark() {
  const strides = selectedStrides();
  if (!strides.length) {
    updateStatus("Select at least one stride", "error");
    return;
  }
  const maxKb = Number(elements.maxSize.value);
  const iterations = Number(elements.iterations.value);
  clearMeasurements();
  expectedPoints = expectedSizeCount(maxKb) * strides.length;
  controller = new AbortController();
  elements.runButton.disabled = true;
  elements.cancelButton.disabled = false;
  elements.runSpinner.classList.remove("hidden");
  elements.runLabel.textContent = "Running…";
  updateStatus("Benchmark running", "running");

  const query = new URLSearchParams({
    min_kb: "4",
    max_kb: String(maxKb),
    strides: strides.join(","),
    iterations: String(iterations),
  });

  try {
    const response = await fetch(`/api/benchmark/stream?${query}`, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || `Benchmark request failed (${response.status})`);
    }
    if (!response.body) throw new Error("This browser does not support streamed responses.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let separator;
      while ((separator = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, separator);
        const delimiter = buffer.slice(separator).match(/^\r?\n\r?\n/)[0];
        buffer = buffer.slice(separator + delimiter.length);
        const message = parseSseBlock(block);
        if (!message.data) continue;
        if (message.event === "measurement") {
          addMeasurement(JSON.parse(message.data));
        } else if (message.event === "complete") {
          completed = true;
        } else if (message.event === "error") {
          throw new Error(JSON.parse(message.data).detail || "Benchmark failed.");
        }
      }
      if (done) break;
    }
    if (!completed && !controller.signal.aborted) {
      updateStatus("Stream ended before completion", "error");
    } else if (completed) {
      elements.progressLabel.textContent = "Benchmark complete";
      elements.progressValue.textContent = "100%";
      elements.progressBar.style.width = "100%";
      updateStatus("Benchmark complete", "ready");
    }
  } catch (error) {
    if (error.name === "AbortError") {
      elements.progressLabel.textContent = "Cancelled";
      updateStatus("Benchmark cancelled", "idle");
    } else {
      elements.progressLabel.textContent = "Benchmark failed";
      updateStatus(error.message, "error");
    }
  } finally {
    controller = null;
    elements.runButton.disabled = false;
    elements.cancelButton.disabled = true;
    elements.runSpinner.classList.add("hidden");
    elements.runLabel.textContent = "Run benchmark";
  }
}

elements.maxSize.addEventListener("input", () => {
  elements.maxSizeLabel.textContent = formatSize(Number(elements.maxSize.value));
});
elements.runButton.addEventListener("click", runBenchmark);
elements.cancelButton.addEventListener("click", () => {
  if (controller) controller.abort();
});

createChart();
loadSystemInfo();
