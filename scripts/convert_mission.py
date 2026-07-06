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


# collect_item_event_mission_reward 슬롯 kind 매핑 (active_mission_reward 와 동일 계열).
# 이 테이블은 행 앞에 [0]=reward_id 가 있어 슬롯이 [6]부터 시작 (active_mission 은 [7]부터).
# 슬롯 = [kind, amount, id] 3칸 반복. id 는 kind=1(item/equip)일 때만.
#   0=성도석(stone/beads)  1=item/equip(id>=100000→equipment)  3=마나(mana)  5=경험치(pooled_exp)
#   2,4 = 희소 특수재화(스타크럼/티켓 추정, amount=1) — 잘못 지급 위험 있어 미지급+로그.
REWARD_KIND_MAP = {"0": "stone", "3": "mana", "5": "pooled_exp"}


def parse_mission_rewards(reward_row):
    """collect_item_event_mission_reward 행에서 보상 슬롯 추출 (슬롯 [6]=kind,[7]=amt,[8]=id 부터 3칸 반복)."""
    rewards = []
    i = 6
    while i + 2 < len(reward_row):
        kind_raw = none(reward_row[i])
        amount = none(reward_row[i + 1])
        content_id = none(reward_row[i + 2])
        if kind_raw is None and amount is None:
            i += 3
            continue
        amt = int(amount) if amount and str(amount).isdigit() else 1
        k = str(kind_raw) if kind_raw is not None else ""
        if k == "1":
            if content_id is None:
                i += 3
                continue
            cid = int(content_id) if str(content_id).isdigit() else content_id
            kind = "equipment" if (isinstance(cid, int) and cid >= 100000) else "item"
            rewards.append({"kind": kind, "id": cid, "amount": amt})
        elif k in REWARD_KIND_MAP:
            rewards.append({"kind": REWARD_KIND_MAP[k], "amount": amt})
        else:
            # unknown kind (2/4 등) — 지급하지 않고 원본 kind 기록 (오지급 방지)
            rewards.append({"kind": "unknown", "rawKind": k, "amount": amt})
        i += 3
    return rewards


def convert_mission_reward_table(obj):
    """{ "<mission_id>": { "<stage>": [reward_row] } } → { "<mission_id>": { "<stage>": [rewards] } }"""
    out = {}
    for mid, stages in obj.items():
        if not isinstance(stages, dict):
            continue
        stage_map = {}
        for stage, row in stages.items():
            if isinstance(row, list):
                stage_map[stage] = parse_mission_rewards(row)
        if stage_map:
            out[mid] = stage_map
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

    # Event/campaign missions the client opens by event_id (category 4).
    # Stored under a dedicated "eventMissions" key: { "<event_id>": { "<mid>": {...} } }
    event_missions = convert_collect_item_event_missions(load("collect_item_event_mission.json"))
    merged["eventMissions"] = event_missions
    total_event = sum(len(v) for v in event_missions.values())
    print(f"  collect_item_event_mission.json: {total_event} missions across {len(event_missions)} events (category 4)")

    # Event mission rewards, keyed by mission_id → { stage → [rewards] }. Granted on completion.
    event_rewards = convert_mission_reward_table(load("collect_item_event_mission_reward.json"))
    merged["eventMissionRewards"] = event_rewards
    print(f"  collect_item_event_mission_reward.json: {len(event_rewards)} mission rewards")

    out_path = os.path.join(OUT, "mission.json")
    json.dump(merged, open(out_path, "w", encoding="utf8"), indent=2, ensure_ascii=False)
    total = sum(len(v) for v in merged.values() if isinstance(v, dict) and "eventMissions" not in str(type(v)))
    print(f"wrote {out_path}: regular/daily/event + {len(event_missions)} event-mission groups")


if __name__ == "__main__":
    main()
