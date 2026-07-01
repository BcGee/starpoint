#!/usr/bin/env python3
# Standalone mission converter for World Flipper starpoint.
#
# Produces assets/mission.json in a server-friendly shape from the extracted
# master tables (scripts/in/mission/*.json). Kept SEPARATE from converter.py so
# it can be run/verified independently without touching the fragile quest
# converters (whose field indices don't match this 2024-07 CDN snapshot).
#
# Output shape (mission.json):
# {
#   "1":  { "category": 1, "pattern": "max_combo", "target": 28,
#            "desc": "...", "startDate": null, "endDate": null,
#            "rewardId": <id or null> },   # category 1 = regular (always-on)
#   "6":  { "category": 2, ... "startDate": "...", "endDate": "..." }, # daily
#   ...
# }
# category: 1 = regular (상시), 2 = daily (데일리), 3 = event (이벤트)
#
# The server (get_mission_progress) can then filter by server time window and
# return {mission_category, mission_id, progress_value, stage} tuples the client
# expects. Progress values come from the client via update_mission_progress
# (WF computes progress client-side and pushes it), stored per-player in DB.

import json
import os

ROOT = os.path.dirname(os.path.realpath(__file__))
IN = os.path.join(ROOT, "in", "mission")
OUT = os.path.join(ROOT, "out")
os.makedirs(OUT, exist_ok=True)


def load(name):
    p = os.path.join(IN, name)
    if not os.path.exists(p):
        print(f"  WARN: {name} not found")
        return {}
    return json.load(open(p, encoding="utf8"))


def none(v):
    return None if v in ("(None)", "", None) else v


def convert_mission_table(obj, category):
    """Each mission row: [0]=pattern [1]=desc [2]=target ... [19]=start [20]=end.
    regular_mission has 31 fields (start/end = None → always-on); daily/event
    have 28 fields with real date windows at [19][20]."""
    out = {}
    for mid, row in obj.items():
        if not isinstance(row, list) or len(row) < 21:
            continue
        out[mid] = {
            "category": category,
            "pattern": row[0],
            "desc": row[1],
            "target": int(row[2]) if str(row[2]).isdigit() else 0,
            "startDate": none(row[19]),
            "endDate": none(row[20]),
        }
    return out


def main():
    merged = {}
    # category 1 = regular (always-on), 2 = daily, 3 = event
    for name, cat in [("regular_mission.json", 1),
                      ("daily_mission.json", 2),
                      ("event_mission.json", 3)]:
        table = convert_mission_table(load(name), cat)
        # namespace collision guard: mission ids can overlap across categories,
        # so store each category under its own sub-key.
        merged.setdefault(str(cat), {}).update(table)
        print(f"  {name}: {len(table)} missions (category {cat})")

    out_path = os.path.join(OUT, "mission.json")
    json.dump(merged, open(out_path, "w", encoding="utf8"), indent=2, ensure_ascii=False)
    total = sum(len(v) for v in merged.values())
    print(f"wrote {out_path}: {total} missions across {len(merged)} categories")


if __name__ == "__main__":
    main()
