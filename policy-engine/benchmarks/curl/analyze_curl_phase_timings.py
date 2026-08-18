#!/usr/bin/env python3
"""Analyze curl benchmark phase timings.

This script expects measurements.csv files created by run-realistic-curl.ps1
after the diagnostic timing columns were added:

    post_duration_ms
    time_to_first_event_ms
    time_to_claimed_ms
    claimed_to_terminal_ms
    time_to_terminal_ms

Interpretation:
    Large spread in time_to_claimed_ms points to task pickup / Beam / Focus
    polling. Large spread in claimed_to_terminal_ms points to Focus / Blaze /
    result processing. Large post_duration_ms would point to Spot request
    submission.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd


PHASE_COLUMNS = [
    "post_duration_ms",
    "time_to_first_event_ms",
    "time_to_claimed_ms",
    "claimed_to_terminal_ms",
    "duration_ms",
]


def default_runs_dir() -> Path:
    return Path(__file__).resolve().parent / "runs"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Summarize phase timings from curl benchmark measurements.")
    parser.add_argument(
        "runs_dir",
        nargs="?",
        default=default_runs_dir(),
        type=Path,
        help="Directory containing curl run folders with measurements.csv files.",
    )
    parser.add_argument(
        "--phase",
        default="measurement",
        help="CSV phase to analyze. Default: measurement.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    runs_dir = args.runs_dir.resolve()
    csv_paths = sorted(runs_dir.rglob("measurements.csv"))

    if not csv_paths:
        raise SystemExit(f"No measurements.csv files found below {runs_dir}")

    analyzed = 0
    for csv_path in csv_paths:
        df = pd.read_csv(csv_path)
        missing = [column for column in PHASE_COLUMNS if column not in df.columns]
        if missing:
            print(f"\nSkipping {csv_path.relative_to(runs_dir)}: missing diagnostic columns")
            continue

        if "phase" in df.columns:
            df = df[df["phase"] == args.phase].copy()

        for column in PHASE_COLUMNS:
            df[column] = pd.to_numeric(df[column], errors="coerce")

        df = df.dropna(subset=["duration_ms", "profile"])
        if df.empty:
            continue

        print(f"\n{csv_path.relative_to(runs_dir)}")
        for profile, group in df.groupby("profile", sort=False):
            summary = summarize_group(group)
            likely = likely_bottleneck(summary)
            print(
                f"  {profile}: n={len(group)} "
                f"duration p50/p90/p95={fmt(summary['duration_ms']['p50'])}/"
                f"{fmt(summary['duration_ms']['p90'])}/{fmt(summary['duration_ms']['p95'])} "
                f"claimed p50/p90={fmt(summary['time_to_claimed_ms']['p50'])}/"
                f"{fmt(summary['time_to_claimed_ms']['p90'])} "
                f"claimed->terminal p50/p90={fmt(summary['claimed_to_terminal_ms']['p50'])}/"
                f"{fmt(summary['claimed_to_terminal_ms']['p90'])} "
                f"likely={likely}"
            )

        analyzed += 1

    if analyzed == 0:
        print(
            "\nNo CSV with diagnostic timing columns found. "
            "Run run-realistic-curl.ps1 again to collect phase timings.",
        )


def summarize_group(group: pd.DataFrame) -> dict[str, dict[str, float]]:
    result: dict[str, dict[str, float]] = {}
    for column in PHASE_COLUMNS:
        values = group[column].dropna()
        result[column] = {
            "count": int(values.count()),
            "p50": float(values.quantile(0.50)) if not values.empty else float("nan"),
            "p90": float(values.quantile(0.90)) if not values.empty else float("nan"),
            "p95": float(values.quantile(0.95)) if not values.empty else float("nan"),
            "spread": float(values.quantile(0.90) - values.quantile(0.50)) if not values.empty else float("nan"),
        }
    return result


def likely_bottleneck(summary: dict[str, dict[str, float]]) -> str:
    if summary["duration_ms"]["count"] < 2:
        return "insufficient_data"

    spreads = {
        "spot_submit": summary["post_duration_ms"]["spread"],
        "task_pickup_or_polling": summary["time_to_claimed_ms"]["spread"],
        "focus_blaze_or_result_processing": summary["claimed_to_terminal_ms"]["spread"],
    }
    return max(spreads, key=lambda key: -1 if pd.isna(spreads[key]) else spreads[key])


def fmt(value: float) -> str:
    if pd.isna(value):
        return "n/a"
    return f"{value / 1000:.2f}s"


if __name__ == "__main__":
    main()
