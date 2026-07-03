import csv
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INPUT = ROOT / "data" / "salinity_labels.csv"
OUTPUT = ROOT / "data" / "salinity_labels_daily_interpolated.csv"


def parse_date(value):
    return datetime.strptime(value, "%Y-%m-%d").date()


def interpolate_group(rows):
    rows = sorted(rows, key=lambda row: row["recorded_date"])
    daily_rows = []
    for index in range(len(rows) - 1):
        current = rows[index]
        next_row = rows[index + 1]
        start = parse_date(current["recorded_date"])
        end = parse_date(next_row["recorded_date"])
        span_days = max((end - start).days, 1)
        start_value = float(current["salinity_gpl"])
        end_value = float(next_row["salinity_gpl"])

        for day_offset in range(span_days):
            ratio = day_offset / span_days
            value = start_value + (end_value - start_value) * ratio
            record = dict(current)
            record["recorded_date"] = (start + timedelta(days=day_offset)).isoformat()
            record["salinity_gpl"] = f"{value:.3f}"
            record["label_source"] = "historical_station_dataset"
            record["preprocessing"] = "daily_linear_interpolation"
            record["interpolated"] = "false" if day_offset == 0 else "true"
            daily_rows.append(record)

    last = dict(rows[-1])
    last["label_source"] = "historical_station_dataset"
    last["preprocessing"] = "daily_linear_interpolation"
    last["interpolated"] = "false"
    daily_rows.append(last)
    return daily_rows


def main():
    with INPUT.open("r", encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))

    grouped = defaultdict(list)
    for row in rows:
        grouped[(row["province"], row["station"])].append(row)

    output_rows = []
    for group_rows in grouped.values():
        output_rows.extend(interpolate_group(group_rows))

    fieldnames = [
        "station",
        "province",
        "latitude",
        "longitude",
        "recorded_date",
        "salinity_gpl",
        "label_source",
        "preprocessing",
        "interpolated",
    ]
    with OUTPUT.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows({key: row.get(key, "") for key in fieldnames} for row in output_rows)

    print(f"Wrote {len(output_rows)} daily rows to {OUTPUT}")


if __name__ == "__main__":
    main()
