"""Train the at-risk classifier on one run and test it on a run with a DIFFERENT seed (S9).

The question per van per hour: "will this van have a real fault incident in the next 24 h?"
Model: scikit-learn HistGradientBoostingClassifier (gradient boosting). It is compared with:
  - rule at-risk: the S5 flag (same model, duty and depot as an open campaign and deviating), as deployed;
  - global threshold: the van has crossed the fixed global limit (coolant > 97 °C / battery > 47 °C);
  - one-signal score: the van's current peer-adjusted coolant z (what a single-signal ranking would do).

Metrics on the test run: PR-AUC (average precision), precision@k per hour (top k vans each hour, averaged over
hours that have at least one positive van), and false positives among heatwave-region and naturally-hot vans at
the operating point where the model flags as many van-hours as the rule does (a like-for-like comparison).

Usage: python train.py <train.csv.gz> <test.csv.gz> <out_dir> [full|signals]
  full    = all detection-visible features, incl. model powertrain, duty and climate zone
  signals = the van's own signals and its peers' incidents only (no categorical context): the plants sit in the same
            cohorts under every seed, so categorical features can learn "which cohort breaks" instead of the signal
"""

import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import average_precision_score, precision_score, recall_score

NUMERIC = [
    "coolant_dev", "coolant_z", "coolant_zs", "batt_dev", "batt_z", "batt_zs", "lv_dev", "lv_zs",
    "dtc_count", "harsh_count", "ambient_c", "readings",
    "coolant_zs_3h", "coolant_zs_max6h", "coolant_dev_delta6h", "batt_zs_3h", "batt_zs_max6h", "batt_dev_delta6h",
    "lv_zs_3h", "dtc_24h", "dtc_6h", "harsh_24h", "cohort_incidents_24h",
]  # fmt: skip
BOOLEAN = ["cohort_campaign_open", "own_incident_open"]
CATEGORICAL = ["powertrain", "climate_zone", "duty_type_id"]
# never features: rule_at_risk, rule_global, gt_role, gt_fault, gt_event_ts, label, vin, ts, model_id (an id that
# would let the model memorise the training run's planted model instead of learning the signal)


def load(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, compression="gzip", low_memory=False)
    if "rule_queue_at_risk" not in df.columns:
        df["rule_queue_at_risk"] = False
    for b in BOOLEAN + ["rule_at_risk", "rule_queue_at_risk", "rule_global", "gt_fault"]:
        df[b] = df[b].astype(str).str.lower().isin(["true", "t", "1"])
    return df


VARIANT = sys.argv[4] if len(sys.argv) > 4 else "full"
if VARIANT == "signals":
    CATEGORICAL = []
    NUMERIC = [c for c in NUMERIC if c != "ambient_c"]


def features(df: pd.DataFrame, categories: dict[str, list] | None = None) -> tuple[pd.DataFrame, dict[str, list]]:
    x = df[NUMERIC].astype(float).copy()
    for b in BOOLEAN:
        x[b] = df[b].astype(float)
    cats = categories or {c: sorted(df[c].astype(str).unique().tolist()) for c in CATEGORICAL}
    for c in CATEGORICAL:
        x[c] = pd.Categorical(df[c].astype(str), categories=cats[c]).codes.astype(float)
    return x, cats


def precision_at_k(df: pd.DataFrame, score: np.ndarray, k: int) -> float:
    """Top-k vans each hour by score; mean precision over hours with at least one positive van."""
    d = pd.DataFrame({"ts": df["ts"].values, "y": df["label"].values, "s": score})
    d = d[d.groupby("ts")["y"].transform("max") > 0]
    top = d.sort_values(["ts", "s"], ascending=[True, False]).groupby("ts").head(k)
    return float(top.groupby("ts")["y"].mean().mean()) if len(top) else float("nan")


def fp_groups(df: pd.DataFrame, flagged: np.ndarray) -> dict[str, dict[str, int]]:
    out = {}
    for role in ["heatwave_region", "naturally_hot", "background"]:
        m = (df["gt_role"] == role).values
        out[role] = {
            "van_hours_flagged": int((flagged & m).sum()),
            "vans_flagged": int(df.loc[flagged & m, "vin"].nunique()),
            "vans": int(df.loc[m, "vin"].nunique()),
        }
    return out


def binary_report(df: pd.DataFrame, flagged: np.ndarray) -> dict:
    y = df["label"].values
    return {
        "flagged_van_hours": int(flagged.sum()),
        "precision": float(precision_score(y, flagged, zero_division=0)),
        "recall": float(recall_score(y, flagged, zero_division=0)),
        "fault_vans_caught_before_incident": int(df.loc[flagged & (y == 1), "vin"].nunique()),
        "false_positives": fp_groups(df, flagged & (y == 0)),
    }


def main() -> None:
    train_path, test_path, out_dir = sys.argv[1], sys.argv[2], Path(sys.argv[3])
    out_dir.mkdir(parents=True, exist_ok=True)
    started = time.time()
    tr, te = load(train_path), load(test_path)
    xtr, cats = features(tr)
    xte, _ = features(te, cats)
    ytr, yte = tr["label"].values, te["label"].values
    cat_mask = [c in CATEGORICAL for c in xtr.columns]
    pos = ytr.mean()
    model = HistGradientBoostingClassifier(
        max_iter=300, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=40, l2_regularization=1.0,
        categorical_features=cat_mask, class_weight={0: 1.0, 1: float(min(50.0, 0.1 / max(pos, 1e-6)))},
        early_stopping=True, validation_fraction=0.15, random_state=7,
    )  # fmt: skip
    model.fit(xtr, ytr)
    p = model.predict_proba(xte)[:, 1]

    rule = te["rule_at_risk"].values
    qrule = te["rule_queue_at_risk"].values
    glob = te["rule_global"].values
    zs = te["coolant_zs"].fillna(-99).astype(float).values
    n_rule = int(rule.sum())
    # like-for-like operating point: flag as many van-hours as the rule does (or 0.5 if the rule flags nothing)
    thr = float(np.sort(p)[::-1][n_rule - 1]) if n_rule > 0 else 0.5
    ml_flag = p >= thr
    n_q = int(qrule.sum())
    thr_q = float(np.sort(p)[::-1][n_q - 1]) if n_q > 0 else 0.5

    fault_vans = te.loc[te["gt_fault"], "vin"].nunique()
    result = {
        "train": {"file": train_path, "van_hours": len(tr), "vans": int(tr["vin"].nunique()), "positives": int(ytr.sum()),
                  "positive_vans": int(tr.loc[ytr == 1, "vin"].nunique())},
        "test": {"file": test_path, "van_hours": len(te), "vans": int(te["vin"].nunique()), "positives": int(yte.sum()),
                 "positive_vans": int(te.loc[yte == 1, "vin"].nunique()), "fault_vans": int(fault_vans)},
        "pr_auc": {
            "model": float(average_precision_score(yte, p)),
            "rule_at_risk": float(average_precision_score(yte, rule.astype(float))),
            "rule_queue_at_risk": float(average_precision_score(yte, qrule.astype(float))),
            "global_threshold": float(average_precision_score(yte, glob.astype(float))),
            "coolant_zs_score": float(average_precision_score(yte, zs)),
            "base_rate": float(yte.mean()),
        },
        "precision_at_k": {
            str(k): {
                "model": precision_at_k(te, p, k),
                "rule_at_risk": precision_at_k(te, rule.astype(float) + 1e-9 * zs, k),
                "rule_queue_at_risk": precision_at_k(te, qrule.astype(float) + 1e-9 * zs, k),
                "global_threshold": precision_at_k(te, glob.astype(float) + 1e-9 * zs, k),
                "coolant_zs_score": precision_at_k(te, zs, k),
            }
            for k in (5, 10, 25)
        },
        "operating_point": {
            "threshold": thr,
            "model": binary_report(te, ml_flag),
            "rule_at_risk": binary_report(te, rule),
            "rule_queue_at_risk": binary_report(te, qrule),
            "model_at_queue_rule_volume": binary_report(te, p >= thr_q),
            "global_threshold": binary_report(te, glob),
        },
        "feature_importance_note": "HistGradientBoosting has no built-in importances; see permutation_importance",
        "variant": VARIANT,
        "features": list(xtr.columns),
        "seconds": round(time.time() - started, 1),
    }
    # permutation importance on a sample of the test run (top features, for the model card)
    from sklearn.inspection import permutation_importance

    sample = te.sample(n=min(len(te), 60_000), random_state=1).index
    pi = permutation_importance(model, xte.loc[sample], yte[te.index.get_indexer(sample)], scoring="average_precision",
                                n_repeats=3, random_state=1)  # fmt: skip
    order = np.argsort(pi.importances_mean)[::-1][:10]
    result["top_features"] = [[xte.columns[i], round(float(pi.importances_mean[i]), 4)] for i in order]
    (out_dir / f"metrics-{VARIANT}.json").write_text(json.dumps(result, indent=2))
    print(json.dumps({k: result[k] for k in ["train", "test", "pr_auc", "precision_at_k"]}, indent=2))
    print(json.dumps(result["operating_point"], indent=2))
    print("top features:", result["top_features"])


if __name__ == "__main__":
    main()
