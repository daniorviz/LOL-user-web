# Rift Scout

Web para jugadores de League of Legends: resultados de esports y asistente de selección de campeón
(posición → rival → counters → runas, objetos y orden de habilidades).

## Qué hay

| Ruta | Qué hace |
|---|---|
| `index.html` | La web (sin dependencias; carga `data/*.json` y los sprites de `img/`). |
| `data/static.json`, `img/*.webp` | Campeones, habilidades, objetos, runas y hechizos del parche actual (Data Dragon, es_ES) en hojas de sprites. |
| `data/esports.json` | Copia de respaldo de los resultados. En Netlify, la web usa `/api/esports` en directo. |
| rama `stats` → `data/builds.json` | Estadísticas generadas por el workflow; la web las lee desde raw.githubusercontent.com. |
| `netlify/functions/esports.mjs` | Proxy a la API de LoL Esports → `/api/esports`. |
| `scripts/aggregate.mjs` | Descarga partidas clasificatorias con la API de Riot (League-V4 + Match-V5) y acumula estadísticas en `data/stats.json`. |
| `scripts/summarize.mjs` | Convierte el acumulado en `data/builds.json`, que es lo que lee la web (tier, winrate, pick/ban rate, mejor build y enfrentamientos). |
| `scripts/build_static.py` | Regenera `static.json` y los sprites al cambiar de parche. |
| `.github/workflows/stats.yml` | Ejecuta el agregador cada 6 horas y publica las estadísticas en la rama `stats` (sin redesplegar Netlify). |

## Puesta en marcha gratis

Todo cabe en los planes gratuitos si se hace así:

1. **Repositorio público en GitHub** con este proyecto. Los minutos de GitHub Actions son gratis en repositorios públicos.
2. **Netlify** conectado a la rama `main`, con *Branch deploys* en "Deploy only the production branch" (es el valor por defecto).
   Las estadísticas se publican en la rama `stats`, así que actualizarlas no provoca despliegues ni gasta créditos.
   La función `/api/esports` va cacheada 5 minutos en la CDN de Netlify, por lo que casi no consume.
3. En `index.html`, cambia `USUARIO/REPO` en la etiqueta `<meta name="rift-stats">` por tu usuario y repositorio.
4. **Clave de Riot** (gratis): para probar, la de desarrollo en local; para el workflow, solicita la de producción
   (la web pública la necesita). Guárdala como secreto `RIOT_API_KEY` en GitHub.
5. Opcional, en *Variables* del repositorio: `RIFT_PLATFORM`, `RIFT_TIERS`, `RIFT_MATCHES`. Con clave de producción
   puedes subir `RIFT_MATCHES` a 20000 o más.

### Probar en local con la clave de desarrollo

```bash
export RIOT_API_KEY=RGAPI-...
node scripts/aggregate.mjs --platform euw1 --tiers CHALLENGER,GRANDMASTER,MASTER --matches 1000 --timelines 1
node scripts/summarize.mjs
npx serve .        # la web cae en data/builds.json local si la rama stats aún no existe
```

Con clave de desarrollo (100 peticiones cada 2 min) salen unas 700 partidas/hora con timelines.
Las recomendaciones usan la cota inferior de Wilson para no premiar winrates de muestras pequeñas.

## Cambio de parche

```bash
# descarga raw/ (ver comentarios en build_static.py) y luego:
python3 scripts/build_static.py raw .
```

Rift Scout no está respaldado por Riot Games. Cumple las políticas de Riot para proyectos de la comunidad (sin anuncios engañosos, aviso legal en el pie).
