#!/usr/bin/env python3
"""Create profile boxplots for curl end-to-end benchmark runs.

By default, measurements from repeated run folders are combined before plotting.
For example, these files are aggregated into one plot:

    runs/blaze/opa/run_01/30000patients5warmup30iterations1concurrency/measurements.csv
    runs/blaze/opa/run_02/30000patients5warmup30iterations1concurrency/measurements.csv

Rows are filtered to phase=measurement by default and duration_ms values are
grouped by the Toxiproxy profile column.

Usage:
    python policy-engine/benchmarks/curl/blaze-scripts/plot_curl_profiles.py
    python policy-engine/benchmarks/curl/blaze-scripts/plot_curl_profiles.py --succeeded-only
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
    return Path(__file__).resolve().parent.parent / "runs" / "blaze"


def default_out_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "plots" / "blaze"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Plot duration_ms boxplots per network profile for curl benchmark measurements.",
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
        help="Directory where PNG plots are written.",
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
        "--per-file",
        action="store_true",
        help="Create one plot per measurements.csv instead of aggregating repeated run folders.",
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

    grouped_csvs = group_measurement_csvs(csv_paths, runs_dir, per_file=args.per_file)

    created = 0
    for run_name, grouped_paths in grouped_csvs.items():
        frames = [
            load_measurements(csv_path, runs_dir, include_warmup=args.all_phases, succeeded_only=args.succeeded_only)
            for csv_path in grouped_paths
        ]
        frames = [frame for frame in frames if not frame.empty]
        df = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
        if df.empty:
            print(f"Skipping {run_name}: no matching rows")
            continue

        output_path = out_dir / f"{run_name}_duration_by_profile.png"
        plot_run(df, run_name, output_path)
        print(f"Wrote {output_path}")
        created += 1

    print(f"Created {created} plot(s).")


def group_measurement_csvs(csv_paths: list[Path], runs_dir: Path, per_file: bool) -> dict[str, list[Path]]:
    grouped: dict[str, list[Path]] = {}

    for csv_path in csv_paths:
        run_name = grouped_run_name(csv_path, runs_dir, per_file=per_file)
        grouped.setdefault(run_name, []).append(csv_path)

    return dict(sorted(grouped.items()))


def grouped_run_name(csv_path: Path, runs_dir: Path, per_file: bool) -> str:
    parts = csv_path.parent.relative_to(runs_dir).parts

    if per_file:
        return "_".join(parts)

    # Current repeated-run layout:
    #   <architecture>/run_01/<configuration>/measurements.csv
    #   <architecture>/run_02/<configuration>/measurements.csv
    # should become:
    #   <architecture>_<configuration>
    if len(parts) >= 3 and is_repetition_folder(parts[1]):
        return "_".join((parts[0], *parts[2:]))

    return "_".join(parts)


def is_repetition_folder(value: str) -> bool:
    return value.lower().startswith("run_")


def benchmark_details(value: str) -> str:
    match = re.search(
        r"(?P<patients>\d+)patients(?P<warmup>\d+)warmup(?P<iterations>\d+)iterations(?P<concurrency>\d+)concurrency",
        value,
    )
    if not match:
        return value

    return (
        f"Patienten: {format(int(match.group('patients')), ',').replace(',', '.')}, "
        f"Iterationen: {int(match.group('iterations'))}, "
        f"Parallelität: {int(match.group('concurrency'))}"
    )


def load_measurements(csv_path: Path, runs_dir: Path, include_warmup: bool, succeeded_only: bool) -> pd.DataFrame:
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
    df = df.dropna(subset=["duration_ms", "profile"])
    df["duration_s"] = df["duration_ms"] / 1000
    df["profile"] = df["profile"].astype(str)
    df["source_run"] = "_".join(csv_path.parent.relative_to(runs_dir).parts)
    return df


def plot_run(df: pd.DataFrame, run_name: str, output_path: Path) -> None:
    profiles = sorted(df["profile"].unique(), key=profile_sort_key)
    data = [df.loc[df["profile"] == profile, "duration_s"].tolist() for profile in profiles]
    stats = [profile_stats(profile, values) for profile, values in zip(profiles, data)]
    source_count = df["source_run"].nunique() if "source_run" in df.columns else 1

    fig_height = max(5.5, 4.6 + len(profiles) * 0.25)
    fig, ax = plt.subplots(figsize=(10, fig_height))

    boxplot = ax.boxplot(
        data,
        tick_labels=[display_profile(profile) for profile in profiles],
        patch_artist=True,
        showmeans=True,
        meanprops={
            "marker": "o",
            "markerfacecolor": "white",
            "markeredgecolor": "#111827",
            "markersize": 5,
        },
        medianprops={"color": "#111827", "linewidth": 2},
        whiskerprops={"color": "#6b7280"},
        capprops={"color": "#6b7280"},
        flierprops={
            "marker": "x",
            "markeredgecolor": "#9ca3af",
            "markersize": 5,
            "alpha": 0.75,
        },
    )

    for patch, profile in zip(boxplot["boxes"], profiles):
        patch.set_facecolor(PROFILE_COLORS.get(profile, "#9ca3af"))
        patch.set_alpha(0.72)
        patch.set_edgecolor("#374151")

    for index, row in enumerate(stats, start=1):
        ax.scatter(index, row["p90"], marker="D", color="#7c3aed", s=34, zorder=3, label="p90" if index == 1 else None)
        ax.scatter(index, row["p95"], marker="^", color="#dc2626", s=42, zorder=3, label="p95" if index == 1 else None)

    ax.set_title(
        "Curl End-to-End Dauer nach Profil\n"
        f"{benchmark_details(run_name)} ({source_count} Durchläufe)",
    )
    ax.set_ylabel("Dauer in Sekunden")
    ax.set_xlabel(" ")
    ax.set_xlim(0.5, len(profiles) + 1)
    ax.grid(axis="y", linestyle="--", alpha=0.35)
    legend_handles = [
        Line2D([0], [0], color="#111827", linewidth=2, label="Median"),
        Line2D(
            [0],
            [0],
            marker="o",
            markerfacecolor="white",
            markeredgecolor="#111827",
            color="none",
            markersize=5,
            label="Durchschnitt",
        ),
        Line2D(
            [0],
            [0],
            marker="x",
            color="none",
            markeredgecolor="#9ca3af",
            markersize=5,
            label="Ausreißer",
        ),
        Line2D(
            [0],
            [0],
            marker="D",
            color="none",
            markerfacecolor="#7c3aed",
            markeredgecolor="#7c3aed",
            markersize=5,
            label="p90",
        ),
        Line2D(
            [0],
            [0],
            marker="^",
            color="none",
            markerfacecolor="#dc2626",
            markeredgecolor="#dc2626",
            markersize=6,
            label="p95",
        ),
    ]
    ax.legend(
        handles=legend_handles,
        loc="upper right",
        fontsize=8,
        handlelength=1.3,
        handletextpad=0.4,
        borderpad=0.35,
        labelspacing=0.3,
    )

    table_rows = [
        [
            display_profile(str(row["profile"])),
            str(row["n"]),
            format_seconds(row["median"]),
            format_seconds(row["p90"]),
            format_seconds(row["p95"]),
        ]
        for row in stats
    ]
    table = ax.table(
        cellText=table_rows,
        colLabels=["Profil", "n", "Median", "p90", "p95"],
        loc="bottom",
        cellLoc="center",
        bbox=[0.0, -0.48, 1.0, 0.32],
    )
    table.auto_set_font_size(False)
    table.set_fontsize(9)

    fig.subplots_adjust(bottom=0.34)
    fig.savefig(output_path, dpi=160, bbox_inches="tight")
    plt.close(fig)


def profile_stats(profile: str, values: list[float]) -> dict[str, object]:
    series = pd.Series(values, dtype="float64")
    return {
        "profile": profile,
        "n": int(series.count()),
        "median": percentile(series, 50),
        "p90": percentile(series, 90),
        "p95": percentile(series, 95),
    }


def percentile(series: pd.Series, value: int) -> float:
    if series.empty:
        return math.nan
    return float(series.quantile(value / 100, interpolation="linear"))


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


if __name__ == "__main__":
    main()
