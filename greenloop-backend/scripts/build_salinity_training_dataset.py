import csv
import json
import math
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LABELS_PATH = ROOT / "data" / "salinity_labels.csv"
OUTPUT_PATH = ROOT / "data" / "salinity_training_dataset.csv"
REPORT_PATH = ROOT / "data" / "salinity_training_dataset_report.json"
OPEN_METEO_URL = "https://flood-api.open-meteo.com/v1/flood"
NASA_POWER_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
WINDOW_DAYS = 7


def parse_date(value):
    return datetime.strptime(value, "%Y-%m-%d").date()


def date_to_str(value):
    return value.isoformat()


def fetch_json(url, params):
    query = urllib.parse.urlencode(params)
    request = urllib.request.Request(
        f"{url}?{query}",
        headers={"User-Agent": "GreenLoop-ML/1.0"}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def rolling_average(series, end_date, days):
    values = []
    for offset in range(days):
        key = date_to_str(end_date - timedelta(days=offset))
        value = series.get(key)
        if value is None:
            continue
        values.append(float(value))
    if not values:
        return None
    return sum(values) / len(values)


def rolling_sum(series, end_date, days):
    values = []
    for offset in range(days):
        key = date_to_str(end_date - timedelta(days=offset))
        value = series.get(key)
        if value is None:
            continue
        values.append(float(value))
    if not values:
        return None
    return sum(values)


def count_dry_days(series, end_date, days, threshold=1.0):
    count = 0
    seen = 0
    for offset in range(days):
        key = date_to_str(end_date - timedelta(days=offset))
        value = series.get(key)
        if value is None:
            continue
        seen += 1
        if float(value) < threshold:
            count += 1
    return count if seen else None


def fetch_open_meteo_series(latitude, longitude, start_date, end_date):
    payload = fetch_json(
        OPEN_METEO_URL,
        {
            "latitude": latitude,
            "longitude": longitude,
            "daily": "river_discharge",
            "start_date": start_date,
            "end_date": end_date,
        },
    )
    times = payload.get("daily", {}).get("time", [])
    values = payload.get("daily", {}).get("river_discharge", [])
    return {
        str(day): (float(value) if value is not None else None)
        for day, value in zip(times, values)
    }


def fetch_nasa_series(latitude, longitude, start_date, end_date):
    payload = fetch_json(
        NASA_POWER_URL,
        {
            "parameters": "PRECTOTCORR",
            "community": "AG",
            "longitude": longitude,
            "latitude": latitude,
            "start": start_date.replace("-", ""),
            "end": end_date.replace("-", ""),
            "format": "JSON",
        },
    )
    values = payload.get("properties", {}).get("parameter", {}).get("PRECTOTCORR", {})
    return {
        f"{key[0:4]}-{key[4:6]}-{key[6:8]}": (float(value) if value is not None else None)
        for key, value in values.items()
    }


def feature_row(label_row, river_series, rain_series):
    day = parse_date(label_row["recorded_date"])
    day_of_year = day.timetuple().tm_yday
    river_today = river_series.get(label_row["recorded_date"])
    rain_today = rain_series.get(label_row["recorded_date"])
    river_avg_3d = rolling_average(river_series, day, 3)
    river_avg_7d = rolling_average(river_series, day, 7)
    rain_3d = rolling_sum(rain_series, day, 3)
    rain_7d = rolling_sum(rain_series, day, 7)
    dry_days_7d = count_dry_days(rain_series, day, 7)
    if None in [river_today, rain_today, river_avg_3d, river_avg_7d, rain_3d, rain_7d, dry_days_7d]:
      return None
    return {
        "station": label_row["station"],
        "province": label_row["province"],
        "latitude": f"{float(label_row['latitude']):.6f}",
        "longitude": f"{float(label_row['longitude']):.6f}",
        "recorded_date": label_row["recorded_date"],
        "month": str(day.month),
        "day_of_year_sin": f"{math.sin((2 * math.pi * day_of_year) / 365.0):.8f}",
        "day_of_year_cos": f"{math.cos((2 * math.pi * day_of_year) / 365.0):.8f}",
        "river_discharge_today": f"{float(river_today):.8f}",
        "river_discharge_avg_3d": f"{float(river_avg_3d):.8f}",
        "river_discharge_avg_7d": f"{float(river_avg_7d):.8f}",
        "rain_today_mm": f"{float(rain_today):.8f}",
        "rain_3d_mm": f"{float(rain_3d):.8f}",
        "rain_7d_mm": f"{float(rain_7d):.8f}",
        "dry_days_7d": str(int(dry_days_7d)),
        "salinity_gpl": f"{float(label_row['salinity_gpl']):.8f}",
        "label_source": "historical_station_dataset",
        "feature_sources": "open-meteo:river_discharge|nasa-power:PRECTOTCORR",
    }


def main():
    rows = list(csv.DictReader(LABELS_PATH.open("r", encoding="utf-8", newline="")))
    grouped = defaultdict(list)
    province_values = defaultdict(list)
    station_values = defaultdict(list)
    for row in rows:
        grouped[(row["province"], row["station"], row["latitude"], row["longitude"])].append(row)
        province_values[row["province"]].append(float(row["salinity_gpl"]))
        station_values[(row["province"], row["station"])].append(float(row["salinity_gpl"]))

    province_means = {
        key: (sum(values) / len(values))
        for key, values in province_values.items()
    }
    station_means = {
        key: (sum(values) / len(values))
        for key, values in station_values.items()
    }

    output_rows = []
    report_groups = []
    for (province, station, latitude, longitude), group_rows in grouped.items():
        group_rows = sorted(group_rows, key=lambda row: row["recorded_date"])
        start_day = parse_date(group_rows[0]["recorded_date"]) - timedelta(days=WINDOW_DAYS - 1)
        end_day = parse_date(group_rows[-1]["recorded_date"])
        river_series = fetch_open_meteo_series(latitude, longitude, date_to_str(start_day), date_to_str(end_day))
        rain_series = fetch_nasa_series(latitude, longitude, date_to_str(start_day), date_to_str(end_day))
        before_count = len(output_rows)
        for row in group_rows:
            features = feature_row(row, river_series, rain_series)
            if features:
                features["province_label_avg_salinity"] = f"{province_means[row['province']]:.8f}"
                features["station_label_avg_salinity"] = f"{station_means[(row['province'], row['station'])]:.8f}"
                output_rows.append(features)
        report_groups.append(
            {
                "province": province,
                "station": station,
                "latitude": latitude,
                "longitude": longitude,
                "label_rows": len(group_rows),
                "feature_rows": len(output_rows) - before_count,
                "date_range": [group_rows[0]["recorded_date"], group_rows[-1]["recorded_date"]],
            }
        )

    fieldnames = [
        "station",
        "province",
        "latitude",
        "longitude",
        "recorded_date",
        "month",
        "day_of_year_sin",
        "day_of_year_cos",
        "river_discharge_today",
        "river_discharge_avg_3d",
        "river_discharge_avg_7d",
        "rain_today_mm",
        "rain_3d_mm",
        "rain_7d_mm",
        "dry_days_7d",
        "province_label_avg_salinity",
        "station_label_avg_salinity",
        "salinity_gpl",
        "label_source",
        "feature_sources",
    ]
    with OUTPUT_PATH.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(output_rows)

    report = {
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "input_label_rows": len(rows),
        "output_feature_rows": len(output_rows),
        "window_days": WINDOW_DAYS,
        "stations": report_groups,
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Wrote {len(output_rows)} rows to {OUTPUT_PATH}")
    print(f"Wrote report to {REPORT_PATH}")


if __name__ == "__main__":
    main()
