#!/usr/bin/env python3
# Standalone item master converter for starpoint (item/sell, item/use_item).
#
# Produces assets/item.json with the fields the server needs for selling & using items.
# Column layout confirmed against live values (scripts/in/item/item.json):
#   [0]=pattern [1]=name [5]=useKind(2=stamina potion, 0=non-usable material)
#   [6]=useValue(stamina recovered: 1/25/50/100) [12]=itemKind [14]=salePrice
#   [15]=rarity [16]=maxStack
#
# Output shape (assets/item.json):
#   { "<item_id>": { "pattern", "salePrice", "useKind", "useValue", "rarity", "maxStack" } }
# salePrice = mana granted per unit sold (WF item sale currency is mana).

import json
import os

ROOT = os.path.dirname(os.path.realpath(__file__))
IN = os.path.join(ROOT, "in", "item", "item.json")
OUT = os.path.join(ROOT, "out")
os.makedirs(OUT, exist_ok=True)


def to_int(v, default=0):
    s = str(v)
    return int(s) if s.lstrip("-").isdigit() else default


def main():
    src = json.load(open(IN, encoding="utf8"))
    out = {}
    for item_id, row in src.items():
        if not isinstance(row, list) or len(row) < 17:
            continue
        out[item_id] = {
            "pattern": row[0],
            "salePrice": to_int(row[14], 0),   # mana per unit
            "useKind": to_int(row[5], 0),      # 2 = stamina potion
            "useValue": to_int(row[6], 0),     # stamina recovered per use
            "rarity": to_int(row[15], 0),
            "maxStack": to_int(row[16], 9999),
        }
    out_path = os.path.join(OUT, "item.json")
    json.dump(out, open(out_path, "w", encoding="utf8"), indent=2, ensure_ascii=False)
    print(f"wrote {out_path}: {len(out)} items")


if __name__ == "__main__":
    main()
