#!/usr/bin/env python3
"""Genera los datos estáticos y las hojas de sprites de Rift Scout.

Lee la carpeta raw/ (descargas de Data Dragon, Meraki y la API de LoL Esports)
y escribe en site/:
  data/static.json  campeones (posiciones, habilidades), objetos, runas, fragmentos, hechizos
  data/esports.json Worlds y últimas finales de cada liga
  img/*.webp        hojas de sprites (campeones, habilidades, objetos, runas, equipos)

Uso: python3 scripts/build_static.py RAW_DIR SITE_DIR
"""
import json, re, sys, glob, html, os
from PIL import Image

RAW, SITE = sys.argv[1], sys.argv[2]
os.makedirs(f"{SITE}/data", exist_ok=True); os.makedirs(f"{SITE}/img", exist_ok=True)
J = lambda f: json.load(open(f"{RAW}/{f}"))

def sheet(name, paths, size, cols=None, quality=82):
    """Pega imágenes en una rejilla. Devuelve dict ruta->índice y metadatos de la hoja."""
    cols = cols or min(len(paths), 24)
    rows = (len(paths) + cols - 1) // cols
    im = Image.new("RGBA", (cols * size, rows * size), (0, 0, 0, 0))
    idx = {}
    for i, p in enumerate(paths):
        try:
            t = Image.open(p).convert("RGBA")
            t.thumbnail((size, size), Image.LANCZOS)
            ox, oy = (size - t.width) // 2, (size - t.height) // 2
            im.paste(t, ((i % cols) * size + ox, (i // cols) * size + oy), t)
        except Exception as e:
            print("skip", p, e)
        idx[p] = i
    im.save(f"{SITE}/img/{name}.webp", "WEBP", quality=quality, method=6)
    return idx, {"file": f"img/{name}.webp", "size": size, "cols": cols, "rows": rows}

def clean(s, n=320):
    s = re.sub(r"<br\s*/?>", " ", s or "")
    s = html.unescape(re.sub(r"<[^>]+>", "", s))
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= n else s[:n].rsplit(" ", 1)[0] + "…"

ver = J("championFull.json")["version"]
champs = J("championFull.json")["data"]
meraki = J("meraki.json")
POS = {"TOP": "top", "JUNGLE": "jungle", "MIDDLE": "mid", "BOTTOM": "adc", "SUPPORT": "support"}

# ---- campeones y habilidades
order = sorted(champs, key=lambda k: champs[k]["name"])
cidx, csheet = sheet("champions", [f"{RAW}/img/champ/{k}.png" for k in order], 80, 16)
ab_paths = []
for k in order:
    ab_paths.append(f"{RAW}/img/passive/{k}.png")
    ab_paths += [f"{RAW}/img/spell/{k}_{s}.png" for s in "QWER"]
aidx, asheet = sheet("abilities", ab_paths, 48, 30)
out_champs = []
for k in order:
    c = champs[k]
    pos = [POS[p] for p in (meraki.get(k, {}).get("positions") or []) if p in POS]
    out_champs.append({
        "id": k, "key": int(c["key"]), "name": c["name"], "title": c["title"],
        "tags": c["tags"], "roles": pos,
        "s": cidx[f"{RAW}/img/champ/{k}.png"],
        "passive": {"name": c["passive"]["name"], "desc": clean(c["passive"]["description"]),
                    "s": aidx[f"{RAW}/img/passive/{k}.png"]},
        "spells": [{"k": "QWER"[i], "name": s["name"], "desc": clean(s["description"]),
                    "cd": s.get("cooldownBurn", ""), "s": aidx[f"{RAW}/img/spell/{k}_{'QWER'[i]}.png"]}
                   for i, s in enumerate(c["spells"])],
    })

# ---- objetos (Grieta del Invocador, comprables)
items = J("item.json")["data"]
keep = [i for i, v in items.items()
        if v.get("maps", {}).get("11") and (v.get("gold", {}).get("purchasable") or v.get("gold", {}).get("total", 0) > 0 or v.get("from"))
        and os.path.exists(f"{RAW}/img/item/{i}.png") and int(i) < 100000]
keep.sort(key=int)
iidx, isheet = sheet("items", [f"{RAW}/img/item/{i}.png" for i in keep], 48, 30)
out_items = {i: {"name": items[i]["name"], "gold": items[i]["gold"]["total"], "text": clean(items[i].get("plaintext", ""), 120),
                 "s": iidx[f"{RAW}/img/item/{i}.png"]} for i in keep}

# ---- runas + fragmentos
trees = J("runesReforged.json")
SH = [(5008, "Fuerza adaptativa", "StatModsAdaptiveForceIcon"), (5005, "Velocidad de ataque", "StatModsAttackSpeedIcon"),
      (5007, "Aceleración de habilidad", "StatModsCDRScalingIcon"), (5010, "Velocidad de movimiento", "StatModsMovementSpeedIcon"),
      (5001, "Vida escalable", "StatModsHealthScalingIcon"), (5011, "Vida", "StatModsHealthPlusIcon"),
      (5013, "Tenacidad y resistencia a ralentizaciones", "StatModsTenacityIcon")]
rpaths = [f"{RAW}/img/rune/{t['id']}.png" for t in trees]
for t in trees:
    for sl in t["slots"]:
        rpaths += [f"{RAW}/img/rune/{r['id']}.png" for r in sl["runes"]]
rpaths += [f"{RAW}/img/shard/{f}.png" for _, _, f in SH]
ridx, rsheet = sheet("runes", rpaths, 64, 16)
out_runes = [{"id": t["id"], "name": t["name"], "s": ridx[f"{RAW}/img/rune/{t['id']}.png"],
              "slots": [[{"id": r["id"], "name": r["name"], "desc": clean(r["shortDesc"], 200),
                          "s": ridx[f"{RAW}/img/rune/{r['id']}.png"]} for r in sl["runes"]] for sl in t["slots"]]}
             for t in trees]
out_shards = {str(i): {"name": n, "s": ridx[f"{RAW}/img/shard/{f}.png"]} for i, n, f in SH}

# ---- hechizos de invocador (Grieta)
sums = {v["key"]: v for v in J("summoner.json")["data"].values() if "CLASSIC" in v["modes"]}
sk = sorted(sums)
for k in sk:  # buscamos la imagen por id interno
    pass
spaths = [f"{RAW}/img/sum/{sums[k]['id']}.png" for k in sk]
sidx, ssheet = sheet("summoners", spaths, 48, len(spaths))
out_sums = {k: {"name": sums[k]["name"], "s": sidx[f"{RAW}/img/sum/{sums[k]['id']}.png"]} for k in sk}

json.dump({"version": ver, "sheets": {"champ": csheet, "ability": asheet, "item": isheet, "rune": rsheet, "sum": ssheet},
           "champions": out_champs, "items": out_items, "runes": out_runes, "shards": out_shards, "summoners": out_sums},
          open(f"{SITE}/data/static.json", "w"), ensure_ascii=False, separators=(",", ":"))

# ---- esports
tpaths = sorted(glob.glob(f"{RAW}/img/team/*.png"))
tidx, tsheet = sheet("teams", tpaths, 72, 12)
logo = lambda code: tidx.get(f"{RAW}/img/team/{code}.png")
def ev_out(e):
    m = e["match"]
    return {"t": e["startTime"], "state": e["state"], "block": e.get("blockName"), "bo": m.get("strategy", {}).get("count"),
            "teams": [{"code": t["code"], "name": t["name"], "wins": (t.get("result") or {}).get("gameWins"),
                       "out": (t.get("result") or {}).get("outcome"), "s": logo(t["code"])} for t in m["teams"]]}
wev = []
for f in ["worlds_sched2.json", "worlds_sched.json"]:
    wev += [e for e in J(f)["data"]["schedule"]["events"] if e["type"] == "match" and e["startTime"] >= "2026-10-01"]
leagues = {l["id"]: l for l in J("leagues.json")["data"]["leagues"]}
others = []
for f in sorted(glob.glob(f"{RAW}/lg_*.json")):
    lid = f.split("_")[-1][:-5]
    ev = [e for e in json.load(open(f))["data"]["schedule"]["events"] if e["type"] == "match" and e["state"] == "completed"]
    if not ev: continue
    l = leagues[lid]
    others.append({"league": l["name"], "region": l["region"], "s": logo("LG_" + l["slug"]), **ev_out(ev[-1])})
others.sort(key=lambda o: o["t"], reverse=True)
json.dump({"updated": max(e["startTime"] for e in wev if e["state"] == "completed"), "sheet": tsheet,
           "worlds": {"name": "Worlds 2026", "s": logo("LG_worlds"), "events": [ev_out(e) for e in wev]}, "others": others},
          open(f"{SITE}/data/esports.json", "w"), ensure_ascii=False, separators=(",", ":"))
print("ok", ver, len(out_champs), "campeones,", len(out_items), "objetos")
