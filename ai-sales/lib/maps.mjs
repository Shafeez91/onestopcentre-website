// Google Maps Platform for the AI: where a project really is, where a place really is, and how far it is between
// them (walking, driving, public transport, straight line). Server-side only; the key never leaves the function.
//
//   Project location, in order of authority: coordinates typed into the project (data.latlng "3.21,101.73") ›
//   the staff's own Google Maps pin link (data.mapUrl, resolved to the pin's coordinates) › a place search on the
//   project name and area (labelled "approximate"). A broad area is never used as the project's location.
//   Destinations: Places API (New) text search, biased to the project's surroundings; for LRT / MRT / KTM / station
//   questions only transit-station results count. Routes: Routes API computeRoutes (WALK, DRIVE without live traffic,
//   TRANSIT). Every result says which provider and kind it is, and when it was fetched; results are cached in
//   ai_geo_cache (migration 17) when that table exists.
//
// APIs to enable on the key's Google Cloud project: "Places API (New)" and "Routes API". Env: GOOGLE_MAPS_API_KEY.
export class MapsError extends Error {
  constructor(message, { kind = "error", status = 0 } = {}) { super(message); this.kind = kind; this.status = status; }
}

const PLACES = "https://places.googleapis.com/v1/places:searchText";
const ROUTES = "https://routes.googleapis.com/directions/v2:computeRoutes";
const DAY = 864e5;
const TTL = { project: 90 * DAY, place: 30 * DAY, route: 14 * DAY };
const MODE = { walk: "WALK", drive: "DRIVE", transit: "TRANSIT" };
const LINK_MODE = { walk: "walking", drive: "driving", transit: "transit" };
const TRANSIT_TYPES = ["subway_station", "train_station", "transit_station", "light_rail_station", "bus_station"];
const WANTS_STATION = /\b(lrt|mrt|ktm|erl|brt|monorail|komuter|station|stesen)\b/i;

/** Straight-line (great-circle) distance in metres. */
export function haversine(a, b) {
  const R = 6371008.8, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

const valid = (p) => p && isFinite(p.lat) && isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && !(p.lat === 0 && p.lng === 0);

/** "3.2051, 101.7312" (or "3.2051 101.7312") → { lat, lng }; anything else → null. */
export function parseLatLng(s) {
  const m = String(s || "").trim().match(/^(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)$/);
  const p = m && { lat: +m[1], lng: +m[2] };
  return valid(p) ? p : null;
}

/**
 * The pin of a full Google Maps URL. "!3d<lat>!4d<lng>" is the place's own pin and wins; "?q=lat,lng" or
 * "query=lat,lng" next; "@lat,lng" is only the map's centre, so it is used only when nothing better is there.
 */
export function coordsFromMapsUrl(url) {
  const u = decodeURIComponent(String(url || ""));
  const pin = [...u.matchAll(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/g)].pop();
  if (pin) return { lat: +pin[1], lng: +pin[2], precision: "pin" };
  const q = u.match(/[?&](?:q|query|destination|ll)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
  if (q) return { lat: +q[1], lng: +q[2], precision: "pin" };
  const at = u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (at) return { lat: +at[1], lng: +at[2], precision: "map_centre" };
  return null;
}

/** A Google Maps directions link (documented Maps URLs format), or a search link for one place. */
export function directionsLink(origin, dest, mode = "walk") {
  const p = new URLSearchParams({ api: "1", origin: `${origin.lat},${origin.lng}`, destination: dest.name || `${dest.lat},${dest.lng}`, travelmode: LINK_MODE[mode] || "walking" });
  if (dest.place_id) p.set("destination_place_id", dest.place_id);
  else if (valid(dest)) p.set("destination", `${dest.lat},${dest.lng}`);
  return "https://www.google.com/maps/dir/?" + p.toString();
}

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const r5 = (x) => Math.round(x * 1e5) / 1e5;

/**
 * @param {object} o { key, db (service-role adapter, for the cache; optional), fetchImpl, now, timeoutMs }
 */
export function mapsService(o = {}) {
  const fetchImpl = o.fetchImpl || fetch, now = o.now || (() => new Date()), timeoutMs = o.timeoutMs ?? 8000;
  const stats = { api_calls: 0, cache_hits: 0 };

  async function cacheGet(key) {
    if (!o.db) return null;
    try {
      const row = (await o.db.get(`ai_geo_cache?key=eq.${encodeURIComponent(key)}&select=value,fetched_at,expires_at`))?.[0];
      if (row && new Date(row.expires_at) > now()) { stats.cache_hits++; return { ...row.value, fetched_at: row.fetched_at, cached: true }; }
    } catch { /* cache table not installed: work without it */ }
    return null;
  }
  async function cachePut(key, kind, value, ttl) {
    if (!o.db) return;
    const at = now();
    try { await o.db.post("ai_geo_cache?on_conflict=key", { key, kind, value, provider: "google", fetched_at: at.toISOString(), expires_at: new Date(at.getTime() + ttl).toISOString() }, { prefer: "resolution=merge-duplicates,return=minimal" }); }
    catch { /* best effort */ }
  }

  async function call(url, body, fieldMask) {
    if (!o.key) throw new MapsError("Google Maps is not configured (GOOGLE_MAPS_API_KEY).", { kind: "config" });
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 600));
      stats.api_calls++;
      let res;
      try {
        res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": o.key, "x-goog-fieldmask": fieldMask }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) { last = new MapsError("Google Maps could not be reached: " + (e?.message || e), { kind: "network" }); continue; }
      if (res.status === 429 || res.status >= 500) { last = new MapsError(`Google Maps is busy (HTTP ${res.status}).`, { kind: "unavailable", status: res.status }); continue; }
      const json = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) throw new MapsError(`Google Maps refused the key (HTTP ${res.status}): ${json?.error?.message || ""}`.trim(), { kind: "auth", status: res.status });
      if (!res.ok) throw new MapsError(`Google Maps rejected the request (HTTP ${res.status}): ${json?.error?.message || ""}`.trim(), { kind: "rejected", status: res.status });
      return json;
    }
    throw last;
  }

  /** Places text search → the best place, or null. near: { lat, lng } to bias towards. */
  async function place(query, near = null) {
    const station = WANTS_STATION.test(query);
    const key = `place:${norm(query)}|${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : "-"}`;
    const hit = await cacheGet(key);
    if (hit) return hit.none ? null : hit;
    const body = { textQuery: query, regionCode: "MY", languageCode: "en", maxResultCount: 5,
      ...(near ? { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 30000 } } } : {}) };
    const json = await call(PLACES, body, "places.id,places.displayName,places.formattedAddress,places.location,places.types,places.businessStatus");
    const list = (json.places || []).filter((p) => p.location && valid({ lat: p.location.latitude, lng: p.location.longitude }));
    const pick = station ? list.find((p) => (p.types || []).some((t) => TRANSIT_TYPES.includes(t))) : list[0];
    const out = pick ? { name: pick.displayName?.text || query, address: pick.formattedAddress || "", place_id: pick.id, lat: pick.location.latitude, lng: pick.location.longitude,
      types: pick.types || [], status: pick.businessStatus || null, query, fetched_at: now().toISOString(), provider: "Google Places API" } : null;
    await cachePut(key, "place", out || { none: true, query }, out ? TTL.place : DAY);
    return out;
  }

  /**
   * Where a project is. project: { id, name, area, latlng, map_url, address }.
   * Returns { lat, lng, source, precision, address } or null (with a reason in .missing).
   */
  async function projectLocation(project) {
    const typed = parseLatLng(project.latlng);
    if (typed) return { ...typed, source: "coordinates entered for the project", precision: "pin" };
    if (/^https?:\/\//.test(project.map_url || "")) {
      const key = `project:${project.id}|${project.map_url}`;
      const hit = await cacheGet(key);
      if (hit) return hit;
      let full = project.map_url;
      // short links (maps.app.goo.gl) redirect to the full URL that carries the pin
      for (let i = 0; i < 3 && !coordsFromMapsUrl(full); i++) {
        try {
          const res = await fetchImpl(full, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
          const next = res.headers.get("location");
          if (!next) break;
          full = new URL(next, full).toString();
        } catch { break; }
      }
      const c = coordsFromMapsUrl(full);
      if (c && valid(c)) {
        const out = { lat: c.lat, lng: c.lng, precision: c.precision, source: "the project's Google Maps pin (website editor)", fetched_at: now().toISOString() };
        await cachePut(key, "project", out, TTL.project);
        return out;
      }
    }
    if (project.name) {
      const p = await place(`${project.name} ${project.area || ""} condominium`.trim());
      if (p) return { lat: p.lat, lng: p.lng, precision: "approximate", source: `Google place search for "${project.name}" (approximate: no map pin on record)`, address: p.address };
    }
    return null;
  }

  /** One route. mode: walk | drive | transit. Driving is traffic-unaware: a typical time, not live traffic. */
  async function route(origin, dest, mode) {
    const key = `route:${r5(origin.lat)},${r5(origin.lng)}|${dest.place_id || `${r5(dest.lat)},${r5(dest.lng)}`}|${mode}`;
    const hit = await cacheGet(key);
    if (hit) return hit.none ? null : hit;
    const body = { origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
      destination: dest.place_id ? { placeId: dest.place_id } : { location: { latLng: { latitude: dest.lat, longitude: dest.lng } } },
      travelMode: MODE[mode], units: "METRIC", languageCode: "en", ...(mode === "drive" ? { routingPreference: "TRAFFIC_UNAWARE" } : {}) };
    const json = await call(ROUTES, body, "routes.distanceMeters,routes.duration,routes.staticDuration");
    const r = json.routes?.[0];
    const secs = (s) => (s ? Math.round(parseFloat(String(s).replace(/s$/, ""))) : null);
    const out = r ? { mode, kind: "route", distance_m: r.distanceMeters ?? null, duration_s: secs(r.staticDuration || r.duration), provider: "Google Routes API",
      note: mode === "drive" ? "typical driving time without live traffic" : mode === "transit" ? "public transport as scheduled; times vary" : null, fetched_at: now().toISOString() } : null;
    await cachePut(key, "route", out || { none: true }, out ? TTL.route : DAY);
    return out;
  }

  /**
   * project → destination, for the requested modes. Returns everything the AI may state, with sources; never throws
   * for a missing piece (that is reported in .missing), only for a configuration or provider failure.
   */
  async function lookup({ project, destination, modes = ["walk", "drive"] }) {
    const out = { project: project.name, destination_query: destination, routes: [], missing: [] };
    const from = await projectLocation(project);
    if (!from) { out.missing.push(`no verified location for ${project.name} (add its Google Maps pin in the website editor)`); return out; }
    out.origin = { lat: from.lat, lng: from.lng, source: from.source, precision: from.precision };
    const to = await place(`${destination}`, from);
    if (!to) { out.missing.push(`no place found for "${destination}" near ${project.name}`); return out; }
    out.destination = { name: to.name, address: to.address, place_id: to.place_id, types: to.types, status: to.status, source: to.provider };
    out.straight_line_m = haversine(from, to);
    for (const m of [...new Set(modes)].filter((x) => MODE[x])) {
      const r = await route(from, to, m);
      if (r) out.routes.push(r); else out.missing.push(`no ${m} route returned`);
    }
    out.maps_link = directionsLink(from, to, modes.includes("walk") ? "walk" : modes[0] || "drive");
    if (from.precision !== "pin") out.missing.push(`${project.name}'s location is ${from.precision === "map_centre" ? "the map's centre, not a pin" : "approximate (found by search)"}`);
    return out;
  }

  return { configured: !!o.key, stats, place, projectLocation, route, lookup };
}
