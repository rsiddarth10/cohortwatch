"""Generates grafana/dashboards/cohortwatch.json (S9). Run: python make_dashboard.py"""

import json
from pathlib import Path

P = [
    ("Ingest rate (msgs/s)", "short", [
        ("sum(rate(cw_sim_messages_sent_total[1m]))", "sent by the simulator"),
        ("sum(rate(cw_norm_in_total[1m]))", "into the normaliser"),
        ("sum(rate(cw_norm_out_total[1m]))", "canonical out"),
    ]),
    ("Consumer lag (records)", "short", [
        ("sum(cw_norm_consumer_lag)", "normaliser"),
        ("sum(cw_state_consumer_lag)", "state processor"),
        ("sum(cw_camp_consumer_lag)", "campaign engine"),
    ]),
    ("Event → incident latency (s)", "s", [
        ("histogram_quantile(0.5, sum(rate(cw_state_incident_latency_seconds_bucket[5m])) by (le))", "p50"),
        ("histogram_quantile(0.95, sum(rate(cw_state_incident_latency_seconds_bucket[5m])) by (le))", "p95"),
    ]),
    ("Incidents (per 5 min)", "short", [
        ("sum(increase(cw_state_incidents_total[5m]))", "incident actions"),
        ("sum(increase(cw_state_global_rule_hits_total[5m]))", "global-threshold hits (shadow baseline)"),
    ]),
    ("Campaign events (per 5 min)", "short", [
        ("sum by (type) (increase(cw_camp_events_total[5m]))", "{{type}}"),
    ]),
    ("Queue update latency: incident written → depot queue committed (s)", "s", [
        ("histogram_quantile(0.5, sum(rate(cw_ws_queue_update_latency_seconds_bucket[5m])) by (le))", "p50"),
        ("histogram_quantile(0.95, sum(rate(cw_ws_queue_update_latency_seconds_bucket[5m])) by (le))", "p95"),
    ]),
    ("Hourly queue tick (s)", "s", [
        ("histogram_quantile(0.5, sum(rate(cw_ws_tick_seconds_bucket[10m])) by (le))", "p50"),
        ("histogram_quantile(0.95, sum(rate(cw_ws_tick_seconds_bucket[10m])) by (le))", "p95"),
    ]),
    ("API request latency (s)", "s", [
        ("histogram_quantile(0.5, sum(rate(cw_api_http_seconds_bucket[5m])) by (le))", "p50"),
        ("histogram_quantile(0.95, sum(rate(cw_api_http_seconds_bucket[5m])) by (le))", "p95"),
    ]),
]  # fmt: skip

panels = []
for i, (title, unit, targets) in enumerate(P):
    panels.append({
        "id": i + 1,
        "type": "timeseries",
        "title": title,
        "datasource": {"type": "prometheus", "uid": "prom"},
        "gridPos": {"h": 8, "w": 12, "x": (i % 2) * 12, "y": (i // 2) * 8},
        "fieldConfig": {"defaults": {"unit": unit, "custom": {"lineWidth": 2, "fillOpacity": 8}}, "overrides": []},
        "options": {"legend": {"displayMode": "list", "placement": "bottom"}, "tooltip": {"mode": "multi"}},
        "targets": [
            {"refId": chr(65 + j), "expr": e, "legendFormat": l, "datasource": {"type": "prometheus", "uid": "prom"}}
            for j, (e, l) in enumerate(targets)
        ],
    })  # fmt: skip

dash = {
    "uid": "cohortwatch",
    "title": "CohortWatch pipeline",
    "tags": ["cohortwatch"],
    "timezone": "browser",
    "refresh": "10s",
    "time": {"from": "now-30m", "to": "now"},
    "schemaVersion": 39,
    "panels": panels,
}
out = Path(__file__).parent / "grafana" / "dashboards" / "cohortwatch.json"
out.write_text(json.dumps(dash, indent=2) + "\n")
print(f"wrote {out} ({len(panels)} panels)")
