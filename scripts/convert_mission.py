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


def convert_collect_item_event_missions(obj):
    """collect_item_event_mission rows are the CAMPAIGN/EVENT missions the client
    opens by event_id (e.g. srm21_3_campaign_mission = event 10010). The client
    requests get_mission_progress with {category:4, event_id:X} and expects ONLY
    that event's missions. Row layout (confirmed 2024-07 snapshot + live [BATTLE/stats]):
      [0]=event_id [1]=stage [2]=pattern [3]=desc [4]=target
      [5]=subCondition (battle-stat counter kind when [8] is None):
          0=weak_point_attack 1=power_flip 2=dash 4=skill 5=fever 7=enemy_kill
      [8]=questKind (required content type):
          2/5/10=협력(멀티, 싱글서버엔 없음) 7=붕괴역 12=흔들리는미궁(server category 14)
          (None)=아무 배틀 (then [5] decides which battle stat to count)
      [9]=questKind target id (specific boss/event; unused for 미궁)
      [21]=startDate [22]=endDate
    Grouped by event_id so mission.ts can serve exactly the requested event."""
    by_event = {}
    for mid, row in obj.items():
        if not isinstance(row, list) or len(row) < 23:
            continue
        event_id = str(row[0])
        if event_id in ("(None)", "", None):
            continue

        def _int_or_none(v):
            s = str(v)
            return int(s) if s.lstrip("-").isdigit() else None

        by_event.setdefault(event_id, {})[mid] = {
            "category": 4,
            "eventId": int(event_id) if event_id.isdigit() else event_id,
            "stage": int(row[1]) if str(row[1]).isdigit() else 1,
            "pattern": row[2],
            "desc": row[3],
            "target": int(row[4]) if str(row[4]).isdigit() else 0,
            # battle-mission classification (server-side accumulation):
            "subCondition": _int_or_none(row[5]),   # [5] battle-stat counter kind (when questKind is None)
            "questKind": _int_or_none(row[8]),       # [8] required content type (12=미궁 etc.)
            "questKindTarget": _int_or_none(row[9]), # [9] specific boss/event id
            "startDate": none(row[21]),
            "endDate": none(row[22]),
        }
    return by_event


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

    # Event/campaign missions the client opens by event_id (category 4).
    # Stored under a dedicated "eventMissions" key: { "<event_id>": { "<mid>": {...} } }
    event_missions = convert_collect_item_event_missions(load("collect_item_event_mission.json"))
    merged["eventMissions"] = event_missions
    total_event = sum(len(v) for v in event_missions.values())
    print(f"  collect_item_event_mission.json: {total_event} missions across {len(event_missions)} events (category 4)")

    out_path = os.path.join(OUT, "mission.json")
    json.dump(merged, open(out_path, "w", encoding="utf8"), indent=2, ensure_ascii=False)
    total = sum(len(v) for v in merged.values() if isinstance(v, dict) and "eventMissions" not in str(type(v)))
    print(f"wrote {out_path}: regular/daily/event + {len(event_missions)} event-mission groups")


if __name__ == "__main__":
    main()
