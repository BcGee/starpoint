#!/usr/bin/env python3
"""
convert_active_mission.py — active_mission (스텝업 미션) CDN 마스터 → 서버 assets 변환

배경: converter.py 에 active_mission 핸들러가 없어서 assets/active_mission.json 이 없다.
그 결과 서버가 스텝업 미션을 클라에 못 준다. 이 스크립트가 추출본(scripts/in_extracted/
active_mission/*.json)을 서버가 쓰는 assets/active_mission.json 으로 변환한다.

입력 (scripts/in_extracted/active_mission/):
  active_mission.json        : { "<mission_id>": [event_id, order, category, pattern, desc, ...] }
  active_mission_event.json  : { "<event_id>": [key, name, ?, stage_count, ...start/end] }
  active_mission_reward.json : { "<mission_id>": { "<stage>": [reward_id, ?, bool, n, ..., k,amt,id] } }

출력 (assets/active_mission.json):
  {
    "events": { "<event_id>": { name, key, stageCount, startDate, endDate } },
    "missions": {
      "<mission_id>": {
        eventId, order, category, pattern, description, stage,
        rewards: [ { kind, id, amount } ... ]   # kind: item/equipment/stone/mana/pooled_exp/character/degree
      }
    }
  }

reward 컬럼 매핑 (데이터 전수 분석으로 확정):
  reward 행 슬롯: [7]=reward category, [8]=amount(개수), [9]=content id(빈값이면 없음)
    [7]=0 → 성도석(Stone), [9] 없음.  (예: 미션 완주 보상 300/600)
    [7]=3 → 성도석(Stone), [9] 없음.  (예: 큰 보상 2000~15000)
    [7]=5 → 성도석(Stone), [9] 없음.  (예: 500~8000)
    [7]=1 → 아이템/장비, [9]=content id, [8]=개수.
              content id 범위로 세분: id>=100000 → equipment, 그 외 → item.
  스텝업(event1) 44개 전수 검증: [7]∈{0,3,5} 13개 모두 [9] 빈값(성도석),
    [7]=1 31개 모두 [9] 값 있음(아이템/장비). 100% 일관.
  NOTE: 성도석은 서버 RewardType.BEADS(무료 성도석)로 지급. 아이템 id 실체(999003 등)는
        아이템 마스터 참조 필요하나 스텝업은 표시/수령 동작이 우선, blanc 무한재화라 부차적.
"""
import json, os, sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # starpoint/
IN = os.path.join(BASE, "scripts", "in_extracted", "active_mission")
OUT = os.path.join(BASE, "assets", "active_mission.json")


def load(name):
    p = os.path.join(IN, name)
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def none(v):
    return None if v in ("(None)", "", None) else v


# active_mission_reward 슬롯 kind 매핑 (blanc 인게임 증언 + 미션 설명으로 역산 확정).
# 슬롯 = [kind, amount, id] 3칸, [7]부터 반복. id는 kind가 item/equip일 때만 존재.
#   0 = 성도석(stone/beads)   — "미션 모두 클리어" 완주보상 300/600, id 없음
#   1 = 아이템/장비           — id 있음(101/100000/999005 등). id>=100000 → equipment, 그 외 item
#   3 = 마나(mana)            — "마나 보드"/"특별상품" 2000~15000, id 없음
#   5 = 캐릭터 경험치(pooled_exp) — "Lv강화 경험치"/"유니존 편성" 500~5000, id 없음
# ※ GeneralRewardKind enum(2=Stone,3=Mana,4=Exp,5=Char)과 다름 — 이 테이블 전용 kind.
#   blanc 확인: 성도석은 지급됨, 마나/경험치가 누락됐었음 → 3/5를 stone으로 잘못 보냈던 게 원인.
KIND_MAP = {
    "0": "stone",
    "3": "mana",
    "5": "pooled_exp",
    # 1은 아래에서 id 범위로 item/equipment 세분
}


def parse_rewards(reward_row):
    """reward 행에서 보상 슬롯 추출. 슬롯 = ([7]=kind, [8]=amount, [9]=id) 3칸 반복."""
    rewards = []
    i = 7
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
            # 아이템/장비: id 필수
            if content_id is None:
                i += 3
                continue
            cid = int(content_id) if str(content_id).isdigit() else content_id
            kind = "equipment" if (isinstance(cid, int) and cid >= 100000) else "item"
            rewards.append({"kind": kind, "id": cid, "amount": amt})
        elif k in KIND_MAP:
            # 재화형(성도석/마나/경험치): id 없음
            rewards.append({"kind": KIND_MAP[k], "amount": amt})
        elif content_id is not None:
            # 알 수 없는 kind인데 id 존재 → item 으로 처리 (안전 폴백)
            cid = int(content_id) if str(content_id).isdigit() else content_id
            rewards.append({"kind": "item", "id": cid, "amount": amt})
        i += 3
    return rewards


def main():
    am = load("active_mission.json")
    ev = load("active_mission_event.json")
    rw = load("active_mission_reward.json")

    events = {}
    for eid, r in ev.items():
        events[eid] = {
            "key": r[0],
            "name": r[1],
            "stageCount": int(r[3]) if none(r[3]) and str(r[3]).isdigit() else None,
            "startDate": none(r[14]) if len(r) > 14 else None,
            "endDate": none(r[15]) if len(r) > 15 else None,
        }

    missions = {}
    for mid, r in am.items():
        reward_stages = rw.get(mid, {})
        # 각 스테이지의 보상 (스텝업은 stage "1" 하나가 일반적)
        rewards_by_stage = {}
        for stage_key, reward_row in reward_stages.items():
            rewards_by_stage[stage_key] = parse_rewards(reward_row)
        missions[mid] = {
            "eventId": r[0],
            "order": int(r[1]) if none(r[1]) and str(r[1]).isdigit() else 0,
            "category": r[2],          # "입문편" / "초급편" ...
            "pattern": r[3],           # step_up_1_character_episode ...
            "description": r[4],
            "stage": int(r[1]) if none(r[1]) and str(r[1]).isdigit() else 1,
            "startDate": none(r[54]) if len(r) > 54 else None,
            "endDate": none(r[55]) if len(r) > 55 else None,
            "rewardsByStage": rewards_by_stage,
        }

    out = {"events": events, "missions": missions}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    # 요약
    by_event = {}
    for m in missions.values():
        by_event[m["eventId"]] = by_event.get(m["eventId"], 0) + 1
    print(f"[convert_active_mission] events={len(events)} missions={len(missions)}")
    print(f"  event별 미션수: {by_event}")
    print(f"  → {OUT}")
    # 샘플
    sample_id = "11010"
    if sample_id in missions:
        print(f"  샘플 {sample_id}: {json.dumps(missions[sample_id], ensure_ascii=False)}")


if __name__ == "__main__":
    main()
