// Netlify Function: /api/esports → resultados en directo de la API de LoL Esports, con el mismo formato que data/esports.json.
// La clave es la pública que usa lolesports.com; se puede sobrescribir con LOLESPORTS_KEY.
const KEY = process.env.LOLESPORTS_KEY || "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z";
const API = "https://esports-api.lolesports.com/persisted/gw";
const WORLDS = "98767975604431411";
const OTHERS = ["98767991325878492", "113464388705111224", "98767991302996019", "98767991310872058", "98767991314006698",
  "98767991299243165", "98767991332355509", "113476371197627891", "105266074488398661"];

const get = async path => {
  const r = await fetch(`${API}/${path}${path.includes("?") ? "&" : "?"}hl=es-ES`, { headers: { "x-api-key": KEY } });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return (await r.json()).data;
};
const https = u => (u || "").replace(/^http:/, "https:");
const evOut = e => ({
  t: e.startTime, state: e.state, block: e.blockName, bo: e.match?.strategy?.count,
  teams: e.match.teams.map(t => ({ code: t.code, name: t.name, wins: t.result?.gameWins, out: t.result?.outcome, img: https(t.image) }))
});

export default async () => {
  try {
    const leagues = Object.fromEntries((await get("getLeagues")).leagues.map(l => [l.id, l]));
    const season = new Date().getUTCFullYear();
    let s = (await get(`getSchedule?leagueId=${WORLDS}`)).schedule, events = s.events;
    if (s.pages?.older) events = (await get(`getSchedule?leagueId=${WORLDS}&pageToken=${s.pages.older}`)).schedule.events.concat(events);
    events = events.filter(e => e.type === "match" && e.startTime >= `${season}-09-01`);
    const others = [];
    await Promise.all(OTHERS.map(async id => {
      const ev = (await get(`getSchedule?leagueId=${id}`)).schedule.events.filter(e => e.type === "match" && e.state === "completed");
      if (!ev.length) return;
      const l = leagues[id];
      others.push({ league: l.name, region: l.region, img: https(l.image), ...evOut(ev.at(-1)) });
    }));
    others.sort((a, b) => b.t.localeCompare(a.t));
    const body = { updated: new Date().toISOString(), live: true,
      worlds: { name: `Worlds ${season}`, img: https(leagues[WORLDS].image), events: events.map(evOut) }, others };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "public, max-age=120",
      // la CDN de Netlify guarda la respuesta 5 min: la función apenas se ejecuta y casi no gasta créditos
      "netlify-cdn-cache-control": "public, durable, s-maxage=300, stale-while-revalidate=600" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { "content-type": "application/json" } });
  }
};
export const config = { path: "/api/esports" };
