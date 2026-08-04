#!/usr/bin/env python3
"""Create profile boxplots for curl end-to-end benchmark runs.

By default, measurements from repeated run folders are combined before plotting.
For example, these files are aggregated into one plot:

    runs/opa/run_01/30000patients5warmup30iterations1concurrency/measurements.csv
    runs/opa/run_02/30000patients5warmup30iterations1concurrency/measurements.csv

Rows are filtered to phase=measurement by default and duration_ms values are
grouped by the Toxiproxy profile column.

Usage:
    python policy-engine/benchmarks/curl/plot_curl_profiles.py
    python policy-engine/benchmarks/curl/plot_curl_profiles.py --succeeded-only
"""

from __future__ import annotations

import argparse
import math
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

PROFILE_COLORS = {
    "lan": "#4c78a8",
    "wan-typical": "#f58518",
    "intercontinental": "#54a24b",
    "wan-poor": "#e45756",
    "wan-regional": "#72b7b2",
    "satellite": "#b279a2",
}


def default_runs_dir() -> Path:
    return Path(__file__).resolve().parent / "runs"


def default_out_dir() -> Path:
    return Path(__file__).resolve().parent / "plots"


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
    df["profile"] = df["profile"].astype(str)
    df["source_run"] = "_".join(csv_path.parent.relative_to(runs_dir).parts)
    return df


def plot_run(df: pd.DataFrame, run_name: str, output_path: Path) -> None:
    profiles = sorted(df["profile"].unique(), key=profile_sort_key)
    data = [df.loc[df["profile"] == profile, "duration_ms"].tolist() for profile in profiles]
    stats = [profile_stats(profile, values) for profile, values in zip(profiles, data)]
    source_count = df["source_run"].nunique() if "source_run" in df.columns else 1

    fig_height = max(5.5, 4.6 + len(profiles) * 0.25)
    fig, ax = plt.subplots(figsize=(10, fig_height))

    boxplot = ax.boxplot(
        data,
        tick_labels=profiles,
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

    ax.set_title(f"Curl End-to-End Duration by Network Profile\n{run_name} ({source_count} run(s))")
    ax.set_ylabel("Duration in ms")
    ax.set_xlabel("Toxiproxy profile")
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
            markersize=6,
            label="Mean",
        ),
        Line2D(
            [0],
            [0],
            marker="x",
            color="none",
            markeredgecolor="#9ca3af",
            markersize=6,
            label="Outlier",
        ),
        Line2D(
            [0],
            [0],
            marker="D",
            color="none",
            markerfacecolor="#7c3aed",
            markeredgecolor="#7c3aed",
            markersize=6,
            label="p90",
        ),
        Line2D(
            [0],
            [0],
            marker="^",
            color="none",
            markerfacecolor="#dc2626",
            markeredgecolor="#dc2626",
            markersize=7,
            label="p95",
        ),
    ]
    ax.legend(handles=legend_handles, loc="upper right")

    table_rows = [
        [
            row["profile"],
            str(row["n"]),
            format_ms(row["median"]),
            format_ms(row["p90"]),
            format_ms(row["p95"]),
        ]
        for row in stats
    ]
    table = ax.table(
        cellText=table_rows,
        colLabels=["profile", "n", "median", "p90", "p95"],
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


def format_ms(value: float) -> str:
    if math.isnan(value):
        return "n/a"
    return f"{value:,.0f} ms".replace(",", " ")


def profile_sort_key(profile: str) -> tuple[int, str]:
    if profile in PROFILE_ORDER:
        return (PROFILE_ORDER.index(profile), profile)
    return (len(PROFILE_ORDER), profile)


if __name__ == "__main__":
    main()
