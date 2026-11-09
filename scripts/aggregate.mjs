#!/usr/bin/env node
/**
 * Rift Scout — agregador de estadísticas con la API de Riot (League-V4 + Match-V5).
 *
 * Descarga partidas clasificatorias Solo/Duo del parche indicado, en los rangos indicados,
 * y genera data/stats.json con, por campeón y posición:
 *   partidas, victorias, bans, runas, objetos (inicio, núcleo en orden, botas),
 *   orden de habilidades, hechizos de invocador y enfrentamientos contra cada rival de línea.
 *
 * Uso:
 *   RIOT_API_KEY=RGAPI-xxxx node scripts/aggregate.mjs --platform euw1 --tiers CHALLENGER,GRANDMASTER,MASTER \
 *     --patch 16.22 --matches 3000 --timelines 1
 *
 * Opciones:
 *   --platform   euw1 | eun1 | kr | na1 | br1 | la1 | la2 | tr1 | ru | jp1 | oc1 | ...   (por defecto euw1)
 *   --tiers      CHALLENGER,GRANDMASTER,MASTER  (y/o DIAMOND,EMERALD con --divisions)
 *   --patch      parche "major.minor" que se acepta (por defecto: el último de Data Dragon)
 *   --matches    nº máximo de partidas a descargar (por defecto 2000)
 *   --timelines  1 = descarga también la línea de tiempo (orden de habilidades y de compra; dobla las peticiones)
 *   --out        ruta de salida (por defecto data/stats.json). Si existe, se SUMA a lo que ya hay del mismo parche.
 *
 * Límites: una clave de desarrollo admite 20 peticiones/s y 100 cada 2 min. El script los respeta y
 * reintenta con Retry-After en un 429. Con clave de desarrollo salen ~1.500 partidas/hora (sin timelines).
 * Para cifras como op.gg o u.gg (cientos de miles de partidas por parche) hace falta una clave de producción.
 */
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith("--")) a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "1"]);
  return a;
}, []));
const KEY = process.env.RIOT_API_KEY;
if (!KEY) { console.error("Falta RIOT_API_KEY en el entorno."); process.exit(1); }

const PLATFORM = (args.platform || "euw1").toLowerCase();
const REGION = { euw1: "europe", eun1: "europe", tr1: "europe", ru: "europe", me1: "europe",
  na1: "americas", br1: "americas", la1: "americas", la2: "americas",
  kr: "asia", jp1: "asia", oc1: "sea", sg2: "sea", tw2: "sea", vn2: "sea" }[PLATFORM];
const TIERS = (args.tiers || "CHALLENGER,GRANDMASTER,MASTER").split(",").map(s => s.trim().toUpperCase());
const MAX_MATCHES = +(args.matches || 2000);
const TIMELINES = args.timelines === "1";
const OUT = args.out || "data/stats.json";
const DIVISIONS = (args.divisions || "I,II").split(",");

/* ---------- rate limiter (20/1s y 100/120s por defecto; se ajusta con las cabeceras) ---------- */
const windows = [{ n: 20, ms: 1000, t: [] }, { n: 100, ms: 120000, t: [] }];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function slot() {
  for (;;) {
    const now = Date.now();
    let wait = 0;
    for (const w of windows) {
      w.t = w.t.filter(x => now - x < w.ms);
      if (w.t.length >= w.n) wait = Math.max(wait, w.ms - (now - w.t[0]) + 25);
    }
    if (!wait) { windows.forEach(w => w.t.push(now)); return; }
    await sleep(wait);
  }
}
function adoptLimits(h) {
  const lim = h.get("x-app-rate-limit"); // "20:1,100:120"
  if (!lim) return;
  const parsed = lim.split(",").map(p => p.split(":").map(Number));
  if (parsed.length === windows.length) parsed.forEach(([n, s], i) => { windows[i].n = n; windows[i].ms = s * 1000; });
}
let calls = 0;
async function riot(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    await slot();
    const r = await fetch(url, { headers: { "X-Riot-Token": KEY } });
    calls++; adoptLimits(r.headers);
    if (r.ok) return r.json();
    if (r.status === 429) { await sleep((+r.headers.get("retry-after") || 10) * 1000); continue; }
    if (r.status >= 500) { await sleep(2000 * (i + 1)); continue; }
    if (r.status === 404) return null;
    if (r.status === 401 || r.status === 403) throw new Error(`Clave rechazada (${r.status}). ¿Ha caducado la clave de desarrollo?`);
    throw new Error(`${r.status} ${url}`);
  }
  return null;
}

/* ---------- datos estáticos ---------- */
const versions = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json();
const PATCH = args.patch || versions[0].split(".").slice(0, 2).join(".");
const DD = versions.find(v => v.startsWith(PATCH + ".")) || versions[0];
const itemData = (await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${DD}/data/en_US/item.json`)).json()).data;
const isFinished = id => {
  const it = itemData[id]; if (!it) return false;
  if ((it.tags || []).includes("Consumable") || (it.tags || []).includes("Trinket")) return false;
  if ((it.tags || []).includes("Boots")) return false;
  return !(it.into || []).length && (it.gold?.total || 0) >= 2000;
};
const bootsSet = new Set(Object.keys(itemData).filter(id => (itemData[id].tags || []).includes("Boots") && (itemData[id].from || []).length && !(itemData[id].into || []).length));

/* ---------- jugadores ---------- */
async function playersFor(tier) {
  const q = "RANKED_SOLO_5x5", base = `https://${PLATFORM}.api.riotgames.com/lol/league/v4`;
  if (["CHALLENGER", "GRANDMASTER", "MASTER"].includes(tier)) {
    const lower = tier.toLowerCase();
    const r = await riot(`${base}/${lower}leagues/by-queue/${q}`);
    return (r?.entries || []).map(e => e.puuid).filter(Boolean);
  }
  const out = [];
  for (const d of DIVISIONS) {
    for (let page = 1; page <= 3; page++) {
      const r = await riot(`${base}/entries/${q}/${tier}/${d}?page=${page}`);
      if (!r?.length) break;
      out.push(...r.map(e => e.puuid).filter(Boolean));
    }
  }
  return out;
}

/* ---------- acumulador ---------- */
let store = { patch: PATCH, platform: PLATFORM, tiers: TIERS, matches: 0, seen: [], generated: null, champs: {} };
if (fs.existsSync(OUT)) {
  try { const prev = JSON.parse(fs.readFileSync(OUT, "utf8")); if (prev.patch === PATCH && prev.platform === PLATFORM) store = prev; } catch {}
}
const seen = new Set(store.seen || []);
const bump = (obj, key, win) => { const e = obj[key] || (obj[key] = [0, 0]); e[0]++; if (win) e[1]++; };
const POS = { TOP: "top", JUNGLE: "jungle", MIDDLE: "mid", BOTTOM: "adc", UTILITY: "support" };

function addMatch(m, tl) {
  const info = m.info;
  if (info.queueId !== 420 || !String(info.gameVersion).startsWith(PATCH + ".")) return false;
  if (info.gameDuration < 600) return false; // remakes
  const bans = new Set(info.teams.flatMap(t => t.bans.map(b => b.championId)));
  const byPos = {};
  info.participants.forEach(p => { (byPos[p.teamPosition] ||= {})[p.teamId] = p; });

  // timeline: orden de habilidades y compras por participante
  const skills = {}, buys = {};
  if (tl) for (const f of tl.info.frames) for (const e of f.events) {
    if (e.type === "SKILL_LEVEL_UP" && e.levelUpType === "NORMAL") (skills[e.participantId] ||= []).push("QWER"[e.skillSlot - 1]);
    if (e.type === "ITEM_PURCHASED") (buys[e.participantId] ||= []).push([e.timestamp, String(e.itemId)]);
    if (e.type === "ITEM_UNDO") { const b = buys[e.participantId]; if (b) { const i = b.map(x => x[1]).lastIndexOf(String(e.beforeId)); if (i >= 0) b.splice(i, 1); } }
  }

  for (const p of info.participants) {
    const role = POS[p.teamPosition]; if (!role) continue;
    const key = `${p.championName}|${role}`;
    const c = store.champs[key] ||= { g: 0, w: 0, runes: {}, keystone: {}, shards: {}, sums: {}, start: {}, core: {}, boots: {}, items: {}, skills: {}, vs: {} };
    const win = p.win;
    c.g++; if (win) c.w++;
    // runas
    const [pri, sec] = p.perks.styles;
    const perks = [...pri.selections.map(s => s.perk), ...sec.selections.map(s => s.perk)];
    bump(c.runes, `${pri.style}:${sec.style}:${perks.join(",")}`, win);
    bump(c.keystone, String(perks[0]), win);
    const sp = p.perks.statPerks; bump(c.shards, `${sp.offense},${sp.flex},${sp.defense}`, win);
    bump(c.sums, [p.summoner1Id, p.summoner2Id].sort((a, b) => a - b).join(","), win);
    // objetos
    const inv = [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5].map(String).filter(x => x !== "0");
    inv.filter(isFinished).forEach(id => bump(c.items, id, win));
    const boots = inv.find(id => bootsSet.has(id)); if (boots) bump(c.boots, boots, win);
    const order = buys[p.participantId];
    if (order) {
      const start = order.filter(([t]) => t < 60000).map(([, id]) => id).sort();
      if (start.length) bump(c.start, start.join(","), win);
      const core = []; for (const [, id] of order) if (isFinished(id) && !core.includes(id)) { core.push(id); if (core.length === 3) break; }
      if (core.length === 3) bump(c.core, core.join(","), win);
    } else {
      const fin = inv.filter(isFinished); if (fin.length >= 3) bump(c.core, fin.slice(0, 3).sort().join(","), win);
    }
    const sk = skills[p.participantId]; if (sk && sk.length >= 11) bump(c.skills, sk.slice(0, 15).join(""), win);
    // rival de línea
    const opp = byPos[p.teamPosition]?.[p.teamId === 100 ? 200 : 100];
    if (opp) bump(c.vs, opp.championName, win);
  }
  store.bans = store.bans || {};
  bans.forEach(id => { store.bans[id] = (store.bans[id] || 0) + 1; });
  return true;
}

/* ---------- bucle principal ---------- */
const t0 = Date.now();
const puuids = [];
for (const t of TIERS) { const p = await playersFor(t); console.log(`${t}: ${p.length} jugadores`); puuids.push(...p); }
// mezcla para no sesgar hacia la parte alta de la tabla
for (let i = puuids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [puuids[i], puuids[j]] = [puuids[j], puuids[i]]; }

let added = 0;
const save = () => {
  store.seen = [...seen].slice(-200000);
  store.generated = new Date().toISOString();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(store));
};
outer: for (const puuid of puuids) {
  const ids = await riot(`https://${REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&type=ranked&count=20`);
  for (const id of ids || []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const m = await riot(`https://${REGION}.api.riotgames.com/lol/match/v5/matches/${id}`);
    if (!m) continue;
    if (!String(m.info.gameVersion).startsWith(PATCH + ".")) break; // parche antiguo: las partidas siguientes de este jugador también lo serán
    const tl = TIMELINES ? await riot(`https://${REGION}.api.riotgames.com/lol/match/v5/matches/${id}/timeline`) : null;
    if (addMatch(m, tl)) { store.matches++; added++; }
    if (added % 50 === 0 && added) {
      save();
      const mins = (Date.now() - t0) / 60000;
      console.log(`${added} partidas nuevas · ${store.matches} en total · ${calls} peticiones · ${mins.toFixed(1)} min`);
    }
    if (added >= MAX_MATCHES) break outer;
  }
}
save();
console.log(`Listo: ${store.matches} partidas del parche ${PATCH} en ${OUT}`);
