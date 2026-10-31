"""Host CPU model and cache discovery for Linux and Windows."""

import platform
import re
import subprocess
from pathlib import Path


_DEFAULTS = {"l1_kb": 32, "l2_kb": 512, "l3_kb": 16384}


def _size_to_kb(value):
    match = re.fullmatch(r"\s*(\d+)\s*([KMG]?)\s*", str(value), re.IGNORECASE)
    if not match:
        return None
    amount = int(match.group(1))
    unit = match.group(2).upper()
    multiplier = {"": 1 / 1024, "K": 1, "M": 1024, "G": 1024 * 1024}[unit]
    return max(1, int(amount * multiplier))


def _linux_model():
    cpuinfo = Path("/proc/cpuinfo")
    if cpuinfo.is_file():
        for line in cpuinfo.read_text(errors="replace").splitlines():
            if line.lower().startswith(("model name", "hardware")):
                _, _, model = line.partition(":")
                if model.strip():
                    return model.strip()
    return platform.processor() or platform.machine() or "Unknown CPU"


def _linux_caches():
    values = {}
    cache_root = Path("/sys/devices/system/cpu/cpu0/cache")
    for index in cache_root.glob("index*"):
        try:
            level = int((index / "level").read_text().strip())
            cache_type = (index / "type").read_text().strip().lower()
            size_kb = _size_to_kb((index / "size").read_text())
        except (OSError, ValueError):
            continue
        if size_kb is None or level not in (1, 2, 3):
            continue
        if level == 1 and cache_type not in ("data", "unified"):
            continue
        if level == 2 and cache_type not in ("unified", "data"):
            continue
        if level == 3 and cache_type not in ("unified", "data"):
            continue
        key = f"l{level}_kb"
        values[key] = max(values.get(key, 0), size_kb)
    return values


def _windows_info():
    model = platform.processor() or platform.machine() or "Unknown CPU"
    values = {}
    command = [
        "wmic",
        "cpu",
        "get",
        "Name,L2CacheSize,L3CacheSize",
        "/format:list",
    ]
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, timeout=4, check=False
        )
        for line in result.stdout.splitlines():
            key, separator, value = line.partition("=")
            if not separator or not value.strip():
                continue
            key = key.strip().lower()
            if key == "name":
                model = value.strip()
            elif key == "l2cachesize":
                size = int(value.strip())
                if size > 0:
                    values["l2_kb"] = size
            elif key == "l3cachesize":
                size = int(value.strip())
                if size > 0:
                    values["l3_kb"] = size
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return model, values


def get_cpu_cache_info():
    """Return CPU model and approximate L1/L2/L3 cache sizes in KiB."""
    if platform.system() == "Windows":
        model, discovered = _windows_info()
        missing = {"l1_kb", "l2_kb", "l3_kb"} - discovered.keys()
        source = (
            "Windows WMI; L1 uses a standard estimate"
            if missing == {"l1_kb"}
            else "Windows WMI + fallback estimates"
            if missing
            else "Windows WMI"
        )
    else:
        model = _linux_model()
        discovered = _linux_caches()
        source = (
            "Linux sysfs"
            if {"l1_kb", "l2_kb", "l3_kb"} <= discovered.keys()
            else "Linux sysfs + fallback estimates"
        )

    return {
        "model": model,
        "l1_kb": discovered.get("l1_kb", _DEFAULTS["l1_kb"]),
        "l2_kb": discovered.get("l2_kb", _DEFAULTS["l2_kb"]),
        "l3_kb": discovered.get("l3_kb", _DEFAULTS["l3_kb"]),
        "cache_source": source,
    }
