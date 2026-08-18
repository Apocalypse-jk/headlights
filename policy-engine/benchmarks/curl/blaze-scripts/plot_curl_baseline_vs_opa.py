#!/usr/bin/env python3
"""Compare curl baseline, OPA and Casbin end-to-end durations.

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

For every measurement name that exists in all configured architectures, this
script creates one PNG. Inside that PNG, each Toxiproxy profile gets one boxplot
per architecture. Values from all run_XX folders are combined.

Usage:
    python policy-engine/benchmarks/curl/blaze-scripts/plot_curl_baseline_vs_opa.py
    python policy-engine/benchmarks/curl/blaze-scripts/plot_curl_baseline_vs_opa.py --succeeded-only
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


ARCHITECTURES = {
    "baseline": "Baseline",
    "opa": "OPA",
    "casbin": "Casbin",
}

ARCHITECTURE_COLORS = {
    "baseline": "#4c78a8",
    "opa": "#f58518",
    "casbin": "#54a24b",
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


def default_runs_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "runs" / "blaze"


def default_out_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "plots" / "blaze" / "architecture_comparison"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create curl architecture comparison duration boxplots grouped by profile.",
    )
    parser.add_argument(
        "runs_dir",
        nargs="?",
        default=default_runs_dir(),
        type=Path,
        help="Directory containing baseline/, opa/ and casbin/ curl run folders.",
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
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    runs_dir = args.runs_dir.resolve()
    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    measurements = find_measurement_groups(runs_dir)
    architecture_measurements = [set(measurements.get(architecture, {})) for architecture in ARCHITECTURES]
    common_measurements = sorted(set.intersection(*architecture_measurements), key=natural_sort_key)
    if not common_measurements:
        raise SystemExit(f"No matching curl measurements found for all architectures below {runs_dir}")

    created = 0
    for measurement_name in common_measurements:
        frames = []
        for architecture in ARCHITECTURES:
            for csv_path in measurements[architecture][measurement_name]:
                frame = load_measurements(
                    csv_path,
                    architecture=architecture,
                    measurement_name=measurement_name,
                    include_warmup=args.all_phases,
                    succeeded_only=args.succeeded_only,
                )
                if not frame.empty:
                    frames.append(frame)

        if not frames:
            print(f"Skipping {measurement_name}: no matching rows")
            continue

        df = pd.concat(frames, ignore_index=True)
        output_path = out_dir / f"{sanitize_filename(measurement_name)}_architecture_comparison_by_profile.png"
        plot_measurement(df, measurement_name, output_path)
        print(f"Wrote {output_path}")
        created += 1

    print(f"Created {created} plot(s).")


def find_measurement_groups(runs_dir: Path) -> dict[str, dict[str, list[Path]]]:
    result: dict[str, dict[str, list[Path]]] = {architecture: {} for architecture in ARCHITECTURES}

    for architecture in ARCHITECTURES:
        architecture_dir = runs_dir / architecture
        if not architecture_dir.exists():
            print(f"Skipping missing architecture directory: {architecture_dir}")
            continue

        for csv_path in sorted(architecture_dir.rglob("measurements.csv")):
            measurement_name = measurement_name_from_path(csv_path, architecture_dir)
            result[architecture].setdefault(measurement_name, []).append(csv_path)

    return result


def measurement_name_from_path(csv_path: Path, architecture_dir: Path) -> str:
    parts = csv_path.parent.relative_to(architecture_dir).parts

    # Repeated-run layout:
    #   run_01/<measurement-name>/measurements.csv
    #   run_02/<measurement-name>/measurements.csv
    if len(parts) >= 2 and is_repetition_folder(parts[0]):
        return "_".join(parts[1:])

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


def load_measurements(
    csv_path: Path,
    architecture: str,
    measurement_name: str,
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
    df["architecture_key"] = architecture
    df["architecture"] = ARCHITECTURES[architecture]
    df["measurement_name"] = measurement_name
    df["source_run"] = csv_path.parent.parent.name if is_repetition_folder(csv_path.parent.parent.name) else str(csv_path.parent)
    return df


def plot_measurement(df: pd.DataFrame, measurement_name: str, output_path: Path) -> None:
    profiles = sorted(df["profile"].unique(), key=profile_sort_key)
    run_count = df["source_run"].nunique() if "source_run" in df.columns else 1
    grouped_data: list[list[float]] = []
    positions: list[float] = []
    colors: list[str] = []

    group_spacing = 3.1
    offsets = centered_offsets(len(ARCHITECTURES), width=0.58)
    profile_centers = []

    for profile_index, profile in enumerate(profiles, start=1):
        center = profile_index * group_spacing
        profile_centers.append(center)

        for architecture, offset in zip(ARCHITECTURES, offsets):
            values = df[
                (df["profile"] == profile)
                & (df["architecture_key"] == architecture)
            ]["duration_s"].tolist()
            grouped_data.append(values)
            positions.append(center + offset)
            colors.append(ARCHITECTURE_COLORS[architecture])

    fig_width = max(8.8, len(profiles) * 2.0)
    fig, ax = plt.subplots(figsize=(fig_width, 9.6))

    boxplot = ax.boxplot(
        grouped_data,
        positions=positions,
        widths=0.58,
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

    stats = comparison_stats(df, profiles)
    for row in stats:
        ax.scatter(row["position"], row["p90"], marker="D", color="#7c3aed", s=30, zorder=3)
        ax.scatter(row["position"], row["p95"], marker="^", color="#dc2626", s=38, zorder=3)

    ax.set_title(
        "Curl End-to-End Architekturvergleich nach Profil\n"
        f"{benchmark_details(measurement_name)} ({run_count} Durchläufe)",
    )
    ax.set_ylabel("Dauer in Sekunden")
    ax.set_xlabel(" ")
    ax.set_xticks(profile_centers)
    ax.set_xticklabels([display_profile(profile) for profile in profiles])
    ax.set_xlim(0.8, (len(profiles) + 1) * group_spacing)
    ax.grid(axis="y", linestyle="--", alpha=0.35)

    legend_handles = [
        *[
            Patch(
                facecolor=ARCHITECTURE_COLORS[architecture],
                edgecolor="#374151",
                alpha=0.72,
                label=label,
            )
            for architecture, label in ARCHITECTURES.items()
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
                row["architecture"],
                str(row["n"]),
                format_seconds(row["median"]),
                format_seconds(row["p90"]),
                format_seconds(row["p95"]),
            ]
            for row in stats
        ],
        colLabels=["Profil", "Architektur", "n", "Median", "p90", "p95"],
        loc="bottom",
        cellLoc="center",
        bbox=[0.0, -0.63, 1.0, 0.50],
    )
    table.auto_set_font_size(False)
    table.set_fontsize(8)

    fig.subplots_adjust(bottom=0.52)
    fig.savefig(output_path, dpi=160, bbox_inches="tight")
    plt.close(fig)


def comparison_stats(df: pd.DataFrame, profiles: list[str]) -> list[dict[str, object]]:
    rows = []
    group_spacing = 3.1
    offsets = centered_offsets(len(ARCHITECTURES), width=0.58)

    for profile_index, profile in enumerate(profiles, start=1):
        center = profile_index * group_spacing
        for architecture, offset in zip(ARCHITECTURES, offsets):
            values = df[
                (df["profile"] == profile)
                & (df["architecture_key"] == architecture)
            ]["duration_s"]
            rows.append(
                {
                    "profile": profile,
                    "architecture": ARCHITECTURES[architecture],
                    "n": int(values.count()),
                    "median": percentile(values, 50),
                    "p90": percentile(values, 90),
                    "p95": percentile(values, 95),
                    "position": center + offset,
                },
            )

    return rows


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
