#!/usr/bin/env node
/**
 * Convierte el acumulado bruto (data/stats.json) en lo que lee la web (data/builds.json):
 * por campeón y posición, winrate, pick rate, ban rate, tier y la mejor opción de runas,
 * hechizos, objetos y habilidades ("muy jugada y con más winrate"), más los enfrentamientos.
 *
 * Uso: node scripts/summarize.mjs [--in data/stats.json] [--out data/builds.json] [--min 20]
 */
import fs from "node:fs";

const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf("--" + k); return i >= 0 ? a[i + 1] : d; };
const IN = opt("in", "data/stats.json"), OUT = opt("out", "data/builds.json"), MIN = +opt("min", 20);
const raw = JSON.parse(fs.readFileSync(IN, "utf8"));
const champKeys = await (async () => {
  const v = (await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json())[0];
  const d = (await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${v}/data/en_US/champion.json`)).json()).data;
  return { key: Object.fromEntries(Object.values(d).map(c => [c.id, +c.key])),
    id: Object.fromEntries(Object.values(d).map(c => [c.id.toLowerCase(), c.id])),
    trinkets: new Set(Object.entries((await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${v}/data/en_US/item.json`)).json()).data)
      .filter(([, it]) => (it.tags || []).includes("Trinket")).map(([id]) => id)) };
})();
// la API usa a veces otra capitalización (FiddleSticks) que Data Dragon (Fiddlesticks)
const ddId = n => champKeys.id[n.toLowerCase()] || n;

// cota inferior de Wilson al 90 %: premia el winrate alto sin fiarse de muestras pequeñas
const wilson = (w, n, z = 1.645) => {
  if (!n) return 0; const p = w / n;
  return (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n);
};
/** Entre las opciones con al menos el 10 % de las partidas del campeón (o MIN), la de mejor Wilson. */
function best(map, total) {
  const rows = Object.entries(map).map(([k, [g, w]]) => ({ k, g, w }));
  if (!rows.length) return null;
  const floor = Math.max(3, Math.min(MIN, total * 0.1));
  const pool = rows.filter(r => r.g >= floor);
  // sin opciones con muestra suficiente: la más jugada (no la de winrate más alto, que sería ruido)
  const pick = pool.length ? pool.sort((x, y) => wilson(y.w, y.g) - wilson(x.w, x.g) || y.g - x.g)[0]
                           : rows.sort((x, y) => y.g - x.g || y.w - x.w)[0];
  return { k: pick.k, g: pick.g, wr: +(pick.w / pick.g * 100).toFixed(1), share: +(pick.g / total * 100).toFixed(1) };
}
function maxOrder(seq) {
  const pts = { Q: 0, W: 0, E: 0 }, done = [];
  for (const s of seq) if (s in pts && ++pts[s] === 5) done.push(s);
  const rest = Object.keys(pts).filter(k => !done.includes(k)).sort((x, y) => pts[y] - pts[x]);
  return [...done, ...rest].join("");
}

const roleGames = {};
for (const [key, c] of Object.entries(raw.champs)) { const r = key.split("|")[1]; roleGames[r] = (roleGames[r] || 0) + c.g; }
const out = { patch: raw.patch, platform: raw.platform, tiers: raw.tiers, matches: raw.matches, generated: raw.generated, min: MIN, champs: {} };

for (const [key, c] of Object.entries(raw.champs)) {
  const [name, role] = key.split("|");
  if (c.g < 5) continue;
  const runes = best(c.runes, c.g), shards = best(c.shards, c.g), sums = best(c.sums, c.g);
  const startClean = {};
  for (const [k, [g, w]] of Object.entries(c.start)) { const kk = k.split(",").filter(id => !champKeys.trinkets.has(id)).join(","); if (!kk) continue; const e = startClean[kk] ||= [0, 0]; e[0] += g; e[1] += w; }
  const core = best(c.core, c.g), boots = best(c.boots, c.g), start = best(startClean, c.g), skills = best(c.skills, c.g);
  const [pri, sec, perks] = runes ? runes.k.split(":") : [];
  const bans = raw.bans?.[champKeys.key[ddId(name)]] || 0;
  const id = ddId(name);
  out.champs[`${id}|${role}`] = {
    n: id, role, g: c.g, wr: +(c.w / c.g * 100).toFixed(2),
    pr: +(c.g / raw.matches * 100).toFixed(2),
    br: +(bans / raw.matches * 100).toFixed(2),
    runes: runes && { pri: +pri, sec: +sec, perks: perks.split(",").map(Number), g: runes.g, wr: runes.wr, share: runes.share },
    shards: shards && { ids: shards.k.split(",").map(Number), g: shards.g, wr: shards.wr },
    sums: sums && { ids: sums.k.split(",").map(Number), g: sums.g, wr: sums.wr },
    start: start && { ids: start.k.split(","), g: start.g, wr: start.wr },
    core: core && { ids: core.k.split(","), g: core.g, wr: core.wr },
    boots: boots && { id: boots.k, g: boots.g, wr: boots.wr },
    situational: Object.entries(c.items).filter(([id]) => !core?.k.split(",").includes(id)).sort((x, y) => y[1][0] - x[1][0]).slice(0, 4)
      .map(([id, [g, w]]) => ({ id, g, wr: +(w / g * 100).toFixed(1) })),
    skills: skills && { seq: skills.k, max: maxOrder(skills.k), g: skills.g, wr: skills.wr },
    vs: Object.fromEntries(Object.entries(c.vs).map(([o, [g, w]]) => [ddId(o), [g, w]]))
  };
}
// tier por posición: winrate ajustado a la muestra y presencia
for (const role of new Set(Object.values(out.champs).map(c => c.role))) {
  const list = Object.values(out.champs).filter(c => c.role === role && c.g >= MIN);
  const score = c => wilson(c.wr / 100 * c.g, c.g) * 100 + Math.min(c.pr + c.br, 30) * 0.08;
  list.sort((x, y) => score(y) - score(x)).forEach((c, i) => {
    const q = i / Math.max(1, list.length);
    c.tier = q < 0.08 ? "S" : q < 0.25 ? "A" : q < 0.55 ? "B" : q < 0.85 ? "C" : "D";
  });
}
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`${Object.keys(out.champs).length} campeón·posición · ${raw.matches} partidas → ${OUT}`);
