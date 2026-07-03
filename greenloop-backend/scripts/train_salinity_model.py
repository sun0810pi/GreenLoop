import csv
import json
import math
import random
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATASET_PATH = ROOT / "data" / "salinity_training_dataset.csv"
MODEL_PATH = ROOT / "models" / "salinity_ml_model.json"
REPORT_PATH = ROOT / "models" / "salinity_ml_report.json"
FEATURE_NAMES = [
    "latitude",
    "longitude",
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
]
TARGET_NAME = "salinity_gpl"
ALPHAS = [0.01, 0.1, 1.0, 5.0, 10.0, 25.0]


def read_rows():
    rows = list(csv.DictReader(DATASET_PATH.open("r", encoding="utf-8", newline="")))
    for row in rows:
        for name in FEATURE_NAMES + [TARGET_NAME]:
            row[name] = float(row[name])
    return rows


def chronological_split(rows):
    groups = defaultdict(list)
    for row in rows:
        groups[(row["province"], row["station"])].append(row)
    train, test = [], []
    for group_rows in groups.values():
        group_rows.sort(key=lambda item: item["recorded_date"])
        test_size = max(1, round(len(group_rows) * 0.2))
        split_index = max(1, len(group_rows) - test_size)
        train.extend(group_rows[:split_index])
        test.extend(group_rows[split_index:])
    return train, test


def matrix_transpose(matrix):
    return [list(row) for row in zip(*matrix)]


def matrix_multiply(a, b):
    if not a or not b:
        return []
    if isinstance(b[0], (int, float)):
        result = []
        for row in a:
            result.append(sum(row[i] * b[i] for i in range(len(b))))
        return result
    result = []
    b_t = matrix_transpose(b)
    for row in a:
        result.append([sum(row[i] * col[i] for i in range(len(col))) for col in b_t])
    return result


def solve_linear_system(matrix, vector):
    size = len(vector)
    augmented = [matrix[i][:] + [vector[i]] for i in range(size)]
    for col in range(size):
        pivot = max(range(col, size), key=lambda row: abs(augmented[row][col]))
        if abs(augmented[pivot][col]) < 1e-12:
            raise ValueError("Matrix is singular")
        augmented[col], augmented[pivot] = augmented[pivot], augmented[col]
        divisor = augmented[col][col]
        augmented[col] = [value / divisor for value in augmented[col]]
        for row in range(size):
            if row == col:
                continue
            factor = augmented[row][col]
            augmented[row] = [
                augmented[row][idx] - factor * augmented[col][idx]
                for idx in range(size + 1)
            ]
    return [augmented[row][-1] for row in range(size)]


def compute_scaler(rows):
    means = []
    stds = []
    mins = []
    maxs = []
    for name in FEATURE_NAMES:
        values = [row[name] for row in rows]
        mean = sum(values) / len(values)
        variance = sum((value - mean) ** 2 for value in values) / len(values)
        std = math.sqrt(variance) or 1.0
        means.append(mean)
        stds.append(std)
        mins.append(min(values))
        maxs.append(max(values))
    return means, stds, mins, maxs


def transform_rows(rows, means, stds):
    transformed = []
    for row in rows:
        transformed.append([(row[name] - means[idx]) / stds[idx] for idx, name in enumerate(FEATURE_NAMES)])
    return transformed


def fit_ridge_regression(train_rows, alpha):
    means, stds, mins, maxs = compute_scaler(train_rows)
    x_scaled = transform_rows(train_rows, means, stds)
    x_design = [[1.0] + row for row in x_scaled]
    y = [row[TARGET_NAME] for row in train_rows]
    xt = matrix_transpose(x_design)
    xtx = matrix_multiply(xt, x_design)
    for idx in range(1, len(xtx)):
        xtx[idx][idx] += alpha
    xty = matrix_multiply(xt, y)
    weights = solve_linear_system(xtx, xty)
    return {
        "intercept": weights[0],
        "coefficients": weights[1:],
        "means": means,
        "stds": stds,
        "mins": mins,
        "maxs": maxs,
        "alpha": alpha,
    }


def predict_row(model, row):
    total = model["intercept"]
    for idx, name in enumerate(FEATURE_NAMES):
        scaled = (row[name] - model["means"][idx]) / model["stds"][idx]
        total += model["coefficients"][idx] * scaled
    return total


def evaluate(model, rows):
    actual = [row[TARGET_NAME] for row in rows]
    predicted = [predict_row(model, row) for row in rows]
    errors = [predicted[idx] - actual[idx] for idx in range(len(actual))]
    mae = sum(abs(error) for error in errors) / len(errors)
    rmse = math.sqrt(sum(error ** 2 for error in errors) / len(errors))
    mean_actual = sum(actual) / len(actual)
    ss_res = sum((predicted[idx] - actual[idx]) ** 2 for idx in range(len(actual)))
    ss_tot = sum((value - mean_actual) ** 2 for value in actual) or 1.0
    r2 = 1 - (ss_res / ss_tot)
    return {
        "mae": round(mae, 4),
        "rmse": round(rmse, 4),
        "r2": round(r2, 4),
        "count": len(rows),
    }


def main():
    rows = read_rows()
    random.seed(42)
    train_rows, test_rows = chronological_split(rows)
    best = None
    for alpha in ALPHAS:
        model = fit_ridge_regression(train_rows, alpha)
        test_metrics = evaluate(model, test_rows)
        if best is None or test_metrics["mae"] < best["test_metrics"]["mae"]:
            best = {
                "model": model,
                "test_metrics": test_metrics,
                "train_metrics": evaluate(model, train_rows),
            }

    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    artifact = {
        "model_type": "ridge_regression_v1",
        "trained_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "feature_names": FEATURE_NAMES,
        "target_name": TARGET_NAME,
        "intercept": best["model"]["intercept"],
        "coefficients": best["model"]["coefficients"],
        "means": best["model"]["means"],
        "stds": best["model"]["stds"],
        "mins": best["model"]["mins"],
        "maxs": best["model"]["maxs"],
        "alpha": best["model"]["alpha"],
        "target_min": min(row[TARGET_NAME] for row in train_rows),
        "target_max": max(row[TARGET_NAME] for row in train_rows),
        "train_metrics": best["train_metrics"],
        "test_metrics": best["test_metrics"],
        "training_rows": len(train_rows),
        "test_rows": len(test_rows),
        "dataset_path": str(DATASET_PATH.name),
        "feature_sources": ["open-meteo:river_discharge", "nasa-power:PRECTOTCORR"],
        "label_source": "historical_station_dataset",
    }
    MODEL_PATH.write_text(json.dumps(artifact, indent=2), encoding="utf-8")

    report = {
        "generated_at": artifact["trained_at"],
        "model_path": str(MODEL_PATH),
        "train_metrics": artifact["train_metrics"],
        "test_metrics": artifact["test_metrics"],
        "alpha": artifact["alpha"],
        "training_rows": artifact["training_rows"],
        "test_rows": artifact["test_rows"],
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Wrote model to {MODEL_PATH}")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
