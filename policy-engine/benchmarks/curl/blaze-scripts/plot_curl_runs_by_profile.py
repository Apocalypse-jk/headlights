#!/usr/bin/env python3
"""Compare repeated curl benchmark runs by Toxiproxy profile.

Expected layout:

    runs/blaze/
      baseline/
        run_01/<measurement-name>/measurements.csv
        run_02/<measurement-name>/measurements.csv
      opa/
        run_01/<measurement-name>/measurements.csv
        run_02/<measurement-name>/measurements.csv
      casbin/
        run_01/<measurement-name>/measurements.csv
        run_02/<measurement-name>/measurements.csv

For every architecture and measurement name, this script creates one PNG. Each
Toxiproxy profile is shown as a group, and the repeated runs are plotted next to
each other inside that group.

Usage:
    python policy-engine/benchmarks/curl/blaze-scripts/plot_curl_runs_by_profile.py
    python policy-engine/benchmarks/curl/blaze-scripts/plot_curl_runs_by_profile.py --succeeded-only
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
from matplotlib.patches import Patch  # noqa: E402


ARCHITECTURE_LABELS = {
    "baseline": "Baseline",
    "opa": "OPA",
    "casbin": "Casbin",
}

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

RUN_COLORS = [
    "#4c78a8",
    "#f58518",
    "#54a24b",
    "#e45756",
    "#72b7b2",
    "#b279a2",
    "#ff9da6",
    "#9d755d",
]


def default_runs_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "runs" / "blaze"


def default_out_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "plots" / "blaze" / "runs_by_profile"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create curl repeated-run comparison boxplots grouped by Toxiproxy profile.",
    )
    parser.add_argument(
        "runs_dir",
        nargs="?",
        default=default_runs_dir(),
        type=Path,
        help="Directory containing baseline/, opa/ and/or casbin/ curl run folders.",
    )
    parser.add_argument(
        "--out-dir",
        default=default_out_dir(),
        type=Path,
        help="Output directory for PNG plots.",
    )
    parser.add_argument(
        "--architecture",
        choices=list(ARCHITECTURE_LABELS),
        default=None,
        help="Plot only one architecture. By default all known architectures are plotted when present.",
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
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    runs_dir = args.runs_dir.resolve()
    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    architectures = [args.architecture] if args.architecture else list(ARCHITECTURE_LABELS)
    created = 0

    for architecture in architectures:
        groups = find_architecture_groups(runs_dir, architecture)
        if not groups:
            print(f"Skipping {architecture}: no repeated curl measurement CSVs found")
            continue

        for measurement_name, run_paths in groups.items():
            frames = []
            for run_name, csv_path in run_paths:
                frame = load_measurements(
                    csv_path,
                    run_name=run_name,
                    include_warmup=args.all_phases,
                    succeeded_only=args.succeeded_only,
                )
                if not frame.empty:
                    frames.append(frame)

            if not frames:
                print(f"Skipping {architecture}/{measurement_name}: no matching rows")
                continue

            df = pd.concat(frames, ignore_index=True)
            output_path = (
                out_dir
                / f"{sanitize_filename(architecture)}_{sanitize_filename(measurement_name)}_runs_by_profile.png"
            )
            plot_architecture_measurement(df, architecture, measurement_name, output_path)
            print(f"Wrote {output_path}")
            created += 1

    print(f"Created {created} plot(s).")


def find_architecture_groups(runs_dir: Path, architecture: str) -> dict[str, list[tuple[str, Path]]]:
    architecture_dir = runs_dir / architecture
    if not architecture_dir.exists():
        return {}

    groups: dict[str, list[tuple[str, Path]]] = {}
    for csv_path in sorted(architecture_dir.rglob("measurements.csv")):
        parts = csv_path.parent.relative_to(architecture_dir).parts
        if len(parts) >= 2 and is_repetition_folder(parts[0]):
            run_name = parts[0]
            measurement_name = "_".join(parts[1:])
        else:
            run_name = "run"
            measurement_name = "_".join(parts)

        groups.setdefault(measurement_name, []).append((run_name, csv_path))

    return dict(sorted(groups.items(), key=lambda item: natural_sort_key(item[0])))


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


def load_measurements(
    csv_path: Path,
    run_name: str,
    include_warmup: bool,
    succeeded_only: bool,
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
    df = df.dropna(subset=["duration_ms", "profile"])
    df["duration_s"] = df["duration_ms"] / 1000
    df["profile"] = df["profile"].astype(str)
    df["run_name"] = run_name
    return df


def plot_architecture_measurement(
    df: pd.DataFrame,
    architecture: str,
    measurement_name: str,
    output_path: Path,
) -> None:
    profiles = sorted(df["profile"].unique(), key=profile_sort_key)
    run_names = sorted(df["run_name"].unique(), key=natural_sort_key)

    group_spacing = max(2.5, len(run_names) * 0.9 + 1.2)
    offsets = centered_offsets(len(run_names), width=0.72)
    box_width = min(0.55, 0.95 / max(1, len(run_names)))

    data: list[list[float]] = []
    positions: list[float] = []
    colors: list[str] = []
    stats: list[dict[str, object]] = []
    profile_centers: list[float] = []

    for profile_index, profile in enumerate(profiles, start=1):
        center = profile_index * group_spacing
        profile_centers.append(center)

        for run_index, run_name in enumerate(run_names):
            position = center + offsets[run_index]
            values = df[
                (df["profile"] == profile)
                & (df["run_name"] == run_name)
            ]["duration_s"]

            data.append(values.tolist())
            positions.append(position)
            colors.append(RUN_COLORS[run_index % len(RUN_COLORS)])
            stats.append(
                {
                    "profile": profile,
                    "run": run_name,
                    "n": int(values.count()),
                    "median": percentile(values, 50),
                    "p90": percentile(values, 90),
                    "p95": percentile(values, 95),
                    "position": position,
                },
            )

    fig_width = max(11, len(profiles) * max(2.5, len(run_names) * 1.05))
    fig_height = max(7.4, 5.2 + len(stats) * 0.10)
    fig, ax = plt.subplots(figsize=(fig_width, fig_height))

    boxplot = ax.boxplot(
        data,
        positions=positions,
        widths=box_width,
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

    for patch, color in zip(boxplot["boxes"], colors):
        patch.set_facecolor(color)
        patch.set_alpha(0.72)
        patch.set_edgecolor("#374151")

    for row in stats:
        ax.scatter(row["position"], row["p90"], marker="D", color="#7c3aed", s=30, zorder=3)
        ax.scatter(row["position"], row["p95"], marker="^", color="#dc2626", s=38, zorder=3)

    architecture_label = ARCHITECTURE_LABELS.get(architecture, architecture)
    ax.set_title(
        f"Curl End-to-End Durchläufe nach Profil ({architecture_label})\n"
        f"{benchmark_details(measurement_name)} ({len(run_names)} Durchläufe)",
    )
    ax.set_ylabel("Dauer in Sekunden")
    ax.set_xlabel(" ")
    ax.set_xticks(profile_centers)
    ax.set_xticklabels([display_profile(profile) for profile in profiles])
    ax.set_xlim(0.7, (len(profiles) + 1) * group_spacing)
    ax.grid(axis="y", linestyle="--", alpha=0.35)

    legend_handles = [
        *[
            Patch(
                facecolor=RUN_COLORS[index % len(RUN_COLORS)],
                edgecolor="#374151",
                alpha=0.72,
                label=run_name,
            )
            for index, run_name in enumerate(run_names)
        ],
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

    table = ax.table(
        cellText=[
            [
                display_profile(str(row["profile"])),
                row["run"],
                str(row["n"]),
                format_seconds(row["median"]),
                format_seconds(row["p90"]),
                format_seconds(row["p95"]),
            ]
            for row in stats
        ],
        colLabels=["Profil", "run", "n", "Median", "p90", "p95"],
        loc="bottom",
        cellLoc="center",
        bbox=[0.0, -0.64, 1.0, 0.46],
    )
    table.auto_set_font_size(False)
    table.set_fontsize(8)

    fig.subplots_adjust(bottom=0.46)
    fig.savefig(output_path, dpi=160, bbox_inches="tight")
    plt.close(fig)


def centered_offsets(count: int, width: float) -> list[float]:
    if count <= 1:
        return [0.0]
    start = -((count - 1) * width) / 2
    return [start + index * width for index in range(count)]


def percentile(values: pd.Series, percentile_value: int) -> float:
    values = pd.Series(values, dtype="float64").dropna()
    if values.empty:
        return math.nan
    return float(values.quantile(percentile_value / 100, interpolation="linear"))


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


def natural_sort_key(value: str) -> list[object]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", value)]


def sanitize_filename(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("_")


if __name__ == "__main__":
    main()
