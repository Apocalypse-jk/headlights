#!/usr/bin/env python3
"""Create one histogram plot per individual curl benchmark run.

Expected layout examples:

    runs/mock-blaze/baseline/run_01/<measurement-name>/measurements.csv
    runs/mock-blaze/opa/run_02/<measurement-name>/measurements.csv

For every matching measurements.csv, this script creates one PNG. By default,
only runs with concurrency 10 or 15 are plotted. Each Toxiproxy profile is shown
in a separate histogram subplot, so the duration distribution of a single run can
be inspected without mixing repeated runs.

Usage:
    python policy-engine/benchmarks/curl/mock-blaze-scripts/plot_curl_histograms_by_run.py
    python policy-engine/benchmarks/curl/mock-blaze-scripts/plot_curl_histograms_by_run.py --succeeded-only
"""

from __future__ import annotations

import argparse
import math
import re
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402
from matplotlib.ticker import MaxNLocator  # noqa: E402


PROFILE_ORDER = [
    "lan",
    "wan-typical",
    "intercontinental",
    "wan-poor",
    "wan-regional",
    "satellite",
]

PROFILE_LABELS = {
    "lan": "LAN",
    "wan-typical": "WAN-Typical",
    "intercontinental": "Intercontinental",
}

PROFILE_COLORS = {
    "lan": "#4c78a8",
    "wan-typical": "#f58518",
    "intercontinental": "#54a24b",
    "wan-poor": "#e45756",
    "wan-regional": "#72b7b2",
    "satellite": "#b279a2",
}


def default_runs_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "runs" / "mock-blaze"


def default_out_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "plots" / "mock-blaze" / "histograms_by_run"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create duration histograms per Toxiproxy profile for each individual curl run.",
    )
    parser.add_argument(
        "runs_dir",
        nargs="?",
        default=default_runs_dir(),
        type=Path,
        help="Directory containing curl run folders with measurements.csv files.",
    )
    parser.add_argument(
        "--out-dir",
        default=default_out_dir(),
        type=Path,
        help="Output directory for PNG plots.",
    )
    parser.add_argument(
        "--all-phases",
        action="store_true",
        help="Include warmup rows too. By default only phase=measurement rows are plotted.",
    )
    parser.add_argument(
        "--succeeded-only",
        action="store_true",
        help="Plot only rows with status=succeeded.",
    )
    parser.add_argument(
        "--bins",
        default="0.05",
        help=(
            "Histogram bin width in seconds. Default: 0.05, which starts at 0s "
            "and creates one new bar every 0.05s. Use a matplotlib mode like "
            "auto to let matplotlib choose the bins."
        ),
    )
    parser.add_argument(
        "--concurrency",
        default="10,15",
        help="Comma-separated concurrency values to plot. Default: 10,15. Use empty string to include all.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    runs_dir = args.runs_dir.resolve()
    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    csv_paths = sorted(runs_dir.rglob("measurements.csv"))
    if not csv_paths:
        raise SystemExit(f"No measurements.csv files found below {runs_dir}")

    bins = parse_bins(args.bins)
    selected_concurrency = parse_concurrency_selection(args.concurrency)
    created = 0
    for csv_path in csv_paths:
        df = load_measurements(
            csv_path,
            include_warmup=args.all_phases,
            succeeded_only=args.succeeded_only,
            selected_concurrency=selected_concurrency,
        )
        if df.empty:
            print(f"Skipping {csv_path}: no matching rows")
            continue

        run_name = "_".join(csv_path.parent.relative_to(runs_dir).parts)
        output_path = out_dir / f"{sanitize_filename(run_name)}_duration_histograms_by_profile.png"
        plot_histograms(df, run_name, output_path, bins=bins)
        print(f"Wrote {output_path}")
        created += 1

    print(f"Created {created} plot(s).")


def parse_bins(value: str) -> str | float:
    try:
        parsed = float(value)
    except ValueError:
        return value
    return parsed if parsed > 0 else "auto"


def parse_concurrency_selection(value: str) -> set[int] | None:
    if value.strip() == "":
        return None

    selected: set[int] = set()
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            selected.add(int(part))
        except ValueError as error:
            raise SystemExit(f"Invalid concurrency value: {part}") from error

    return selected or None


def load_measurements(
    csv_path: Path,
    include_warmup: bool,
    succeeded_only: bool,
    selected_concurrency: set[int] | None,
) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    required_columns = {"duration_ms", "profile"}
    missing = required_columns - set(df.columns)
    if missing:
        raise SystemExit(f"{csv_path} is missing required column(s): {', '.join(sorted(missing))}")

    if not include_warmup and "phase" in df.columns:
        df = df[df["phase"] == "measurement"]

    if succeeded_only and "status" in df.columns:
        df = df[df["status"] == "succeeded"]

    df = df.copy()
    df["duration_ms"] = pd.to_numeric(df["duration_ms"], errors="coerce")
    if selected_concurrency is not None:
        if "concurrency" in df.columns:
            df["concurrency"] = pd.to_numeric(df["concurrency"], errors="coerce")
            df = df[df["concurrency"].isin(selected_concurrency)]
        else:
            path_concurrency = concurrency_from_path(csv_path)
            if path_concurrency not in selected_concurrency:
                return pd.DataFrame()

    df = df.dropna(subset=["duration_ms", "profile"])
    df["duration_s"] = df["duration_ms"] / 1000
    df["profile"] = df["profile"].astype(str)
    return df


def concurrency_from_path(path: Path) -> int | None:
    match = re.search(r"(\d+)concurrency", str(path))
    if not match:
        return None
    return int(match.group(1))


def benchmark_details(value: str) -> str:
    match = re.search(
        r"(?P<patients>\d+)patients(?P<warmup>\d+)warmup(?P<iterations>\d+)iterations(?P<concurrency>\d+)concurrency",
        value,
    )
    if not match:
        return value

    details = []
    patient_count = int(match.group("patients"))
    if patient_count > 0:
        details.append(f"Patienten: {format(patient_count, ',').replace(',', '.')}")
    details.extend(
        [
            f"Iterationen: {int(match.group('iterations'))}",
            f"Parallelität: {int(match.group('concurrency'))}",
        ]
    )
    return ", ".join(details)


def plot_histograms(df: pd.DataFrame, run_name: str, output_path: Path, bins: str | float) -> None:
    profiles = sorted(df["profile"].unique(), key=profile_sort_key)
    column_count = min(3, max(1, len(profiles)))
    row_count = math.ceil(len(profiles) / column_count)

    fig_width = max(10, column_count * 4.4)
    fig_height = max(4.8, row_count * 3.6 + 1.2)
    fig, axes = plt.subplots(row_count, column_count, figsize=(fig_width, fig_height), squeeze=False)
    flat_axes = [axis for row in axes for axis in row]

    for axis, profile in zip(flat_axes, profiles):
        values = df.loc[df["profile"] == profile, "duration_s"]
        color = PROFILE_COLORS.get(profile, "#9ca3af")
        median = percentile(values, 50)
        p90 = percentile(values, 90)
        p95 = percentile(values, 95)

        profile_bins = histogram_bins(values, bins)
        axis.hist(values, bins=profile_bins, color=color, alpha=0.76, edgecolor="#374151")
        axis.axvline(median, color="#111827", linewidth=2)
        axis.axvline(p90, color="#7c3aed", linewidth=1.8, linestyle="--")
        axis.axvline(p95, color="#dc2626", linewidth=1.8, linestyle=":")

        axis.set_title(
            f"{display_profile(profile)} (n={values.count()})\n"
            f"median={format_seconds(median)}, p90={format_seconds(p90)}, p95={format_seconds(p95)}",
        )
        axis.set_xlabel("Dauer in Sekunden")
        axis.set_ylabel("Frequency")
        axis.yaxis.set_major_locator(MaxNLocator(integer=True))
        axis.grid(axis="y", linestyle="--", alpha=0.3)

    for unused_axis in flat_axes[len(profiles):]:
        unused_axis.axis("off")

    legend_handles = [
        Line2D([0], [0], color="#111827", linewidth=2, label="Median"),
        Line2D([0], [0], color="#7c3aed", linewidth=1.8, linestyle="--", label="p90"),
        Line2D([0], [0], color="#dc2626", linewidth=1.8, linestyle=":", label="p95"),
    ]
    fig.legend(
        handles=legend_handles,
        loc="upper right",
        bbox_to_anchor=(0.98, 0.96),
        fontsize=8,
        handlelength=1.3,
        handletextpad=0.4,
        borderpad=0.35,
        labelspacing=0.3,
    )
    fig.suptitle(
        "Curl End-to-End Dauer-Histogramme nach Profil\n"
        f"{benchmark_details(run_name)} (1 Durchläufe)",
        y=0.98,
    )
    fig.tight_layout(rect=[0.0, 0.0, 1.0, 0.90])
    fig.savefig(output_path, dpi=160, bbox_inches="tight")
    plt.close(fig)


def percentile(values: pd.Series, percentile_value: int) -> float:
    values = pd.Series(values, dtype="float64").dropna()
    if values.empty:
        return math.nan
    return float(values.quantile(percentile_value / 100, interpolation="linear"))


def histogram_bins(values: pd.Series, bins: str | float) -> str | list[float]:
    if not isinstance(bins, float):
        return bins

    values = pd.Series(values, dtype="float64").dropna()
    if values.empty:
        return "auto"

    maximum = float(values.max())
    start = 0
    width = bins
    lower = 0
    upper = max(width, math.ceil(maximum / width) * width + width)

    edge_count = int(round((upper - lower) / width)) + 1
    edges = [lower + index * width for index in range(edge_count + 1)]

    # Matplotlib needs at least two bin edges.
    if len(edges) < 2:
        return [start, start + width]

    return edges


def format_seconds(value: float) -> str:
    if math.isnan(value):
        return "n/a"
    return f"{value:,.2f} s".replace(",", " ")


def display_profile(profile: str) -> str:
    return PROFILE_LABELS.get(profile, profile)


def profile_sort_key(profile: str) -> tuple[int, str]:
    if profile in PROFILE_ORDER:
        return (PROFILE_ORDER.index(profile), profile)
    return (len(PROFILE_ORDER), profile)


def sanitize_filename(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("_")


if __name__ == "__main__":
    main()
