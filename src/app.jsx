import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import * as _fb from './firebase.js';

const LOGO_URI = "/assets/images/logo.png";
const LOGO_URI2 = "/assets/images/escalacao-blue.png";

// ─── Firebase helpers ─────────────────────────────────────────────────────────
// getFirebase() mantém a mesma interface que o código usa (fb.doc, fb.db, etc.)
// mas agora retorna imports diretos — firebase está sempre disponível.
function getFirebase() {
  return {
    auth: _fb.auth,
    db: _fb.db,
    storage: _fb.storage,
    analytics: _fb.analytics,
    provider: _fb.provider,
    logEvent: _fb.logEvent,
    signInWithPopup: _fb.signInWithPopup,
    signInWithRedirect: _fb.signInWithRedirect,
    getRedirectResult: _fb.getRedirectResult,
    signOut: _fb.signOut,
    onAuthStateChanged: _fb.onAuthStateChanged,
    doc: _fb.doc,
    setDoc: _fb.setDoc,
    getDoc: _fb.getDoc,
    getDocFromServer: _fb.getDocFromServer,
    deleteDoc: _fb.deleteDoc,
    collection: _fb.collection,
    getDocs: _fb.getDocs,
    writeBatch: _fb.writeBatch,
    onSnapshot: _fb.onSnapshot,
    query: _fb.query,
    orderBy: _fb.orderBy,
    serverTimestamp: _fb.serverTimestamp,
    limit: _fb.limit,
    storageRef: _fb.storageRef,
    uploadBytes: _fb.uploadBytes,
    getDownloadURL: _fb.getDownloadURL,
    deleteObject: _fb.deleteObject,
    FirebaseAuthentication: _fb.FirebaseAuthentication,
    signInWithCredential: _fb.signInWithCredential,
    GoogleAuthProvider: _fb.GoogleAuthProvider,
  };
}

// ─── Analytics helper ────────────────────────────────────────────────────────
function logA(event, params) {
  try {
    _fb.logEvent(_fb.analytics, event, params || {});
  } catch(e) {}
}

// ─── Image Compression ───────────────────────────────────────────────────────
/**
 * Compresses a base64 data URL to ~300×300px at 75% JPEG quality.
 * Falls back to original if Canvas API is unavailable.
 * @param {string} dataUrl  - Original data URL (any format)
 * @param {number} maxDim   - Max width/height in pixels (default 300)
 * @param {number} quality  - JPEG quality 0-1 (default 0.75)
 * @returns {Promise<string>} Compressed JPEG data URL
 */
function compressImage(dataUrl, maxDim = 300, quality = 0.75) {
  return new Promise((resolve) => {
    if (!dataUrl || !dataUrl.startsWith("data:")) { resolve(dataUrl); return; }
    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
    // Safety timeout: never let this hang the UI forever (e.g. if onload/onerror
    // never fire for some image formats/environments).
    const timer = setTimeout(() => finish(dataUrl), 6000);
    const img = new Image();
    img.onload = () => {
      clearTimeout(timer);
      try {
        const { naturalWidth: w, naturalHeight: h } = img;
        const scale = Math.min(1, maxDim / Math.max(w, h));
        const nw = Math.round(w * scale);
        const nh = Math.round(h * scale);
        const canvas = document.createElement("canvas");
        canvas.width = nw; canvas.height = nh;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, nw, nh);
        // Preserve PNG format (and transparency) when the source is PNG;
        // JPEG would fill transparent pixels with black.
        const isPng = dataUrl.startsWith("data:image/png");
        finish(isPng ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", quality));
      } catch (e) { finish(dataUrl); }
    };
    img.onerror = () => { clearTimeout(timer); finish(dataUrl); };
    img.src = dataUrl;
  });
}

/** Wraps a promise with a timeout fallback so the UI never hangs forever. */
function withTimeout(promise, ms = 8000) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

/**
 * Generates a collision-resistant unique ID (UUID v4).
 * Uses crypto.randomUUID() when available (modern browsers, secure contexts).
 * Falls back to crypto.getRandomValues(), then to Math.random() for very old
 * environments — always returns a syntactically valid UUID v4 string.
 */
function genUUID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map(b => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0,4).join("")}-${hex.slice(4,6).join("")}-${hex.slice(6,8).join("")}-${hex.slice(8,10).join("")}-${hex.slice(10,16).join("")}`;
}

/**
 * Compares two IDs for sorting, supporting a mix of legacy numeric IDs
 * (from the old Date.now()-based generator) and new UUID strings
 * (from genUUID()). Numeric IDs sort first (oldest-created-first, as before);
 * UUID IDs sort after them, ordered alphabetically for a stable, deterministic
 * order.
 */
function compareIds(a, b) {
  const na = Number(a), nb = Number(b);
  const aNum = !isNaN(na) && a !== "" && a != null;
  const bNum = !isNaN(nb) && b !== "" && b != null;
  if (aNum && bNum) return na - nb;
  if (aNum !== bNum) return aNum ? -1 : 1;
  return String(a).localeCompare(String(b));
}

// ─── In-memory cache ─────────────────────────────────────────────────────────
// Avoids redundant Firestore reads within the same session.
// Structure: { teams: Map<uid, {value, ts}>, players: Map<uid_teamId, {value, ts}>, lineups: Map<uid_teamId, {value, ts}> }
// Each entry carries a timestamp (ts) and expires after CACHE_TTL_MS — this
// prevents unbounded memory growth in long-lived sessions (e.g. an app left
// open for hours while browsing many teams). Expired entries are simply
// re-fetched from Firestore on next access, same as a cache miss.
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const _memCache = {
  teams: new Map(),      // uid → {value: team[], ts}
  players: new Map(),    // `${uid}_${teamId}` → {value: player[], ts}
  lineups: new Map(),    // `${uid}_${teamId}` → {value: lineup[], ts}

  _fresh(map, key) {
    const entry = map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts >= CACHE_TTL_MS) { map.delete(key); return undefined; }
    return entry;
  },
  has(map, key) {
    return this._fresh(map, key) !== undefined;
  },
  get(map, key) {
    const entry = this._fresh(map, key);
    return entry ? entry.value : undefined;
  },
  set(map, key, value) {
    map.set(key, { value, ts: Date.now() });
  },
  invalidateTeam(uid, teamId) {
    const key = `${uid}_${teamId}`;
    this.players.delete(key);
    this.lineups.delete(key);
    // Invalidate team list so next full load picks up changes
    this.teams.delete(uid);
  },
  invalidateAll(uid) {
    this.teams.delete(uid);
    // Remove all player/lineup keys for this uid
    for (const k of [...this.players.keys()]) { if (k.startsWith(uid + "_")) this.players.delete(k); }
    for (const k of [...this.lineups.keys()]) { if (k.startsWith(uid + "_")) this.lineups.delete(k); }
  },
  /** Removes all expired entries across every map. Call periodically (e.g. every few minutes). */
  purgeExpired() {
    const now = Date.now();
    for (const map of [this.teams, this.players, this.lineups]) {
      for (const [k, entry] of map) {
        if (now - entry.ts >= CACHE_TTL_MS) map.delete(k);
      }
    }
  }
};

// ─── Image helpers ────────────────────────────────────────────────────────────

/** Returns true if the string is a base64 data URL (e.g. "data:image/png;base64,...") */
function isBase64Image(str) {
  return typeof str === "string" && str.startsWith("data:");
}

/**
 * Prepares an image value for Firestore storage.
 * - https URL  → returned as-is (legacy compat with old Storage URLs).
 * - base64     → compressed to ≤200×200px / 65% JPEG (~8-15 KB) and returned as base64.
 *               Stored directly in the Firestore document — no Firebase Storage needed.
 *               This avoids CORS issues, Storage security-rule setup, and upload failures.
 * - empty/null → returns "".
 */
async function resolveImageUrl(uid, value, path) {
  if (!value) return "";
  if (!isBase64Image(value)) return value; // already an https URL
  try {
    return await compressImage(value, 200, 0.65);
  } catch (e) {
    console.warn("resolveImageUrl compress failed, using original:", e);
    return value;
  }
}

/**
 * Ensures team photo is compressed before saving to Firestore.
 * (resolveImageUrl now stores base64 directly — no Storage upload.)
 */
async function migrateBase64InTeam(uid, team) {
  const teamPhoto = await resolveImageUrl(uid, team.photo || "", `shields/team_${team.id}`);
  return { ...team, photo: teamPhoto };
}

// ─── v3: players as subcollection ─────────────────────────────────────────────
// Structure:
//   users/{uid}                          → { schemaVersion: 3, ... }
//   users/{uid}/teams/{teamId}           → team metadata (no players array)
//   users/{uid}/teams/{teamId}/players/{playerId} → individual player docs
//
// Fields stored per player: id, name, number, position, foot, stars, photo, updatedAt

const SCHEMA_VERSION = 4;

// ── Player cloud CRUD ─────────────────────────────────────────────────────────

/** Save (upsert) a single player document under a team. */
async function savePlayerCloud(uid, teamId, player) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    // Photo is already resolved (compressed base64) by the time it reaches here
    const ref = fb.doc(fb.db, "users", uid, "teams", String(teamId), "players", String(player.id));
    await fb.setDoc(ref, { ...player, updatedAt: fb.serverTimestamp() });
    // Update cache entry in-place instead of invalidating (avoids next full re-read)
    const cacheKey = `${uid}_${teamId}`;
    const cached = _memCache.get(_memCache.players, cacheKey);
    if (cached) {
      const idx = cached.findIndex(p => String(p.id) === String(player.id));
      if (idx >= 0) cached[idx] = player; else cached.push(player);
      _memCache.set(_memCache.players, cacheKey, cached); // refresh TTL
    }
    return true;
  } catch(e) { console.warn("savePlayerCloud error:", e); return false; }
}

/** Delete a single player document and update cache. */
async function deletePlayerCloud(uid, teamId, playerId) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    await fb.deleteDoc(
      fb.doc(fb.db, "users", uid, "teams", String(teamId), "players", String(playerId))
    );
    // Remove from cache without full re-read
    const cacheKey = `${uid}_${teamId}`;
    const cached = _memCache.get(_memCache.players, cacheKey);
    if (cached) {
      _memCache.set(_memCache.players, cacheKey, cached.filter(p => String(p.id) !== String(playerId)));
    }
    return true;
  } catch(e) { console.warn("deletePlayerCloud error:", e); return false; }
}

/** Load all players for a team from the players subcollection (cached). */
async function loadPlayersCloud(uid, teamId, { force = false } = {}) {
  const cacheKey = `${uid}_${teamId}`;
  if (!force && _memCache.has(_memCache.players, cacheKey)) return _memCache.get(_memCache.players, cacheKey);
  const fb = getFirebase(); if (!fb) return null;
  try {
    const col = fb.collection(fb.db, "users", uid, "teams", String(teamId), "players");
    const snap = await fb.getDocs(col);
    const players = snap.empty ? [] : snap.docs.map(d => d.data());
    players.sort((a, b) => compareIds(a.id, b.id));
    _memCache.set(_memCache.players, cacheKey, players);
    return players;
  } catch(e) { console.warn("loadPlayersCloud error:", e); return null; }
}

/** Delete all players in a team's subcollection (used when deleting a team). */
async function deleteAllPlayersCloud(uid, teamId) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    const col = fb.collection(fb.db, "users", uid, "teams", String(teamId), "players");
    const snap = await fb.getDocs(col);
    if (snap.empty) return true;
    // Firestore batch supports up to 500 ops; chunked for safety
    const CHUNK = 400;
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += CHUNK) {
      const batch = fb.writeBatch(fb.db);
      docs.slice(i, i + CHUNK).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    return true;
  } catch(e) { console.warn("deleteAllPlayersCloud error:", e); return false; }
}

// ── Team cloud CRUD (v3 — no players array in team doc) ───────────────────────

/**
 * Save (upsert) team metadata only (no players, lineup, or lineups arrays).
 * Migrates shield base64 → Storage URL.
 */
async function saveTeamCloud(uid, team) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    const resolved = await migrateBase64InTeam(uid, team);
    const { players: _p, lineup: _l, lineups: _ls, ...teamMeta } = resolved;
    const ref = fb.doc(fb.db, "users", uid, "teams", String(team.id));
    await fb.setDoc(ref, { ...teamMeta, updatedAt: fb.serverTimestamp() });
    // Update teams metadata cache in-place
    const cached = _memCache.get(_memCache.teams, uid);
    if (cached) {
      const idx = cached.findIndex(t => String(t.id) === String(team.id));
      if (idx >= 0) cached[idx] = { ...cached[idx], ...teamMeta }; else cached.push(teamMeta);
      _memCache.set(_memCache.teams, uid, cached); // refresh TTL
    }
    return true;
  } catch(e) { console.warn("saveTeamCloud error:", e); return false; }
}

/**
 * Delete a team document AND all its player subcollection docs.
 */
async function deleteTeamCloud(uid, teamId) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    await Promise.all([
      deleteAllPlayersCloud(uid, teamId),
      deleteAllLineupsCloud(uid, teamId),
    ]);
    await fb.deleteDoc(fb.doc(fb.db, "users", uid, "teams", String(teamId)));
    _memCache.invalidateTeam(uid, teamId);
    _memCache.teams.delete(uid); // force team list refresh
    return true;
  } catch(e) { console.warn("deleteTeamCloud error:", e); return false; }
}

/**
 * Load all teams metadata from the teams subcollection.
 * By default uses cache; pass force=true to bypass.
 * Players/lineups are NOT loaded here — use loadTeamFull() for that.
 */
async function loadTeamsCloud(uid, { force = false } = {}) {
  if (!force && _memCache.has(_memCache.teams, uid)) return _memCache.get(_memCache.teams, uid);
  const fb = getFirebase(); if (!fb) return null;
  try {
    const col = fb.collection(fb.db, "users", uid, "teams");
    const snap = await fb.getDocs(col);
    if (snap.empty) { _memCache.set(_memCache.teams, uid, []); return []; }
    // Filtrar times que já foram migrados para collab (ficam apenas como backup no Firestore)
    const teams = snap.docs.map(d => d.data()).filter(t => !t._collabMigrated);
    teams.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
    _memCache.set(_memCache.teams, uid, teams);
    return teams;
  } catch(e) { console.warn("loadTeamsCloud error:", e); return null; }
}

/**
 * Load a single team fully (metadata + players + lineups).
 * This is the lazy-load entry point called when a team is opened.
 */
async function loadTeamFull(uid, teamMeta, { force = false } = {}) {
  const [players, lineups] = await Promise.all([
    loadPlayersCloud(uid, teamMeta.id, { force }),
    loadLineupsCloud(uid, teamMeta.id, { force }),
  ]);
  const activeLineup = getActiveLineup(teamMeta, lineups || []);
  return {
    ...teamMeta,
    players: players || [],
    lineups: lineups || [],
    formation: activeLineup?.formation || teamMeta.formation || "4-4-2",
    lineup: activeLineup?.entries || [],
  };
}

/**
 * Full init: loads ALL teams with players+lineups (used after migrations and first login).
 * Subsequent navigations use loadTeamFull() per team instead.
 */
async function loadAllTeamsFull(uid) {
  const teams = await loadTeamsCloud(uid, { force: true });
  if (!teams) return null;
  return Promise.all(teams.map(t => loadTeamFull(uid, t, { force: false })));
}


// ── Lineup cloud CRUD ─────────────────────────────────────────────────────────
// Structure: users/{uid}/teams/{teamId}/lineups/{lineupId}
// Fields: id, name, type ("titular"|"reserva"|"personalizada"), formation,
//         entries (Array<{slotId,playerId}>), isActive, updatedAt

/** Factory: create a new lineup object (local only, not saved). */
function makeLineup(overrides = {}) {
  return {
    id: String(Date.now()),
    name: "Titular",
    type: "titular",
    formation: "4-4-2",
    entries: [],
    isActive: true,
    coach: "",
    benchPlayerIds: [],
    ...overrides,
  };
}

/** Returns the active lineup object from a team's lineups array. */
function getActiveLineup(team, lineups) {
  if (!lineups || lineups.length === 0) return null;
  // Prefer the one marked isActive matching activeLineupId
  if (team.activeLineupId) {
    const byId = lineups.find(l => String(l.id) === String(team.activeLineupId));
    if (byId) return byId;
  }
  // Fallback: first isActive, then first
  return lineups.find(l => l.isActive) || lineups[0];
}

/** Save (upsert) a single lineup document under a team; updates cache. */
async function saveLineupCloud(uid, teamId, lineup) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    const ref = fb.doc(fb.db, "users", uid, "teams", String(teamId), "lineups", String(lineup.id));
    await fb.setDoc(ref, { ...lineup, updatedAt: fb.serverTimestamp() });
    // Update in-place in lineup cache
    const cacheKey = `${uid}_${teamId}`;
    const cached = _memCache.get(_memCache.lineups, cacheKey);
    if (cached) {
      const idx = cached.findIndex(l => String(l.id) === String(lineup.id));
      if (idx >= 0) cached[idx] = lineup; else cached.push(lineup);
      _memCache.set(_memCache.lineups, cacheKey, cached); // refresh TTL
    }
    return true;
  } catch(e) { console.warn("saveLineupCloud error:", e); return false; }
}

/** Delete a single lineup document and update cache. */
async function deleteLineupCloud(uid, teamId, lineupId) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    await fb.deleteDoc(
      fb.doc(fb.db, "users", uid, "teams", String(teamId), "lineups", String(lineupId))
    );
    const cacheKey = `${uid}_${teamId}`;
    const cached = _memCache.get(_memCache.lineups, cacheKey);
    if (cached) {
      _memCache.set(_memCache.lineups, cacheKey, cached.filter(l => String(l.id) !== String(lineupId)));
    }
    return true;
  } catch(e) { console.warn("deleteLineupCloud error:", e); return false; }
}

/** Load all lineups for a team from the lineups subcollection (cached). */
async function loadLineupsCloud(uid, teamId, { force = false } = {}) {
  const cacheKey = `${uid}_${teamId}`;
  if (!force && _memCache.has(_memCache.lineups, cacheKey)) return _memCache.get(_memCache.lineups, cacheKey);
  const fb = getFirebase(); if (!fb) return null;
  try {
    const col = fb.collection(fb.db, "users", uid, "teams", String(teamId), "lineups");
    const snap = await fb.getDocs(col);
    const lineups = snap.empty ? [] : snap.docs.map(d => d.data());
    _memCache.set(_memCache.lineups, cacheKey, lineups);
    return lineups;
  } catch(e) { console.warn("loadLineupsCloud error:", e); return null; }
}

/** Delete all lineups in a team's subcollection (used when deleting a team). */
async function deleteAllLineupsCloud(uid, teamId) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    const col = fb.collection(fb.db, "users", uid, "teams", String(teamId), "lineups");
    const snap = await fb.getDocs(col);
    if (snap.empty) return true;
    const CHUNK = 400;
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += CHUNK) {
      const batch = fb.writeBatch(fb.db);
      docs.slice(i, i + CHUNK).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    return true;
  } catch(e) { console.warn("deleteAllLineupsCloud error:", e); return false; }
}

// ── Matches (calendar / office) ───────────────────────────────────────────────
async function saveMatchCloud(uid, teamId, match) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    const ref = fb.doc(fb.db, "users", uid, "teams", String(teamId), "matches", String(match.id));
    await fb.setDoc(ref, { ...match, updatedAt: fb.serverTimestamp() }, { merge: true });
    return true;
  } catch(e) { console.warn("saveMatchCloud error:", e); return false; }
}
async function deleteMatchCloud(uid, teamId, matchId) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    await fb.deleteDoc(fb.doc(fb.db, "users", uid, "teams", String(teamId), "matches", String(matchId)));
    return true;
  } catch(e) { console.warn("deleteMatchCloud error:", e); return false; }
}
async function loadMatchesCloud(uid, teamId) {
  const fb = getFirebase(); if (!fb) return null;
  try {
    const col = fb.collection(fb.db, "users", uid, "teams", String(teamId), "matches");
    const snap = await fb.getDocs(col);
    return snap.empty ? [] : snap.docs.map(d => d.data());
  } catch(e) { console.warn("loadMatchesCloud error:", e); return null; }
}

// ── Player stats ───────────────────────────────────────────────────────────────
async function savePlayerStatsCloud(uid, teamId, stats) {
  // stats: { playerId, goals, assists, goalsAgainst, updatedAt }
  const fb = getFirebase(); if (!fb) return false;
  try {
    const ref = fb.doc(fb.db, "users", uid, "teams", String(teamId), "stats", String(stats.playerId));
    await fb.setDoc(ref, { ...stats, updatedAt: fb.serverTimestamp() }, { merge: true });
    return true;
  } catch(e) { console.warn("savePlayerStatsCloud error:", e); return false; }
}
async function loadAllStatsCloud(uid, teamId) {
  const fb = getFirebase(); if (!fb) return null;
  try {
    const col = fb.collection(fb.db, "users", uid, "teams", String(teamId), "stats");
    const snap = await fb.getDocs(col);
    return snap.empty ? {} : Object.fromEntries(snap.docs.map(d => [d.id, d.data()]));
  } catch(e) { console.warn("loadAllStatsCloud error:", e); return null; }
}



// ─── Premium / monetization scaffolding ────────────────────────────────────
// This app is being prepared for a future freemium release on the Play Store.
// `isPremium` lives on the user's profile doc (users/{uid}.isPremium, default
// false) so it's available across devices. FREE_* constants define the limits
// that apply while `isPremium` is false; gating UI (PremiumUpsellModal) and
// checks live alongside the relevant features (e.g. lineup creation below).
// Ativo apenas em localhost — nunca em produção.
// Permite testar FREE vs PRO sem acesso ao Firebase Console.
const IS_DEV = typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

const FREE_LINEUP_LIMIT = 1;  // max saved lineups per team on the free plan
const FREE_TEAM_LIMIT = 1;    // max teams on the free plan
const FREE_PLAYER_LIMIT = 12; // max players per team on the free plan
const FREE_GUEST_LIMIT = 1;   // max guest players per team on the free plan
const FREE_KIT_IDS = ["titular","goleiro"]; // kit ids/types usable on the free plan
const FREE_EXPORT_THEMES = ["modern"];      // export themes usable on the free plan

async function getIsPremium(uid) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    const snap = await fb.getDoc(fb.doc(fb.db, "users", uid));
    if (!snap.exists()) return false;
    return !!snap.data().isPremium;
  } catch(e) { return false; }
}

async function setIsPremiumFlag(uid, value) {
  const fb = getFirebase(); if (!fb) return;
  try {
    await fb.setDoc(fb.doc(fb.db, "users", uid), { isPremium: !!value }, { merge: true });
  } catch(e) { console.warn("setIsPremiumFlag error:", e); }
}

async function getSchemaVersion(uid) {
  const fb = getFirebase(); if (!fb) return 1;
  try {
    const snap = await fb.getDoc(fb.doc(fb.db, "users", uid));
    if (!snap.exists()) return 1;
    return snap.data().schemaVersion || 1;
  } catch(e) { return 1; }
}

async function setSchemaVersion(uid, version) {
  const fb = getFirebase(); if (!fb) return;
  try {
    await fb.setDoc(fb.doc(fb.db, "users", uid),
      { schemaVersion: version, migratedAt: fb.serverTimestamp() },
      { merge: true });
  } catch(e) { console.warn("setSchemaVersion error:", e); }
}

// ── Migrations ────────────────────────────────────────────────────────────────

/**
 * v1 → v2: Migrate legacy teams array from users/{uid}.teams
 *          into individual team documents (users/{uid}/teams/{teamId}).
 *          Players remain embedded in team docs at this stage.
 */
async function migrateV1toV2(uid) {
  const fb = getFirebase(); if (!fb) return [];
  try {
    const userSnap = await fb.getDoc(fb.doc(fb.db, "users", uid));
    if (!userSnap.exists()) return [];
    const data = userSnap.data();
    const legacyTeams = data.teams || [];
    if (legacyTeams.length === 0) return [];
    await Promise.all(legacyTeams.map(team =>
      fb.setDoc(
        fb.doc(fb.db, "users", uid, "teams", String(team.id)),
        { ...team, updatedAt: fb.serverTimestamp() }
      )
    ));
    console.log(`[v1→v2] Migrated ${legacyTeams.length} teams for uid=${uid}`);
    return legacyTeams;
  } catch(e) { console.warn("migrateV1toV2 error:", e); return []; }
}

/**
 * v2 → v3: For each team doc that still has an embedded players array,
 *          write each player as an individual document in the players subcollection,
 *          then remove the players array from the team doc.
 *          Idempotent: safe to call multiple times.
 */
async function migrateV2toV3(uid) {
  const fb = getFirebase(); if (!fb) return;
  try {
    const col = fb.collection(fb.db, "users", uid, "teams");
    const snap = await fb.getDocs(col);
    if (snap.empty) return;

    await Promise.all(snap.docs.map(async teamDoc => {
      const teamData = teamDoc.data();
      const embeddedPlayers = teamData.players;
      if (!Array.isArray(embeddedPlayers) || embeddedPlayers.length === 0) return;

      // Write each player to subcollection
      await Promise.all(embeddedPlayers.map(p =>
        fb.setDoc(
          fb.doc(fb.db, "users", uid, "teams", String(teamData.id), "players", String(p.id)),
          { ...p, updatedAt: fb.serverTimestamp() }
        )
      ));

      // Remove embedded players array from team doc (keep all other fields)
      const { players: _p, ...teamMeta } = teamData;
      await fb.setDoc(
        fb.doc(fb.db, "users", uid, "teams", String(teamData.id)),
        { ...teamMeta, updatedAt: fb.serverTimestamp() }
      );
      console.log(`[v2→v3] Migrated ${embeddedPlayers.length} players for team ${teamData.id}`);
    }));
  } catch(e) { console.warn("migrateV2toV3 error:", e); }
}


/**
 * v3 → v4: Move embedded `lineup` array + `formation` from each team doc
 *          into an individual lineup document in the lineups subcollection.
 *          Sets isActive=true and type="titular" on the migrated lineup.
 *          Idempotent: skips teams that already have lineup docs.
 */
async function migrateV3toV4(uid) {
  const fb = getFirebase(); if (!fb) return;
  try {
    const col = fb.collection(fb.db, "users", uid, "teams");
    const snap = await fb.getDocs(col);
    if (snap.empty) return;

    await Promise.all(snap.docs.map(async teamDoc => {
      const teamData = teamDoc.data();
      // Check if lineups subcollection already has docs (already migrated)
      const lineupCol = fb.collection(fb.db, "users", uid, "teams", String(teamData.id), "lineups");
      const lineupSnap = await fb.getDocs(lineupCol);
      if (!lineupSnap.empty) return; // already migrated

      // Build a lineup doc from embedded fields
      const lineupId = String(Date.now() + Math.random());
      const lineupDoc = {
        id: lineupId,
        name: "Titular",
        type: "titular",
        formation: teamData.formation || "4-4-2",
        entries: Array.isArray(teamData.lineup) ? teamData.lineup : [],
        isActive: true,
        updatedAt: fb.serverTimestamp(),
      };

      // Write lineup to subcollection
      await fb.setDoc(
        fb.doc(fb.db, "users", uid, "teams", String(teamData.id), "lineups", lineupId),
        lineupDoc
      );

      // Update team doc: set activeLineupId, remove embedded lineup/formation
      const { lineup: _l, ...teamMeta } = teamData;
      await fb.setDoc(
        fb.doc(fb.db, "users", uid, "teams", String(teamData.id)),
        { ...teamMeta, activeLineupId: lineupId, updatedAt: fb.serverTimestamp() }
      );
      console.log(`[v3→v4] Migrated lineup for team ${teamData.id} → lineup ${lineupId}`);
    }));
  } catch(e) { console.warn("migrateV3toV4 error:", e); }
}

/**
 * Full init routine: check schema, run any pending migrations, load all teams+players+lineups.
 * Returns { teams: Array, migrated: boolean }
 */
async function initTeamsFromCloud(uid) {
  const version = await getSchemaVersion(uid);
  let migrated = false;

  if (version < 2) {
    await migrateV1toV2(uid);
    migrated = true;
  }
  if (version < 3) {
    await migrateV2toV3(uid);
    migrated = true;
  }
  if (version < 4) {
    await migrateV3toV4(uid);
    await setSchemaVersion(uid, SCHEMA_VERSION);
    migrated = true;
  }

  const teams = await loadAllTeamsFull(uid);
  return { teams: teams || [], migrated };
}

// ── Batch save helpers ────────────────────────────────────────────────────────

/**
 * Save team metadata + all its players + all lineups to cloud.
 * Used for force-save and initial push from localStorage.
 */
async function saveTeamWithPlayersCloud(uid, team) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    // Save team metadata (no players/lineup arrays)
    const teamOk = await saveTeamCloud(uid, team);
    if (!teamOk) return false;
    // Save each player individually
    const playerResults = await Promise.all(
      (team.players || []).map(p => savePlayerCloud(uid, team.id, p))
    );
    // Save each lineup individually
    const lineupResults = await Promise.all(
      (team.lineups || []).map(l => saveLineupCloud(uid, team.id, l))
    );
    return [...playerResults, ...lineupResults].every(Boolean);
  } catch(e) { console.warn("saveTeamWithPlayersCloud error:", e); return false; }
}

/** Force-save all teams and all their players. */
async function saveAllTeamsCloud(uid, teams) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    const results = await Promise.all(teams.map(t => saveTeamWithPlayersCloud(uid, t)));
    return results.every(Boolean);
  } catch(e) { console.warn("saveAllTeamsCloud error:", e); return false; }
}

// ── Team Sharing via invite code ──────────────────────────────────────────────
// Structure: shared_teams/{code} → { ownerUid, ownerName, teamSnapshot, expiresAt, createdAt }
// teamSnapshot = { meta, players, lineups, matches, stats }
// Codes expire after 24h. Anyone who has the code can read and import a copy.

function generateShareCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I,O,0,1 for readability
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

/** Publish a team snapshot to shared_teams/{code}. Returns the code or null on error. */
async function publishTeamShare(uid, userName, team, options = {}) {
  // options: { includeStats, includeMatches, includeLineups }
  const fb = getFirebase(); if (!fb) return null;
  try {
    // For collab teams, players/lineups live in collab_teams/{id}/* not users/{uid}/teams/{id}/*
    const isCollab = !!team.isCollab;

    // Load full data — collab teams use their own loaders
    let players, lineups, matches, stats;
    if (isCollab) {
      const [pSnap, lSnap, mSnap, sSnap] = await Promise.all([
        fb.getDocs(fb.collection(fb.db, "collab_teams", String(team.id), "players")),
        options.includeLineups ? fb.getDocs(fb.collection(fb.db, "collab_teams", String(team.id), "lineups")) : Promise.resolve(null),
        options.includeMatches ? fb.getDocs(fb.collection(fb.db, "collab_teams", String(team.id), "matches")) : Promise.resolve(null),
        options.includeStats   ? fb.getDocs(fb.collection(fb.db, "collab_teams", String(team.id), "stats"))   : Promise.resolve(null),
      ]);
      players = pSnap.docs.map(d => d.data());
      lineups = lSnap ? lSnap.docs.map(d => d.data()) : [];
      matches = mSnap ? mSnap.docs.map(d => d.data()) : [];
      // stats subcollection → object keyed by playerId
      stats = sSnap ? Object.fromEntries(sSnap.docs.map(d => [d.id, d.data()])) : {};
    } else {
      [players, lineups, matches, stats] = await Promise.all([
        loadPlayersCloud(uid, team.id, { force: true }),
        options.includeLineups ? loadLineupsCloud(uid, team.id, { force: true }) : Promise.resolve([]),
        options.includeMatches ? loadMatchesCloud(uid, team.id) : Promise.resolve([]),
        options.includeStats   ? loadAllStatsCloud(uid, team.id) : Promise.resolve({}),
      ]);
      // Fallback to in-memory players if cloud returned empty (e.g. not yet synced)
      if (!players || players.length === 0) {
        players = team.players || [];
      }
    }

    // Strip photo data URLs (too large) from players to keep doc lean
    const safePlayers = (players || []).map(p => ({ ...p, photo: p.photo && p.photo.startsWith("data:") ? "" : (p.photo || "") }));

    const code = generateShareCode();
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24h

    // Team meta — strip all collab/owner fields so the copy is standalone
    const { players: _p, lineups: _l, lineup: _li, isCollab: _ic, ownerUid: _ou, _collabMigrated: _cm, ...teamMeta } = team;

    const snapshot = {
      meta: teamMeta,
      players: safePlayers,
      lineups: options.includeLineups ? (lineups || []) : [],
      matches: options.includeMatches ? (matches || []) : [],
      stats:   options.includeStats   ? (stats || {}) : {},
    };

    await fb.setDoc(fb.doc(fb.db, "shared_teams", code), {
      ownerUid: uid,
      ownerName: userName || "Usuário",
      teamName: team.name || "Time",
      teamSnapshot: JSON.stringify(snapshot),
      expiresAt,
      createdAt: fb.serverTimestamp(),
    });

    return code;
  } catch(e) { console.warn("publishTeamShare error:", e); return null; }
}

/** Fetch a share doc by code. Returns null if not found or expired. */
async function fetchTeamShare(code) {
  const fb = getFirebase(); if (!fb) return null;
  try {
    const snap = await fb.getDoc(fb.doc(fb.db, "shared_teams", code.trim().toUpperCase()));
    if (!snap.exists()) return null;
    const data = snap.data();
    if (data.expiresAt && Date.now() > data.expiresAt) return null; // expired
    return { ...data, teamSnapshot: JSON.parse(data.teamSnapshot || "{}") };
  } catch(e) { console.warn("fetchTeamShare error:", e); return null; }
}

/** Import a shared team snapshot into the current user's account. */
async function importTeamShare(uid, shareData, options = {}) {
  // options: { includeStats, includeMatches, includeLineups }
  const fb = getFirebase(); if (!fb) return false;
  try {
    const snap = shareData.teamSnapshot;
    const newTeamId = String(Date.now());
    const now = fb.serverTimestamp();

    // Remap IDs: players get new IDs (preserve mapping for stats/lineups)
    const idMap = {}; // oldPlayerId → newPlayerId
    const newPlayers = (snap.players || []).map(p => {
      const newId = String(Date.now() + Math.random()).replace(".","");
      idMap[String(p.id)] = newId;
      return { ...p, id: newId };
    });

    // Team meta with new id + name suffix — strip all collab fields so the copy is fully standalone
    const { isCollab: _ic, ownerUid: _ou, _collabMigrated: _cm, activeLineupId: _al, ...cleanMeta } = snap.meta || {};
    const newMeta = {
      ...cleanMeta,
      id: newTeamId,
      name: (snap.meta?.name || "Time") + " (cópia)",
      isCollab: false,
      updatedAt: now,
    };

    // Save team doc
    await fb.setDoc(fb.doc(fb.db, "users", uid, "teams", newTeamId), newMeta);

    // Save players
    await Promise.all(newPlayers.map(p =>
      fb.setDoc(fb.doc(fb.db, "users", uid, "teams", newTeamId, "players", String(p.id)), { ...p, updatedAt: now })
    ));

    // Lineups (remap player ids inside entries)
    let activeLineupId = null;
    if (options.includeLineups && (snap.lineups || []).length > 0) {
      const newLineups = snap.lineups.map(l => {
        const newLid = String(Date.now() + Math.random()).replace(".","");
        if (l.isActive) activeLineupId = newLid;
        return {
          ...l,
          id: newLid,
          entries: (l.entries || []).map(e => ({ ...e, playerId: idMap[String(e.playerId)] || e.playerId })),
          benchPlayerIds: (l.benchPlayerIds || []).map(pid => idMap[String(pid)] || pid),
          updatedAt: now,
        };
      });
      await Promise.all(newLineups.map(l =>
        fb.setDoc(fb.doc(fb.db, "users", uid, "teams", newTeamId, "lineups", String(l.id)), l)
      ));
      if (activeLineupId) {
        await fb.setDoc(fb.doc(fb.db, "users", uid, "teams", newTeamId), { activeLineupId }, { merge: true });
      }
    }

    // Matches (remap player ids in scorers/assisters/gkGoalsConceded/presentPlayerIds)
    if (options.includeMatches && (snap.matches || []).length > 0) {
      await Promise.all(snap.matches.map(m => {
        const newMatch = {
          ...m,
          id: String(Date.now() + Math.random()).replace(".",""),
          scorers: (m.scorers || []).map(pid => idMap[String(pid)] || pid),
          assisters: (m.assisters || []).map(pid => idMap[String(pid)] || pid),
          presentPlayerIds: (m.presentPlayerIds || []).map(pid => idMap[String(pid)] || pid),
          gkGoalsConceded: Object.fromEntries(
            Object.entries(m.gkGoalsConceded || {}).map(([k,v]) => [idMap[k] || k, v])
          ),
          updatedAt: now,
        };
        return fb.setDoc(fb.doc(fb.db, "users", uid, "teams", newTeamId, "matches", String(newMatch.id)), newMatch);
      }));
    }

    // Stats (remap player ids)
    if (options.includeStats && Object.keys(snap.stats || {}).length > 0) {
      await Promise.all(Object.entries(snap.stats).map(([oldPid, statData]) => {
        const newPid = idMap[oldPid] || oldPid;
        return fb.setDoc(
          fb.doc(fb.db, "users", uid, "teams", newTeamId, "stats", newPid),
          { ...statData, playerId: newPid, updatedAt: now }
        );
      }));
    }

    return newTeamId;
  } catch(e) { console.warn("importTeamShare error:", e); return false; }
}

// ─── Collaborative Teams ──────────────────────────────────────────────────────
// Times colaborativos ficam em uma coleção separada para que qualquer membro
// possa ler e escrever sem precisar de acesso à coleção users/ de outra pessoa.
//
// Estrutura Firestore:
//   collab_teams/{teamId}                    → metadados do time + ownerUid + members map
//   collab_teams/{teamId}/players/{id}       → jogadores (mesmo schema de users/.../players)
//   collab_teams/{teamId}/lineups/{id}       → escalações
//   collab_teams/{teamId}/matches/{id}       → partidas
//   collab_teams/{teamId}/stats/{id}         → estatísticas
//   collab_teams/{teamId}/members/{uid}      → { uid, name, email, role, joinedAt }
//   collab_invites/{code}                    → { teamId, teamName, ownerUid, ownerName, createdAt }
//   users/{uid}/collab_refs/{teamId}         → { teamId, role } ← índice por usuário

function collabTeamRef(teamId) {
  const fb = getFirebase(); if (!fb) return null;
  return fb.doc(fb.db, "collab_teams", String(teamId));
}
function collabSubRef(teamId, sub, docId) {
  const fb = getFirebase(); if (!fb) return null;
  return fb.doc(fb.db, "collab_teams", String(teamId), sub, String(docId));
}
function collabSubCol(teamId, sub) {
  const fb = getFirebase(); if (!fb) return null;
  return fb.collection(fb.db, "collab_teams", String(teamId), sub);
}

/** Marca o time como colaborativo e cria documento em collab_teams/. */
async function createCollabTeam(ownerUid, ownerUser, team) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    const teamId = String(team.id);
    const { players: _p, lineups: _ls, lineup: _l, ...teamMeta } = team;
    const now = fb.serverTimestamp();

    // Documento principal do time
    await fb.setDoc(fb.doc(fb.db, "collab_teams", teamId), {
      ...teamMeta,
      isCollab: true,
      ownerUid,
      updatedAt: now,
    });

    // Membro dono
    await fb.setDoc(fb.doc(fb.db, "collab_teams", teamId, "members", ownerUid), {
      uid: ownerUid,
      name: ownerUser.displayName || ownerUser.email || "Dono",
      email: ownerUser.email || "",
      role: "owner",
      joinedAt: now,
    });

    // Índice reverso no perfil do dono
    await fb.setDoc(fb.doc(fb.db, "users", ownerUid, "collab_refs", teamId), {
      teamId, role: "owner", joinedAt: now,
    });

    // Migrar jogadores, escalações E estatísticas existentes
    const [players, lineups, stats] = await Promise.all([
      loadPlayersCloud(ownerUid, teamId, { force: true }),
      loadLineupsCloud(ownerUid, teamId, { force: true }),
      loadAllStatsCloud(ownerUid, teamId),
    ]);
    await Promise.all([
      ...(players || []).map(p =>
        fb.setDoc(fb.doc(fb.db, "collab_teams", teamId, "players", String(p.id)), { ...p, updatedAt: now })
      ),
      ...(lineups || []).map(l =>
        fb.setDoc(fb.doc(fb.db, "collab_teams", teamId, "lineups", String(l.id)), { ...l, updatedAt: now })
      ),
      // Migrar stats: objeto { playerId: {goals, assists, ...} }
      ...Object.values(stats || {}).map(s =>
        fb.setDoc(fb.doc(fb.db, "collab_teams", teamId, "stats", String(s.playerId)), { ...s, updatedAt: now })
      ),
    ]);

    // Marcar o time pessoal original como migrado para não aparecer duplicado na lista.
    // O doc em users/{uid}/teams/{teamId} continua existindo como backup mas é filtrado
    // pelo app via o flag _collabMigrated.
    await fb.setDoc(
      fb.doc(fb.db, "users", ownerUid, "teams", teamId),
      { _collabMigrated: true },
      { merge: true }
    );

    return true;
  } catch(e) { console.warn("createCollabTeam error:", e); return false; }
}

/**
 * Copia stats e partidas do path pessoal (users/{uid}/teams/{id}/*) para
 * collab_teams/{id}/*. Usado para times que foram ativados como colaborativos
 * antes do fix que migrava esses dados automaticamente.
 * Seguro de rodar múltiplas vezes (setDoc é idempotente).
 */
async function recoverCollabData(ownerUid, teamId) {
  const fb = getFirebase(); if (!fb) return { stats: 0, matches: 0 };
  try {
    const [stats, matches] = await Promise.all([
      loadAllStatsCloud(ownerUid, teamId),
      loadMatchesCloud(ownerUid, teamId),
    ]);
    const now = fb.serverTimestamp();
    const ops = [
      ...Object.values(stats || {}).map(s =>
        fb.setDoc(
          fb.doc(fb.db, "collab_teams", String(teamId), "stats", String(s.playerId)),
          { ...s, updatedAt: now }
        )
      ),
      ...(matches || []).map(m =>
        fb.setDoc(
          fb.doc(fb.db, "collab_teams", String(teamId), "matches", String(m.id)),
          { ...m, updatedAt: now }
        )
      ),
    ];
    if (ops.length === 0) return { stats: 0, matches: 0 };
    await Promise.all(ops);
    const nStats = Object.keys(stats || {}).length;
    const nMatches = (matches || []).length;
    console.log(`[recoverCollabData] stats=${nStats} partidas=${nMatches} → collab_teams/${teamId}`);
    return { stats: nStats, matches: nMatches };
  } catch(e) { console.warn("recoverCollabData error:", e); return { stats: 0, matches: 0 }; }
}

/** Gera e salva um código de convite para o time colaborativo. */
async function createCollabInvite(teamId, teamName, ownerUid, ownerName) {
  const fb = getFirebase(); if (!fb) return null;
  try {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "C"; // prefixo "C" para distinguir de convites de cópia
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    await fb.setDoc(fb.doc(fb.db, "collab_invites", code), {
      teamId: String(teamId),
      teamName: teamName || "Time",
      ownerUid,
      ownerName: ownerName || "Usuário",
      createdAt: fb.serverTimestamp(),
    });
    return code;
  } catch(e) { console.warn("createCollabInvite error:", e); return null; }
}

/** Busca convite colaborativo por código. */
async function fetchCollabInvite(code) {
  const fb = getFirebase(); if (!fb) return null;
  try {
    const snap = await fb.getDoc(fb.doc(fb.db, "collab_invites", code.trim().toUpperCase()));
    if (!snap.exists()) return null;
    return snap.data();
  } catch(e) { console.warn("fetchCollabInvite error:", e); return null; }
}

/** Aceita convite e adiciona o usuário como membro editor do time colaborativo. */
async function acceptCollabInvite(inviteData, uid, user) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    const { teamId } = inviteData;
    const now = fb.serverTimestamp();

    // Verifica se já é membro
    // Verificar via índice reverso (users/ é acessível pelo próprio usuário)
    const refSnap = await fb.getDoc(fb.doc(fb.db, "users", uid, "collab_refs", teamId));
    if (refSnap.exists()) return "already_member";

    // Adiciona membro editor
    await fb.setDoc(fb.doc(fb.db, "collab_teams", teamId, "members", uid), {
      uid,
      name: user.displayName || user.email || "Editor",
      email: user.email || "",
      role: "editor",
      joinedAt: now,
    });

    // Índice reverso no perfil do editor
    await fb.setDoc(fb.doc(fb.db, "users", uid, "collab_refs", teamId), {
      teamId, role: "editor", joinedAt: now,
    });

    return true;
  } catch(e) { console.warn("acceptCollabInvite error:", e); return false; }
}

/** Remove um membro do time colaborativo (dono pode remover qualquer editor; editor pode sair). */
async function removeCollabMember(teamId, memberUid, byOwner = false) {
  const fb = getFirebase(); if (!fb) return false;
  const tid = String(teamId);
  const muid = String(memberUid);
  try {
    const refPath = fb.doc(fb.db, "users", muid, "collab_refs", tid);

    // Deletar o índice reverso do próprio usuário.
    await fb.deleteDoc(refPath);

    // Verificar que o delete chegou ao servidor — o Firestore com cache offline
    // pode aceitar o delete localmente e falhar silenciosamente no servidor.
    // getDocFromServer ignora o cache e vai direto ao Firestore.
    const check = await fb.getDocFromServer(refPath);
    if (check.exists()) {
      // O doc ainda existe no servidor — o delete não foi aceito.
      console.error("removeCollabMember: collab_ref ainda existe no servidor após delete");
      return false;
    }

    // Remover do doc de membro no time colaborativo (falha silenciosa — regras podem bloquear editores)
    try {
      await fb.deleteDoc(fb.doc(fb.db, "collab_teams", tid, "members", muid));
    } catch(inner) {
      console.warn("removeCollabMember: members doc delete blocked:", inner?.code, inner?.message);
    }
    return true;
  } catch(e) {
    console.error("removeCollabMember failed:", e?.code, e?.message);
    return false;
  }
}

/** Carrega a lista de membros de um time colaborativo. */
async function loadCollabMembers(teamId) {
  const fb = getFirebase(); if (!fb) return [];
  try {
    const snap = await fb.getDocs(collabSubCol(teamId, "members"));
    return snap.docs.map(d => d.data());
  } catch(e) { return []; }
}

/** Carrega todos os teamIds colaborativos que o usuário participa. */
async function loadCollabRefs(uid) {
  const fb = getFirebase(); if (!fb) return [];
  try {
    const col = fb.collection(fb.db, "users", uid, "collab_refs");
    const snap = await fb.getDocs(col);
    return snap.docs.map(d => d.data());
  } catch(e) { return []; }
}

/** Carrega um time colaborativo completo (meta + players + lineups). */
async function loadCollabTeamFull(teamId) {
  const fb = getFirebase(); if (!fb) return null;
  try {
    const [metaSnap, playersSnap, lineupsSnap] = await Promise.all([
      fb.getDoc(fb.doc(fb.db, "collab_teams", String(teamId))),
      fb.getDocs(collabSubCol(teamId, "players")),
      fb.getDocs(collabSubCol(teamId, "lineups")),
    ]);
    if (!metaSnap.exists()) return null;
    const meta = metaSnap.data();
    const players = playersSnap.docs.map(d => d.data()).sort((a, b) => compareIds(a.id, b.id));
    const lineups = lineupsSnap.docs.map(d => d.data());
    const activeLineup = getActiveLineup(meta, lineups);
    return {
      ...meta,
      players,
      lineups,
      formation: activeLineup?.formation || meta.formation || "4-4-2",
      lineup: activeLineup?.entries || [],
      isCollab: true,
    };
  } catch(e) { console.warn("loadCollabTeamFull error:", e); return null; }
}

// ── Collab CRUD — gravação nas subcoleções de collab_teams/ ──────────────────

async function saveCollabTeamMeta(team) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    const { players: _p, lineups: _ls, lineup: _l, ...meta } = team;
    await fb.setDoc(fb.doc(fb.db, "collab_teams", String(team.id)),
      { ...meta, updatedAt: fb.serverTimestamp() }, { merge: true });
    return true;
  } catch(e) { console.warn("saveCollabTeamMeta error:", e); return false; }
}

async function saveCollabPlayer(teamId, player) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    await fb.setDoc(
      fb.doc(fb.db, "collab_teams", String(teamId), "players", String(player.id)),
      { ...player, updatedAt: fb.serverTimestamp() }
    );
    return true;
  } catch(e) { console.warn("saveCollabPlayer error:", e); return false; }
}

async function deleteCollabPlayer(teamId, playerId) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    await fb.deleteDoc(fb.doc(fb.db, "collab_teams", String(teamId), "players", String(playerId)));
    return true;
  } catch(e) { return false; }
}

async function saveCollabLineup(teamId, lineup) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    await fb.setDoc(
      fb.doc(fb.db, "collab_teams", String(teamId), "lineups", String(lineup.id)),
      { ...lineup, updatedAt: fb.serverTimestamp() }
    );
    return true;
  } catch(e) { console.warn("saveCollabLineup error:", e); return false; }
}

async function deleteCollabLineup(teamId, lineupId) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    await fb.deleteDoc(fb.doc(fb.db, "collab_teams", String(teamId), "lineups", String(lineupId)));
    return true;
  } catch(e) { return false; }
}

async function saveCollabMatch(teamId, match) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    await fb.setDoc(
      fb.doc(fb.db, "collab_teams", String(teamId), "matches", String(match.id)),
      { ...match, updatedAt: fb.serverTimestamp() }
    );
    return true;
  } catch(e) { return false; }
}

async function deleteCollabMatch(teamId, matchId) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    await fb.deleteDoc(fb.doc(fb.db, "collab_teams", String(teamId), "matches", String(matchId)));
    return true;
  } catch(e) { return false; }
}

async function saveCollabStat(teamId, stat) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    await fb.setDoc(
      fb.doc(fb.db, "collab_teams", String(teamId), "stats", String(stat.playerId)),
      { ...stat, updatedAt: fb.serverTimestamp() }
    );
    return true;
  } catch(e) { return false; }
}

/** Desativa a colaboração: migra dados de volta para users/{uid}/teams e remove collab_teams.
 *  Diferente de deleteCollabTeam, NÃO apaga jogadores/escalações/stats/partidas.
 *  Os dados são copiados de volta para o path pessoal antes de remover o collab. */
async function deactivateCollabTeam(teamId, ownerUid) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    const now = fb.serverTimestamp();
    const tid = String(teamId);

    // 1. Carregar todos os dados do collab para migrar de volta
    const [playersSnap, lineupsSnap, statsSnap, matchesSnap, membersSnap] = await Promise.all([
      fb.getDocs(fb.collection(fb.db, "collab_teams", tid, "players")),
      fb.getDocs(fb.collection(fb.db, "collab_teams", tid, "lineups")),
      fb.getDocs(fb.collection(fb.db, "collab_teams", tid, "stats")),
      fb.getDocs(fb.collection(fb.db, "collab_teams", tid, "matches")),
      fb.getDocs(fb.collection(fb.db, "collab_teams", tid, "members")),
    ]);

    // 2. Copiar de volta para users/{uid}/teams/{teamId}/*
    const writes = [];
    playersSnap.docs.forEach(d => writes.push(
      fb.setDoc(fb.doc(fb.db, "users", ownerUid, "teams", tid, "players", d.id), { ...d.data(), updatedAt: now })
    ));
    lineupsSnap.docs.forEach(d => writes.push(
      fb.setDoc(fb.doc(fb.db, "users", ownerUid, "teams", tid, "lineups", d.id), { ...d.data(), updatedAt: now })
    ));
    statsSnap.docs.forEach(d => writes.push(
      fb.setDoc(fb.doc(fb.db, "users", ownerUid, "teams", tid, "stats", d.id), { ...d.data(), updatedAt: now })
    ));
    matchesSnap.docs.forEach(d => writes.push(
      fb.setDoc(fb.doc(fb.db, "users", ownerUid, "teams", tid, "matches", d.id), { ...d.data(), updatedAt: now })
    ));
    await Promise.all(writes);

    // 3. Remover o flag _collabMigrated do time pessoal para ele voltar a aparecer
    await fb.setDoc(
      fb.doc(fb.db, "users", ownerUid, "teams", tid),
      { _collabMigrated: false, isCollab: false },
      { merge: true }
    );

    // 4. Remover collab_refs de todos os membros
    const memberUids = membersSnap.docs.map(d => d.id);
    await Promise.all(memberUids.map(mUid =>
      fb.deleteDoc(fb.doc(fb.db, "users", mUid, "collab_refs", tid))
    ));

    // 5. Deletar subcoleções do collab (dados já foram copiados)
    const allDocs = [
      ...playersSnap.docs, ...lineupsSnap.docs,
      ...statsSnap.docs, ...matchesSnap.docs, ...membersSnap.docs,
    ];
    const CHUNK = 400;
    for (let i = 0; i < allDocs.length; i += CHUNK) {
      const batch = fb.writeBatch(fb.db);
      allDocs.slice(i, i + CHUNK).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }

    // 6. Deletar o documento raiz do collab
    await fb.deleteDoc(fb.doc(fb.db, "collab_teams", tid));

    return true;
  } catch(e) { console.warn("deactivateCollabTeam error:", e); return false; }
}

/** Cancela colaboração: remove o time colaborativo para todos (apenas dono pode). */
async function deleteCollabTeam(teamId, ownerUid) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    // Remover refs de todos os membros
    const membersSnap = await fb.getDocs(collabSubCol(teamId, "members"));
    await Promise.all(membersSnap.docs.map(d =>
      fb.deleteDoc(fb.doc(fb.db, "users", d.id, "collab_refs", teamId))
    ));
    // Deletar subcoleções (players, lineups, matches, stats, members)
    for (const sub of ["players","lineups","matches","stats","members"]) {
      const subSnap = await fb.getDocs(collabSubCol(teamId, sub));
      const CHUNK = 400;
      for (let i = 0; i < subSnap.docs.length; i += CHUNK) {
        const batch = fb.writeBatch(fb.db);
        subSnap.docs.slice(i, i + CHUNK).forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    }
    await fb.deleteDoc(fb.doc(fb.db, "collab_teams", teamId));
    return true;
  } catch(e) { console.warn("deleteCollabTeam error:", e); return false; }
}

// ── Hook: sincronização em tempo real de um time colaborativo ─────────────────
// Usado no App para receber updates de outros membros instantaneamente.
// Retorna função de cleanup (unsub).
function subscribeCollabTeam(teamId, onUpdate) {
  const fb = getFirebase(); if (!fb) return () => {};
  const unsubMeta = fb.onSnapshot(
    fb.doc(fb.db, "collab_teams", String(teamId)),
    metaDoc => {
      if (!metaDoc.exists()) {
        // Time foi encerrado pelo dono — notificar o App para remover da lista
        onUpdate({ type: "deleted" });
        return;
      }
      onUpdate({ type: "meta", data: metaDoc.data() });
    },
    () => {}
  );
  const unsubPlayers = fb.onSnapshot(
    fb.collection(fb.db, "collab_teams", String(teamId), "players"),
    snap => {
      const players = snap.docs.map(d => d.data()).sort((a, b) => compareIds(a.id, b.id));
      onUpdate({ type: "players", data: players });
    },
    () => {}
  );
  const unsubLineups = fb.onSnapshot(
    fb.collection(fb.db, "collab_teams", String(teamId), "lineups"),
    snap => {
      const lineups = snap.docs.map(d => d.data());
      onUpdate({ type: "lineups", data: lineups });
    },
    () => {}
  );
  return () => { unsubMeta(); unsubPlayers(); unsubLineups(); };
}

// ── Modal: Ativar colaboração em um time próprio ──────────────────────────────
function EnableCollabModal({ team, user, onClose, onEnabled }) {
  const [step, setStep] = useState("confirm"); // confirm | loading | done | error
  const handleEnable = async () => {
    setStep("loading");
    const ok = await createCollabTeam(user.uid, user, team);
    if (ok) { setStep("done"); }
    else setStep("error");
  };
  return (
    <div style={{position:"fixed",inset:0,zIndex:1200,display:"flex",alignItems:"flex-end",justifyContent:"center",background:"rgba(0,0,0,0.85)",backdropFilter:"blur(6px)"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#0a1628",border:"1px solid rgba(59,130,246,0.25)",borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"24px 20px 40px",display:"flex",flexDirection:"column",gap:18}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#fff",letterSpacing:1}}>ATIVAR COLABORAÇÃO</span>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer",fontSize:20}}>✕</button>
        </div>

        {step==="confirm"&&(<>
          <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",background:"rgba(59,130,246,0.06)",borderRadius:13,border:"1px solid rgba(59,130,246,0.2)"}}>
            <TeamShield team={team} size={44}/>
            <div>
              <div style={{color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:17,letterSpacing:0.5}}>{team.name}</div>
              <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:11}}>{(team.players||[]).length} jogadores · {team.formation}</div>
            </div>
          </div>

          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {[
              {icon:"👥", title:"Edição em tempo real", desc:"Todos os membros veem as alterações instantaneamente, sem precisar recarregar."},
              {icon:"🔗", title:"Código de convite permanente", desc:"Gere um código e envie para quem quiser. Revogue quando quiser."},
              {icon:"⚡", title:"Sincronização automática", desc:"Qualquer mudança em jogadores, escalações e partidas se propaga para todos."},
            ].map(({icon,title,desc})=>(
              <div key={title} style={{display:"flex",gap:12,padding:"10px 12px",background:"rgba(255,255,255,0.03)",borderRadius:11,border:"1px solid rgba(255,255,255,0.06)"}}>
                <span style={{fontSize:20,lineHeight:1.4}}>{icon}</span>
                <div>
                  <div style={{color:"#e5e7eb",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700}}>{title}</div>
                  <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11,marginTop:2,lineHeight:1.5}}>{desc}</div>
                </div>
              </div>
            ))}
          </div>

          <div style={{padding:"10px 12px",background:"rgba(250,204,21,0.06)",borderRadius:10,border:"1px solid rgba(250,204,21,0.15)"}}>
            <div style={{color:"#fbbf24",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,marginBottom:2}}>⚠️ Atenção</div>
            <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11,lineHeight:1.5}}>Seus dados existentes (jogadores, escalações) serão copiados para o espaço colaborativo. O time original em sua conta permanece como backup.</div>
          </div>

          <button onClick={handleEnable} style={{padding:"14px 0",borderRadius:13,border:"none",cursor:"pointer",background:"linear-gradient(135deg,#1e3a8a,#3b82f6)",color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:17,letterSpacing:1.5,boxShadow:"0 6px 20px rgba(59,130,246,0.35)"}}>
            ATIVAR COLABORAÇÃO
          </button>
        </>)}

        {step==="loading"&&(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:14,padding:"30px 0"}}>
            <div style={{width:40,height:40,border:"3px solid rgba(59,130,246,0.2)",borderTopColor:"#3b82f6",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
            <span style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13}}>Ativando colaboração...</span>
          </div>
        )}

        {step==="done"&&(<>
          <div style={{textAlign:"center",padding:"16px 0"}}>
            <div style={{fontSize:52,marginBottom:12}}>🤝</div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#fff",letterSpacing:1,marginBottom:6}}>COLABORAÇÃO ATIVADA!</div>
            <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13,lineHeight:1.6,maxWidth:300,margin:"0 auto"}}>
              Agora você pode convidar outros usuários para editar o time junto com você em tempo real.
            </div>
          </div>
          <button onClick={()=>{ onEnabled && onEnabled(); onClose(); }} style={{padding:"14px 0",borderRadius:13,border:"none",cursor:"pointer",background:"linear-gradient(135deg,#1e3a8a,#3b82f6)",color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:17,letterSpacing:1.5}}>
            IR PARA O TIME
          </button>
        </>)}

        {step==="error"&&(<>
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:"#f87171",letterSpacing:1,marginBottom:6}}>ERRO AO ATIVAR</div>
            <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:12}}>Verifique sua conexão e tente novamente.</div>
          </div>
          <button onClick={()=>setStep("confirm")} style={{padding:"13px 0",borderRadius:12,border:"none",cursor:"pointer",background:"rgba(255,255,255,0.06)",color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700}}>Tentar novamente</button>
        </>)}
      </div>
    </div>
  );
}

// ── Modal: Gerenciar convite colaborativo ─────────────────────────────────────
function CollabInviteModal({ team, user, onClose, onBeforeDeactivate, onDeactivated, onEnabled }) {
  const [step, setStep] = useState("loading"); // loading | ready | error | deactivating | activating
  const [code, setCode] = useState("");
  const [members, setMembers] = useState([]);
  const [copied, setCopied] = useState(false);
  const [removingUid, setRemovingUid] = useState(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [collabActive, setCollabActive] = useState(!!team.isCollab);
  const isOwner = team.ownerUid === user.uid;

  useEffect(() => {
    if (!collabActive) return;
    const fb = getFirebase(); if (!fb) { setStep("error"); return; }
    const unsub = fb.onSnapshot(
      fb.collection(fb.db, "collab_teams", String(team.id), "members"),
      snap => { setMembers(snap.docs.map(d => d.data())); setStep("ready"); },
      () => setStep("error")
    );
    return () => unsub();
  }, [team.id, collabActive]);

  const handleGenerateCode = async () => {
    setStep("loading");
    const c = await createCollabInvite(team.id, team.name, user.uid, user.displayName || user.email);
    if (c) { setCode(c); setStep("ready"); }
    else setStep("error");
  };

  const handleRevokeCode = async () => {
    if (!code) return;
    const fb = getFirebase(); if (!fb) return;
    try { await fb.deleteDoc(fb.doc(fb.db, "collab_invites", code)); } catch {}
    setCode("");
  };

  const handleCopy = async () => {
    const msg = `Oi! Te convido para coeditar o time *${team.name}* no Escalação FC 🤝\nCódigo colaborativo: *${code}*\nAbra o app → Importar time → cole o código.`;
    try {
      if (navigator.share) await navigator.share({ title: "Escalação FC", text: msg });
      else { await navigator.clipboard.writeText(msg); setCopied(true); setTimeout(() => setCopied(false), 2500); }
    } catch {
      try { await navigator.clipboard.writeText(msg); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch {}
    }
  };

  const handleRemove = async (mUid) => {
    setRemovingUid(mUid);
    await removeCollabMember(team.id, mUid);
    setMembers(prev => prev.filter(m => m.uid !== mUid));
    setRemovingUid(null);
    if (mUid === user.uid) onClose();
  };

  const handleDeactivate = async () => {
    setConfirmDeactivate(false);
    setStep("deactivating");
    // CRÍTICO: parar o listener em tempo real ANTES de deletar o doc no Firestore.
    // Sem isso, o onSnapshot dispara "deleted" → remove o time do array → tela preta.
    if (onBeforeDeactivate) onBeforeDeactivate();
    // Revogar código de convite ativo
    if (code) {
      const fb = getFirebase();
      if (fb) { try { await fb.deleteDoc(fb.doc(fb.db, "collab_invites", code)); } catch {} }
    }
    const ok = await deactivateCollabTeam(team.id, user.uid);
    if (ok) {
      setCollabActive(false);
      setCode("");
      setMembers([]);
      setStep("ready");
      if (onDeactivated) onDeactivated();
    } else {
      setStep("error");
    }
  };

  const handleActivate = async () => {
    setStep("activating");
    if (!team?.id) { setStep("error"); return; }
    const fb = getFirebase(); if (!fb) { setStep("error"); return; }
    try {
      const now = fb.serverTimestamp();
      const tid = String(team.id);
      const uid = user.uid;

      // 1. Criar / atualizar doc raiz do collab
      const { players: _p, lineups: _l, lineup: _li, ...teamMeta } = team;
      await fb.setDoc(fb.doc(fb.db, "collab_teams", tid), {
        ...teamMeta,
        isCollab: true,
        ownerUid: uid,
        updatedAt: now,
      }, { merge: true });

      // 2. Copiar jogadores e escalações do path pessoal para as subcoleções do collab.
      //    Necessário para reativações (segunda, terceira vez...) onde as subcoleções
      //    foram deletadas pela desativação anterior.
      const [personalPlayersSnap, personalLineupsSnap, personalStatsSnap, personalMatchesSnap] = await Promise.all([
        fb.getDocs(fb.collection(fb.db, "users", uid, "teams", tid, "players")),
        fb.getDocs(fb.collection(fb.db, "users", uid, "teams", tid, "lineups")),
        fb.getDocs(fb.collection(fb.db, "users", uid, "teams", tid, "stats")),
        fb.getDocs(fb.collection(fb.db, "users", uid, "teams", tid, "matches")),
      ]);
      const copyWrites = [];
      personalPlayersSnap.docs.forEach(d => copyWrites.push(
        fb.setDoc(fb.doc(fb.db, "collab_teams", tid, "players", d.id), { ...d.data(), updatedAt: now })
      ));
      personalLineupsSnap.docs.forEach(d => copyWrites.push(
        fb.setDoc(fb.doc(fb.db, "collab_teams", tid, "lineups", d.id), { ...d.data(), updatedAt: now })
      ));
      personalStatsSnap.docs.forEach(d => copyWrites.push(
        fb.setDoc(fb.doc(fb.db, "collab_teams", tid, "stats", d.id), { ...d.data(), updatedAt: now })
      ));
      personalMatchesSnap.docs.forEach(d => copyWrites.push(
        fb.setDoc(fb.doc(fb.db, "collab_teams", tid, "matches", d.id), { ...d.data(), updatedAt: now })
      ));
      await Promise.all(copyWrites);

      // 3. Adicionar dono como membro
      await fb.setDoc(fb.doc(fb.db, "collab_teams", tid, "members", uid), {
        uid,
        name: user.displayName || user.email || "Dono",
        email: user.email || "",
        role: "owner",
        joinedAt: now,
      });

      // 4. Marcar time pessoal como migrado e criar collab_ref
      await fb.setDoc(fb.doc(fb.db, "users", uid, "teams", tid), { isCollab: true, _collabMigrated: true }, { merge: true });
      await fb.setDoc(fb.doc(fb.db, "users", uid, "collab_refs", tid), { teamId: tid, role: "owner", joinedAt: now });

      setCollabActive(true);
      if (onEnabled) onEnabled();
    } catch(e) {
      console.warn("handleActivate error:", e);
      setStep("error");
    }
  };

  const roleLabel = { owner: "Dono", editor: "Editor" };
  const roleColor = { owner: "#f59e0b", editor: "#60a5fa" };

  return (
    <div style={{position:"fixed",inset:0,zIndex:1200,display:"flex",alignItems:"flex-end",justifyContent:"center",background:"rgba(0,0,0,0.85)",backdropFilter:"blur(6px)"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#0a1628",border:"1px solid rgba(59,130,246,0.25)",borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"22px 20px 40px",display:"flex",flexDirection:"column",gap:16,maxHeight:"85vh",overflowY:"auto"}}>

        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:"#fff",letterSpacing:1}}>COLABORAÇÃO</span>
            <div style={{color:"#3b82f6",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,marginTop:1}}>{team.name}</div>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer",fontSize:20}}>✕</button>
        </div>

        {/* Toggle ativar/desativar — apenas dono, quando não está em loading */}
        {isOwner && step !== "loading" && step !== "deactivating" && step !== "activating" && (
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{
              display:"flex",alignItems:"center",gap:6,padding:"5px 12px",borderRadius:8,flexShrink:0,
              background: collabActive ? "rgba(52,211,153,0.1)" : "rgba(107,114,128,0.1)",
              border: collabActive ? "1px solid rgba(52,211,153,0.3)" : "1px solid rgba(107,114,128,0.25)",
              color: collabActive ? "#34d399" : "#6B7280",
              fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,
            }}>
              <span style={{width:7,height:7,borderRadius:"50%",background: collabActive ? "#34d399" : "#6B7280",display:"inline-block"}}/>
              {collabActive ? "Ativa" : "Inativa"}
            </div>
            {collabActive ? (
              <button onClick={() => setConfirmDeactivate(true)}
                style={{flex:1,padding:"8px 0",borderRadius:9,border:"1px solid rgba(239,68,68,0.3)",background:"rgba(239,68,68,0.08)",color:"#f87171",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700}}>
                🔒 Desativar colaboração
              </button>
            ) : (
              <button onClick={handleActivate}
                style={{flex:1,padding:"8px 0",borderRadius:9,border:"none",background:"linear-gradient(135deg,#1e3a8a,#3b82f6)",color:"#fff",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700,boxShadow:"0 3px 12px rgba(59,130,246,0.3)"}}>
                🤝 Ativar colaboração
              </button>
            )}
          </div>
        )}

        {/* Confirmação de desativação */}
        {confirmDeactivate && (
          <div style={{background:"rgba(239,68,68,0.07)",border:"1px solid rgba(239,68,68,0.25)",borderRadius:12,padding:"14px 16px",display:"flex",flexDirection:"column",gap:10}}>
            <div style={{color:"#f87171",fontFamily:"'Bebas Neue',sans-serif",fontSize:15,letterSpacing:0.5}}>DESATIVAR COLABORAÇÃO?</div>
            <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:12,lineHeight:1.5}}>
              Todos os colaboradores serão desvinculados. O time voltará a ser somente seu, com todos os dados preservados.
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setConfirmDeactivate(false)} style={{flex:1,padding:"10px 0",borderRadius:10,border:"1px solid rgba(255,255,255,0.1)",background:"transparent",color:"#9CA3AF",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:600}}>Cancelar</button>
              <button onClick={handleDeactivate} style={{flex:1,padding:"10px 0",borderRadius:10,border:"none",background:"linear-gradient(135deg,#dc2626,#ef4444)",color:"#fff",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700}}>Desativar</button>
            </div>
          </div>
        )}

        {/* Spinner */}
        {(step==="loading"||step==="deactivating"||step==="activating")&&(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"30px 0",gap:10}}>
            <div style={{width:36,height:36,border:"3px solid rgba(59,130,246,0.2)",borderTopColor:"#3b82f6",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
            <span style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:12}}>
              {step==="deactivating"?"Desativando colaboração...":step==="activating"?"Ativando colaboração...":"Carregando..."}
            </span>
          </div>
        )}

        {/* Mensagem quando desativada */}
        {step==="ready" && !collabActive && (
          <div style={{textAlign:"center",padding:"16px 0",color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:13}}>
            A colaboração está desativada. O time é somente seu.
          </div>
        )}

        {step==="ready" && collabActive &&(<>
          {/* Membros */}
          <div>
            <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>
              Membros ({members.length})
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {members.map(m => (
                <div key={m.uid} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:"rgba(255,255,255,0.03)",borderRadius:11,border:"1px solid rgba(255,255,255,0.06)"}}>
                  <div style={{width:36,height:36,borderRadius:"50%",background:"rgba(59,130,246,0.15)",border:"1px solid rgba(59,130,246,0.25)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontFamily:"'Bebas Neue',sans-serif",color:"#60a5fa",fontSize:16}}>
                    {(m.name||"?")[0].toUpperCase()}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{color:"#e5e7eb",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.name || "Usuário"}</div>
                    <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:10,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.email || ""}</div>
                  </div>
                  <span style={{padding:"2px 8px",borderRadius:6,background:`${roleColor[m.role]}1a`,border:`1px solid ${roleColor[m.role]}33`,color:roleColor[m.role],fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700,flexShrink:0}}>
                    {roleLabel[m.role] || m.role}
                  </span>
                  {isOwner && m.role !== "owner" && (
                    <button onClick={()=>handleRemove(m.uid)} disabled={removingUid===m.uid} style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.2)",color:"#f87171",borderRadius:7,padding:"4px 8px",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700,flexShrink:0}}>
                      {removingUid===m.uid?"...":"Remover"}
                    </button>
                  )}
                  {!isOwner && m.uid === user.uid && (
                    <button onClick={()=>handleRemove(m.uid)} style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.2)",color:"#f87171",borderRadius:7,padding:"4px 8px",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700,flexShrink:0}}>
                      Sair
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Convite */}
          {isOwner && (
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1}}>Convidar alguém</div>
              {code ? (
                <>
                  <div style={{display:"flex",justifyContent:"center"}}>
                    <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:38,letterSpacing:7,color:"#3b82f6",background:"rgba(59,130,246,0.08)",border:"2px dashed rgba(59,130,246,0.35)",borderRadius:14,padding:"12px 24px",textAlign:"center"}}>{code}</div>
                  </div>
                  <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:11,textAlign:"center"}}>Envie este código para o outro usuário. Ele não expira até você revogar.</div>
                  <button onClick={handleCopy} style={{padding:"13px 0",borderRadius:12,border:"1px solid rgba(59,130,246,0.35)",cursor:"pointer",background:copied?"rgba(59,130,246,0.2)":"rgba(59,130,246,0.08)",color:"#60a5fa",fontFamily:"'Bebas Neue',sans-serif",fontSize:15,letterSpacing:1}}>
                    {copied?"✓ COPIADO!":"📋 COMPARTILHAR CÓDIGO"}
                  </button>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={handleGenerateCode} style={{flex:1,padding:"10px 0",borderRadius:11,border:"1px solid rgba(255,255,255,0.08)",background:"transparent",color:"#4B5563",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:600}}>
                      Gerar novo
                    </button>
                    <button onClick={handleRevokeCode} style={{flex:1,padding:"10px 0",borderRadius:11,border:"1px solid rgba(239,68,68,0.2)",background:"rgba(239,68,68,0.06)",color:"#f87171",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:600}}>
                      Revogar
                    </button>
                  </div>
                </>
              ) : (
                <button onClick={handleGenerateCode} style={{padding:"13px 0",borderRadius:12,border:"none",cursor:"pointer",background:"linear-gradient(135deg,#1e3a8a,#3b82f6)",color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:16,letterSpacing:1.5,boxShadow:"0 4px 16px rgba(59,130,246,0.3)"}}>
                  GERAR CÓDIGO DE CONVITE
                </button>
              )}
            </div>
          )}
        </>)}

        {step==="error"&&(
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <div style={{color:"#f87171",fontFamily:"'Bebas Neue',sans-serif",fontSize:16,letterSpacing:1}}>ERRO AO CARREGAR</div>
            <button onClick={()=>{setStep("loading");}} style={{marginTop:12,padding:"10px 20px",borderRadius:10,border:"none",cursor:"pointer",background:"rgba(255,255,255,0.06)",color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:12}}>Tentar novamente</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Modal: Entrar em time colaborativo por código ─────────────────────────────
function JoinCollabModal({ user, onClose, onJoined, initialCode, isPremium, collabMemberCount }) {
  const [code, setCode] = useState(initialCode || "");
  const [step, setStep] = useState(initialCode && initialCode.length >= 7 ? "loading" : "input");
  const [invite, setInvite] = useState(null);
  const [errMsg, setErrMsg] = useState("");

  // Auto-buscar se veio com código pré-preenchido
  useEffect(() => {
    if (initialCode && initialCode.length >= 7) handleLookup(initialCode);
  }, []);

  const handleLookup = async (overrideCode) => {
    const q = (overrideCode || code).trim().toUpperCase();
    if (q.length < 7) return; // "C" + 6 chars
    setCode(q);
    setStep("loading");
    const data = await fetchCollabInvite(q);
    if (!data) { setErrMsg("Código colaborativo não encontrado. Verifique e tente novamente."); setStep("error"); return; }
    setInvite(data);
    setStep("preview");
  };

  const handleJoin = async () => {
    setStep("joining");
    const result = await acceptCollabInvite(invite, user.uid, user);
    if (result === "already_member") { setStep("already"); return; }
    if (result) { setStep("done"); }
    else { setErrMsg("Erro ao entrar no time. Verifique sua conexão."); setStep("error"); }
  };

  return (
    <div style={{position:"fixed",inset:0,zIndex:1200,display:"flex",alignItems:"flex-end",justifyContent:"center",background:"rgba(0,0,0,0.85)",backdropFilter:"blur(6px)"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#0a1628",border:"1px solid rgba(59,130,246,0.25)",borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"22px 20px 40px",display:"flex",flexDirection:"column",gap:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#fff",letterSpacing:1}}>ENTRAR EM TIME</span>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer",fontSize:20}}>✕</button>
        </div>

        {!isPremium&&(collabMemberCount||0)>=1&&(
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <div style={{fontSize:40,marginBottom:12}}>🔒</div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:"#fbbf24",letterSpacing:1,marginBottom:8}}>LIMITE DO PLANO GRATUITO</div>
            <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13,lineHeight:1.6,maxWidth:300,margin:"0 auto"}}>No plano gratuito você pode participar de apenas 1 time colaborativo. Faça upgrade para o premium e entre em quantos times quiser.</div>
            <button onClick={onClose} style={{marginTop:20,padding:"12px 24px",borderRadius:12,border:"none",cursor:"pointer",background:"rgba(255,255,255,0.06)",color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700}}>Fechar</button>
          </div>
        )}
        {(isPremium||(collabMemberCount||0)<1)&&step==="input"&&(<>
          <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13,lineHeight:1.6}}>
            Insira o código colaborativo recebido do dono do time. Você poderá editar o time em tempo real junto com os outros membros.
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            <label style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1}}>Código colaborativo</label>
            <input
              value={code}
              onChange={e=>setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,7))}
              placeholder="Ex: CABC123"
              maxLength={7}
              style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(59,130,246,0.25)",borderRadius:12,padding:"12px 14px",color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:26,letterSpacing:6,textAlign:"center",colorScheme:"dark",outline:"none"}}
              onFocus={e=>e.target.style.borderColor="#3b82f6"}
              onBlur={e=>e.target.style.borderColor="rgba(59,130,246,0.25)"}
              autoCapitalize="characters"
            />
            <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:10,textAlign:"center"}}>Códigos colaborativos começam com a letra C</div>
          </div>
          <button onClick={()=>handleLookup()} disabled={code.length<7} style={{padding:"14px 0",borderRadius:13,border:"none",cursor:code.length<7?"default":"pointer",background:code.length<7?"rgba(255,255,255,0.06)":"linear-gradient(135deg,#1e3a8a,#3b82f6)",color:code.length<7?"#4B5563":"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:17,letterSpacing:1.5}}>
            BUSCAR TIME
          </button>
        </>)}

        {(step==="loading"||step==="joining")&&(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:14,padding:"30px 0"}}>
            <div style={{width:40,height:40,border:"3px solid rgba(59,130,246,0.2)",borderTopColor:"#3b82f6",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
            <span style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13}}>{step==="loading"?"Buscando time...":"Entrando no time..."}</span>
          </div>
        )}

        {step==="preview"&&invite&&(<>
          <div style={{padding:"14px",background:"rgba(59,130,246,0.06)",borderRadius:13,border:"1px solid rgba(59,130,246,0.2)"}}>
            <div style={{color:"#60a5fa",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,marginBottom:6}}>🤝 TIME COLABORATIVO ENCONTRADO</div>
            <div style={{color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:22,letterSpacing:0.5,marginBottom:4}}>{invite.teamName}</div>
            <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11}}>Dono: {invite.ownerName}</div>
          </div>

          <div style={{padding:"10px 12px",background:"rgba(52,211,153,0.06)",borderRadius:10,border:"1px solid rgba(52,211,153,0.15)"}}>
            <div style={{color:"#34d399",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,marginBottom:2}}>✅ O que você poderá fazer</div>
            <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11,lineHeight:1.6}}>
              Adicionar/editar jogadores · Criar escalações · Registrar partidas · Ver estatísticas — tudo em tempo real com os outros membros.
            </div>
          </div>

          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>setStep("input")} style={{flex:1,padding:"12px 0",borderRadius:11,border:"1px solid rgba(255,255,255,0.12)",background:"rgba(255,255,255,0.04)",color:"#9CA3AF",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700}}>Voltar</button>
            <button onClick={handleJoin} style={{flex:2,padding:"12px 0",borderRadius:11,border:"none",cursor:"pointer",background:"linear-gradient(135deg,#1e3a8a,#3b82f6)",color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:16,letterSpacing:1,boxShadow:"0 4px 14px rgba(59,130,246,0.3)"}}>ENTRAR NO TIME</button>
          </div>
        </>)}

        {step==="done"&&(<>
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <div style={{fontSize:52,marginBottom:12}}>🤝</div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#fff",letterSpacing:1,marginBottom:6}}>VOCÊ ENTROU NO TIME!</div>
            <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13,lineHeight:1.6}}>
              "{invite?.teamName}" foi adicionado à sua lista. Todas as edições são sincronizadas em tempo real.
            </div>
          </div>
          <button onClick={()=>{ onJoined && onJoined(invite?.teamId); onClose(); }} style={{padding:"14px 0",borderRadius:13,border:"none",cursor:"pointer",background:"linear-gradient(135deg,#1e3a8a,#3b82f6)",color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:17,letterSpacing:1.5}}>VER TIMES</button>
        </>)}

        {step==="already"&&(<>
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <div style={{fontSize:44,marginBottom:12}}>🏆</div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:"#fff",letterSpacing:1,marginBottom:6}}>VOCÊ JÁ É MEMBRO</div>
            <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13}}>Você já participa deste time colaborativo.</div>
          </div>
          <button onClick={onClose} style={{padding:"13px 0",borderRadius:12,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.04)",color:"#9CA3AF",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700}}>Fechar</button>
        </>)}

        {step==="error"&&(<>
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:"#f87171",letterSpacing:1,marginBottom:6}}>OPS!</div>
            <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13}}>{errMsg}</div>
          </div>
          <button onClick={()=>setStep("input")} style={{padding:"13px 0",borderRadius:12,border:"none",cursor:"pointer",background:"rgba(255,255,255,0.06)",color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700}}>Tentar novamente</button>
        </>)}
      </div>
    </div>
  );
}

// ─── Collaborative Agendas ────────────────────────────────────────────────────
// Estrutura Firestore:
//   collab_agendas/{agendaId}                       → metadados + ownerUid + isCollab:true
//   collab_agendas/{agendaId}/mensalidades/{mesAno} → pagamentos do mês
//   collab_agendas/{agendaId}/members/{uid}         → { uid, name, email, role, joinedAt }
//   collab_agenda_invites/{code}                    → { agendaId, agendaName, ownerUid, ownerName }
//   users/{uid}/collab_agenda_refs/{agendaId}       → { agendaId, role }

async function createCollabAgenda(ownerUid, ownerUser, agenda) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    const agendaId = String(agenda.id);
    const now = fb.serverTimestamp();
    const { players: _p, ...agendaMeta } = agenda;
    await fb.setDoc(fb.doc(fb.db, "collab_agendas", agendaId), {
      ...agendaMeta, isCollab: true, ownerUid, updatedAt: now,
    });

    // Copiar mensalidades existentes do path pessoal para o collab.
    // Necessário para que dados já registrados apareçam ao ativar a colaboração.
    const personalMensSnap = await fb.getDocs(
      fb.collection(fb.db, "users", ownerUid, "mensalistas", agendaId, "mensalidades")
    );
    if (!personalMensSnap.empty) {
      await Promise.all(personalMensSnap.docs.map(d =>
        fb.setDoc(fb.doc(fb.db, "collab_agendas", agendaId, "mensalidades", d.id), { ...d.data(), updatedAt: now })
      ));
    }

    await fb.setDoc(fb.doc(fb.db, "collab_agendas", agendaId, "members", ownerUid), {
      uid: ownerUid, name: ownerUser.displayName || ownerUser.email || "Dono",
      email: ownerUser.email || "", role: "owner", joinedAt: now,
    });
    await fb.setDoc(fb.doc(fb.db, "users", ownerUid, "collab_agenda_refs", agendaId), {
      agendaId, role: "owner", joinedAt: now,
    });
    // Marcar agenda pessoal como migrada para não duplicar na lista
    await fb.setDoc(fb.doc(fb.db, "users", ownerUid, "mensalistas", agendaId), { _collabMigrated: true }, { merge: true });
    return true;
  } catch(e) { console.warn("createCollabAgenda error:", e); return false; }
}

/** Desativa colaboração da agenda: copia mensalidades de volta para o path pessoal,
 *  remove membros e deleta o doc collab. Espelho de deactivateCollabTeam. */
async function deactivateCollabAgenda(agendaId, ownerUid) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    const aid = String(agendaId);
    const now = fb.serverTimestamp();

    // 1. Carregar dados do collab para migrar de volta
    const [mensSnap, membersSnap] = await Promise.all([
      fb.getDocs(fb.collection(fb.db, "collab_agendas", aid, "mensalidades")),
      fb.getDocs(fb.collection(fb.db, "collab_agendas", aid, "members")),
    ]);

    // 2. Copiar mensalidades de volta para o path pessoal do dono
    if (!mensSnap.empty) {
      await Promise.all(mensSnap.docs.map(d =>
        fb.setDoc(
          fb.doc(fb.db, "users", ownerUid, "mensalistas", aid, "mensalidades", d.id),
          { ...d.data(), updatedAt: now }
        )
      ));
    }

    // 3. Marcar agenda pessoal como não-collab
    await fb.setDoc(
      fb.doc(fb.db, "users", ownerUid, "mensalistas", aid),
      { isCollab: false, _collabMigrated: false },
      { merge: true }
    );

    // 4. Remover collab_agenda_refs de todos os membros
    await Promise.all(membersSnap.docs.map(d =>
      fb.deleteDoc(fb.doc(fb.db, "users", d.id, "collab_agenda_refs", aid))
    ));

    // 5. Deletar subcoleções do collab em batch
    const allDocs = [...mensSnap.docs, ...membersSnap.docs];
    const CHUNK = 400;
    for (let i = 0; i < allDocs.length; i += CHUNK) {
      const batch = fb.writeBatch(fb.db);
      allDocs.slice(i, i + CHUNK).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }

    // 6. Deletar doc raiz do collab
    await fb.deleteDoc(fb.doc(fb.db, "collab_agendas", aid));

    return true;
  } catch(e) { console.warn("deactivateCollabAgenda error:", e); return false; }
}

/** Desativa todas as agendas colaborativas que o usuário possui (usado no downgrade). */
async function deactivateAllOwnedCollabAgendas(uid) {
  const fb = getFirebase(); if (!fb) return;
  try {
    const snap = await fb.getDocs(fb.collection(fb.db, "users", uid, "mensalistas"));
    const owned = snap.docs.filter(d => { const data = d.data(); return data.isCollab && data.ownerUid === uid; });
    if (owned.length > 0) await Promise.all(owned.map(d => deactivateCollabAgenda(d.id, uid)));
  } catch(e) { console.warn("deactivateAllOwnedCollabAgendas error:", e); }
}

async function createCollabAgendaInvite(agendaId, agendaName, ownerUid, ownerName) {
  const fb = getFirebase(); if (!fb) return null;
  try {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "A";
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    await fb.setDoc(fb.doc(fb.db, "collab_agenda_invites", code), {
      agendaId: String(agendaId), agendaName: agendaName || "Agenda",
      ownerUid, ownerName: ownerName || "Usuario", createdAt: fb.serverTimestamp(),
    });
    return code;
  } catch(e) { console.warn("createCollabAgendaInvite error:", e); return null; }
}

async function fetchCollabAgendaInvite(code) {
  const fb = getFirebase(); if (!fb) return null;
  try {
    const snap = await fb.getDoc(fb.doc(fb.db, "collab_agenda_invites", code.trim().toUpperCase()));
    if (!snap.exists()) return null;
    return snap.data();
  } catch(e) { return null; }
}

async function acceptCollabAgendaInvite(inviteData, uid, user) {
  const fb = getFirebase(); if (!fb) return false;
  const agendaId = inviteData.agendaId;
  const now = fb.serverTimestamp();
  try {
    const refSnapA = await fb.getDoc(fb.doc(fb.db, "users", uid, "collab_agenda_refs", agendaId));
    if (refSnapA.exists()) return "already_member";
  } catch(e) { console.warn("acceptCollabAgendaInvite check error:", e); return false; }
  try {
    await fb.setDoc(fb.doc(fb.db, "collab_agendas", agendaId, "members", uid), {
      uid, name: user.displayName || user.email || "Editor",
      email: user.email || "", role: "editor", joinedAt: now,
    });
  } catch(e) { console.warn("acceptCollabAgendaInvite members write error:", e); return false; }
  try {
    await fb.setDoc(fb.doc(fb.db, "users", uid, "collab_agenda_refs", agendaId), {
      agendaId, role: "editor", joinedAt: now,
    });
  } catch(e) {
    // Membro foi adicionado mas ref local falhou — limpar para evitar estado parcial
    console.warn("acceptCollabAgendaInvite collab_agenda_refs write error:", e);
    try { await fb.deleteDoc(fb.doc(fb.db, "collab_agendas", agendaId, "members", uid)); } catch {}
    return false;
  }
  return true;
}

async function removeCollabAgendaMember(agendaId, memberUid) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    await fb.deleteDoc(fb.doc(fb.db, "collab_agendas", agendaId, "members", memberUid));
    await fb.deleteDoc(fb.doc(fb.db, "users", memberUid, "collab_agenda_refs", agendaId));
    return true;
  } catch(e) { return false; }
}

async function loadCollabAgendaMembers(agendaId) {
  const fb = getFirebase(); if (!fb) return [];
  try {
    const snap = await fb.getDocs(fb.collection(fb.db, "collab_agendas", agendaId, "members"));
    return snap.docs.map(d => d.data());
  } catch(e) { return []; }
}

async function loadCollabAgendaRefs(uid) {
  const fb = getFirebase(); if (!fb) return [];
  try {
    const col = fb.collection(fb.db, "users", uid, "collab_agenda_refs");
    const snap = await fb.getDocs(col);
    return snap.docs.map(d => d.data());
  } catch(e) { return []; }
}

async function loadCollabAgenda(agendaId) {
  const fb = getFirebase(); if (!fb) return null;
  try {
    const snap = await fb.getDoc(fb.doc(fb.db, "collab_agendas", String(agendaId)));
    if (!snap.exists()) return null;
    return { id: snap.id, ...snap.data(), isCollab: true };
  } catch(e) { return null; }
}

async function saveCollabAgendaMeta(agendaId, data) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    await fb.setDoc(fb.doc(fb.db, "collab_agendas", String(agendaId)),
      { ...data, updatedAt: fb.serverTimestamp() }, { merge: true });
    return true;
  } catch(e) { return false; }
}

async function deleteCollabAgenda(agendaId) {
  const fb = getFirebase(); if (!fb) return false;
  try {
    const membersSnap = await fb.getDocs(fb.collection(fb.db, "collab_agendas", agendaId, "members"));
    await Promise.all(membersSnap.docs.map(d =>
      fb.deleteDoc(fb.doc(fb.db, "users", d.id, "collab_agenda_refs", agendaId))
    ));
    for (const sub of ["members","mensalidades"]) {
      const subSnap = await fb.getDocs(fb.collection(fb.db, "collab_agendas", agendaId, sub));
      const CHUNK = 400;
      for (let i = 0; i < subSnap.docs.length; i += CHUNK) {
        const batch = fb.writeBatch(fb.db);
        subSnap.docs.slice(i, i + CHUNK).forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    }
    await fb.deleteDoc(fb.doc(fb.db, "collab_agendas", agendaId));
    return true;
  } catch(e) { console.warn("deleteCollabAgenda error:", e); return false; }
}

// Retorna o path de mensalidade correto (pessoal ou collab)
function mensalidadePath(uid, agendaId, mesAnoKey, isCollab) {
  return isCollab
    ? "collab_agendas/" + agendaId + "/mensalidades/" + mesAnoKey
    : "users/" + uid + "/mensalistas/" + agendaId + "/mensalidades/" + mesAnoKey;
}

// Local fallback (used while offline / before auth)
const STORAGE_KEY = "escalacao_fc_v6";
function loadDataLocal() {
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function saveDataLocal(d) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); } catch {}
}

// ─── 16 Formations ───────────────────────────────────────────────────────────
const FORMATIONS = {
  "4-4-2": { slots:[
    {id:0,label:"GOL",x:50,y:88},
    {id:1,label:"LE",x:14,y:73},{id:2,label:"ZAG",x:36,y:73},{id:3,label:"ZAG",x:64,y:73},{id:4,label:"LD",x:86,y:73},
    {id:5,label:"ME",x:14,y:52},{id:6,label:"MC",x:36,y:52},{id:7,label:"MC",x:64,y:52},{id:8,label:"MD",x:86,y:52},
    {id:9,label:"CA",x:36,y:26},{id:10,label:"CA",x:64,y:26},
  ]},
  "4-3-3": { slots:[
    {id:0,label:"GOL",x:50,y:88},
    {id:1,label:"LE",x:14,y:73},{id:2,label:"ZAG",x:36,y:73},{id:3,label:"ZAG",x:64,y:73},{id:4,label:"LD",x:86,y:73},
    {id:5,label:"VOL",x:26,y:54},{id:6,label:"MC",x:50,y:54},{id:7,label:"MC",x:74,y:54},
    {id:8,label:"PE",x:16,y:26},{id:9,label:"CA",x:50,y:22},{id:10,label:"PD",x:84,y:26},
  ]},
  "4-2-3-1": { slots:[
    {id:0,label:"GOL",x:50,y:88},
    {id:1,label:"LE",x:14,y:73},{id:2,label:"ZAG",x:36,y:73},{id:3,label:"ZAG",x:64,y:73},{id:4,label:"LD",x:86,y:73},
    {id:5,label:"VOL",x:35,y:60},{id:6,label:"VOL",x:65,y:60},
    {id:7,label:"ME",x:14,y:42},{id:8,label:"MAT",x:50,y:40},{id:9,label:"MD",x:86,y:42},
    {id:10,label:"CA",x:50,y:22},
  ]},
  "4-1-4-1": { slots:[
    {id:0,label:"GOL",x:50,y:88},
    {id:1,label:"LE",x:14,y:73},{id:2,label:"ZAG",x:36,y:73},{id:3,label:"ZAG",x:64,y:73},{id:4,label:"LD",x:86,y:73},
    {id:5,label:"VOL",x:50,y:62},
    {id:6,label:"ME",x:10,y:46},{id:7,label:"MC",x:33,y:46},{id:8,label:"MC",x:67,y:46},{id:9,label:"MD",x:90,y:46},
    {id:10,label:"CA",x:50,y:22},
  ]},
  "4-5-1": { slots:[
    {id:0,label:"GOL",x:50,y:88},
    {id:1,label:"LE",x:14,y:73},{id:2,label:"ZAG",x:36,y:73},{id:3,label:"ZAG",x:64,y:73},{id:4,label:"LD",x:86,y:73},
    {id:5,label:"ME",x:10,y:51},{id:6,label:"VOL",x:30,y:51},{id:7,label:"MC",x:50,y:51},{id:8,label:"VOL",x:70,y:51},{id:9,label:"MD",x:90,y:51},
    {id:10,label:"CA",x:50,y:24},
  ]},
  "4-4-2 ◆": { slots:[
    {id:0,label:"GOL",x:50,y:88},
    {id:1,label:"LE",x:14,y:73},{id:2,label:"ZAG",x:36,y:73},{id:3,label:"ZAG",x:64,y:73},{id:4,label:"LD",x:86,y:73},
    {id:5,label:"VOL",x:50,y:61},
    {id:6,label:"MC",x:22,y:49},{id:7,label:"MC",x:78,y:49},
    {id:8,label:"MAT",x:50,y:37},
    {id:9,label:"CA",x:36,y:24},{id:10,label:"CA",x:64,y:24},
  ]},
  "4-3-2-1": { slots:[
    {id:0,label:"GOL",x:50,y:88},
    {id:1,label:"LE",x:14,y:73},{id:2,label:"ZAG",x:36,y:73},{id:3,label:"ZAG",x:64,y:73},{id:4,label:"LD",x:86,y:73},
    {id:5,label:"VOL",x:24,y:57},{id:6,label:"MC",x:50,y:57},{id:7,label:"VOL",x:76,y:57},
    {id:8,label:"MAT",x:35,y:39},{id:9,label:"MAT",x:65,y:39},
    {id:10,label:"CA",x:50,y:22},
  ]},
  "3-5-2": { slots:[
    {id:0,label:"GOL",x:50,y:88},
    {id:1,label:"ZAG",x:22,y:73},{id:2,label:"ZAG",x:50,y:73},{id:3,label:"ZAG",x:78,y:73},
    {id:4,label:"AD",x:9,y:52},{id:5,label:"VOL",x:29,y:52},{id:6,label:"MC",x:50,y:52},{id:7,label:"VOL",x:71,y:52},{id:8,label:"AE",x:91,y:52},
    {id:9,label:"CA",x:36,y:26},{id:10,label:"CA",x:64,y:26},
  ]},
  "3-4-3": { slots:[
    {id:0,label:"GOL",x:50,y:88},
    {id:1,label:"ZAG",x:22,y:73},{id:2,label:"ZAG",x:50,y:73},{id:3,label:"ZAG",x:78,y:73},
    {id:4,label:"ME",x:14,y:54},{id:5,label:"MC",x:37,y:54},{id:6,label:"MC",x:63,y:54},{id:7,label:"MD",x:86,y:54},
    {id:8,label:"PE",x:16,y:26},{id:9,label:"CA",x:50,y:22},{id:10,label:"PD",x:84,y:26},
  ]},
  "3-4-1-2": { slots:[
    {id:0,label:"GOL",x:50,y:88},
    {id:1,label:"ZAG",x:22,y:73},{id:2,label:"ZAG",x:50,y:73},{id:3,label:"ZAG",x:78,y:73},
    {id:4,label:"ME",x:14,y:57},{id:5,label:"MC",x:37,y:57},{id:6,label:"MC",x:63,y:57},{id:7,label:"MD",x:86,y:57},
    {id:8,label:"MAT",x:50,y:40},
    {id:9,label:"CA",x:36,y:24},{id:10,label:"CA",x:64,y:24},
  ]},
  "3-6-1": { slots:[
    {id:0,label:"GOL",x:50,y:88},
    {id:1,label:"ZAG",x:22,y:73},{id:2,label:"ZAG",x:50,y:73},{id:3,label:"ZAG",x:78,y:73},
    {id:4,label:"ME",x:9,y:55},{id:5,label:"VOL",x:27,y:55},{id:6,label:"MC",x:45,y:55},{id:7,label:"MC",x:63,y:55},{id:8,label:"VOL",x:81,y:55},{id:9,label:"MD",x:91,y:55},
    {id:10,label:"CA",x:50,y:24},
  ]},
  "5-3-2": { slots:[
    {id:0,label:"GOL",x:50,y:88},
    {id:1,label:"LE",x:9,y:73},{id:2,label:"ZAG",x:27,y:73},{id:3,label:"ZAG",x:50,y:73},{id:4,label:"ZAG",x:73,y:73},{id:5,label:"LD",x:91,y:73},
    {id:6,label:"MC",x:24,y:52},{id:7,label:"MC",x:50,y:52},{id:8,label:"MC",x:76,y:52},
    {id:9,label:"CA",x:36,y:26},{id:10,label:"CA",x:64,y:26},
  ]},
  "5-4-1": { slots:[
    {id:0,label:"GOL",x:50,y:88},
    {id:1,label:"LE",x:9,y:73},{id:2,label:"ZAG",x:27,y:73},{id:3,label:"ZAG",x:50,y:73},{id:4,label:"ZAG",x:73,y:73},{id:5,label:"LD",x:91,y:73},
    {id:6,label:"ME",x:14,y:52},{id:7,label:"MC",x:37,y:52},{id:8,label:"MC",x:63,y:52},{id:9,label:"MD",x:86,y:52},
    {id:10,label:"CA",x:50,y:24},
  ]},
  "5-2-3": { slots:[
    {id:0,label:"GOL",x:50,y:88},
    {id:1,label:"LE",x:9,y:73},{id:2,label:"ZAG",x:27,y:73},{id:3,label:"ZAG",x:50,y:73},{id:4,label:"ZAG",x:73,y:73},{id:5,label:"LD",x:91,y:73},
    {id:6,label:"VOL",x:35,y:57},{id:7,label:"VOL",x:65,y:57},
    {id:8,label:"PE",x:16,y:28},{id:9,label:"CA",x:50,y:23},{id:10,label:"PD",x:84,y:28},
  ]},
  "4-3-3 ◆": { slots:[
    {id:0,label:"GOL",x:50,y:88},
    {id:1,label:"LE",x:14,y:73},{id:2,label:"ZAG",x:36,y:73},{id:3,label:"ZAG",x:64,y:73},{id:4,label:"LD",x:86,y:73},
    {id:5,label:"VOL",x:50,y:62},
    {id:6,label:"MC",x:32,y:48},{id:7,label:"MC",x:68,y:48},
    {id:8,label:"PE",x:16,y:28},{id:9,label:"CA",x:50,y:23},{id:10,label:"PD",x:84,y:28},
  ]},
  "2-3-5": { slots:[
    {id:0,label:"GOL",x:50,y:88},
    {id:1,label:"ZAG",x:32,y:76},{id:2,label:"ZAG",x:68,y:76},
    {id:3,label:"MC",x:22,y:60},{id:4,label:"VOL",x:50,y:60},{id:5,label:"MC",x:78,y:60},
    {id:6,label:"PD",x:9,y:30},{id:7,label:"MA",x:29,y:26},{id:8,label:"CA",x:50,y:22},{id:9,label:"MA",x:71,y:26},{id:10,label:"PE",x:91,y:30},
  ]},
};
const FKEYS = Object.keys(FORMATIONS);

function migrateLineup(oldLineup, oldSlots, newSlots) {
  const result = [];
  oldLineup.forEach(entry => {
    const oldIdx = oldSlots.findIndex(s => s.id === entry.slotId);
    if (oldIdx >= 0 && oldIdx < newSlots.length) {
      result.push({ slotId: newSlots[oldIdx].id, playerId: entry.playerId });
    }
  });
  return result;
}

const POSITIONS = ["Goleiro","Lateral Direito","Lateral Esquerdo","Zagueiro","Volante","Meio-campo","Meia Atacante","Ponta Direita","Ponta Esquerda","Centroavante","Atacante","Segundo Volante","Líbero"];

const PLAYER_STATUSES = [
  { id:"active",    label:"Ativo",      icon:"active",    color:"#34d399" },
  { id:"injured",   label:"Lesionado",  icon:"injured",   color:"#f97316" },
  { id:"suspended", label:"Suspenso",   icon:"suspended", color:"#f87171" },
  { id:"inactive",  label:"Inativo",    icon:"inactive",  color:"#6B7280" },
];
function getPlayerStatus(player) {
  return PLAYER_STATUSES.find(s=>s.id===(player?.status||"active"))||PLAYER_STATUSES[0];
}
const AVATAR_COLORS = ["#1a6b3a","#c8102e","#003087","#6f2c91","#00539f","#e8650a","#b45309","#0e7490","#7c3aed","#be185d"];

// ─── Jersey customization (used as the player avatar when no photo is set) ───
// "solid"/"stripes"/"hoops"/"sleeves" are the free/basic patterns; the rest
// are richer two-tone styles — good premium-pack candidates later.
const JERSEY_PATTERNS = [
  { id:"solid",    name:"Liso" },
  { id:"stripes",  name:"Listrado V" },
  { id:"hoops",    name:"Listrado H" },
  { id:"sleeves",  name:"Gola" },
  { id:"sash",     name:"Faixa" },
  { id:"gradient", name:"Degradê" },
  { id:"halves",   name:"Bipartido V" },
  { id:"halves-h", name:"Bipartido H" },
  { id:"diagonal", name:"Diagonal" },
  { id:"quarters", name:"Xadrez" },
  { id:"ring",     name:"Anel" },
  { id:"dots",     name:"Bolinhas" },
];
const JERSEY_COLOR_SWATCHES = [
  "#1a6b3a","#c8102e","#003087","#6f2c91","#00539f","#e8650a","#b45309","#0e7490","#7c3aed","#be185d",
  "#ffffff","#000000","#facc15","#22c55e","#3b82f6","#f97316","#ec4899","#06b6d4","#94a3b8","#16a34a",
];

// Number font options for jersey numbers — applied to the digit shown on the
// player avatar (screen and export). All loaded via Google Fonts.
const JERSEY_FONTS = [
  { id:"bebas",     name:"Bebas Neue",   family:"'Bebas Neue',sans-serif" },
  { id:"anton",     name:"Anton",        family:"'Anton',sans-serif" },
  { id:"oswald",    name:"Oswald",       family:"'Oswald',sans-serif" },
  { id:"teko",      name:"Teko",         family:"'Teko',sans-serif" },
  { id:"russo",     name:"Russo One",    family:"'Russo One',sans-serif" },
  { id:"archivo",   name:"Archivo Black",family:"'Archivo Black',sans-serif" },
  { id:"squada",    name:"Squada One",   family:"'Squada One',sans-serif" },
  { id:"blackops",  name:"Black Ops One",family:"'Black Ops One',sans-serif" },
  { id:"orbitron",  name:"Orbitron",     family:"'Orbitron',sans-serif" },
  { id:"staatliches",name:"Staatliches", family:"'Staatliches',sans-serif" },
  { id:"bungee",    name:"Bungee",       family:"'Bungee',sans-serif" },
];

/** Returns the default jersey config for a player based on their number (kept stable/backward-compatible with the old solid-color avatar). */
function defaultJersey(number){
  return { pattern:"solid", primary: AVATAR_COLORS[(parseInt(number)||0)%AVATAR_COLORS.length], secondary:"#ffffff", numberFont:"bebas" };
}

/** Returns the CSS font-family stack for a jersey's number font (falls back to Bebas Neue). */
function getJerseyFontFamily(jersey){
  const f=JERSEY_FONTS.find(f=>f.id===jersey?.numberFont);
  return f?f.family:"'Bebas Neue',sans-serif";
}
/** Returns the bare font name (for canvas `ctx.font` strings, no fallback list). */
function getJerseyFontName(jersey){
  const f=JERSEY_FONTS.find(f=>f.id===jersey?.numberFont);
  return f?f.name:"Bebas Neue";
}

/** Converts a "#rrggbb" hex color to an "rgba(r,g,b,a)" string. Used so export
 *  themes can tint glows/borders/halos with their own accent color. */
function hexToRgba(hex,alpha=1){
  const h=(hex||"#34d399").replace("#","");
  const r=parseInt(h.substring(0,2),16),g=parseInt(h.substring(2,4),16),b=parseInt(h.substring(4,6),16);
  return `rgba(${r},${g},${b},${alpha})`;
}


/** Returns a CSS `background` value for a jersey config — used by PlayerAvatar (React). */
function getJerseyBackground(jersey){
  const {pattern="solid",primary="#1a6b3a",secondary="#ffffff"}=jersey||{};
  switch(pattern){
    case "stripes":  return `repeating-linear-gradient(90deg, ${primary} 0 25%, ${secondary} 25% 50%)`;
    case "hoops":    return `repeating-linear-gradient(0deg, ${primary} 0 25%, ${secondary} 25% 50%)`;
    case "sleeves":  return `linear-gradient(to bottom, ${secondary} 0 18%, ${primary} 18% 100%)`;
    case "sash":     return `linear-gradient(135deg, ${primary} 0 38%, ${secondary} 38% 58%, ${primary} 58% 100%)`;
    case "gradient": return `linear-gradient(135deg, ${primary}, ${secondary})`;
    case "halves":   return `linear-gradient(90deg, ${primary} 0 50%, ${secondary} 50% 100%)`;
    case "halves-h": return `linear-gradient(180deg, ${primary} 0 50%, ${secondary} 50% 100%)`;
    case "diagonal": return `linear-gradient(135deg, ${primary} 0 50%, ${secondary} 50% 100%)`;
    case "quarters": return `conic-gradient(from -45deg, ${primary} 0 90deg, ${secondary} 90deg 180deg, ${primary} 180deg 270deg, ${secondary} 270deg 360deg)`;
    case "ring":     return `radial-gradient(circle, ${primary} 0 62%, ${secondary} 62% 100%)`;
    case "dots":     return `radial-gradient(${secondary} 22%, transparent 23%) 0 0/30% 30%, radial-gradient(${secondary} 22%, transparent 23%) 15% 15%/30% 30%, ${primary}`;
    default:         return primary;
  }
}

/**
 * Fills a square area (cx-R..cx+R, cy-R..cy+R) with the jersey pattern —
 * the canvas equivalent of getJerseyBackground(), used during export.
 * Caller is expected to have already clipped to the player avatar circle.
 */
function drawJerseyFill(ctx,cx,cy,R,jersey){
  const {pattern="solid",primary="#1a6b3a",secondary="#ffffff"}=jersey||{};
  const x0=cx-R,y0=cy-R,d=R*2;
  switch(pattern){
    case "stripes": {
      const bw=d/4;
      for(let i=0;i<4;i++){ ctx.fillStyle=i%2===0?primary:secondary; ctx.fillRect(x0+i*bw,y0,bw,d); }
      break;
    }
    case "hoops": {
      const bh=d/4;
      for(let i=0;i<4;i++){ ctx.fillStyle=i%2===0?primary:secondary; ctx.fillRect(x0,y0+i*bh,d,bh); }
      break;
    }
    case "sleeves": {
      ctx.fillStyle=primary; ctx.fillRect(x0,y0,d,d);
      ctx.fillStyle=secondary; ctx.fillRect(x0,y0,d,d*0.18);
      break;
    }
    case "sash": {
      ctx.fillStyle=primary; ctx.fillRect(x0,y0,d,d);
      ctx.save();
      ctx.translate(cx,cy);ctx.rotate(-Math.PI/4);
      ctx.fillStyle=secondary;
      ctx.fillRect(-d,-d*0.18,d*2,d*0.36);
      ctx.restore();
      break;
    }
    case "gradient": {
      const g=ctx.createLinearGradient(x0,y0,x0+d,y0+d);
      g.addColorStop(0,primary);g.addColorStop(1,secondary);
      ctx.fillStyle=g; ctx.fillRect(x0,y0,d,d);
      break;
    }
    case "halves": {
      ctx.fillStyle=primary; ctx.fillRect(x0,y0,d/2,d);
      ctx.fillStyle=secondary; ctx.fillRect(x0+d/2,y0,d/2,d);
      break;
    }
    case "halves-h": {
      ctx.fillStyle=primary; ctx.fillRect(x0,y0,d,d/2);
      ctx.fillStyle=secondary; ctx.fillRect(x0,y0+d/2,d,d/2);
      break;
    }
    case "diagonal": {
      ctx.fillStyle=primary; ctx.fillRect(x0,y0,d,d);
      ctx.fillStyle=secondary;
      ctx.beginPath();
      ctx.moveTo(x0,y0+d);ctx.lineTo(x0+d,y0+d);ctx.lineTo(x0+d,y0);ctx.closePath();
      ctx.fill();
      break;
    }
    case "quarters": {
      const hw=d/2,hh=d/2;
      ctx.fillStyle=primary;   ctx.fillRect(x0,y0,hw,hh);             // top-left
      ctx.fillStyle=secondary; ctx.fillRect(x0+hw,y0,hw,hh);          // top-right
      ctx.fillStyle=secondary; ctx.fillRect(x0,y0+hh,hw,hh);          // bottom-left
      ctx.fillStyle=primary;   ctx.fillRect(x0+hw,y0+hh,hw,hh);       // bottom-right
      break;
    }
    case "ring": {
      ctx.fillStyle=secondary; ctx.fillRect(x0,y0,d,d);
      ctx.fillStyle=primary;
      ctx.beginPath();ctx.arc(cx,cy,R*0.78,0,Math.PI*2);ctx.fill();
      break;
    }
    case "dots": {
      ctx.fillStyle=primary; ctx.fillRect(x0,y0,d,d);
      ctx.fillStyle=secondary;
      const step=d*0.3, rad=d*0.07;
      for(let yy=y0-step;yy<=y0+d+step;yy+=step){
        for(let xx=x0-step;xx<=x0+d+step;xx+=step){
          ctx.beginPath();ctx.arc(xx,yy,rad,0,Math.PI*2);ctx.fill();
          ctx.beginPath();ctx.arc(xx+step/2,yy+step/2,rad,0,Math.PI*2);ctx.fill();
        }
      }
      break;
    }
    default:
      ctx.fillStyle=primary; ctx.fillRect(x0,y0,d,d);
  }
}
const SHIELD_COLORS = [
  // Base set
  ["#16a34a","#22c55e"],["#dc2626","#f87171"],["#2563eb","#60a5fa"],
  ["#7c3aed","#a78bfa"],["#b45309","#fbbf24"],["#0e7490","#22d3ee"],
  ["#be185d","#f472b6"],["#15803d","#4ade80"],
  // Extra set — striking gradients (gold, neon, two-tone) for richer customization
  ["#facc15","#b45309"], // ouro
  ["#0f172a","#facc15"], // preto & dourado
  ["#a3e635","#16a34a"], // verde neon
  ["#06b6d4","#7c3aed"], // ciano-violeta
  ["#f97316","#ec4899"], // pôr do sol
  ["#94a3b8","#475569"], // prata
  ["#10b981","#3b82f6"], // esmeralda-azul
  ["#f43f5e","#0ea5e9"], // carmim-celeste
];

// SVG shield/crest silhouettes (100×100 viewBox). `path` is reused both for
// React <path> elements and for canvas Path2D() during export.
const SHIELD_SHAPES = [
  { id:"shield",       name:"Clássico",  path:"M8,8 H92 V45 C92,72 72,90 50,96 C28,90 8,72 8,45 Z" },
  { id:"shield-round", name:"Brasão",    path:"M50,4 C75,4 92,12 92,30 V55 C92,78 74,94 50,98 C26,94 8,78 8,55 V30 C8,12 25,4 50,4 Z" },
  { id:"crest",        name:"Coroado",   path:"M50,2 C20,2 6,18 6,40 V60 C6,82 26,98 50,98 C74,98 94,82 94,60 V40 C94,18 80,2 50,2 Z" },
  { id:"hexagon",      name:"Hexágono",  path:"M50,2 L94,26 V74 L50,98 L6,74 V26 Z" },
  { id:"pentagon",     name:"Pentágono", path:"M50,2 L96,36 L78,96 L22,96 L4,36 Z" },
  { id:"diamond",      name:"Diamante",  path:"M50,2 L98,50 L50,98 L2,50 Z" },
  { id:"banner",       name:"Bandeira",  path:"M6,4 H94 V70 L72,58 L50,76 L28,58 L6,70 Z" },
  { id:"circle",       name:"Círculo",   path:"M50,2 A48,48 0 1 1 49.99,2 Z" },
];

// ─── Team kits (uniforms) ──────────────────────────────────────────────────────
// A team has a library of "kits" (uniform sets): the 4 standard categories
// (titular/reserva/alternativo/goleiro) plus any number of custom ones the
// user adds. `activeKitId` selects which kit outfield players wear; the
// "goleiro" kit is always used for players whose position is "Goleiro".
function makeDefaultKits(colorIdx=0){
  const [c1,c2]=SHIELD_COLORS[colorIdx%SHIELD_COLORS.length];
  return [
    { id:"titular",     type:"titular",     name:"Titular",     jersey:{pattern:"solid",  primary:c1,        secondary:"#ffffff"} },
    { id:"reserva",     type:"reserva",     name:"Reserva",     jersey:{pattern:"solid",  primary:"#ffffff", secondary:c1} },
    { id:"alternativo", type:"alternativo", name:"Alternativo", jersey:{pattern:"stripes",primary:c1,        secondary:c2} },
    { id:"goleiro",     type:"goleiro",     name:"Goleiro",     jersey:{pattern:"solid",  primary:"#facc15", secondary:"#1f2937"} },
  ];
}

const TEAM_KITS_BRASIL = [
  { file:"fla.png",  name:"Vermelho & Preto RJ" },
  { file:"cor.png",  name:"Timão SP" },
  { file:"pal.png",  name:"Verdão SP" },
  { file:"san.png",  name:"Peixe SP" },
  { file:"sao.png",  name:"Tricolor SP" },
  { file:"int.png",  name:"Colorado RS" },
  { file:"gre.png",  name:"Imortal RS" },
  { file:"cru.png",  name:"Raposa MG" },
  { file:"atlmg.png",name:"Galo MG" },
  { file:"flu.png",  name:"Tricolor RJ" },
  { file:"vas.png",  name:"Cruzmaltino RJ" },
];
const TEAM_KITS_EUROPA = [
  { file:"real_madrid.png",   name:"Os Merengues" },
  { file:"barcelona.png",     name:"Os Culés" },
  { file:"man_united.png",    name:"Red Devils" },
  { file:"liverpool.png",     name:"The Reds" },
  { file:"man_city.png",      name:"Sky Blues" },
  { file:"chelsea.png",       name:"The Blues" },
  { file:"bayern.png",        name:"Die Roten" },
  { file:"juventus.png",      name:"La Vecchia Signora" },
  { file:"milan.png",         name:"Il Diavolo" },
  { file:"atletico_madrid.png",name:"Los Colchoneros" },
  { file:"psg.png",           name:"Les Parisiens" },
];
const TEAM_KITS_SELECOES = [
  { file:"brasil.png",    name:"Canarinho" },
  { file:"argentina.png", name:"La Albiceleste" },
  { file:"portugal.png",  name:"A Seleção das Quinas" },
  { file:"franca.png",    name:"Les Bleus" },
  { file:"espanha.png",   name:"La Roja" },
  { file:"inglaterra.png",name:"Three Lions" },
  { file:"alemanha.png",  name:"Die Mannschaft" },
  { file:"mexico.png",    name:"El Tri" },
  { file:"equador.png",   name:"La Tri Ecuador" },
  { file:"japao.png",     name:"Samurai Azul" },
];

/** Resolves the jersey a player should wear, based on the team's kit library. */
function getPlayerJersey(team,player){
  const kits=team?.kits||makeDefaultKits(team?.colorIdx||0);
  if(player?.position==="Goleiro"){
    const gk=kits.find(k=>k.type==="goleiro")||kits.find(k=>k.id==="goleiro");
    if(gk) return gk.jersey;
  }
  const active=kits.find(k=>k.id===team?.activeKitId)||kits.find(k=>k.type==="titular")||kits[0];
  return active?.jersey||defaultJersey(player?.number);
}

/** Returns the full kit object (jersey + badgeIcon) for a player. */
function getPlayerKit(team,player){
  const kits=team?.kits||makeDefaultKits(team?.colorIdx||0);
  if(player?.position==="Goleiro"){
    const gk=kits.find(k=>k.type==="goleiro")||kits.find(k=>k.id==="goleiro");
    if(gk) return gk;
  }
  return kits.find(k=>k.id===team?.activeKitId)||kits.find(k=>k.type==="titular")||kits[0];
}

/** Renders the kit icon: colored round circle, or team uniform image with optional shield overlay. */
function KitIconPreview({kit,size=38,number,team=null}){
  const jersey=kit?.jersey||{pattern:"solid",primary:"#1a6b3a",secondary:"#fff"};
  const num=number||(kit?.type==="goleiro"?"1":"10");
  const tki=kit?.teamKitIcon;
  if(tki?.file){
    const folder=tki.folder==="europa"?"icones_uniformes_europa":tki.folder==="selecoes"?"icones_uniformes_selecoes":"icones_uniformes_brasil";
    const shieldScale=tki.shieldScale||1;
    const shieldSize=Math.round(size*0.38*shieldScale);
    const shieldX=tki.shieldX??50; // percent from left
    const shieldY=tki.shieldY??30; // percent from top
    const [c1,c2]=team?SHIELD_COLORS[(team.colorIdx||0)%SHIELD_COLORS.length]:["#1a6b3a","#34d399"];
    const shape=team?SHIELD_SHAPES.find(s=>s.id===team.shieldShapeId):null;
    return (
      <div style={{width:size,height:size,position:"relative",flexShrink:0}}>
        <img src={`/assets/images/icones_uniformes/${folder}/${tki.file}`} alt={tki.name||""}
          style={{width:"100%",height:"100%",objectFit:"contain",display:"block"}}/>
        {tki.shield&&team&&(
          <div style={{position:"absolute",left:`${shieldX}%`,top:`${shieldY}%`,transform:"translate(-50%,-50%)",pointerEvents:"none"}}>
            <ShieldVisual c1={c1} c2={c2} shape={shape} photo={team.photo} emoji={team.shieldEmoji} size={shieldSize} uid={team.id||"prev"} name={team.name||""} transparent={!!team.shieldTransparent}/>
          </div>
        )}
      </div>
    );
  }
  return (
    <div style={{width:size,height:size,borderRadius:"50%",background:getJerseyBackground(jersey),display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
      <span style={{fontFamily:getJerseyFontFamily(jersey),fontSize:size*0.39,lineHeight:1,color:"#fff",textShadow:"0 1px 3px rgba(0,0,0,0.45)"}}>{num}</span>
    </div>
  );
}

// ─── Default team factory ─────────────────────────────────────────────────────
let _uid = 1;
function makeTeam(name="Novo Time", colorIdx=0) {
  const defaultLineup = makeLineup({ id: String(Date.now()), name: "Titular", type: "titular", formation: "4-4-2", entries: [], isActive: true });
  return {
    id: Date.now() + (_uid++),
    name,
    colorIdx,
    shieldEmoji: "🛡️",
    shieldShapeId: null, // null = default rounded-square; or one of SHIELD_SHAPES ids
    kits: makeDefaultKits(colorIdx),
    activeKitId: "titular",
    players: [],
    captainPlayerId: null,
    // v4: lineups subcollection; active lineup exposed at team level for compat
    lineups: [defaultLineup],
    activeLineupId: defaultLineup.id,
    // backward-compat getters (derived from active lineup)
    lineup: [],
    formation: "4-4-2",
  };
}

// ─── Icon component (SVG sprite) ─────────────────────────────────────────────
const Icon = ({ id, size = 18, style = {}, className = "" }) => {
  if (id === "soccer-ball") return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{ display:"inline-block", verticalAlign:"middle", flexShrink:0, ...style }}
      className={className} aria-hidden="true">
      <path d="M11 7a16 16 20 0 1 10.98 4.362"/>
      <path d="M12 12a13 13 0 0 1-8.66 5"/>
      <path d="M16.83 13.634a16 16 0 0 1-9.267 7.328"/>
      <path d="M20.66 17A13 13 0 0 0 12 12a13 13 0 0 1 0-10"/>
      <path d="M8.17 15.366a16 16 0 0 1-1.713-11.69"/>
      <circle cx="12" cy="12" r="10"/>
    </svg>
  );
  return (
    <svg
      width={size}
      height={size}
      style={{ display:"inline-block", verticalAlign:"middle", flexShrink:0, ...style }}
      className={className}
      aria-hidden="true"
    >
      <use href={`/assets/icons/icons.svg#${id}`} />
    </svg>
  );
};

// ─── Icons ────────────────────────────────────────────────────────────────────
const Ico = {
  Plus:    ()=><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  Edit:    ()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  Trash:   ()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>,
  Close:   ()=><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  Shield:  ()=><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  Users:   ()=><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  Tactic:  ()=><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/><circle cx="16" cy="8" r="1.5" fill="currentColor"/><circle cx="12" cy="16" r="1.5" fill="currentColor"/></svg>,
  Camera:  ()=><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>,
  Gallery: ()=><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>,
  ChevL:   ()=><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>,
  ChevR:   ()=><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>,
  ChevDown:()=><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>,
  Share:   ()=><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>,
  Download:()=><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
  List:    ()=><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>,
  Back:    ()=><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>,
  Home:    ()=><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
  Palette: ()=><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><circle cx="8" cy="10" r="1" fill="currentColor"/><circle cx="16" cy="10" r="1" fill="currentColor"/><circle cx="12" cy="16" r="1" fill="currentColor"/></svg>,
  Save:    ()=><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>,
  Lineup:  ()=><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><circle cx="8" cy="15" r="1" fill="currentColor"/><circle cx="12" cy="15" r="1" fill="currentColor"/><circle cx="16" cy="15" r="1" fill="currentColor"/></svg>,
  Star2:   ()=><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
  NavHome: ()=>(
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Shield shape — represents teams */}
      <path d="M12 2L3 6.5V12c0 4.8 3.8 9.1 9 10 5.2-.9 9-5.2 9-10V6.5L12 2Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" fill="none"/>
      <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  NavTactic: ()=>(
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Football pitch top-down view */}
      <rect x="2" y="3" width="20" height="18" rx="2.5" stroke="currentColor" strokeWidth="1.8" fill="none"/>
      <line x1="12" y1="3" x2="12" y2="21" stroke="currentColor" strokeWidth="1.2" strokeDasharray="0"/>
      {/* Centre circle */}
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.2" fill="none"/>
      {/* Goal areas */}
      <rect x="2" y="8" width="4" height="8" stroke="currentColor" strokeWidth="1.2" fill="none"/>
      <rect x="18" y="8" width="4" height="8" stroke="currentColor" strokeWidth="1.2" fill="none"/>
    </svg>
  ),
  NavOffice: ()=>(
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Clipboard with chart — represents office/stats */}
      <rect x="6" y="2" width="12" height="3" rx="1.5" stroke="currentColor" strokeWidth="1.8" fill="none"/>
      <path d="M8 2H6a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2h-2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none"/>
      {/* Bar chart lines */}
      <line x1="9" y1="17" x2="9" y2="13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <line x1="12" y1="17" x2="12" y2="10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <line x1="15" y1="17" x2="15" y2="12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  ),
  Calendar:()=>(
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2.5"/>
      <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
      <circle cx="8" cy="15" r="1" fill="currentColor" stroke="none"/>
      <circle cx="12" cy="15" r="1" fill="currentColor" stroke="none"/>
      <circle cx="16" cy="15" r="1" fill="currentColor" stroke="none"/>
    </svg>
  ),
  Stats:   ()=>(
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/>
      <line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="6"  y1="20" x2="6"  y2="14"/>
      <line x1="3"  y1="20" x2="21" y2="20"/>
    </svg>
  ),
  Import:  ()=>(
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  ),
  Players: ()=>(
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="7" r="4"/>
      <path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/>
      <circle cx="18" cy="8" r="3"/>
      <path d="M21 21v-1.5a3 3 0 0 0-2-2.83"/>
    </svg>
  ),
  Goal:    ()=><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 3v9l5 5"/></svg>,
  Clock:   ()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  MapPin:  ()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>,
  Trophy:  ()=><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/></svg>,
  Bell:    ()=><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
  Image:   ()=><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>,
  Send:    ()=><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>,
  // ── Novos ícones (substituem emojis) ──
  Soccer:       (p={})=><Icon id="soccer-ball"  size={p.size||18} style={p.style}/>,
  Goalkeeper:   (p={})=><Icon id="goalkeeper"   size={p.size||18} style={p.style}/>,
  Ticket:       (p={})=><Icon id="ticket"        size={p.size||14} style={p.style}/>,
  CheckCircle:  (p={})=><Icon id="check-circle" size={p.size||16} style={p.style}/>,
  XCircle:      (p={})=><Icon id="x-circle"     size={p.size||16} style={p.style}/>,
  Warning:      (p={})=><Icon id="warning"       size={p.size||16} style={p.style}/>,
  InfoIco:      (p={})=><Icon id="info"          size={p.size||16} style={p.style}/>,
  Clipboard:    (p={})=><Icon id="clipboard"     size={p.size||16} style={p.style}/>,
  ChartBar:     (p={})=><Icon id="chart-bar"    size={p.size||18} style={p.style}/>,
  CalendarIco:  (p={})=><Icon id="calendar"      size={p.size||18} style={p.style}/>,
  ClockIco:     (p={})=><Icon id="clock"         size={p.size||14} style={p.style}/>,
  Stopwatch:    (p={})=><Icon id="stopwatch"     size={p.size||14} style={p.style}/>,
  People:       (p={})=><Icon id="users"         size={p.size||16} style={p.style}/>,
  Person:       (p={})=><Icon id="person"        size={p.size||16} style={p.style}/>,
  Jersey:       (p={})=><Icon id="jersey"        size={p.size||16} style={p.style}/>,
  TrophyIco:    (p={})=><Icon id="trophy"        size={p.size||18} style={p.style}/>,
  Medal:        (p={})=><Icon id="medal"         size={p.size||16} style={p.style}/>,
  Target:       (p={})=><Icon id="target"        size={p.size||16} style={p.style}/>,
  Balance:      (p={})=><Icon id="balance"       size={p.size||22} style={p.style}/>,
  Dice:         (p={})=><Icon id="dice"          size={p.size||22} style={p.style}/>,
  Lightning:    (p={})=><Icon id="lightning"     size={p.size||20} style={p.style}/>,
  Fire:         (p={})=><Icon id="fire"          size={p.size||18} style={p.style}/>,
  Stadium:      (p={})=><Icon id="stadium"       size={p.size||18} style={p.style}/>,
  Money:        (p={})=><Icon id="money-bag"    size={p.size||18} style={p.style}/>,
  Banknote:     (p={})=><Icon id="banknote"      size={p.size||16} style={p.style}/>,
  Receipt:      (p={})=><Icon id="receipt"       size={p.size||18} style={p.style}/>,
  CreditCard:   (p={})=><Icon id="credit-card"  size={p.size||16} style={p.style}/>,
  LockIco:      (p={})=><Icon id="lock"          size={p.size||14} style={p.style}/>,
  EyeIco:       (p={})=><Icon id="eye"           size={p.size||16} style={p.style}/>,
  SearchIco:    (p={})=><Icon id="search"        size={p.size||16} style={p.style}/>,
  Refresh:      (p={})=><Icon id="refresh"       size={p.size||16} style={p.style}/>,
  Shuffle:      (p={})=><Icon id="shuffle"       size={p.size||16} style={p.style}/>,
  RepeatIco:    (p={})=><Icon id="repeat"        size={p.size||16} style={p.style}/>,
  LinkIco:      (p={})=><Icon id="link"          size={p.size||48} style={p.style}/>,
  PinIco:       (p={})=><Icon id="pin"           size={p.size||14} style={p.style}/>,
  TagIco:       (p={})=><Icon id="tag"           size={p.size||16} style={p.style}/>,
  Bulb:         (p={})=><Icon id="bulb"          size={p.size||18} style={p.style}/>,
  Cloud:        (p={})=><Icon id="cloud"         size={p.size||16} style={p.style}/>,
  Moon:         (p={})=><Icon id="moon"          size={p.size||16} style={p.style}/>,
  Sun:          (p={})=><Icon id="sun"           size={p.size||16} style={p.style}/>,
  Radio:        (p={})=><Icon id="radio"         size={p.size||16} style={p.style}/>,
  Party:        (p={})=><Icon id="party"         size={p.size||36} style={p.style}/>,
  Sad:          (p={})=><Icon id="sad"           size={p.size||44} style={p.style}/>,
  Gem:          (p={})=><Icon id="gem"           size={p.size||16} style={p.style}/>,
  Memo:         (p={})=><Icon id="memo"          size={p.size||13} style={p.style}/>,
  FolderOpen:   (p={})=><Icon id="folder-open"  size={p.size||16} style={p.style}/>,
  UploadIco:    (p={})=><Icon id="upload"        size={p.size||18} style={p.style}/>,
  Crown:        (p={})=><Icon id="crown"         size={p.size||54} style={p.style}/>,
  HomeIco:      (p={})=><Icon id="home"          size={p.size||16} style={p.style}/>,
  Airplane:     (p={})=><Icon id="airplane"      size={p.size||16} style={p.style}/>,
  Handshake:    (p={})=><Icon id="handshake"     size={p.size||16} style={p.style}/>,
  FestivalIco:  (p={})=><Icon id="festival"      size={p.size||16} style={p.style}/>,
  Competition:  (p={})=><Icon id="competition"   size={p.size||16} style={p.style}/>,
  ActiveDot:    (p={})=><Icon id="active"        size={p.size||12} style={p.style}/>,
  InjuredIco:   (p={})=><Icon id="injured"       size={p.size||12} style={p.style}/>,
  Suspended:    (p={})=><Icon id="suspended"     size={p.size||12} style={p.style}/>,
  InactiveIco:  (p={})=><Icon id="inactive"      size={p.size||12} style={p.style}/>,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const StarRating = ({value,onChange,readonly,size=14}) => (
  <div style={{display:"flex",gap:2,cursor:readonly?"default":"pointer"}}>
    {[1,2,3,4,5].map(n=>(
      <span key={n} onClick={()=>!readonly&&onChange(n)} style={{transition:"transform 0.1s",display:"inline-block"}}
        onMouseEnter={e=>{if(!readonly)e.currentTarget.style.transform="scale(1.3)";}}
        onMouseLeave={e=>{e.currentTarget.style.transform="scale(1)";}}>
        <svg width={size} height={size} viewBox="0 0 24 24" fill={n<=value?"#F59E0B":"none"} stroke={n<=value?"#F59E0B":"#6B7280"} strokeWidth="1.5">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
      </span>
    ))}
  </div>
);

// ─── Sync Status Indicator ───────────────────────────────────────────────────
// Shows the state of automatic background saves to the cloud.
// "idle"    → nothing to show (no recent activity)
// "pending" → changes queued, waiting for debounce
// "syncing" → actively writing to Firestore
// "synced"  → just finished successfully (auto-hides after 2s)
// "error"   → last save attempt failed
function SyncIndicator({status, onRetry}) {
  if (status === "idle") return null;
  const CFG = {
    pending: { color:"#9CA3AF", label:"Alterações pendentes...", spin:false, icon:"●" },
    syncing: { color:"#34d399", label:"Sincronizando...",        spin:true,  icon:null },
    synced:  { color:"#34d399", label:"Sincronizado",            spin:false, icon:"✓" },
    error:   { color:"#f87171", label:"Erro ao sincronizar",     spin:false, icon:"!" },
  };
  const c = CFG[status]; if (!c) return null;
  const clickable = status === "error" && onRetry;
  return (
    <div onClick={clickable?onRetry:undefined} title={clickable?"Toque para tentar novamente":undefined} style={{
      display:"flex",alignItems:"center",gap:6,padding:"4px 9px",borderRadius:20,
      background:`${c.color}18`,border:`1px solid ${c.color}40`,
      color:c.color,fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700,
      letterSpacing:0.3,whiteSpace:"nowrap",cursor:clickable?"pointer":"default",
      transition:"all 0.2s"
    }}>
      {c.spin
        ? <div style={{width:9,height:9,border:`1.5px solid ${c.color}50`,borderTopColor:c.color,borderRadius:"50%",animation:"spin 0.7s linear infinite",flexShrink:0}}/>
        : <span style={{fontSize:11,lineHeight:1}}>{c.icon}</span>}
      {c.label}
    </div>
  );
}

/**
 * Renders a team shield: either a custom SVG shape (gradient-filled, with the
 * photo clipped to the shape or the emoji centered on top) or the legacy
 * rounded-square style. `uid` must be unique per rendered instance to avoid
 * SVG id collisions when several shields render on the same page.
 */
function ShieldVisual({c1,c2,shape,photo,emoji,size=56,uid,name="",transparent=false}) {
  // Transparent PNG mode: show image as-is, no background shape
  if(transparent && photo){
    return (
      <div style={{width:size,height:size,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
        <img src={photo} alt={name} style={{width:"100%",height:"100%",objectFit:"contain"}}/>
      </div>
    );
  }
  if (shape) {
    const gradId=`sg-${uid}`, clipId=`sc-${uid}`;
    return (
      <svg width={size} height={size} viewBox="0 0 100 100" style={{flexShrink:0,filter:`drop-shadow(0 4px 10px ${c1}55)`,overflow:"visible"}}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={c1}/>
            <stop offset="1" stopColor={c2}/>
          </linearGradient>
          <clipPath id={clipId}><path d={shape.path}/></clipPath>
        </defs>
        <path d={shape.path} fill={`url(#${gradId})`}/>
        {photo
          ? <image href={photo} x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clipId})`}/>
          : <text x="50" y="56" fontSize="44" textAnchor="middle" dominantBaseline="middle">{emoji||"🛡️"}</text>}
      </svg>
    );
  }
  // Default: rounded-square (legacy style, kept for backward compatibility)
  if (photo) {
    return (
      <div style={{width:size,height:size,borderRadius:size*0.18,overflow:"hidden",flexShrink:0}}>
        <img src={photo} alt={name} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
      </div>
    );
  }
  return (
    <div style={{width:size,height:size,borderRadius:size*0.18,background:`linear-gradient(135deg,${c1},${c2})`,
      display:"flex",alignItems:"center",justifyContent:"center",
      boxShadow:`0 4px 18px ${c1}55`,flexShrink:0,fontSize:size*0.44}}>
      {emoji||"🛡️"}
    </div>
  );
}

function TeamShield({team, size=56}) {
  const [c1,c2] = SHIELD_COLORS[(team.colorIdx||0) % SHIELD_COLORS.length];
  const shape = SHIELD_SHAPES.find(s=>s.id===team.shieldShapeId);
  return <ShieldVisual c1={c1} c2={c2} shape={shape} photo={team.photo} emoji={team.shieldEmoji} size={size} uid={team.id} name={team.name} transparent={!!team.shieldTransparent}/>;
}

function PlayerAvatar({player,size=44,style:ex={},team=null}) {
  const base = {width:size,height:size,borderRadius:"50%",flexShrink:0,overflow:"hidden",...ex};
  const [imgError, setImgError] = React.useState(false);

  // Quando a internet volta, tenta recarregar a foto
  React.useEffect(() => {
    if (!imgError || !player?.photo) return;
    const handleOnline = () => setImgError(false);
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [imgError, player?.photo]);

  const KitFallback = () => {
    if (team) {
      const kit = getPlayerKit(team, player);
      if (kit?.teamKitIcon?.file) {
        return <div style={{...base,background:"transparent"}}><KitIconPreview kit={kit} size={size} team={team}/></div>;
      }
      const jersey = kit?.jersey || defaultJersey(player?.number);
      return (
        <div style={{...base,background:getJerseyBackground(jersey),display:"flex",alignItems:"center",justifyContent:"center"}}>
          <span style={{fontFamily:getJerseyFontFamily(jersey),fontSize:size*0.38,lineHeight:1,color:"#fff",textShadow:"0 1px 3px rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center"}}>{player?.number||"?"}</span>
        </div>
      );
    }
    const jersey = player?.jersey || defaultJersey(player?.number);
    return (
      <div style={{...base,background:getJerseyBackground(jersey),display:"flex",alignItems:"center",justifyContent:"center"}}>
        <span style={{fontFamily:getJerseyFontFamily(jersey),fontSize:size*0.38,lineHeight:1,color:"#fff",textShadow:"0 1px 3px rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center"}}>{player?.number||"?"}</span>
      </div>
    );
  };

  if (player?.photo && !imgError) {
    return (
      <div style={base}>
        <img
          src={player.photo}
          alt={player?.name||""}
          style={{width:"100%",height:"100%",objectFit:"cover"}}
          onError={()=>setImgError(true)}
        />
      </div>
    );
  }

  return <KitFallback/>;
}

// ─── Image Cropper Modal ──────────────────────────────────────────────────────
function ImageCropperModal({src,onConfirm,onCancel}) {
  const imgRef=useRef(null);
  const [drag,setDrag]=useState(null);
  const [pos,setPos]=useState({x:0,y:0,scale:1});
  const [imgSize,setImgSize]=useState({w:0,h:0});
  const BOX=260;
  const lastPinch=useRef(null);

  useEffect(()=>{
    const img=new Image();
    img.onload=()=>{
      const w=img.naturalWidth,h=img.naturalHeight;
      setImgSize({w,h});
      const s=Math.max(BOX/w,BOX/h);
      setPos({x:(BOX-w*s)/2,y:(BOX-h*s)/2,scale:s});
    };
    img.src=src;
    imgRef.current=img;
  },[src]);

  const onTouchStart=e=>{
    if(e.touches.length===2){
      const dx=e.touches[0].clientX-e.touches[1].clientX;
      const dy=e.touches[0].clientY-e.touches[1].clientY;
      lastPinch.current=Math.hypot(dx,dy);
    } else {
      setDrag({sx:e.touches[0].clientX,sy:e.touches[0].clientY,ox:pos.x,oy:pos.y});
    }
  };
  const onTouchMove=e=>{
    if(e.touches.length===2&&lastPinch.current){
      e.preventDefault();
      const dx=e.touches[0].clientX-e.touches[1].clientX;
      const dy=e.touches[0].clientY-e.touches[1].clientY;
      const d=Math.hypot(dx,dy);
      const r=d/lastPinch.current;
      lastPinch.current=d;
      setPos(p=>({...p,scale:Math.max(0.3,Math.min(6,p.scale*r))}));
    } else if(e.touches.length===1&&drag){
      setPos(p=>({...p,x:drag.ox+e.touches[0].clientX-drag.sx,y:drag.oy+e.touches[0].clientY-drag.sy}));
    }
  };
  const onTouchEnd=()=>{lastPinch.current=null;setDrag(null);};
  const onMD=e=>setDrag({sx:e.clientX,sy:e.clientY,ox:pos.x,oy:pos.y});
  const onMM=e=>{if(drag)setPos(p=>({...p,x:drag.ox+e.clientX-drag.sx,y:drag.oy+e.clientY-drag.sy}));};
  const onMU=()=>setDrag(null);
  const onWheel=e=>{e.preventDefault();setPos(p=>({...p,scale:Math.max(0.3,Math.min(6,p.scale*(e.deltaY<0?1.1:0.9)))}));};

  const confirm=()=>{
    const canvas=document.createElement("canvas");
    canvas.width=300;canvas.height=300;
    const ctx=canvas.getContext("2d");
    ctx.drawImage(imgRef.current,-pos.x/pos.scale,-pos.y/pos.scale,BOX/pos.scale,BOX/pos.scale,0,0,300,300);
    // Preserve PNG transparency — JPEG fills transparent pixels with black
    const isPng=src.startsWith("data:image/png");
    onConfirm(isPng?canvas.toDataURL("image/png"):canvas.toDataURL("image/jpeg",0.82));
  };

  return (
    <div style={{position:"fixed",inset:0,zIndex:9500,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.93)",fontFamily:"'DM Sans',sans-serif",padding:20}}>
      <div style={{color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:20,letterSpacing:1,marginBottom:6}}>RECORTAR IMAGEM</div>
      <div style={{color:"#6B7280",fontSize:11,marginBottom:14,textAlign:"center"}}>Arraste para mover · Scroll ou pinça para zoom</div>
      <div
        style={{position:"relative",width:BOX,height:BOX,borderRadius:16,overflow:"hidden",border:"2px solid rgba(52,211,153,0.5)",cursor:drag?"grabbing":"grab",userSelect:"none",touchAction:"none",background:"#111",flexShrink:0}}
        onMouseDown={onMD} onMouseMove={onMM} onMouseUp={onMU} onMouseLeave={onMU}
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
        onWheel={onWheel}
      >
        {imgSize.w>0&&<img src={src} alt="" draggable={false} style={{position:"absolute",left:pos.x,top:pos.y,width:imgSize.w*pos.scale,height:imgSize.h*pos.scale,pointerEvents:"none"}}/>}
        <svg style={{position:"absolute",inset:0,pointerEvents:"none"}} width={BOX} height={BOX}>
          <line x1={BOX/3} y1="0" x2={BOX/3} y2={BOX} stroke="rgba(255,255,255,0.15)" strokeWidth="1"/>
          <line x1={BOX*2/3} y1="0" x2={BOX*2/3} y2={BOX} stroke="rgba(255,255,255,0.15)" strokeWidth="1"/>
          <line x1="0" y1={BOX/3} x2={BOX} y2={BOX/3} stroke="rgba(255,255,255,0.15)" strokeWidth="1"/>
          <line x1="0" y1={BOX*2/3} x2={BOX} y2={BOX*2/3} stroke="rgba(255,255,255,0.15)" strokeWidth="1"/>
        </svg>
      </div>
      <div style={{marginTop:12,display:"flex",alignItems:"center",gap:8,width:BOX}}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        <input type="range" min="0.3" max="6" step="0.05" value={pos.scale} onChange={e=>setPos(p=>({...p,scale:parseFloat(e.target.value)}))} style={{flex:1,accentColor:"#34d399"}}/>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
      </div>
      <div style={{display:"flex",gap:10,marginTop:16,width:BOX}}>
        <button onClick={onCancel} style={{flex:1,padding:"13px 0",borderRadius:12,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.04)",color:"#9CA3AF",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700}}>Cancelar</button>
        <button onClick={confirm} style={{flex:1,padding:"13px 0",borderRadius:12,border:"none",background:"linear-gradient(135deg,#15803d,#34d399)",color:"#fff",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:800,boxShadow:"0 4px 16px rgba(52,211,153,0.35)"}}>Confirmar</button>
      </div>
    </div>
  );
}

function PhotoPicker({photo,onChange}) {
  const gRef=useRef(),cRef=useRef();
  const [cropSrc,setCropSrc]=useState(null);
  const handle=e=>{
    const f=e.target.files[0];if(!f)return;
    e.target.value="";
    const r=new FileReader();
    r.onload=ev=>setCropSrc(ev.target.result);
    r.readAsDataURL(f);
  };
  const handleCropConfirm=async(cropped)=>{
    setCropSrc(null);
    const compressed=await compressImage(cropped,300,0.82);
    onChange(compressed);
  };
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:10}}>
      {cropSrc&&<ImageCropperModal src={cropSrc} onConfirm={handleCropConfirm} onCancel={()=>setCropSrc(null)}/>}
      <div style={{width:84,height:84,borderRadius:16,overflow:"hidden",border:"2px solid rgba(255,255,255,0.12)",background:"rgba(255,255,255,0.04)",display:"flex",alignItems:"center",justifyContent:"center"}}>
        {photo?<img src={photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
          :<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#4B5563" strokeWidth="1.5" strokeLinecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>}
      </div>
      <div style={{display:"flex",gap:8}}>
        {[
          {ref:cRef,capture:"environment",icon:<Ico.Camera/>,label:"Câmera",color:"#34d399"},
          {ref:gRef,capture:null,icon:<Ico.Gallery/>,label:"Galeria",color:"#60a5fa"},
        ].map(({ref,capture,icon,label,color})=>(
          <button key={label} onClick={()=>ref.current.click()} style={{
            display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:"9px 14px",
            background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.1)",
            borderRadius:12,color:"#9CA3AF",cursor:"pointer",transition:"all 0.2s"
          }}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=color;e.currentTarget.style.color=color;}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor="rgba(255,255,255,0.1)";e.currentTarget.style.color="#9CA3AF";}}>
            {icon}<span style={{fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700}}>{label}</span>
          </button>
        ))}
        {photo&&<button onClick={()=>onChange("")} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:"9px 12px",background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:12,color:"#f87171",cursor:"pointer"}}>
          <Ico.Trash/><span style={{fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700}}>Remover</span>
        </button>}
      </div>
      <input ref={cRef} type="file" accept="image/*" capture="environment" onChange={handle} style={{display:"none"}}/>
      <input ref={gRef} type="file" accept="image/*" onChange={handle} style={{display:"none"}}/>
    </div>
  );
}

// ─── Team Form Modal ──────────────────────────────────────────────────────────
const SHIELD_EMOJIS = ["🛡️","⚽","🏆","🦁","🦅","🐯","🐺","🦊","🔥","⚡","🌟","🏅","💎","🦋","🐉","🌙"];
const IS = {background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"10px 14px",color:"#fff",fontFamily:"'DM Sans',sans-serif",fontSize:14,outline:"none",transition:"border-color 0.2s",width:"100%",boxSizing:"border-box"};
const LT = {color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:0.5};

function TeamFormModal({initial,onSave,onClose,isPremium}) {
  const [form,setForm]=useState(()=>{
    if(initial) return {...initial, kits: initial.kits||makeDefaultKits(initial.colorIdx||0), activeKitId: initial.activeKitId||"titular"};
    return {name:"",colorIdx:0,shieldEmoji:"🛡️",shieldShapeId:null,photo:"",kits:makeDefaultKits(0),activeKitId:"titular"};
  });
  const [saving,setSaving]=useState(false);
  const [tab,setTab]=useState("dados"); // "dados" | "uniformes"
  const [editingKitId,setEditingKitId]=useState(null);
  const [showKitUpsell,setShowKitUpsell]=useState(false);
  const [showKitIconUpsell,setShowKitIconUpsell]=useState(false);
  const [kitRegion,setKitRegion]=useState("brasil"); // "brasil" | "europa"
  const [shieldDrag,setShieldDrag]=useState(null); // {x,y} during drag, null otherwise
  const kitPreviewRef=useRef(null);
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const valid=form.name.trim()!=="";
  const [c1,c2]=SHIELD_COLORS[form.colorIdx%SHIELD_COLORS.length];
  const previewIdRef=useRef(null);
  if(!previewIdRef.current) previewIdRef.current=genUUID();
  const previewShape=SHIELD_SHAPES.find(s=>s.id===form.shieldShapeId);
  // Free plan: only Titular/Goleiro kits are usable. Reserva, Alternativo and
  // any custom kits require premium.
  const isKitLocked=(kit)=>!isPremium&&!FREE_KIT_IDS.includes(kit.type);

  const updateKit=(id,patch)=>set("kits",form.kits.map(k=>k.id===id?{...k,...patch}:k));
  const addKit=()=>{
    const id=genUUID();
    const newKit={id,type:"custom",name:`Uniforme ${form.kits.length+1}`,jersey:{pattern:"solid",primary:"#1a6b3a",secondary:"#ffffff"}};
    set("kits",[...form.kits,newKit]);
    setEditingKitId(id);
  };
  const deleteKit=(id)=>{
    const kit=form.kits.find(k=>k.id===id);
    if(!kit||kit.type==="titular")return; // titular kit can't be removed
    setForm(f=>{
      const kits=f.kits.filter(k=>k.id!==id);
      return {...f,kits,activeKitId:f.activeKitId===id?"titular":f.activeKitId};
    });
    if(editingKitId===id)setEditingKitId(null);
  };

  const handleSave=async()=>{
    if(!valid||saving)return;
    setSaving(true);
    try{ await withTimeout(onSave(form), 8000); }catch(e){ console.error("TeamFormModal save error:",e); }
    setSaving(false);
  };
  return (
    <>
    <div style={{position:"fixed",inset:0,zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.85)",backdropFilter:"blur(8px)",padding:"12px"}}>
      <div style={{background:"#0d1f17",border:"1px solid rgba(255,255,255,0.1)",borderRadius:22,width:"100%",maxWidth:420,maxHeight:"92vh",overflowY:"auto",boxShadow:"0 24px 80px rgba(0,0,0,0.9)"}}>
        <div style={{padding:"18px 20px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:"1px solid rgba(255,255,255,0.08)"}}>
          <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#fff",letterSpacing:1}}>{initial?"Editar Time":"Novo Time"}</span>
          <button onClick={onClose} aria-label="Fechar" style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer",padding:4}}><Ico.Close/></button>
        </div>
        <div style={{padding:"18px 20px 22px",display:"flex",flexDirection:"column",gap:16}}>

          {/* Abas */}
          <div style={{display:"flex",gap:6,padding:4,background:"rgba(255,255,255,0.03)",borderRadius:12,border:"1px solid rgba(255,255,255,0.06)"}}>
            {[["dados","Dados do Time"],["uniformes","Uniformes"]].map(([id,label])=>(
              <button key={id} onClick={()=>setTab(id)} style={{
                flex:1,padding:"9px 0",borderRadius:9,border:"none",cursor:"pointer",
                fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:800,letterSpacing:0.3,
                background:tab===id?`linear-gradient(135deg,${c1},${c2})`:"transparent",
                color:tab===id?"#fff":"#9CA3AF",transition:"all 0.2s"
              }}>{label}</button>
            ))}
          </div>

          {tab==="dados"&&(<>
          {/* Preview escudo */}
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
            <div style={{width:80,height:80,display:"flex",alignItems:"center",justifyContent:"center"}}>
              <ShieldVisual c1={c1} c2={c2} shape={previewShape} photo={form.photo} emoji={form.shieldEmoji} size={80} uid={previewIdRef.current} name={form.name} transparent={!!form.shieldTransparent}/>
            </div>
            <span style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11}}>Prévia do escudo</span>
          </div>

          {/* Nome */}
          <div style={{display:"flex",flexDirection:"column",gap:5}}>
            <label htmlFor="team-name" style={LT}>Nome do Time</label>
            <input id="team-name" value={form.name} onChange={e=>set("name",e.target.value)} placeholder="Ex: Flamengo, Real Madrid..." style={IS}
              onFocus={e=>e.target.style.borderColor="#34d399"} onBlur={e=>e.target.style.borderColor="rgba(255,255,255,0.1)"}/>
          </div>

          {/* Formato do escudo */}
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <span style={LT}>Formato do Escudo</span>
            <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:6}}>
              <button onClick={()=>set("shieldShapeId",null)} title="Padrão" style={{
                aspectRatio:"1",borderRadius:9,border:"2px solid",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",
                borderColor:!form.shieldShapeId?"#34d399":"rgba(255,255,255,0.08)",
                background:!form.shieldShapeId?"rgba(52,211,153,0.15)":"rgba(255,255,255,0.03)",
                transition:"all 0.15s"
              }}>
                <div style={{width:"60%",height:"60%",borderRadius:6,background:`linear-gradient(135deg,${c1},${c2})`}}/>
              </button>
              {SHIELD_SHAPES.map(shape=>(
                <button key={shape.id} onClick={()=>set("shieldShapeId",shape.id)} title={shape.name} style={{
                  aspectRatio:"1",borderRadius:9,border:"2px solid",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:6,
                  borderColor:form.shieldShapeId===shape.id?"#34d399":"rgba(255,255,255,0.08)",
                  background:form.shieldShapeId===shape.id?"rgba(52,211,153,0.15)":"rgba(255,255,255,0.03)",
                  transition:"all 0.15s"
                }}>
                  <svg viewBox="0 0 100 100" style={{width:"100%",height:"100%"}}>
                    <path d={shape.path} fill={`url(#tg-${form.colorIdx}-${shape.id})`}/>
                    <defs>
                      <linearGradient id={`tg-${form.colorIdx}-${shape.id}`} x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0" stopColor={c1}/><stop offset="1" stopColor={c2}/>
                      </linearGradient>
                    </defs>
                  </svg>
                </button>
              ))}
            </div>
            {form.photo&&(
              <button onClick={()=>set("shieldTransparent",!form.shieldTransparent)} style={{
                display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:9,border:"1px solid",cursor:"pointer",
                borderColor:form.shieldTransparent?"rgba(52,211,153,0.4)":"rgba(255,255,255,0.1)",
                background:form.shieldTransparent?"rgba(52,211,153,0.08)":"rgba(255,255,255,0.03)",transition:"all 0.15s"
              }}>
                <div style={{width:14,height:14,borderRadius:3,border:"2px solid",flexShrink:0,transition:"all 0.15s",
                  borderColor:form.shieldTransparent?"#34d399":"#6B7280",
                  background:form.shieldTransparent?"#34d399":"transparent",
                  display:"flex",alignItems:"center",justifyContent:"center"}}>
                  {form.shieldTransparent&&<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="4" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>}
                </div>
                <span style={{color:form.shieldTransparent?"#34d399":"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700}}>Imagem sem fundo (PNG transparente)</span>
              </button>
            )}
          </div>

          {/* Emoji escudo */}
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <span style={LT}>Ícone do Escudo</span>
            <div style={{display:"grid",gridTemplateColumns:"repeat(8,1fr)",gap:6}}>
              {SHIELD_EMOJIS.map(e=>(
                <button key={e} onClick={()=>set("shieldEmoji",e)} style={{
                  fontSize:22,padding:"6px 0",borderRadius:9,border:"2px solid",cursor:"pointer",
                  borderColor:form.shieldEmoji===e?"#34d399":"rgba(255,255,255,0.08)",
                  background:form.shieldEmoji===e?"rgba(52,211,153,0.15)":"rgba(255,255,255,0.03)",
                  transition:"all 0.15s"
                }}>{e}</button>
              ))}
            </div>
          </div>

          {/* Cor */}
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <span style={LT}>Cor do Time</span>
            <div style={{display:"grid",gridTemplateColumns:"repeat(8,1fr)",gap:6}}>
              {SHIELD_COLORS.map(([c1i,c2i],i)=>(
                <button key={i} onClick={()=>set("colorIdx",i)} style={{
                  height:30,borderRadius:8,border:"2px solid",cursor:"pointer",
                  background:`linear-gradient(135deg,${c1i},${c2i})`,
                  borderColor:form.colorIdx===i?"#fff":"transparent",
                  boxShadow:form.colorIdx===i?`0 0 10px ${c1i}80`:"none",
                  transition:"all 0.15s"
                }}/>
              ))}
            </div>
          </div>

          {/* Foto escudo (opcional) */}
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <span style={LT}>Ou envie uma imagem do escudo (opcional)</span>
            <div style={{display:"flex",alignItems:"flex-start",gap:6,padding:"7px 10px",borderRadius:9,background:"rgba(251,191,36,0.07)",border:"1px solid rgba(251,191,36,0.2)"}}>
              <span style={{fontSize:13,marginTop:1}}>💡</span>
              <span style={{color:"#D97706",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:600,lineHeight:1.4}}>
                Recomendamos imagens <b>PNG sem fundo</b> para melhor visualização. Ative "Imagem sem fundo" em Formato do Escudo após enviar.
              </span>
            </div>
            <PhotoPicker photo={form.photo} onChange={v=>set("photo",v)}/>
          </div>
          </>)}

          {tab==="uniformes"&&(<>
          {/* Biblioteca de uniformes */}
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <span style={LT}>Uniformes do Time</span>
            <span style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11,marginTop:-4}}>
              O uniforme <b style={{color:"#9CA3AF"}}>ativo</b> é usado pelos jogadores de linha. Goleiros sempre usam o uniforme de Goleiro.
            </span>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
              {form.kits.map(kit=>{
                const isActive=form.activeKitId===kit.id;
                const isEditing=editingKitId===kit.id;
                const locked=isKitLocked(kit);
                const sampleNum=kit.type==="goleiro"?"1":"10";
                return (
                  <button key={kit.id} onClick={()=>{
                    if(locked){setShowKitUpsell(true);return;}
                    setEditingKitId(isEditing?null:kit.id);
                  }} style={{
                    display:"flex",flexDirection:"column",alignItems:"center",gap:5,padding:"8px 4px",borderRadius:11,
                    border:"2px solid",cursor:"pointer",position:"relative",
                    borderColor:isEditing?"#34d399":(isActive?"#facc15":"rgba(255,255,255,0.08)"),
                    background:isEditing?"rgba(52,211,153,0.1)":"rgba(255,255,255,0.03)",
                    opacity:locked?0.55:1,
                    transition:"all 0.15s"
                  }}>
                    {isActive&&<div style={{position:"absolute",top:4,right:4,fontSize:8,fontWeight:900,color:"#1a1a0a",background:"#facc15",borderRadius:4,padding:"1px 4px",fontFamily:"'DM Sans',sans-serif"}}>ATIVO</div>}
                    {locked&&<div style={{position:"absolute",top:4,left:4}}><Icon id="lock" size={11} style={{color:"#9CA3AF"}}/></div>}
                    <KitIconPreview kit={kit} size={38} number={sampleNum}/>
                    <span style={{color:"#e5e7eb",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700,textAlign:"center",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"100%"}}>{kit.name}</span>
                  </button>
                );
              })}
              <button onClick={()=>{
                if(!isPremium){setShowKitUpsell(true);return;}
                addKit();
              }} title="Adicionar uniforme" style={{
                display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:5,padding:"8px 4px",borderRadius:11,
                border:"2px dashed rgba(255,255,255,0.15)",cursor:"pointer",background:"rgba(255,255,255,0.02)",color:"#6B7280",
                transition:"all 0.15s"
              }}>
                <div style={{width:38,height:38,borderRadius:"50%",border:"2px dashed rgba(255,255,255,0.2)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  {isPremium?<Ico.Plus/>:<Icon id="lock" size={14} style={{color:"#9CA3AF"}}/>}
                </div>
                <span style={{fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700}}>Novo</span>
              </button>
            </div>
          </div>

          {/* Editor do uniforme selecionado */}
          {editingKitId&&(()=>{
            const kit=form.kits.find(k=>k.id===editingKitId);
            if(!kit)return null;
            const isActive=form.activeKitId===kit.id;
            const canDelete=kit.type!=="titular";
            return (
              <div style={{display:"flex",flexDirection:"column",gap:12,padding:"12px 13px",borderRadius:12,background:"rgba(255,255,255,0.03)",border:"1px solid rgba(52,211,153,0.25)"}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <KitIconPreview kit={kit} size={48}/>
                  <input value={kit.name} onChange={e=>updateKit(kit.id,{name:e.target.value})} placeholder="Nome do uniforme" style={{...IS,flex:1}}
                    onFocus={e=>e.target.style.borderColor="#34d399"} onBlur={e=>e.target.style.borderColor="rgba(255,255,255,0.1)"}/>
                </div>

                {/* Padrão */}
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  <span style={{...LT,fontSize:9}}>Padrão</span>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:6}}>
                    {JERSEY_PATTERNS.map(p=>(
                      <button key={p.id} onClick={()=>updateKit(kit.id,{jersey:{...kit.jersey,pattern:p.id}})} title={p.name} style={{
                        aspectRatio:"1",borderRadius:9,border:"2px solid",cursor:"pointer",padding:0,overflow:"hidden",
                        borderColor:kit.jersey.pattern===p.id?"#34d399":"rgba(255,255,255,0.08)",
                        transition:"all 0.15s"
                      }}>
                        <div style={{width:"100%",height:"100%",borderRadius:7,background:getJerseyBackground({...kit.jersey,pattern:p.id}),display:"flex",alignItems:"center",justifyContent:"center"}}>
                          <span style={{fontFamily:getJerseyFontFamily({...kit.jersey,pattern:p.id}),fontSize:14,lineHeight:1,color:"#fff",textShadow:"0 1px 3px rgba(0,0,0,0.45)"}}>{kit.type==="goleiro"?"1":"10"}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Cores */}
                <div style={{display:"flex",gap:10}}>
                  <div style={{flex:1,display:"flex",flexDirection:"column",gap:6}}>
                    <span style={{...LT,fontSize:9}}>Cor Principal</span>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:5}}>
                      {JERSEY_COLOR_SWATCHES.map(col=>(
                        <button key={col} onClick={()=>updateKit(kit.id,{jersey:{...kit.jersey,primary:col}})} title={col} style={{
                          aspectRatio:"1",borderRadius:7,border:"2px solid",cursor:"pointer",background:col,
                          borderColor:kit.jersey.primary===col?"#34d399":(col==="#ffffff"?"rgba(255,255,255,0.2)":"transparent"),
                          boxShadow:kit.jersey.primary===col?`0 0 8px ${col}90`:"none",transition:"all 0.15s"
                        }}/>
                      ))}
                    </div>
                  </div>
                  <div style={{flex:1,display:"flex",flexDirection:"column",gap:6}}>
                    <span style={{...LT,fontSize:9}}>Cor Secundária</span>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:5}}>
                      {JERSEY_COLOR_SWATCHES.map(col=>(
                        <button key={col} onClick={()=>updateKit(kit.id,{jersey:{...kit.jersey,secondary:col}})} title={col} style={{
                          aspectRatio:"1",borderRadius:7,border:"2px solid",cursor:"pointer",background:col,
                          borderColor:kit.jersey.secondary===col?"#34d399":(col==="#ffffff"?"rgba(255,255,255,0.2)":"transparent"),
                          boxShadow:kit.jersey.secondary===col?`0 0 8px ${col}90`:"none",transition:"all 0.15s"
                        }}/>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Fonte do número */}
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  <span style={{...LT,fontSize:9}}>Fonte do Número</span>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6}}>
                    {JERSEY_FONTS.map(fnt=>(
                      <button key={fnt.id} onClick={()=>updateKit(kit.id,{jersey:{...kit.jersey,numberFont:fnt.id}})} title={fnt.name} style={{
                        display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:"7px 2px",borderRadius:9,border:"2px solid",cursor:"pointer",
                        borderColor:(kit.jersey.numberFont||"bebas")===fnt.id?"#34d399":"rgba(255,255,255,0.08)",
                        background:(kit.jersey.numberFont||"bebas")===fnt.id?"rgba(52,211,153,0.12)":"rgba(255,255,255,0.03)",
                        transition:"all 0.15s"
                      }}>
                        <span style={{fontFamily:fnt.family,fontSize:18,lineHeight:1,color:"#fff"}}>10</span>
                        <span style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:8,fontWeight:700,textAlign:"center",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"100%"}}>{fnt.name}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Ícone do Uniforme */}
                {(()=>{
                  const tki=kit.teamKitIcon;
                  const hasKit=!!tki?.file;
                  const kitList=kitRegion==="brasil"?TEAM_KITS_BRASIL:kitRegion==="europa"?TEAM_KITS_EUROPA:TEAM_KITS_SELECOES;
                  const kitFolder=kitRegion==="brasil"?"icones_uniformes_brasil":kitRegion==="europa"?"icones_uniformes_europa":"icones_uniformes_selecoes";

                  const handleDragStart=(e)=>{
                    e.preventDefault();
                    const box=kitPreviewRef.current?.getBoundingClientRect();
                    if(!box)return;
                    const move=(ev)=>{
                      const cx=ev.touches?ev.touches[0].clientX:ev.clientX;
                      const cy=ev.touches?ev.touches[0].clientY:ev.clientY;
                      const x=Math.min(100,Math.max(0,((cx-box.left)/box.width)*100));
                      const y=Math.min(100,Math.max(0,((cy-box.top)/box.height)*100));
                      setShieldDrag({x,y});
                    };
                    const up=()=>{
                      setShieldDrag(prev=>{
                        if(prev) updateKit(kit.id,{teamKitIcon:{...tki,shieldX:prev.x,shieldY:prev.y}});
                        return null;
                      });
                      window.removeEventListener("mousemove",move);
                      window.removeEventListener("touchmove",move);
                      window.removeEventListener("mouseup",up);
                      window.removeEventListener("touchend",up);
                    };
                    window.addEventListener("mousemove",move);
                    window.addEventListener("touchmove",move,{passive:false});
                    window.addEventListener("mouseup",up);
                    window.addEventListener("touchend",up);
                  };

                  const liveShieldX=shieldDrag?.x??(tki?.shieldX??50);
                  const liveShieldY=shieldDrag?.y??(tki?.shieldY??30);
                  const [sc1,sc2]=SHIELD_COLORS[(form.colorIdx||0)%SHIELD_COLORS.length];
                  const scShape=SHIELD_SHAPES.find(s=>s.id===form.shieldShapeId);

                  return (
                    <div style={{display:"flex",flexDirection:"column",gap:8}}>
                      <span style={{...LT,fontSize:9}}>Ícone do Uniforme</span>

                      {/* Modo: Redondo ou Uniforme de Time */}
                      <div style={{display:"flex",gap:6}}>
                        <button onClick={()=>updateKit(kit.id,{teamKitIcon:null})} style={{
                          flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4,padding:"8px 4px",borderRadius:9,border:"2px solid",cursor:"pointer",
                          borderColor:!hasKit?"#34d399":"rgba(255,255,255,0.08)",
                          background:!hasKit?"rgba(52,211,153,0.1)":"rgba(255,255,255,0.03)",transition:"all 0.15s"
                        }}>
                          <div style={{width:28,height:28,borderRadius:"50%",background:getJerseyBackground(kit.jersey),display:"flex",alignItems:"center",justifyContent:"center"}}>
                            <span style={{fontFamily:getJerseyFontFamily(kit.jersey),fontSize:11,color:"#fff"}}>10</span>
                          </div>
                          <span style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:8,fontWeight:700}}>Redondo</span>
                        </button>
                        <button onClick={()=>{
                          if(!isPremium){ setShowKitIconUpsell(true); return; }
                          if(!hasKit) updateKit(kit.id,{teamKitIcon:{file:kitList[0].file,name:kitList[0].name,folder:kitRegion,shield:false,shieldX:50,shieldY:30,shieldScale:1}});
                        }} style={{
                          flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4,padding:"8px 4px",borderRadius:9,border:"2px solid",cursor:"pointer",position:"relative",
                          borderColor:hasKit?"#34d399":"rgba(255,255,255,0.08)",
                          background:hasKit?"rgba(52,211,153,0.1)":"rgba(255,255,255,0.03)",transition:"all 0.15s",
                          opacity:isPremium?1:0.65
                        }}>
                          {!isPremium&&<span style={{position:"absolute",top:3,right:4,fontSize:8}}>🔒</span>}
                          <div style={{width:28,height:28,borderRadius:4,overflow:"hidden",background:"rgba(255,255,255,0.05)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.38 3.46L16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.57a1 1 0 0 0 .99.84H5v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V10h1.15a1 1 0 0 0 .99-.84l.58-3.57a2 2 0 0 0-1.34-2.23z"/></svg>
                          </div>
                          <span style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:8,fontWeight:700,textAlign:"center"}}>Uniforme</span>
                        </button>
                      </div>

                      {hasKit&&(<>
                        {/* Tabs Brasil / Europa / Seleções */}
                        <div style={{display:"flex",gap:4,background:"rgba(255,255,255,0.04)",borderRadius:8,padding:3}}>
                          {[["brasil","🇧🇷 Brasil"],["europa","🌍 Europeus"],["selecoes","🏆 Seleções"]].map(([r,label])=>(
                            <button key={r} onClick={()=>setKitRegion(r)} style={{
                              flex:1,padding:"5px 0",borderRadius:6,border:"none",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700,
                              background:kitRegion===r?"rgba(52,211,153,0.2)":"transparent",
                              color:kitRegion===r?"#34d399":"#6B7280",transition:"all 0.15s"
                            }}>{label}</button>
                          ))}
                        </div>

                        {/* Grid de uniformes */}
                        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6}}>
                          {kitList.map(b=>{
                            const sel=tki?.file===b.file&&tki?.folder===kitRegion;
                            return (
                              <button key={b.file} onClick={()=>updateKit(kit.id,{teamKitIcon:{...tki,file:b.file,name:b.name,folder:kitRegion}})} title={b.name} style={{
                                display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:"6px 4px",borderRadius:9,border:"2px solid",cursor:"pointer",
                                borderColor:sel?"#34d399":"rgba(255,255,255,0.08)",
                                background:sel?"rgba(52,211,153,0.1)":"rgba(255,255,255,0.03)",transition:"all 0.15s"
                              }}>
                                <img src={`/assets/images/icones_uniformes/${kitFolder}/${b.file}`} alt={b.name} style={{width:36,height:36,objectFit:"contain"}}/>
                                <span style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:7,fontWeight:700,textAlign:"center",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"100%"}}>{b.name}</span>
                              </button>
                            );
                          })}
                        </div>

                        {/* Toggle escudo */}
                        <button onClick={()=>updateKit(kit.id,{teamKitIcon:{...tki,shield:!tki?.shield}})} style={{
                          display:"flex",alignItems:"center",gap:8,padding:"8px 12px",borderRadius:9,border:"1px solid",cursor:"pointer",
                          borderColor:tki?.shield?"rgba(52,211,153,0.4)":"rgba(255,255,255,0.1)",
                          background:tki?.shield?"rgba(52,211,153,0.08)":"rgba(255,255,255,0.03)",transition:"all 0.15s"
                        }}>
                          <div style={{width:16,height:16,borderRadius:4,border:"2px solid",borderColor:tki?.shield?"#34d399":"#6B7280",background:tki?.shield?"#34d399":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.15s"}}>
                            {tki?.shield&&<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="3.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>}
                          </div>
                          <span style={{color:tki?.shield?"#34d399":"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700}}>Mostrar escudo do time no uniforme</span>
                        </button>

                        {/* Preview + posicionamento do escudo */}
                        {tki?.shield&&(
                          <div style={{display:"flex",flexDirection:"column",gap:8}}>
                            <span style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:700,textAlign:"center"}}>Arraste o escudo para posicioná-lo</span>
                            <div ref={kitPreviewRef} style={{position:"relative",width:"100%",paddingBottom:"100%",background:"rgba(255,255,255,0.03)",borderRadius:12,border:"1px solid rgba(52,211,153,0.2)",overflow:"hidden",cursor:"grab",userSelect:"none",touchAction:"none"}}
                              onMouseDown={handleDragStart} onTouchStart={handleDragStart}>
                              <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",padding:8}}>
                                <img src={`/assets/images/icones_uniformes/${kitFolder}/${tki.file}`} alt={tki.name||""} style={{maxWidth:"100%",maxHeight:"100%",objectFit:"contain",pointerEvents:"none",userSelect:"none"}}/>
                              </div>
                              <div style={{position:"absolute",left:`${liveShieldX}%`,top:`${liveShieldY}%`,transform:"translate(-50%,-50%)",pointerEvents:"none"}}>
                                <ShieldVisual c1={sc1} c2={sc2} shape={scShape} photo={form.photo} emoji={form.shieldEmoji}
                                  size={Math.round(52*(tki.shieldScale||1))} uid={"kit-prev"} name={form.name||""} transparent={!!form.shieldTransparent}/>
                              </div>
                            </div>
                            {/* Slider de tamanho do escudo */}
                            <div style={{display:"flex",flexDirection:"column",gap:4}}>
                              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                                <span style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:700}}>TAMANHO DO ESCUDO</span>
                                <span style={{color:"#34d399",fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:700}}>{Math.round((tki.shieldScale||1)*100)}%</span>
                              </div>
                              <input type="range" min="0.3" max="2.2" step="0.05"
                                value={tki.shieldScale||1}
                                onChange={e=>updateKit(kit.id,{teamKitIcon:{...tki,shieldScale:parseFloat(e.target.value)}})}
                                style={{width:"100%",accentColor:"#34d399",cursor:"pointer"}}/>
                            </div>
                          </div>
                        )}
                      </>)}
                    </div>
                  );
                })()}

                {/* Ações */}
                <div style={{display:"flex",gap:8}}>
                  {kit.type!=="goleiro"&&(
                    <button onClick={()=>set("activeKitId",kit.id)} disabled={isActive} style={{
                      flex:1,padding:"9px 0",borderRadius:9,border:"1px solid",cursor:isActive?"default":"pointer",
                      borderColor:isActive?"rgba(250,204,21,0.4)":"rgba(255,255,255,0.12)",
                      background:isActive?"rgba(250,204,21,0.12)":"rgba(255,255,255,0.04)",
                      color:isActive?"#facc15":"#e5e7eb",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:800,
                    }}>{isActive?"✓ UNIFORME ATIVO":"DEFINIR COMO ATIVO"}</button>
                  )}
                  {canDelete&&(
                    <button onClick={()=>deleteKit(kit.id)} style={{
                      padding:"9px 14px",borderRadius:9,border:"1px solid rgba(239,68,68,0.25)",cursor:"pointer",
                      background:"rgba(239,68,68,0.1)",color:"#f87171",display:"flex",alignItems:"center",justifyContent:"center"
                    }}><Ico.Trash/></button>
                  )}
                </div>
              </div>
            );
          })()}
          </>)}

          <button onClick={handleSave} disabled={saving||!valid} style={{
            marginTop:4,padding:"14px 0",borderRadius:13,border:"none",cursor:(valid&&!saving)?"pointer":"not-allowed",
            background:(valid&&!saving)?`linear-gradient(135deg,${c1},${c2})`:"rgba(255,255,255,0.07)",
            color:(valid&&!saving)?"#fff":"#6B7280",fontFamily:"'Bebas Neue',sans-serif",fontSize:19,letterSpacing:1.5,transition:"all 0.2s",
            boxShadow:(valid&&!saving)?`0 4px 20px ${c1}60`:"none",
            display:"flex",alignItems:"center",justifyContent:"center",gap:8
          }}>
            {saving&&<div style={{width:16,height:16,border:"2px solid rgba(255,255,255,0.3)",borderTopColor:"#fff",borderRadius:"50%",animation:"spin 0.7s linear infinite",flexShrink:0}}/>}
            {saving?"SALVANDO...":"SALVAR TIME"}
          </button>
        </div>
      </div>
    </div>
    {showKitUpsell&&<PremiumUpsellModal
      title="Uniformes premium"
      description="No plano gratuito você tem acesso aos uniformes Titular e Goleiro. Os uniformes Reserva, Alternativo e a criação de uniformes personalizados são exclusivos do plano premium."
      onClose={()=>setShowKitUpsell(false)}
    />}
    {showKitIconUpsell&&<PremiumUpsellModal
      title="Ícone de uniforme premium"
      description="O uso de ícones de camiseta de times (brasileiros, europeus e seleções) no uniforme é um recurso exclusivo do plano premium. O estilo Redondo continua disponível gratuitamente."
      onClose={()=>setShowKitIconUpsell(false)}
    />}
    </>
  );
}

// ─── Premium Benefits Screen ──────────────────────────────────────────────────
function PremiumBenefitsScreen({ onBack, isPremium }) {
  const benefits = [
    {
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
      title: "Colaboração em equipe",
      desc: "Ative times e agendas colaborativas. Convide membros para editar juntos em tempo real.",
    },
    {
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.38 3.46L16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.57a1 1 0 0 0 .99.84H5v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V10h1.15a1 1 0 0 0 .99-.84l.58-3.57a2 2 0 0 0-1.34-2.23z"/></svg>,
      title: "Ícones de uniformes reais",
      desc: "Use camisetas de times brasileiros, europeus e seleções no seu uniforme.",
    },
    {
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>,
      title: "Exportação avançada",
      desc: "Temas exclusivos (Retrô, Neon, Mono, Personalizado), cores do círculo e escudo maior.",
    },
    {
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
      title: "Mais times e jogadores",
      desc: "Crie times ilimitados com até 50 jogadores cada. Sem restrições de escalações.",
    },
    {
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
      title: "Histórico completo",
      desc: "Acesse e exporte todo o histórico de partidas, escalações e mensalidades.",
    },
    {
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
      title: "Novidades em primeira mão",
      desc: "Acesso antecipado a novas funcionalidades antes de chegarem ao plano gratuito.",
    },
  ];

  const freeVsPremium = [
    { feature: "Times",           free: "1",          premium: "Ilimitados" },
    { feature: "Jogadores por time", free: "12",      premium: "50" },
    { feature: "Escalações",      free: "1",          premium: "Ilimitadas" },
    { feature: "Colaboração",     free: "Membro (1)", premium: "Criar + entrar" },
    { feature: "Ícone de uniforme", free: "Redondo",  premium: "Camiseta real" },
    { feature: "Temas de exportação", free: "Moderno",premium: "Todos (6)" },
  ];

  return (
    <div style={{minHeight:"100vh",background:"#050c0a",display:"flex",flexDirection:"column",fontFamily:"'DM Sans',sans-serif",overflowY:"auto"}}>
      {/* Header */}
      <div style={{position:"sticky",top:0,zIndex:10,background:"rgba(5,12,10,0.96)",backdropFilter:"blur(12px)",borderBottom:"1px solid rgba(250,204,21,0.1)",padding:"14px 20px",display:"flex",alignItems:"center",gap:12}}>
        <button onClick={onBack} style={{background:"none",border:"none",padding:"6px 8px",cursor:"pointer",color:"#9ca3af",display:"flex",alignItems:"center",borderRadius:8}}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="#facc15"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:"#fde68a",letterSpacing:1.5}}>ESCALAÇÃO FC PREMIUM</span>
        </div>
      </div>

      <div style={{flex:1,padding:"24px 20px 40px",display:"flex",flexDirection:"column",gap:28}}>

        {/* Hero */}
        <div style={{borderRadius:20,background:"linear-gradient(135deg,#1c0d00 0%,#78350f 60%,#92400e 100%)",padding:"28px 24px",textAlign:"center",position:"relative",overflow:"hidden",boxShadow:"0 8px 32px rgba(250,204,21,0.15)"}}>
          <div style={{position:"absolute",inset:0,backgroundImage:"radial-gradient(circle at 30% 40%, rgba(250,204,21,0.12) 0%,transparent 60%), radial-gradient(circle at 75% 70%, rgba(251,146,60,0.1) 0%,transparent 50%)",pointerEvents:"none"}}/>
          <svg width="52" height="52" viewBox="0 0 24 24" fill="none" style={{marginBottom:12,filter:"drop-shadow(0 4px 12px rgba(250,204,21,0.4))"}}>
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="#facc15" stroke="#f59e0b" strokeWidth="0.5"/>
          </svg>
          <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:28,color:"#fde68a",letterSpacing:2,lineHeight:1,marginBottom:8}}>DESBLOQUEIE O MÁXIMO</div>
          <div style={{color:"rgba(253,230,138,0.75)",fontSize:13,lineHeight:1.55,maxWidth:280,margin:"0 auto"}}>
            Gerencie seu time como um profissional com recursos exclusivos do plano premium.
          </div>
          {isPremium&&(
            <div style={{marginTop:16,display:"inline-flex",alignItems:"center",gap:6,background:"rgba(52,211,153,0.15)",border:"1px solid rgba(52,211,153,0.3)",borderRadius:20,padding:"6px 14px",color:"#34d399",fontSize:12,fontWeight:700}}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              Você já é Premium!
            </div>
          )}
        </div>

        {/* Benefits list */}
        <div>
          <div style={{color:"#6b7280",fontSize:10,fontWeight:800,letterSpacing:1.2,textTransform:"uppercase",marginBottom:12}}>Recursos inclusos</div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {benefits.map((b,i)=>(
              <div key={i} style={{display:"flex",alignItems:"flex-start",gap:14,background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:14,padding:"14px 16px"}}>
                <div style={{width:40,height:40,borderRadius:12,background:"rgba(52,211,153,0.08)",border:"1px solid rgba(52,211,153,0.15)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  {b.icon}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{color:"#e5e7eb",fontSize:13.5,fontWeight:700,marginBottom:3}}>{b.title}</div>
                  <div style={{color:"#6b7280",fontSize:12,lineHeight:1.5}}>{b.desc}</div>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.5" strokeLinecap="round" style={{flexShrink:0,marginTop:2}}><polyline points="20 6 9 17 4 12"/></svg>
              </div>
            ))}
          </div>
        </div>

        {/* Free vs Premium table */}
        <div>
          <div style={{color:"#6b7280",fontSize:10,fontWeight:800,letterSpacing:1.2,textTransform:"uppercase",marginBottom:12}}>Comparativo de planos</div>
          <div style={{borderRadius:16,overflow:"hidden",border:"1px solid rgba(255,255,255,0.07)"}}>
            {/* Table header */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 90px 100px",background:"rgba(255,255,255,0.05)",padding:"10px 16px",gap:8}}>
              <div style={{color:"#6b7280",fontSize:10,fontWeight:800,letterSpacing:0.8,textTransform:"uppercase"}}>Recurso</div>
              <div style={{color:"#6b7280",fontSize:10,fontWeight:800,letterSpacing:0.8,textTransform:"uppercase",textAlign:"center"}}>FREE</div>
              <div style={{color:"#fde68a",fontSize:10,fontWeight:800,letterSpacing:0.8,textTransform:"uppercase",textAlign:"center",display:"flex",alignItems:"center",justifyContent:"center",gap:4}}>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="#facc15"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                PRO
              </div>
            </div>
            {freeVsPremium.map((row,i)=>(
              <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 90px 100px",padding:"11px 16px",gap:8,borderTop:"1px solid rgba(255,255,255,0.04)",background:i%2===0?"transparent":"rgba(255,255,255,0.015)"}}>
                <div style={{color:"#d1d5db",fontSize:12,fontWeight:500,display:"flex",alignItems:"center"}}>{row.feature}</div>
                <div style={{color:"#6b7280",fontSize:11,fontWeight:600,textAlign:"center",display:"flex",alignItems:"center",justifyContent:"center"}}>{row.free}</div>
                <div style={{color:"#34d399",fontSize:11,fontWeight:700,textAlign:"center",display:"flex",alignItems:"center",justifyContent:"center"}}>{row.premium}</div>
              </div>
            ))}
          </div>
        </div>

        {/* CTA / Payment placeholder */}
        {!isPremium&&(
          <div style={{borderRadius:20,border:"1px solid rgba(250,204,21,0.2)",background:"rgba(250,204,21,0.04)",padding:"24px 20px",textAlign:"center"}}>
            <div style={{color:"#fde68a",fontFamily:"'Bebas Neue',sans-serif",fontSize:22,letterSpacing:1.5,marginBottom:6}}>ASSINAR PREMIUM</div>
            <div style={{color:"#9ca3af",fontSize:12,lineHeight:1.55,marginBottom:20}}>
              Pagamento seguro via Google Play. Cancele quando quiser.
            </div>
            <button disabled style={{
              width:"100%",padding:"15px 20px",borderRadius:14,border:"none",cursor:"not-allowed",
              background:"linear-gradient(135deg,#78350f,#92400e)",
              color:"rgba(253,230,138,0.5)",fontFamily:"'Bebas Neue',sans-serif",
              fontSize:16,letterSpacing:1.5,display:"flex",alignItems:"center",justifyContent:"center",gap:8,opacity:0.6
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              EM BREVE — VIA GOOGLE PLAY
            </button>
            <div style={{marginTop:10,color:"#4b5563",fontSize:10,fontWeight:600,letterSpacing:0.5}}>
              Pagamento por assinatura será disponibilizado em breve
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

// ─── Home / Team List ─────────────────────────────────────────────────────────
// ─── Onboarding Screen ────────────────────────────────────────────────────────
const ONBOARDING_KEY = "escalacaofc_onboarding_v1";

function OnboardingScreen({ onDone }) {
  const [step, setStep] = React.useState(0);

  const slides = [
    {
      icon: (
        <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="1.4" strokeLinecap="round">
          <rect x="2" y="3" width="20" height="18" rx="2.5"/>
          <line x1="12" y1="3" x2="12" y2="21"/>
          <circle cx="12" cy="12" r="3"/>
          <rect x="2" y="8" width="4" height="8"/>
          <rect x="18" y="8" width="4" height="8"/>
        </svg>
      ),
      color: "#34d399",
      glow: "rgba(52,211,153,0.18)",
      title: "Monte suas escalações",
      desc: "Crie times, escolha formações táticas, escale jogadores e personalize uniformes. Tudo em um só lugar.",
    },
    {
      icon: (
        <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.4" strokeLinecap="round">
          <rect x="3" y="4" width="18" height="18" rx="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/>
          <line x1="8" y1="2" x2="8" y2="6"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
          <circle cx="8" cy="15" r="1" fill="#60a5fa"/>
          <circle cx="12" cy="15" r="1" fill="#60a5fa"/>
          <circle cx="16" cy="15" r="1" fill="#60a5fa"/>
        </svg>
      ),
      color: "#60a5fa",
      glow: "rgba(96,165,250,0.18)",
      title: "Organize sua pelada",
      desc: "Controle mensalidades, presenças e sorteie times por tampinhas ou lista. Perfeito para peladas fixas.",
    },
    {
      icon: (
        <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="1.4" strokeLinecap="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
        </svg>
      ),
      color: "#a78bfa",
      glow: "rgba(167,139,250,0.18)",
      title: "Sempre sincronizado",
      desc: "Seus dados ficam salvos na nuvem e disponíveis offline. Edite sem internet e sincronize ao reconectar.",
    },
  ];

  const slide = slides[step];
  const isLast = step === slides.length - 1;

  const finish = () => {
    localStorage.setItem(ONBOARDING_KEY, "1");
    logA("onboarding_complete");
    onDone();
  };

  return (
    <div style={{minHeight:"100vh",background:"#050c0a",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:"'DM Sans',sans-serif",padding:"32px 28px",boxSizing:"border-box"}}>
      <style>{`
        @keyframes ob-fade{from{opacity:0;transform:translateY(20px);}to{opacity:1;transform:translateY(0);}}
        .ob-slide{animation:ob-fade 0.4s ease both;}
      `}</style>

      {/* Logo topo */}
      <img src="/assets/images/icon-192.png" alt="Escalação FC" style={{width:52,height:52,borderRadius:14,marginBottom:40,boxShadow:"0 6px 24px rgba(52,211,153,0.3)"}}/>

      {/* Slide */}
      <div key={step} className="ob-slide" style={{display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center",maxWidth:340,flex:1,justifyContent:"center"}}>
        <div style={{width:96,height:96,borderRadius:28,background:slide.glow,border:`1px solid ${slide.color}33`,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:32,boxShadow:`0 0 40px ${slide.glow}`}}>
          {slide.icon}
        </div>
        <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:30,color:"#fff",letterSpacing:1.5,lineHeight:1.1,marginBottom:16}}>{slide.title}</div>
        <div style={{color:"#6b7280",fontSize:15,lineHeight:1.7,maxWidth:280}}>{slide.desc}</div>
      </div>

      {/* Dots */}
      <div style={{display:"flex",gap:8,marginBottom:36}}>
        {slides.map((_,i)=>(
          <div key={i} onClick={()=>setStep(i)} style={{width:i===step?22:7,height:7,borderRadius:4,background:i===step?slide.color:"rgba(255,255,255,0.12)",transition:"all 0.3s",cursor:"pointer"}}/>
        ))}
      </div>

      {/* Botões */}
      <div style={{width:"100%",maxWidth:340,display:"flex",flexDirection:"column",gap:10}}>
        <button
          onClick={isLast ? finish : ()=>setStep(s=>s+1)}
          style={{width:"100%",padding:"15px",borderRadius:14,border:"none",background:`linear-gradient(135deg,${slide.color},${slide.color}bb)`,color:"#050c0a",fontFamily:"'Bebas Neue',sans-serif",fontSize:18,letterSpacing:1.5,cursor:"pointer",boxShadow:`0 6px 24px ${slide.glow}`,transition:"transform 0.15s,box-shadow 0.15s"}}
          onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-2px)";e.currentTarget.style.boxShadow=`0 10px 32px ${slide.glow}`;}}
          onMouseLeave={e=>{e.currentTarget.style.transform="";e.currentTarget.style.boxShadow=`0 6px 24px ${slide.glow}`;}}
        >
          {isLast ? "Começar" : "Próximo"}
        </button>
        {!isLast && (
          <button onClick={finish} style={{width:"100%",padding:"12px",borderRadius:14,border:"none",background:"none",color:"#4b5563",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:600,cursor:"pointer"}}>
            Pular
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main Menu Screen ─────────────────────────────────────────────────────────
// First screen after login — user picks which mode to enter.
function MainMenuScreen({user, onSelect, onLogout, onDeleteAccount, isPremium, onTogglePremium}) {
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const [deleteInput, setDeleteInput] = React.useState("");
  const [deleting, setDeleting] = React.useState(false);

  const confirmDelete = async () => {
    if (deleteInput.trim().toUpperCase() !== "EXCLUIR") return;
    setDeleting(true);
    await onDeleteAccount();
    setDeleting(false);
    setShowDeleteConfirm(false);
  };

  return (
    <div style={{minHeight:"100vh",background:"#050c0a",display:"flex",flexDirection:"column",fontFamily:"'DM Sans',sans-serif"}}>
      {/* Header */}
      <div style={{padding:"56px 24px 8px",display:"flex",flexDirection:"column",alignItems:"center",gap:12}}>
        <div style={{width:72,height:72,borderRadius:20,overflow:"hidden",boxShadow:"0 8px 32px rgba(52,211,153,0.4),0 2px 8px rgba(0,0,0,0.5)"}}>
          <img src={LOGO_URI} alt="Escalação FC" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
        </div>
        <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:30,color:"#fff",letterSpacing:2.5,lineHeight:1}}>ESCALAÇÃO FC</div>
        <div style={{color:"#374151",fontSize:11,fontWeight:700,letterSpacing:1.2,textTransform:"uppercase"}}>Selecione o modo</div>
      </div>

      {/* Mode cards — premium photo style */}
      <style>{`
        @keyframes pm-ripple{0%{transform:scale(0);opacity:0.5;}100%{transform:scale(4);opacity:0;}}
        @keyframes pm-card-press{0%{transform:scale(1);}50%{transform:scale(0.97);}100%{transform:scale(1);}}
        .pm-card{position:relative;width:100%;border:none;border-radius:20px;cursor:pointer;text-align:left;overflow:hidden;display:block;padding:0;background:none;-webkit-tap-highlight-color:transparent;box-shadow:0 8px 32px rgba(0,0,0,0.55);transition:transform 0.18s cubic-bezier(.25,.46,.45,.94),box-shadow 0.18s;}
        .pm-card:hover{transform:translateY(-3px);box-shadow:0 16px 48px rgba(0,0,0,0.7);}
        .pm-card.pm-pressing{animation:pm-card-press 0.35s cubic-bezier(.25,.46,.45,.94) forwards;}
        .pm-ripple{position:absolute;border-radius:50%;background:rgba(255,255,255,0.35);width:80px;height:80px;margin-top:-40px;margin-left:-40px;animation:pm-ripple 0.6s linear forwards;pointer-events:none;z-index:10;}
        .pm-card-img{width:100%;height:100%;object-fit:cover;transition:transform 0.35s cubic-bezier(.25,.46,.45,.94);display:block;}
        .pm-card:hover .pm-card-img,.pm-card:focus .pm-card-img{transform:scale(1.07);}
        .pm-card-img-wrap{width:100%;height:190px;overflow:hidden;border-radius:20px;position:relative;}
        .pm-card-overlay{position:absolute;inset:0;border-radius:20px;pointer-events:none;}
        .pm-card-body{position:absolute;bottom:0;left:0;right:0;padding:18px 20px 20px;pointer-events:none;}
        .pm-card-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:800;letter-spacing:0.8px;margin-bottom:8px;backdrop-filter:blur(6px);}
        .pm-card-title{color:#fff;font-family:'Bebas Neue',sans-serif;font-size:24px;letter-spacing:1.5px;line-height:1.1;margin-bottom:6px;text-shadow:0 2px 8px rgba(0,0,0,0.5);}
        .pm-card-desc{color:rgba(255,255,255,0.72);font-size:11.5px;line-height:1.5;margin-bottom:10px;text-shadow:0 1px 4px rgba(0,0,0,0.6);}
        .pm-tags{display:flex;gap:5px;flex-wrap:wrap;}
        .pm-tag{border-radius:6px;padding:2px 9px;font-size:10px;font-weight:700;backdrop-filter:blur(6px);}
        .pm-card-arrow{position:absolute;top:16px;right:16px;width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,0.15);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;pointer-events:none;}
        .pm-card:active .pm-card-img{transform:scale(1.03);}
        @media(min-width:480px){.pm-card-img-wrap{height:220px;}}
        .pm-premium-body{display:none;}
        @media(min-width:480px){.pm-premium-body{display:block;}}
      `}</style>
      <div style={{flex:1,padding:"28px 20px 24px",display:"flex",flexDirection:"column",gap:16,maxWidth:480,width:"100%",margin:"0 auto",boxSizing:"border-box"}}>

        {/* Card 1 — Futebol de Campo */}
        <button className="pm-card" onClick={(e)=>{const b=e.currentTarget;const r=document.createElement("span");r.className="pm-ripple";const rect=b.getBoundingClientRect();r.style.left=(e.clientX-rect.left)+"px";r.style.top=(e.clientY-rect.top)+"px";b.appendChild(r);b.classList.add("pm-pressing");setTimeout(()=>{r.remove();b.classList.remove("pm-pressing");},600);onSelect("field");}} aria-label="Futebol de Campo">
          <div className="pm-card-img-wrap">
            <img
              className="pm-card-img"
              src="/assets/images/campao.png"
              onError={e=>{e.target.style.display="none";e.target.parentNode.style.background="linear-gradient(135deg,#052e16,#16a34a)"}}
              alt="Futebol de Campo"
              loading="eager"
              
            />
            {/* Gradient overlay: dark bottom, subtle green tint top */}
            <div className="pm-card-overlay" style={{background:"linear-gradient(180deg,rgba(5,12,10,0.18) 0%,rgba(5,12,10,0.35) 40%,rgba(5,12,10,0.88) 100%)"}}/>
            <div className="pm-card-overlay" style={{background:"linear-gradient(135deg,rgba(22,163,74,0.22) 0%,transparent 60%)"}}/>
          </div>
          <div className="pm-card-body">
            <div className="pm-card-badge" style={{background:"rgba(52,211,153,0.22)",color:"#4ade80",border:"1px solid rgba(52,211,153,0.3)"}}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="#4ade80"><circle cx="12" cy="12" r="10"/></svg>
              DISPONÍVEL
            </div>
            <div className="pm-card-title">Futebol de Campo</div>
            <div className="pm-card-desc">Times, escalações táticas, uniformes, calendário de jogos e estatísticas completas.</div>
            <div className="pm-tags">
              {["Times","Escalação","Elenco","Escritório"].map(tag=>(
                <span key={tag} className="pm-tag" style={{background:"rgba(52,211,153,0.18)",color:"#6ee7b7",border:"1px solid rgba(52,211,153,0.2)"}}>{tag}</span>
              ))}
            </div>
          </div>
          <div className="pm-card-arrow">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
          </div>
        </button>

        {/* Card 2 — Pelada Mensal */}
        <button className="pm-card" onClick={(e)=>{const b=e.currentTarget;const r=document.createElement("span");r.className="pm-ripple";const rect=b.getBoundingClientRect();r.style.left=(e.clientX-rect.left)+"px";r.style.top=(e.clientY-rect.top)+"px";b.appendChild(r);b.classList.add("pm-pressing");setTimeout(()=>{r.remove();b.classList.remove("pm-pressing");},600);onSelect("monthly");}} aria-label="Pelada Mensal">
          <div className="pm-card-img-wrap">
            <img
              className="pm-card-img"
              src="/assets/images/society.png"
              onError={e=>{e.target.style.display="none";e.target.parentNode.style.background="linear-gradient(135deg,#1e3a8a,#3b82f6)"}}
              alt="Pelada Mensal"
              loading="eager"
              
            />
            {/* Gradient overlay: dark bottom, blue tint top */}
            <div className="pm-card-overlay" style={{background:"linear-gradient(180deg,rgba(5,12,10,0.18) 0%,rgba(5,12,10,0.38) 40%,rgba(5,12,10,0.9) 100%)"}}/>
            <div className="pm-card-overlay" style={{background:"linear-gradient(135deg,rgba(29,78,216,0.28) 0%,transparent 60%)"}}/>
          </div>
          <div className="pm-card-body">
            <div className="pm-card-badge" style={{background:"rgba(52,211,153,0.22)",color:"#4ade80",border:"1px solid rgba(52,211,153,0.3)"}}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="#4ade80"><circle cx="12" cy="12" r="10"/></svg>
              DISPONÍVEL
            </div>
            <div className="pm-card-title">Pelada Mensal</div>
            <div className="pm-card-desc">Society, Futsal ou pelada recorrente. Organize jogos, presenças e mensalidades.</div>
            <div className="pm-tags">
              {["Society","Futsal","Presenças","Mensalidade"].map(tag=>(
                <span key={tag} className="pm-tag" style={{background:"rgba(96,165,250,0.18)",color:"#93c5fd",border:"1px solid rgba(96,165,250,0.2)"}}>{tag}</span>
              ))}
            </div>
          </div>
          <div className="pm-card-arrow">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
          </div>
        </button>

        {/* Card 3 — Seja Premium (only FREE users) */}
        {!isPremium&&(
          <button className="pm-card" onClick={(e)=>{const b=e.currentTarget;const r=document.createElement("span");r.className="pm-ripple";const rect=b.getBoundingClientRect();r.style.left=(e.clientX-rect.left)+"px";r.style.top=(e.clientY-rect.top)+"px";b.appendChild(r);b.classList.add("pm-pressing");setTimeout(()=>{r.remove();b.classList.remove("pm-pressing");},600);onSelect("premium");}} aria-label="Seja Premium" style={{background:"linear-gradient(135deg,#1a0a00,#3d1500)"}}>
            <div className="pm-card-img-wrap" style={{height:140,background:"linear-gradient(135deg,#1a0a00 0%,#78350f 50%,#92400e 100%)"}}>
              <img
                className="pm-card-img"
                src="/assets/images/premium.png"
                onError={e=>{e.target.style.display="none";}}
                alt="Premium"
                loading="eager"
              />
              <div className="pm-card-overlay pm-premium-body" style={{background:"linear-gradient(to top,rgba(26,10,0,0.92) 0%,rgba(26,10,0,0.3) 60%,transparent 100%)"}}/>
              <div className="pm-card-body pm-premium-body">
                <div className="pm-card-badge" style={{background:"rgba(250,204,21,0.18)",border:"1px solid rgba(250,204,21,0.35)",color:"#fde68a"}}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="#facc15"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                  PREMIUM
                </div>
                <div className="pm-card-title" style={{color:"#fde68a",fontSize:22}}>Seja Premium</div>
                <div className="pm-tags">
                  {["Colaboração","Exportação","Uniformes","Sem limites"].map(tag=>(
                    <span key={tag} className="pm-tag" style={{background:"rgba(250,204,21,0.15)",color:"#fde68a",border:"1px solid rgba(250,204,21,0.25)"}}>{tag}</span>
                  ))}
                </div>
              </div>
            </div>
            <div className="pm-card-arrow">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fde68a" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
          </button>
        )}

      </div>

      {/* Footer: user info + logout */}
      <div style={{padding:"0 20px 8px",maxWidth:480,width:"100%",margin:"0 auto",boxSizing:"border-box"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
          <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
            {user?.photoURL
              ?<img src={user.photoURL} alt="" style={{width:34,height:34,borderRadius:"50%",objectFit:"cover",border:"2px solid rgba(52,211,153,0.3)",flexShrink:0}}/>
              :<div style={{width:34,height:34,borderRadius:"50%",background:"linear-gradient(135deg,#166534,#34d399)",display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:800,fontSize:13,flexShrink:0}}>{(user?.displayName||user?.email||"?")[0].toUpperCase()}</div>}
            <div style={{minWidth:0}}>
              <div style={{color:"#e5e7eb",fontSize:12,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{user?.displayName||user?.email||""}</div>
              {IS_DEV?(
                <button onClick={onTogglePremium} title="[DEV] Alternar plano localmente" style={{background:"none",border:"1px dashed rgba(250,204,21,0.35)",borderRadius:6,padding:"3px 7px",cursor:"pointer",color:isPremium?"#facc15":"#4B5563",fontSize:10,fontWeight:800,letterSpacing:0.5,display:"flex",alignItems:"center",gap:3}}>
                  {isPremium
                    ?<><svg width="10" height="10" viewBox="0 0 24 24" fill="#facc15"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>PRO</>
                    :"FREE"}
                  <span style={{fontSize:8,color:"#6b7280",marginLeft:1}}>DEV</span>
                </button>
              ):(
                <div style={{background:"none",border:"none",padding:0,color:isPremium?"#facc15":"#4B5563",fontSize:10,fontWeight:800,letterSpacing:0.5,display:"flex",alignItems:"center",gap:3,userSelect:"none"}}>
                  {isPremium
                    ?<><svg width="10" height="10" viewBox="0 0 24 24" fill="#facc15"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>PRO</>
                    :"FREE"}
                </div>
              )}
            </div>
          </div>
          <button onClick={onLogout} style={{
            display:"flex",alignItems:"center",gap:5,
            background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.18)",
            borderRadius:10,padding:"8px 14px",color:"#f87171",cursor:"pointer",
            fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,flexShrink:0,transition:"background 0.15s"
          }}
            onMouseEnter={e=>e.currentTarget.style.background="rgba(239,68,68,0.15)"}
            onMouseLeave={e=>e.currentTarget.style.background="rgba(239,68,68,0.08)"}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            Sair
          </button>
        </div>

        {/* Links legais */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:16,padding:"12px 0 32px",borderTop:"1px solid rgba(255,255,255,0.05)",marginTop:12}}>
          <a href="/privacy.html" target="_blank" rel="noopener" style={{color:"#4b5563",fontSize:10,fontWeight:600,letterSpacing:0.3,textDecoration:"none"}}>Política de Privacidade</a>
          <span style={{color:"#1f2937",fontSize:10}}>·</span>
          <button onClick={()=>setShowDeleteConfirm(true)} style={{background:"none",border:"none",color:"#4b5563",fontSize:10,fontWeight:600,letterSpacing:0.3,cursor:"pointer",padding:0,fontFamily:"'DM Sans',sans-serif"}}>Excluir minha conta</button>
        </div>
      </div>

      {/* Modal confirmação exclusão de conta */}
      {showDeleteConfirm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",backdropFilter:"blur(6px)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
          <div style={{background:"#0f1a14",border:"1px solid rgba(239,68,68,0.3)",borderRadius:20,padding:28,maxWidth:360,width:"100%",boxShadow:"0 24px 64px rgba(0,0,0,0.7)"}}>
            <div style={{width:48,height:48,borderRadius:14,background:"rgba(239,68,68,0.12)",border:"1px solid rgba(239,68,68,0.25)",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:16}}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#fff",letterSpacing:1,marginBottom:8}}>Excluir conta</div>
            <div style={{color:"#9ca3af",fontSize:13,lineHeight:1.6,marginBottom:20}}>
              Esta ação é <strong style={{color:"#f87171"}}>permanente e irreversível</strong>. Todos os seus times, jogadores, escalações e mensalistas serão apagados.<br/><br/>
              Digite <strong style={{color:"#fff",letterSpacing:1}}>EXCLUIR</strong> para confirmar:
            </div>
            <input
              value={deleteInput}
              onChange={e=>setDeleteInput(e.target.value)}
              placeholder="EXCLUIR"
              style={{width:"100%",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:10,padding:"10px 14px",color:"#fff",fontFamily:"'DM Sans',sans-serif",fontSize:14,fontWeight:700,letterSpacing:1,outline:"none",marginBottom:16,boxSizing:"border-box"}}
            />
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>{setShowDeleteConfirm(false);setDeleteInput("");}} style={{flex:1,padding:"11px",borderRadius:10,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.05)",color:"#9ca3af",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700,cursor:"pointer"}}>Cancelar</button>
              <button onClick={confirmDelete} disabled={deleteInput.trim().toUpperCase()!=="EXCLUIR"||deleting} style={{flex:1,padding:"11px",borderRadius:10,border:"none",background:deleteInput.trim().toUpperCase()==="EXCLUIR"?"rgba(239,68,68,0.85)":"rgba(239,68,68,0.2)",color:deleteInput.trim().toUpperCase()==="EXCLUIR"?"#fff":"#6b7280",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700,cursor:deleteInput.trim().toUpperCase()==="EXCLUIR"?"pointer":"default",transition:"background 0.15s"}}>
                {deleting?"Excluindo...":"Excluir conta"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Mensalistas Screen ──────────────────────────────────────────────────────

// ─── Collab Agenda Modals ──────────────────────────────────────────────

function EnableCollabAgendaModal({ agenda, user, onClose, onEnabled }) {
  const [step, setStep] = useState("confirm");
  const handleEnable = async () => {
    setStep("loading");
    const ok = await createCollabAgenda(user.uid, user, agenda);
    if (ok) setStep("done"); else setStep("error");
  };
  return (
    <div style={{position:"fixed",inset:0,zIndex:1200,display:"flex",alignItems:"flex-end",justifyContent:"center",background:"rgba(0,0,0,0.85)",backdropFilter:"blur(6px)"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#050e1f",border:"1px solid rgba(59,130,246,0.25)",borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"24px 20px 40px",display:"flex",flexDirection:"column",gap:18}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#fff",letterSpacing:1}}>ATIVAR COLABORACAO</span>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer",fontSize:20}}>X</button>
        </div>
        {step==="confirm"&&(<>
          <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",background:"rgba(59,130,246,0.06)",borderRadius:13,border:"1px solid rgba(59,130,246,0.2)"}}>
            <div style={{width:44,height:44,borderRadius:12,background:"linear-gradient(135deg,#1d4ed8,#3b82f6)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><img src="/assets/images/ball.png" alt="bola" style={{width:26,height:26,objectFit:"contain"}}/></div>
            <div>
              <div style={{color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:17,letterSpacing:0.5}}>{agenda.name}</div>
              <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:11}}>{(agenda.players||[]).length} mensalistas</div>
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {[
              {icon:"👥", title:"Edicao compartilhada", desc:"Qualquer membro pode registrar pagamentos, gastos e info da agenda."},
              {icon:"💰", title:"Financas em tempo real", desc:"Cobranças aparecem para todos na hora, sem recarregar."},
              {icon:"🔗", title:"Codigo permanente", desc:"Gere um codigo e compartilhe. Revogue removendo o membro."},
            ].map(({icon,title,desc})=>(
              <div key={title} style={{display:"flex",gap:12,padding:"10px 12px",background:"rgba(255,255,255,0.03)",borderRadius:11,border:"1px solid rgba(255,255,255,0.06)"}}>
                <span style={{fontSize:20,lineHeight:1.4}}>{icon}</span>
                <div>
                  <div style={{color:"#e5e7eb",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700}}>{title}</div>
                  <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11,marginTop:2,lineHeight:1.5}}>{desc}</div>
                </div>
              </div>
            ))}
          </div>
          <button onClick={handleEnable} style={{padding:"14px 0",borderRadius:13,border:"none",cursor:"pointer",background:"linear-gradient(135deg,#1e3a8a,#3b82f6)",color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:17,letterSpacing:1.5,boxShadow:"0 6px 20px rgba(59,130,246,0.35)"}}>ATIVAR COLABORACAO</button>
        </>)}
        {step==="loading"&&(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:14,padding:"30px 0"}}>
            <div style={{width:40,height:40,border:"3px solid rgba(59,130,246,0.2)",borderTopColor:"#3b82f6",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
            <span style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13}}>Ativando colaboracao...</span>
          </div>
        )}
        {step==="done"&&(<>
          <div style={{textAlign:"center",padding:"16px 0"}}>
            <div style={{fontSize:52,marginBottom:12}}>🤝</div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#fff",letterSpacing:1,marginBottom:6}}>COLABORACAO ATIVADA!</div>
            <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13,lineHeight:1.6}}>Convide outros usuarios para gerenciar a agenda juntos.</div>
          </div>
          <button onClick={()=>{ onEnabled&&onEnabled(); onClose(); }} style={{padding:"14px 0",borderRadius:13,border:"none",cursor:"pointer",background:"linear-gradient(135deg,#1e3a8a,#3b82f6)",color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:17,letterSpacing:1.5}}>VER AGENDA</button>
        </>)}
        {step==="error"&&(<>
          <div style={{textAlign:"center",padding:"20px 0"}}><div style={{color:"#f87171",fontFamily:"'Bebas Neue',sans-serif",fontSize:16,letterSpacing:1}}>ERRO AO ATIVAR</div></div>
          <button onClick={()=>setStep("confirm")} style={{padding:"13px 0",borderRadius:12,border:"none",cursor:"pointer",background:"rgba(255,255,255,0.06)",color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700}}>Tentar novamente</button>
        </>)}
      </div>
    </div>
  );
}

function CollabAgendaInviteModal({ agenda, user, onClose, onDeactivated, onEnabled }) {
  const [step, setStep] = useState("loading");
  const [code, setCode] = useState("");
  const [members, setMembers] = useState([]);
  const [copied, setCopied] = useState(false);
  const [removingUid, setRemovingUid] = useState(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [collabActive, setCollabActive] = useState(!!agenda.isCollab);
  const isOwner = agenda.ownerUid === user.uid;

  useEffect(() => {
    if (!collabActive) return;
    const fb = getFirebase(); if (!fb) { setStep("error"); return; }
    const unsub = fb.onSnapshot(
      fb.collection(fb.db, "collab_agendas", String(agenda.id), "members"),
      snap => { setMembers(snap.docs.map(d => d.data())); setStep("ready"); },
      () => setStep("error")
    );
    return () => unsub();
  }, [agenda.id, collabActive]);

  const handleDeactivate = async () => {
    setConfirmDeactivate(false);
    setStep("deactivating");
    const ok = await deactivateCollabAgenda(agenda.id, user.uid);
    if (ok) {
      setCollabActive(false);
      setCode("");
      setMembers([]);
      setStep("ready");
      if (onDeactivated) onDeactivated();
    } else {
      setStep("error");
    }
  };

  const handleReactivate = async () => {
    setStep("loading");
    const ok = await createCollabAgenda(user.uid, user, agenda);
    if (ok) {
      setCollabActive(true);
      if (onEnabled) onEnabled();
    } else {
      setStep("error");
    }
  };

  const handleGenerateCode = async () => {
    setStep("loading");
    const c = await createCollabAgendaInvite(agenda.id, agenda.name, user.uid, user.displayName || user.email || "");
    if (c) { setCode(c); setStep("ready"); } else setStep("error");
  };

  const handleCopy = async () => {
    const msg = "Convite para agenda " + agenda.name + " - Codigo: " + code;
    try {
      if (navigator.share) await navigator.share({ title:"Escalacao FC", text:msg });
      else { await navigator.clipboard.writeText(msg); setCopied(true); setTimeout(()=>setCopied(false),2500); }
    } catch { try { await navigator.clipboard.writeText(msg); setCopied(true); setTimeout(()=>setCopied(false),2500); } catch {} }
  };

  const handleRemove = async (mUid) => {
    setRemovingUid(mUid);
    await removeCollabAgendaMember(agenda.id, mUid);
    setMembers(prev => prev.filter(m => m.uid !== mUid));
    setRemovingUid(null);
    // Se o próprio usuário saiu, fechar o modal
    if (mUid === user.uid) onClose();
  };

  const roleColor = { owner:"#f59e0b", editor:"#60a5fa" };
  const roleLabel = { owner:"Dono", editor:"Editor" };

  return (
    <div style={{position:"fixed",inset:0,zIndex:1200,display:"flex",alignItems:"flex-end",justifyContent:"center",background:"rgba(0,0,0,0.85)",backdropFilter:"blur(6px)"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#050e1f",border:"1px solid rgba(59,130,246,0.25)",borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"22px 20px 40px",display:"flex",flexDirection:"column",gap:16,maxHeight:"85vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:"#fff",letterSpacing:1}}>COLABORACAO</span>
            <div style={{color:"#3b82f6",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,marginTop:1}}>{agenda.name}</div>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer",fontSize:20}}>X</button>
        </div>
        {/* Toggle ativar/desativar — apenas dono */}
        {isOwner && step !== "loading" && step !== "deactivating" && (
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{display:"flex",alignItems:"center",gap:6,padding:"5px 12px",borderRadius:8,flexShrink:0,
              background:collabActive?"rgba(52,211,153,0.08)":"rgba(255,255,255,0.04)",
              border:"1px solid "+(collabActive?"rgba(52,211,153,0.2)":"rgba(255,255,255,0.08)")}}>
              <div style={{width:7,height:7,borderRadius:"50%",background:collabActive?"#34d399":"#4B5563",flexShrink:0}}/>
              <span style={{color:collabActive?"#34d399":"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700}}>
                {collabActive?"ATIVA":"INATIVA"}
              </span>
            </div>
            {collabActive ? (
              <button onClick={()=>setConfirmDeactivate(true)}
                style={{padding:"5px 12px",borderRadius:8,border:"1px solid rgba(239,68,68,0.25)",background:"rgba(239,68,68,0.06)",color:"#f87171",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,cursor:"pointer"}}>
                Desativar
              </button>
            ) : (
              <button onClick={handleReactivate}
                style={{padding:"5px 12px",borderRadius:8,border:"1px solid rgba(59,130,246,0.3)",background:"rgba(59,130,246,0.1)",color:"#60a5fa",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,cursor:"pointer"}}>
                Reativar
              </button>
            )}
          </div>
        )}

        {/* Confirmação de desativação */}
        {confirmDeactivate&&(
          <div style={{padding:"14px",background:"rgba(239,68,68,0.06)",borderRadius:12,border:"1px solid rgba(239,68,68,0.2)"}}>
            <div style={{color:"#f87171",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700,marginBottom:6}}>Desativar colaboração?</div>
            <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11,lineHeight:1.5,marginBottom:10}}>
              Os dados serão restaurados para sua agenda pessoal. Membros perderão o acesso.
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setConfirmDeactivate(false)} style={{flex:1,padding:"9px 0",borderRadius:9,border:"1px solid rgba(255,255,255,0.1)",background:"transparent",color:"#9CA3AF",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700}}>Cancelar</button>
              <button onClick={handleDeactivate} style={{flex:1,padding:"9px 0",borderRadius:9,border:"none",background:"rgba(239,68,68,0.15)",color:"#f87171",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700}}>Confirmar</button>
            </div>
          </div>
        )}

        {(step==="loading"||step==="deactivating")&&(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:12,padding:"30px 0"}}>
            <div style={{width:36,height:36,border:"3px solid rgba(59,130,246,0.2)",borderTopColor:"#3b82f6",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
            <span style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:12}}>{step==="deactivating"?"Desativando...":"Carregando..."}</span>
          </div>
        )}
        {step==="ready"&&collabActive&&(<>
          <div>
            <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Membros ({members.length})</div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {members.map(m=>(
                <div key={m.uid} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:"rgba(255,255,255,0.03)",borderRadius:11,border:"1px solid rgba(255,255,255,0.06)"}}>
                  <div style={{width:36,height:36,borderRadius:"50%",background:"rgba(59,130,246,0.15)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontFamily:"'Bebas Neue',sans-serif",color:"#60a5fa",fontSize:16}}>
                    {(m.name||"?")[0].toUpperCase()}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{color:"#e5e7eb",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.name||"Usuario"}</div>
                    <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:10}}>{m.email||""}</div>
                  </div>
                  <span style={{padding:"2px 8px",borderRadius:6,background:roleColor[m.role]+"1a",border:"1px solid "+roleColor[m.role]+"33",color:roleColor[m.role],fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700,flexShrink:0}}>
                    {roleLabel[m.role]||m.role}
                  </span>
                  {isOwner && m.role!=="owner" && (
                    <button onClick={()=>handleRemove(m.uid)} disabled={removingUid===m.uid} style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.2)",color:"#f87171",borderRadius:7,padding:"4px 8px",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700,flexShrink:0}}>
                      {removingUid===m.uid?"...":"Remover"}
                    </button>
                  )}
                  {!isOwner && m.uid===user.uid && (
                    <button onClick={()=>handleRemove(m.uid)} style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.2)",color:"#f87171",borderRadius:7,padding:"4px 8px",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700,flexShrink:0}}>Sair</button>
                  )}
                </div>
              ))}
            </div>
          </div>
          {isOwner&&(
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1}}>Convidar alguem</div>
              {code ? (<>
                <div style={{display:"flex",justifyContent:"center"}}>
                  <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:36,letterSpacing:6,color:"#3b82f6",background:"rgba(59,130,246,0.08)",border:"2px dashed rgba(59,130,246,0.35)",borderRadius:14,padding:"12px 24px",textAlign:"center"}}>{code}</div>
                </div>
                <button onClick={handleCopy} style={{padding:"13px 0",borderRadius:12,border:"1px solid rgba(59,130,246,0.35)",cursor:"pointer",background:copied?"rgba(59,130,246,0.2)":"rgba(59,130,246,0.08)",color:"#60a5fa",fontFamily:"'Bebas Neue',sans-serif",fontSize:15,letterSpacing:1}}>
                  {copied?"COPIADO!":"COMPARTILHAR CODIGO"}
                </button>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={handleGenerateCode} style={{flex:1,padding:"10px 0",borderRadius:11,border:"1px solid rgba(255,255,255,0.08)",background:"transparent",color:"#4B5563",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:600}}>Novo</button>
                  <button onClick={async()=>{ if(!code) return; const fb=getFirebase(); if(!fb) return; try{await fb.deleteDoc(fb.doc(fb.db,"collab_agenda_invites",code));}catch{} setCode(""); }} style={{flex:1,padding:"10px 0",borderRadius:11,border:"1px solid rgba(239,68,68,0.2)",background:"rgba(239,68,68,0.06)",color:"#f87171",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:600}}>Revogar</button>
                </div>
              </>) : (
                <button onClick={handleGenerateCode} style={{padding:"13px 0",borderRadius:12,border:"none",cursor:"pointer",background:"linear-gradient(135deg,#1e3a8a,#3b82f6)",color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:16,letterSpacing:1.5}}>GERAR CODIGO DE CONVITE</button>
              )}
            </div>
          )}
        </>)}
        {step==="ready"&&!collabActive&&(
          <div style={{padding:"14px",background:"rgba(255,255,255,0.03)",borderRadius:12,border:"1px solid rgba(255,255,255,0.08)",textAlign:"center"}}>
            <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:12,lineHeight:1.6}}>
              Colaboração desativada. Use o botão "Reativar" acima para ativar novamente.
            </div>
          </div>
        )}
        {step==="error"&&(
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <div style={{color:"#f87171",fontFamily:"'Bebas Neue',sans-serif",fontSize:16,letterSpacing:1}}>ERRO</div>
            <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:12,marginTop:4}}>Verifique sua conexão e tente novamente.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function JoinCollabAgendaModal({ user, onClose, onJoined }) {
  const [code, setCode] = useState("");
  const [step, setStep] = useState("input");
  const [invite, setInvite] = useState(null);
  const [errMsg, setErrMsg] = useState("");

  const handleLookup = async () => {
    const q = code.trim().toUpperCase();
    if (q.length < 7) return;
    setStep("loading");
    const data = await fetchCollabAgendaInvite(q);
    if (!data) { setErrMsg("Codigo nao encontrado."); setStep("error"); return; }
    setInvite(data);
    setStep("preview");
  };

  const handleJoin = async () => {
    setStep("joining");
    const result = await acceptCollabAgendaInvite(invite, user.uid, user);
    if (result === "already_member") { setStep("already"); return; }
    if (result) setStep("done");
    else { setErrMsg("Erro ao entrar."); setStep("error"); }
  };

  return (
    <div style={{position:"fixed",inset:0,zIndex:1200,display:"flex",alignItems:"flex-end",justifyContent:"center",background:"rgba(0,0,0,0.85)",backdropFilter:"blur(6px)"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#050e1f",border:"1px solid rgba(59,130,246,0.25)",borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"22px 20px 40px",display:"flex",flexDirection:"column",gap:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#fff",letterSpacing:1}}>ENTRAR EM AGENDA</span>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer",fontSize:20}}>X</button>
        </div>
        {step==="input"&&(<>
          <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13,lineHeight:1.6}}>Insira o codigo do organizador para cogerenciar a agenda em tempo real.</div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            <input value={code} onChange={e=>setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,7))}
              placeholder="AABC123" maxLength={7}
              style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(59,130,246,0.25)",borderRadius:12,padding:"12px 14px",color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:26,letterSpacing:6,textAlign:"center",colorScheme:"dark",outline:"none"}}
              onFocus={e=>e.target.style.borderColor="#3b82f6"} onBlur={e=>e.target.style.borderColor="rgba(59,130,246,0.25)"} autoCapitalize="characters"/>
            <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:10,textAlign:"center"}}>Codigos de agenda comecam com A</div>
          </div>
          <button onClick={()=>handleLookup()} disabled={code.length<7} style={{padding:"14px 0",borderRadius:13,border:"none",cursor:code.length<7?"default":"pointer",background:code.length<7?"rgba(255,255,255,0.06)":"linear-gradient(135deg,#1e3a8a,#3b82f6)",color:code.length<7?"#4B5563":"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:17,letterSpacing:1.5}}>BUSCAR AGENDA</button>
        </>)}
        {(step==="loading"||step==="joining")&&(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:14,padding:"30px 0"}}>
            <div style={{width:40,height:40,border:"3px solid rgba(59,130,246,0.2)",borderTopColor:"#3b82f6",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
            <span style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13}}>{step==="loading"?"Buscando...":"Entrando..."}</span>
          </div>
        )}
        {step==="preview"&&invite&&(<>
          <div style={{padding:"14px",background:"rgba(59,130,246,0.06)",borderRadius:13,border:"1px solid rgba(59,130,246,0.2)"}}>
            <div style={{color:"#60a5fa",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,marginBottom:6}}>AGENDA COLABORATIVA</div>
            <div style={{color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:22,letterSpacing:0.5,marginBottom:4}}>{invite.agendaName}</div>
            <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11}}>Organizador: {invite.ownerName}</div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>setStep("input")} style={{flex:1,padding:"12px 0",borderRadius:11,border:"1px solid rgba(255,255,255,0.12)",background:"rgba(255,255,255,0.04)",color:"#9CA3AF",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700}}>Voltar</button>
            <button onClick={handleJoin} style={{flex:2,padding:"12px 0",borderRadius:11,border:"none",cursor:"pointer",background:"linear-gradient(135deg,#1e3a8a,#3b82f6)",color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:16,letterSpacing:1}}>ENTRAR NA AGENDA</button>
          </div>
        </>)}
        {step==="done"&&(<>
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <div style={{fontSize:52,marginBottom:12}}>🤝</div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#fff",letterSpacing:1,marginBottom:6}}>VOCE ENTROU NA AGENDA!</div>
            <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13,lineHeight:1.6}}>"{invite?.agendaName}" esta na sua lista.</div>
          </div>
          <button onClick={()=>{ onJoined&&onJoined(invite?.agendaId); onClose(); }} style={{padding:"14px 0",borderRadius:13,border:"none",cursor:"pointer",background:"linear-gradient(135deg,#1e3a8a,#3b82f6)",color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:17,letterSpacing:1.5}}>VER AGENDAS</button>
        </>)}
        {(step==="already"||step==="error")&&(<>
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <div style={{color:step==="already"?"#60a5fa":"#f87171",fontFamily:"'Bebas Neue',sans-serif",fontSize:18,letterSpacing:1,marginBottom:6}}>
              {step==="already"?"JA PARTICIPA DESTA AGENDA":"OPS!"}
            </div>
            <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13}}>{step==="error"?errMsg:"Voce ja e membro desta agenda."}</div>
          </div>
          <button onClick={()=>step==="error"?setStep("input"):onClose()} style={{padding:"13px 0",borderRadius:12,border:"none",cursor:"pointer",background:"rgba(255,255,255,0.06)",color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700}}>
            {step==="error"?"Tentar novamente":"Fechar"}
          </button>
        </>)}
      </div>
    </div>
  );
}


function MensalistasScreen({ onBack, uid, user, isPremium }) {
  const [agendas, setAgendas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeAgendaId, setActiveAgendaId] = useState(null);
  const [showNewAgenda, setShowNewAgenda] = useState(false);
  const [newAgendaName, setNewAgendaName] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [showCollabAgendaUpsell, setShowCollabAgendaUpsell] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [enableCollabAgenda, setEnableCollabAgenda] = useState(null);
  const [manageCollabAgenda, setManageCollabAgenda] = useState(null);
  const [showJoinCollabAgenda, setShowJoinCollabAgenda] = useState(false);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2500); };

  // ── Firestore paths ──────────────────────────────────────────────────────
  const colPath = uid ? `users/${uid}/mensalistas` : null;

  useEffect(() => {
    if (!uid) { setLoading(false); return; }
    const fb = getFirebase();
    if (!fb) { setLoading(false); return; }
    const { db, collection, query, orderBy, onSnapshot } = fb;
    const q = query(collection(db, `users/${uid}/mensalistas`), orderBy("createdAt", "asc"));
    const unsub = onSnapshot(q, snap => {
      const pessoais = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(a => !a._collabMigrated);
      // Carregar agendas colaborativas
      loadCollabAgendaRefs(uid).then(refs => {
        if (refs.length === 0) { setAgendas(pessoais); setLoading(false); return; }
        Promise.all(refs.map(r => loadCollabAgenda(r.agendaId))).then(collabList => {
          const collab = collabList.filter(Boolean);
          setAgendas([...pessoais, ...collab]);
          setLoading(false);
        });
      }).catch(() => { setAgendas(pessoais); setLoading(false); });
    }, () => setLoading(false));
    return () => unsub();
  }, [uid]);

  const createAgenda = async () => {
    const name = newAgendaName.trim();
    if (!name) return;
    setSaving(true);
    try {
      const fb = getFirebase();
      if (fb && uid) {
        const { db, doc, setDoc, serverTimestamp } = fb;
        // Gerar ID único com timestamp + random (evita doc(collection()) que requer addDoc)
        const newId = String(Date.now()) + Math.random().toString(36).slice(2, 7);
        await setDoc(doc(db, "users", uid, "mensalistas", newId), {
          id: newId,
          name,
          local: "",
          horario: "",
          mensalidade: "",
          players: [],
          createdAt: serverTimestamp(),
        });
      }
      setNewAgendaName("");
      setShowNewAgenda(false);
      showToast("Agenda criada!");
    } catch(e) {
      console.warn("createAgenda error:", e);
      showToast("Erro ao criar agenda. Tente novamente.");
    } finally {
      setSaving(false);
    }
  };

  const deleteAgenda = async (id) => {
    const ag = agendas.find(a => a.id === id);
    if (ag?.isCollab) {
      const isOwner = ag.ownerUid === uid;
      if (isOwner) { await deleteCollabAgenda(id); showToast("Agenda colaborativa encerrada"); }
      else { await removeCollabAgendaMember(id, uid); showToast("Você saiu da agenda"); }
    } else {
      const fb = getFirebase();
      if (fb && uid) {
        const { db, doc, deleteDoc } = fb;
        await deleteDoc(doc(db, `users/${uid}/mensalistas`, id));
      }
      showToast("Agenda excluída");
    }
    setDeleteConfirm(null);
    if (activeAgendaId === id) setActiveAgendaId(null);
    setAgendas(prev => prev.filter(a => a.id !== id));
  };

  if (activeAgendaId) {
    const agenda = agendas.find(a => a.id === activeAgendaId);
    if (agenda) return (
      <AgendaDetailScreen
        agenda={agenda}
        uid={uid}
        user={user}
        onBack={() => setActiveAgendaId(null)}
      />
    );
  }

  return (
    <div style={{ minHeight:"100vh", background:"#050c0a", fontFamily:"'DM Sans',sans-serif", display:"flex", flexDirection:"column" }}>
      <style>{`
        @keyframes ms-fadeUp{from{opacity:0;transform:translateY(14px);}to{opacity:1;transform:translateY(0);}}
        .ms-card{background:linear-gradient(135deg,#0d1f38 0%,#0a1628 100%);border:1px solid rgba(59,130,246,0.18);border-radius:16px;padding:16px 18px;cursor:pointer;transition:transform 0.15s,box-shadow 0.15s;animation:ms-fadeUp 0.3s ease both;-webkit-tap-highlight-color:transparent;}
        .ms-card:active{transform:scale(0.97);}
        .ms-card:hover{box-shadow:0 8px 28px rgba(59,130,246,0.18);transform:translateY(-2px);}
        .ms-input{width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(59,130,246,0.25);border-radius:12px;padding:12px 14px;color:#fff;font-family:'DM Sans',sans-serif;font-size:15px;outline:none;}
        .ms-input:focus{border-color:rgba(96,165,250,0.6);background:rgba(59,130,246,0.08);}
        .ms-btn-primary{background:linear-gradient(135deg,#1d4ed8,#3b82f6);border:none;border-radius:12px;padding:13px 24px;color:#fff;font-family:'DM Sans',sans-serif;font-weight:700;font-size:14px;cursor:pointer;transition:opacity 0.15s;}
        .ms-btn-primary:active{opacity:0.8;}
        .ms-btn-ghost{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:12px 20px;color:#9CA3AF;font-family:'DM Sans',sans-serif;font-size:14px;cursor:pointer;}
        .ms-toast{position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:#1d4ed8;color:#fff;padding:10px 22px;border-radius:20px;font-size:13px;font-weight:600;z-index:999;white-space:nowrap;pointer-events:none;animation:toastIn 0.25s ease;}
      `}</style>

      {/* Header */}
      <div style={{ padding:"52px 20px 20px", background:"linear-gradient(175deg,#050e1f 0%,#050c0a 100%)", borderBottom:"1px solid rgba(59,130,246,0.1)", position:"relative", overflow:"hidden" }}>
        <svg style={{ position:"absolute",inset:0,width:"100%",height:"100%",opacity:0.04,pointerEvents:"none" }} viewBox="0 0 360 120" preserveAspectRatio="xMidYMid slice">
          <rect x="12" y="8" width="336" height="104" fill="none" stroke="#3b82f6" strokeWidth="1.5" rx="3"/>
          <line x1="12" y1="60" x2="348" y2="60" stroke="#3b82f6" strokeWidth="1"/>
          <circle cx="180" cy="60" r="22" fill="none" stroke="#3b82f6" strokeWidth="1"/>
        </svg>
        <button onClick={onBack} style={{ position:"absolute",top:16,left:16,width:36,height:36,borderRadius:12,border:"1px solid rgba(59,130,246,0.2)",background:"rgba(59,130,246,0.08)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"#60a5fa",zIndex:2 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:8,position:"relative",zIndex:1 }}>
          <div style={{ fontSize:32 }}><img src="/assets/images/ball.png" alt="bola" style={{width:40,height:40,objectFit:"contain"}}/></div>
          <div style={{ fontFamily:"'Bebas Neue',sans-serif",fontSize:26,color:"#fff",letterSpacing:2 }}>MENSALISTAS</div>
          <div style={{ color:"#374ea8",fontSize:11,fontWeight:700,letterSpacing:1.2,textTransform:"uppercase" }}>Suas Agendas de Futebol</div>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex:1, padding:"20px 20px 100px", overflowY:"auto" }}>
        {loading ? (
          <div style={{ display:"flex",alignItems:"center",justifyContent:"center",paddingTop:60 }}>
            <div style={{ width:32,height:32,border:"3px solid rgba(59,130,246,0.3)",borderTopColor:"#3b82f6",borderRadius:"50%",animation:"spin 0.8s linear infinite" }}/>
          </div>
        ) : agendas.length === 0 ? (
          <div style={{ textAlign:"center",paddingTop:60,color:"#4B5563" }}>
            <div style={{ marginBottom:16 }}><Icon id="calendar" size={48} style={{color:"#4B5563"}}/></div>
            <div style={{ fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:"#6B7280",letterSpacing:1,marginBottom:8 }}>NENHUMA AGENDA CRIADA</div>
            <div style={{ fontSize:13,color:"#374151",lineHeight:1.6 }}>Crie sua primeira agenda de futebol,<br/>ex: Fut de Terça, Fut de Quinta...</div>
          </div>
        ) : (
          <div style={{ display:"flex",flexDirection:"column",gap:12 }}>
            {agendas.map((ag, i) => (
              <div key={ag.id} className="ms-card" style={{ animationDelay:`${i*0.06}s` }} onClick={() => setActiveAgendaId(ag.id)}>
                <div style={{ display:"flex",alignItems:"center",gap:14 }}>
                  <div style={{ width:44,height:44,borderRadius:12,background:"linear-gradient(135deg,#1d4ed8,#3b82f6)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}><img src="/assets/images/ball.png" alt="bola" style={{width:26,height:26,objectFit:"contain"}}/></div>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ display:"flex",alignItems:"center",gap:6,lineHeight:1.2,marginBottom:4 }}>
                      <div style={{ color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:18,letterSpacing:1 }}>{ag.name}</div>
                      {ag.isCollab&&<span style={{ padding:"1px 6px",background:"rgba(59,130,246,0.15)",border:"1px solid rgba(59,130,246,0.3)",borderRadius:5,color:"#60a5fa",fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:700 }}>COLAB</span>}
                    </div>
                    <div style={{ display:"flex",gap:10,flexWrap:"wrap" }}>
                      {ag.horario && <span style={{ color:"#60a5fa",fontSize:11,fontWeight:600,display:"flex",alignItems:"center",gap:3 }}><Icon id="clock" size={11}/> {ag.horario}</span>}
                      {ag.local && <span style={{ color:"#9CA3AF",fontSize:11,display:"flex",alignItems:"center",gap:3 }}><Icon id="map-pin" size={11}/> {ag.local}</span>}
                      <span style={{ color:"#9CA3AF",fontSize:11,display:"flex",alignItems:"center",gap:3 }}><Icon id="users" size={11}/> {(ag.players||[]).length} jogador{(ag.players||[]).length!==1?"es":""}</span>
                    </div>
                  </div>
                  <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                    {!(ag.isCollab && ag.ownerUid !== uid) && (
                      <button onClick={e => { e.stopPropagation(); if(!isPremium){ setShowCollabAgendaUpsell(true); return; } if(ag.isCollab){ setManageCollabAgenda(ag); } else { setEnableCollabAgenda(ag); } }} title={ag.isCollab?"Gerenciar colaboração":"Ativar colaboração"} style={{ width:30,height:30,borderRadius:8,border:"1px solid rgba(59,130,246,0.25)",background:"rgba(59,130,246,0.08)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"#60a5fa",flexShrink:0 }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                      </button>
                    )}
                    {ag.isCollab && ag.ownerUid !== uid ? (
                      <button onClick={e => { e.stopPropagation(); setDeleteConfirm(ag.id); }} title="Sair da agenda" style={{ width:30,height:30,borderRadius:8,border:"1px solid rgba(251,191,36,0.25)",background:"rgba(251,191,36,0.08)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"#FBBF24",flexShrink:0 }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                      </button>
                    ) : (
                      <button onClick={e => { e.stopPropagation(); setDeleteConfirm(ag.id); }} title="Excluir agenda" style={{ width:30,height:30,borderRadius:8,border:"1px solid rgba(239,68,68,0.25)",background:"rgba(239,68,68,0.08)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"#F87171",flexShrink:0 }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                      </button>
                    )}
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4B5563" strokeWidth="2" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Botao entrar em agenda collab */}
      <button onClick={() => { if(!isPremium&&agendas.filter(a=>a.isCollab&&a.ownerUid!==uid).length>=1){ setShowCollabAgendaUpsell(true); return; } setShowJoinCollabAgenda(true); }} style={{ position:"fixed",bottom:96,right:24,zIndex:50,padding:"8px 14px",borderRadius:14,border:"1px solid rgba(59,130,246,0.35)",background:"rgba(59,130,246,0.1)",color:"#60a5fa",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:6 }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        Entrar em agenda
      </button>

      {/* FAB */}
      <button onClick={() => setShowNewAgenda(true)} style={{ position:"fixed",bottom:28,right:24,width:56,height:56,borderRadius:18,background:"linear-gradient(135deg,#1d4ed8,#3b82f6)",border:"none",boxShadow:"0 8px 24px rgba(59,130,246,0.45)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",zIndex:50 }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>

      {/* Modal nova agenda */}
      {showNewAgenda && (
        <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",backdropFilter:"blur(4px)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:200,padding:"0 0 0" }}>
          <div style={{ background:"#0d1828",borderRadius:"24px 24px 0 0",padding:"28px 24px 40px",width:"100%",maxWidth:520,border:"1px solid rgba(59,130,246,0.2)",borderBottom:"none" }}>
            <div style={{ fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#fff",letterSpacing:1.5,marginBottom:6 }}>NOVA AGENDA</div>
            <div style={{ color:"#4B5563",fontSize:12,marginBottom:20 }}>Ex: Fut de Terça, Fut de Quinta...</div>
            <input
              className="ms-input"
              placeholder="Nome da agenda..."
              value={newAgendaName}
              onChange={e => setNewAgendaName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && createAgenda()}
              autoFocus
            />
            <div style={{ display:"flex",gap:10,marginTop:16 }}>
              <button className="ms-btn-ghost" style={{ flex:1 }} onClick={() => { setShowNewAgenda(false); setNewAgendaName(""); }}>Cancelar</button>
              <button className="ms-btn-primary" style={{ flex:2, opacity: saving||!newAgendaName.trim() ? 0.6:1 }} onClick={createAgenda} disabled={saving||!newAgendaName.trim()}>
                {saving ? "Salvando..." : "Criar Agenda"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm delete */}
      {deleteConfirm && (() => {
        const confirmAg = agendas.find(a => a.id === deleteConfirm);
        const isGuest = confirmAg?.isCollab && confirmAg?.ownerUid !== uid;
        return (
          <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:"0 24px" }}>
            <div style={{ background:"#0d1828",borderRadius:20,padding:"28px 24px",width:"100%",maxWidth:340,border:`1px solid ${isGuest?"rgba(251,191,36,0.2)":"rgba(239,68,68,0.2)"}` }}>
              <div style={{ fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:isGuest?"#FBBF24":"#F87171",letterSpacing:1,marginBottom:10 }}>{isGuest?"SAIR DA AGENDA?":"EXCLUIR AGENDA?"}</div>
              <div style={{ color:"#9CA3AF",fontSize:13,marginBottom:20,lineHeight:1.5 }}>{isGuest?"Você deixará de ter acesso a esta agenda colaborativa.":"Todos os dados desta agenda serão removidos permanentemente."}</div>
              <div style={{ display:"flex",gap:10 }}>
                <button className="ms-btn-ghost" style={{ flex:1 }} onClick={() => setDeleteConfirm(null)}>Cancelar</button>
                <button onClick={() => deleteAgenda(deleteConfirm)} style={{ flex:1,background:isGuest?"linear-gradient(135deg,#b45309,#f59e0b)":"linear-gradient(135deg,#dc2626,#ef4444)",border:"none",borderRadius:12,padding:"12px",color:"#fff",fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer" }}>{isGuest?"Sair":"Excluir"}</button>
              </div>
            </div>
          </div>
        );
      })()}

      {enableCollabAgenda&&user&&(
        <EnableCollabAgendaModal
          agenda={enableCollabAgenda}
          user={user}
          onClose={()=>setEnableCollabAgenda(null)}
          onEnabled={()=>{
            setAgendas(prev=>prev.map(a=>a.id===enableCollabAgenda.id?{...a,isCollab:true,ownerUid:uid}:a));
            showToast("Colaboracao ativada!");
          }}
        />
      )}
      {manageCollabAgenda&&user&&(
        <CollabAgendaInviteModal
          agenda={manageCollabAgenda}
          user={user}
          onClose={()=>setManageCollabAgenda(null)}
          onDeactivated={()=>{
            setAgendas(prev=>prev.map(a=>a.id===manageCollabAgenda.id?{...a,isCollab:false,ownerUid:undefined}:a));
            setManageCollabAgenda(prev=>prev?{...prev,isCollab:false}:null);
            showToast("Colaboracao desativada — agenda restaurada");
          }}
          onEnabled={()=>{
            setAgendas(prev=>prev.map(a=>a.id===manageCollabAgenda.id?{...a,isCollab:true,ownerUid:uid}:a));
            setManageCollabAgenda(prev=>prev?{...prev,isCollab:true}:null);
            showToast("Colaboracao reativada!");
          }}
        />
      )}
      {showJoinCollabAgenda&&user&&(
        <JoinCollabAgendaModal
          user={user}
          onClose={()=>setShowJoinCollabAgenda(false)}
          onJoined={async(agendaId)=>{
            if(agendaId){
              const ag=await loadCollabAgenda(agendaId);
              if(ag) setAgendas(prev=>[...prev.filter(a=>a.id!==agendaId),ag]);
            }
            showToast("Voce entrou na agenda!");
          }}
        />
      )}

      {toast && <div className="ms-toast">{toast}</div>}
      {showCollabAgendaUpsell&&<PremiumUpsellModal
        title="Colaboração de agenda premium"
        description="Ativar e entrar em agendas colaborativas é exclusivo do plano premium. Faça upgrade para cogerenciar mensalidades e finanças com outros usuários em tempo real."
        onClose={()=>setShowCollabAgendaUpsell(false)}
      />}
    </div>
  );
}

// ─── Agenda Detail Screen ─────────────────────────────────────────────────────
function AgendaDetailScreen({ agenda: agendaProp, uid, user, onBack }) {
  // Para agendas colaborativas, manter os dados em tempo real via onSnapshot
  const [agenda, setAgenda] = React.useState(agendaProp);
  useEffect(() => {
    setAgenda(agendaProp); // sync quando a prop muda (ex: lista atualiza)
  }, [agendaProp.id]);
  useEffect(() => {
    if (!agendaProp.isCollab) return;
    const fb = getFirebase(); if (!fb) return;
    const unsub = fb.onSnapshot(
      fb.doc(fb.db, "collab_agendas", String(agendaProp.id)),
      snap => { if (snap.exists()) setAgenda({ id: snap.id, ...snap.data(), isCollab: true }); },
      () => {}
    );
    return () => unsub();
  }, [agendaProp.id, agendaProp.isCollab]);
// ─── Mensalidade Tab ─────────────────────────────────────────────────────────
const MESES = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

function MensalidadeTab({ agenda, uid, mensalistasPlayers, valorMensalidade, agendaInfo }) {
  const now = new Date();
  const [mes, setMes] = useState(now.getMonth());
  const [ano, setAno] = useState(now.getFullYear());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [showAddAvulso, setShowAddAvulso] = useState(false);
  const [avulsoName, setAvulsoName] = useState("");
  const [showGasto, setShowGasto] = useState(false);
  const [gastoDesc, setGastoDesc] = useState("");
  const [gastoValor, setGastoValor] = useState("");
  const [showDeleteGasto, setShowDeleteGasto] = useState(null);
  const [valorCampo, setValorCampo] = useState("");
  const [saldoCaixaAnterior, setSaldoCaixaAnterior] = useState("");
  const [saldoCaixaAnteriorNome, setSaldoCaixaAnteriorNome] = useState("Saldo em Caixa Anterior (adicionar ao total)");
  const [editingSaldoNome, setEditingSaldoNome] = useState(false);
  const [outrosCaixas, setOutrosCaixas] = useState([]); // [{id, nome, valor}]
  const [showAddCaixa, setShowAddCaixa] = useState(false);
  const [novoCaixaNome, setNovoCaixaNome] = useState("");
  const [editingCaixaId, setEditingCaixaId] = useState(null); // renomear
  const [expandedId, setExpandedId] = useState(null);
  const [copiedReport, setCopiedReport] = useState(false);
  const saveTimer = useRef(null);

  const mesAnoKey = `${String(mes+1).padStart(2,"0")}_${ano}`;
  const docPath = uid ? mensalidadePath(uid, agenda.id, mesAnoKey, !!agenda.isCollab) : null;
  const showToast = (msg) => { setToast(msg); setTimeout(()=>setToast(null),2200); };

  useEffect(() => {
    if (!uid) { setLoading(false); return; }
    const fb = getFirebase();
    if (!fb) { setLoading(false); return; }
    setLoading(true);
    const { db, doc, onSnapshot } = fb;
    const ref = doc(db, docPath);
    const unsub = onSnapshot(ref, snap => {
      if (snap.exists()) {
        const d = snap.data();
        setData(d);
        setValorCampo(d.valorCampo || "");
        setSaldoCaixaAnterior(d.saldoCaixaAnterior || "");
        setSaldoCaixaAnteriorNome(d.saldoCaixaAnteriorNome || "Saldo em Caixa Anterior (adicionar ao total)");
        setOutrosCaixas(d.outrosCaixas || []);
      } else {
        const initialPagamentos = mensalistasPlayers.map(p => ({
          id: p.id, name: p.name, tipo: "mensalista", pago: false, dataPagamento: "", obs: ""
        }));
        setData({ pagamentos: initialPagamentos, avulsos: [], gastos: [], valorCampo: "", saldoCaixaAnterior: "", saldoCaixaAnteriorNome: "Saldo em Caixa Anterior (adicionar ao total)", outrosCaixas: [] });
        setValorCampo("");
        setSaldoCaixaAnterior("");
        setSaldoCaixaAnteriorNome("Saldo em Caixa Anterior (adicionar ao total)");
        setOutrosCaixas([]);
      }
      setLoading(false);
    }, (err) => { console.warn("MensalidadeTab onSnapshot error:", err); setLoading(false); });
    return () => unsub();
  }, [mesAnoKey, uid, docPath, agenda.id]);

  const save = async (next) => {
    const fb = getFirebase();
    if (!fb || !uid) return;
    const { db, doc, setDoc } = fb;
    await setDoc(doc(db, docPath), next, { merge: true });
  };

  const saveDebounced = (next) => {
    setData(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save(next), 800);
  };

  // Sync novos mensalistas cadastrados na agenda
  // Usa ref para evitar loop: só salva quando há jogadores realmente novos
  // e evita re-trigger causado pelo proprio save
  const syncedKeyRef = useRef(null);
  useEffect(() => {
    if (!data || loading) return;
    // Chave única que representa o estado atual: mês+jogadores
    const key = mesAnoKey + "_" + mensalistasPlayers.map(p=>p.id).join(",");
    if (syncedKeyRef.current === key) return;
    const existingIds = new Set((data.pagamentos||[]).map(p=>p.id));
    const novos = mensalistasPlayers.filter(p=>!existingIds.has(p.id));
    syncedKeyRef.current = key;
    if (novos.length > 0) {
      const added = novos.map(p=>({ id:p.id, name:p.name, tipo:"mensalista", pago:false, dataPagamento:"", obs:"" }));
      const next = { ...data, pagamentos: [...(data.pagamentos||[]), ...added] };
      setData(next); save(next);
    }
  }, [data, mensalistasPlayers.length, mesAnoKey, loading]);

  if (!data && !loading) return null;

  const valorMsg = parseFloat(String(valorMensalidade||"").replace(/[^\d.,]/g,"").replace(",",".")) || 0;
  const pagosMensalistas = (data?.pagamentos||[]).filter(p=>p.pago).length;
  const totalArrecadado = (pagosMensalistas * valorMsg) +
    (data?.avulsos||[]).filter(a=>a.pago).reduce((s,a)=>s+(parseFloat(String(a.valor||0).replace(",","."))||0),0);
  const totalGastos = (data?.gastos||[]).reduce((s,g)=>s+(parseFloat(String(g.valor||0).replace(",","."))||0),0);
  const valorCampoNum = parseFloat(String(valorCampo||"").replace(/[^\d.,]/g,"").replace(",",".")) || 0;
  const saldoCaixaAnteriorNum = parseFloat(String(saldoCaixaAnterior||"").replace(/[^\d.,]/g,"").replace(",",".")) || 0;
  const outrosCaixasTotal = (outrosCaixas||[]).reduce((s,c) => s + (parseFloat(String(c.valor||"").replace(/[^\d.,]/g,"").replace(",",".")) || 0), 0);
  const saldo = totalArrecadado - totalGastos - valorCampoNum + saldoCaixaAnteriorNum + outrosCaixasTotal;

  const navMes = (dir) => {
    let m = mes + dir, a = ano;
    if (m < 0) { m = 11; a--; }
    if (m > 11) { m = 0; a++; }
    setMes(m); setAno(a);
  };

  const togglePago = (id, tipo) => {
    const key = tipo === "avulso" ? "avulsos" : "pagamentos";
    const list = [...(data[key]||[])];
    const idx = list.findIndex(p=>p.id===id);
    if (idx===-1) return;
    const wasPago = list[idx].pago;
    list[idx] = { ...list[idx], pago: !wasPago, dataPagamento: !wasPago ? new Date().toLocaleDateString("pt-BR") : list[idx].dataPagamento };
    saveDebounced({ ...data, [key]: list });
  };

  const updateField = (id, tipo, field, val) => {
    const key = tipo === "avulso" ? "avulsos" : "pagamentos";
    const list = [...(data[key]||[])];
    const idx = list.findIndex(p=>p.id===id);
    if (idx===-1) return;
    list[idx] = { ...list[idx], [field]: val };
    saveDebounced({ ...data, [key]: list });
  };

  const addAvulso = () => {
    const name = avulsoName.trim();
    if (!name) return;
    const a = { id: genUUID(), name, tipo:"avulso", pago:false, dataPagamento:"", obs:"", valor: String(valorMsg||"") };
    const next = { ...data, avulsos: [...(data.avulsos||[]), a] };
    save(next); setData(next);
    setAvulsoName(""); setShowAddAvulso(false);
    showToast("Avulso adicionado!");
  };

  const removeAvulso = (id) => {
    const next = { ...data, avulsos: (data.avulsos||[]).filter(a=>a.id!==id) };
    save(next); setData(next); showToast("Avulso removido");
  };

  const addGasto = () => {
    const desc = gastoDesc.trim();
    if (!desc) return;
    const g = { id: genUUID(), desc, valor: gastoValor, data: new Date().toLocaleDateString("pt-BR") };
    const next = { ...data, gastos: [...(data.gastos||[]), g] };
    save(next); setData(next);
    setGastoDesc(""); setGastoValor(""); setShowGasto(false);
    showToast("Gasto registrado!");
  };

  const removeGasto = (id) => {
    const next = { ...data, gastos: (data.gastos||[]).filter(g=>g.id!==id) };
    save(next); setData(next);
    setShowDeleteGasto(null); showToast("Gasto removido");
  };

  const handleValorCampo = (v) => {
    setValorCampo(v);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save({ ...data, valorCampo: v }), 800);
  };

  const addOutroCaixa = () => {
    const nome = novoCaixaNome.trim();
    if (!nome) return;
    const novo = { id: genUUID(), nome, valor: "" };
    const next = [...(outrosCaixas||[]), novo];
    setOutrosCaixas(next);
    setNovoCaixaNome(""); setShowAddCaixa(false);
    const nextData = { ...data, outrosCaixas: next };
    setData(nextData); save(nextData);
  };

  const updateOutroCaixa = (id, field, val) => {
    const next = (outrosCaixas||[]).map(c => c.id === id ? { ...c, [field]: val } : c);
    setOutrosCaixas(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const nextData = { ...data, outrosCaixas: next };
      setData(nextData); save(nextData);
    }, 800);
  };

  const removeOutroCaixa = (id) => {
    const next = (outrosCaixas||[]).filter(c => c.id !== id);
    setOutrosCaixas(next);
    const nextData = { ...data, outrosCaixas: next };
    setData(nextData); save(nextData);
  };

  const handleSaldoCaixaAnterior = (v) => {
    setSaldoCaixaAnterior(v);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save({ ...data, saldoCaixaAnterior: v, saldoCaixaAnteriorNome }), 800);
  };

  const PlayerRow = ({ item, tipo }) => {
    const isExp = expandedId === item.id;
    return (
      <div style={{ background: item.pago?"rgba(52,211,153,0.07)":"rgba(255,255,255,0.03)", border:`1px solid ${item.pago?"rgba(52,211,153,0.2)":"rgba(255,255,255,0.07)"}`, borderRadius:12, overflow:"hidden", transition:"border-color 0.2s" }}>
        <div style={{ padding:"11px 13px", display:"flex", alignItems:"center", gap:10, cursor:"pointer" }} onClick={()=>setExpandedId(isExp?null:item.id)}>
          <button onClick={e=>{e.stopPropagation();togglePago(item.id,tipo);}} style={{ width:28,height:28,borderRadius:8,border:`2px solid ${item.pago?"#34d399":"rgba(156,163,175,0.35)"}`,background:item.pago?"rgba(52,211,153,0.15)":"transparent",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0,transition:"all 0.2s" }}>
            {item.pago && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>}
          </button>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ color:item.pago?"#6ee7b7":"#E5E7EB", fontWeight:700, fontSize:13 }}>{item.name}</div>
            <div style={{ display:"flex", gap:6, marginTop:2, flexWrap:"wrap" }}>
              {tipo==="avulso" && <span style={{ fontSize:10,fontWeight:700,color:"#FBBF24",background:"rgba(251,191,36,0.12)",padding:"1px 6px",borderRadius:5 }}>AVULSO</span>}
              {item.pago
                ? <span style={{ fontSize:10,color:"#34d399",fontWeight:600 }}>✓ Pago{item.dataPagamento?` em ${item.dataPagamento}`:""}</span>
                : <span style={{ fontSize:10,color:"#6B7280" }}>Aguardando</span>}
              {item.obs && <span style={{ fontSize:10,color:"#60a5fa",display:"flex",alignItems:"center",gap:2 }}><Icon id="memo" size={10}/> {item.obs.slice(0,22)}{item.obs.length>22?"…":""}</span>}
            </div>
          </div>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4B5563" strokeWidth="2" strokeLinecap="round" style={{ transform:isExp?"rotate(90deg)":"none", transition:"transform 0.2s", flexShrink:0 }}><polyline points="9 18 15 12 9 6"/></svg>
        </div>
        {isExp && (
          <div style={{ padding:"0 13px 13px", borderTop:"1px solid rgba(255,255,255,0.05)" }}>
            <div style={{ display:"flex", gap:8, marginTop:10, marginBottom:8 }}>
              <div style={{ flex:1 }}>
                <div style={{ color:"#6B7280",fontSize:10,fontWeight:700,letterSpacing:0.8,marginBottom:4 }}>DATA PAGAMENTO</div>
                <input style={{ width:"100%",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"8px 10px",color:"#fff",fontSize:12,outline:"none",fontFamily:"'DM Sans',sans-serif" }} placeholder="dd/mm/aaaa" value={item.dataPagamento||""} onChange={e=>updateField(item.id,tipo,"dataPagamento",e.target.value)}/>
              </div>
              {tipo==="avulso" && (
                <div style={{ flex:1 }}>
                  <div style={{ color:"#6B7280",fontSize:10,fontWeight:700,letterSpacing:0.8,marginBottom:4 }}>VALOR (R$)</div>
                  <input style={{ width:"100%",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"8px 10px",color:"#fff",fontSize:12,outline:"none",fontFamily:"'DM Sans',sans-serif" }} placeholder="0,00" value={item.valor||""} onChange={e=>updateField(item.id,tipo,"valor",e.target.value)}/>
                </div>
              )}
            </div>
            <div>
              <div style={{ color:"#6B7280",fontSize:10,fontWeight:700,letterSpacing:0.8,marginBottom:4 }}>OBSERVAÇÃO</div>
              <input style={{ width:"100%",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"8px 10px",color:"#fff",fontSize:12,outline:"none",fontFamily:"'DM Sans',sans-serif" }} placeholder="Ex: Vai pagar na quinta..." value={item.obs||""} onChange={e=>updateField(item.id,tipo,"obs",e.target.value)}/>
            </div>
            {tipo==="avulso" && (
              <button onClick={()=>removeAvulso(item.id)} style={{ marginTop:10,alignSelf:"flex-end",background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:8,padding:"6px 12px",color:"#F87171",fontSize:11,fontWeight:700,cursor:"pointer",display:"block",marginLeft:"auto" }}>
                Remover avulso
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ flex:1, padding:"16px 16px 40px", overflowY:"auto", display:"flex", flexDirection:"column", gap:16 }}>
      <style>{`
        .men-label{color:#9CA3AF;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:5px;display:block;}
        .men-input{width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(59,130,246,0.2);border-radius:10px;padding:10px 12px;color:#fff;font-family:'DM Sans',sans-serif;font-size:13px;outline:none;}
        .men-input:focus{border-color:rgba(96,165,250,0.5);}
        .men-section-title{font-family:'Bebas Neue',sans-serif;font-size:15px;letter-spacing:1px;margin-bottom:10px;}
        .men-toast{position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:#1d4ed8;color:#fff;padding:10px 22px;border-radius:20px;font-size:13px;font-weight:600;z-index:999;white-space:nowrap;pointer-events:none;animation:toastIn 0.25s ease;}
      `}</style>

      {/* Nav mês */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", background:"rgba(255,255,255,0.03)", border:"1px solid rgba(59,130,246,0.15)", borderRadius:14, padding:"10px 14px" }}>
        <button onClick={()=>navMes(-1)} style={{ width:32,height:32,borderRadius:8,border:"1px solid rgba(59,130,246,0.2)",background:"rgba(59,130,246,0.08)",color:"#60a5fa",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ textAlign:"center" }}>
          <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:20, color:"#fff", letterSpacing:1.5 }}>{MESES[mes]} {ano}</div>
          <div style={{ fontSize:10, color:"#4B5563", fontWeight:700 }}>{(data?.pagamentos||[]).filter(p=>p.pago).length + (data?.avulsos||[]).filter(a=>a.pago).length} PAGAMENTOS CONFIRMADOS</div>
        </div>
        <button onClick={()=>navMes(1)} style={{ width:32,height:32,borderRadius:8,border:"1px solid rgba(59,130,246,0.2)",background:"rgba(59,130,246,0.08)",color:"#60a5fa",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>

      {loading ? (
        <div style={{ display:"flex",alignItems:"center",justifyContent:"center",padding:"40px 0" }}>
          <div style={{ width:28,height:28,border:"3px solid rgba(59,130,246,0.3)",borderTopColor:"#3b82f6",borderRadius:"50%",animation:"spin 0.8s linear infinite" }}/>
        </div>
      ) : (<>

      {/* Caixa */}
      <div style={{ background:"linear-gradient(135deg,#0a1628,#0d1f38)", border:"1px solid rgba(59,130,246,0.2)", borderRadius:16, padding:"16px" }}>
        <div className="men-section-title" style={{ color:"#60a5fa",display:"flex",alignItems:"center",gap:6 }}><Icon id="money-bag" size={14} style={{color:"#60a5fa"}}/> CAIXA DO MÊS</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:12 }}>
          <div style={{ background:"rgba(52,211,153,0.08)",border:"1px solid rgba(52,211,153,0.2)",borderRadius:10,padding:"10px 12px" }}>
            <div style={{ color:"#6B7280",fontSize:10,fontWeight:700 }}>ARRECADADO</div>
            <div style={{ color:"#34d399",fontFamily:"'Bebas Neue',sans-serif",fontSize:22,letterSpacing:1 }}>R$ {(totalArrecadado + saldoCaixaAnteriorNum + outrosCaixasTotal).toFixed(2).replace(".",",")}</div>
            <div style={{ color:"#4B5563",fontSize:10,marginTop:2 }}>{pagosMensalistas} mens. + {(data?.avulsos||[]).filter(a=>a.pago).length} avulsos{outrosCaixasTotal>0?` + outros`:""}{saldoCaixaAnteriorNum>0?` + ant.`:""}</div>
          </div>
          <div style={{ background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:10,padding:"10px 12px" }}>
            <div style={{ color:"#6B7280",fontSize:10,fontWeight:700 }}>SAÍDAS</div>
            <div style={{ color:"#F87171",fontFamily:"'Bebas Neue',sans-serif",fontSize:22,letterSpacing:1 }}>R$ {(totalGastos+valorCampoNum).toFixed(2).replace(".",",")}</div>
            <div style={{ color:"#4B5563",fontSize:10,marginTop:2 }}>Campo + gastos extras</div>
          </div>
        </div>
        <div style={{ background:saldo>=0?"rgba(52,211,153,0.1)":"rgba(239,68,68,0.1)", border:`1px solid ${saldo>=0?"rgba(52,211,153,0.3)":"rgba(239,68,68,0.3)"}`, borderRadius:10, padding:"10px 14px", display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
          <div style={{ color:"#9CA3AF",fontSize:11,fontWeight:700 }}>SALDO FINAL</div>
          <div style={{ color:saldo>=0?"#34d399":"#F87171", fontFamily:"'Bebas Neue',sans-serif", fontSize:26, letterSpacing:1 }}>R$ {saldo.toFixed(2).replace(".",",")}</div>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:5}}>
              {editingSaldoNome ? (
                <input
                  autoFocus
                  value={saldoCaixaAnteriorNome}
                  onChange={e=>setSaldoCaixaAnteriorNome(e.target.value)}
                  onBlur={()=>{ setEditingSaldoNome(false); save({ ...data, saldoCaixaAnteriorNome }); }}
                  onKeyDown={e=>{ if(e.key==="Enter"||e.key==="Escape"){ setEditingSaldoNome(false); save({ ...data, saldoCaixaAnteriorNome }); } }}
                  style={{flex:1,background:"rgba(59,130,246,0.08)",border:"1px solid rgba(59,130,246,0.4)",borderRadius:7,padding:"4px 8px",color:"#60a5fa",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,outline:"none",letterSpacing:0.5,textTransform:"uppercase"}}
                />
              ) : (
                <label className="men-label" style={{flex:1,marginBottom:0,display:"flex",alignItems:"center",gap:4,cursor:"pointer"}} onClick={()=>setEditingSaldoNome(true)}>
                  <Icon id="banknote" size={12}/> {saldoCaixaAnteriorNome}
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#4B5563" strokeWidth="2.2" strokeLinecap="round" style={{marginLeft:2}}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </label>
              )}
            </div>
            <input className="men-input" placeholder="Ex: 50,00" value={saldoCaixaAnterior} onChange={e=>handleSaldoCaixaAnterior(e.target.value)}/>
          </div>
          <div>
            <label className="men-label"><Icon id="stadium" size={12}/> Valor do Campo (abater do caixa)</label>
            <input className="men-input" placeholder="Ex: 300,00" value={valorCampo} onChange={e=>handleValorCampo(e.target.value)}/>
          </div>

          {/* Outros caixas */}
          {(outrosCaixas||[]).map(c=>(
            <div key={c.id} style={{display:"flex",flexDirection:"column",gap:5}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                {editingCaixaId===c.id ? (
                  <input
                    autoFocus
                    value={c.nome}
                    onChange={e=>updateOutroCaixa(c.id,"nome",e.target.value)}
                    onBlur={()=>setEditingCaixaId(null)}
                    onKeyDown={e=>e.key==="Enter"&&setEditingCaixaId(null)}
                    style={{flex:1,background:"rgba(59,130,246,0.08)",border:"1px solid rgba(59,130,246,0.4)",borderRadius:7,padding:"4px 8px",color:"#60a5fa",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,outline:"none",letterSpacing:0.5,textTransform:"uppercase"}}
                  />
                ) : (
                  <label className="men-label" style={{flex:1,marginBottom:0,display:"flex",alignItems:"center",gap:4,cursor:"pointer"}} onClick={()=>setEditingCaixaId(c.id)}>
                    <Icon id="banknote" size={12}/> {c.nome} (adicionar ao total)
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#4B5563" strokeWidth="2.2" strokeLinecap="round" style={{marginLeft:2}}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  </label>
                )}
                <button onClick={()=>removeOutroCaixa(c.id)} style={{background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:7,padding:"3px 8px",color:"#F87171",fontSize:10,fontWeight:700,cursor:"pointer",flexShrink:0,lineHeight:1.6}}>✕</button>
              </div>
              <input className="men-input" placeholder="Ex: 50,00" value={c.valor} onChange={e=>updateOutroCaixa(c.id,"valor",e.target.value)}/>
            </div>
          ))}

          {/* Botão adicionar novo caixa */}
          {showAddCaixa ? (
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <input
                autoFocus
                className="men-input"
                style={{flex:1}}
                placeholder="Nome do caixa (ex: Rifa, Doação...)"
                value={novoCaixaNome}
                onChange={e=>setNovoCaixaNome(e.target.value)}
                onKeyDown={e=>{ if(e.key==="Enter") addOutroCaixa(); if(e.key==="Escape") setShowAddCaixa(false); }}
              />
              <button onClick={addOutroCaixa} disabled={!novoCaixaNome.trim()} style={{padding:"9px 14px",borderRadius:9,border:"none",background:"linear-gradient(135deg,#1e3a8a,#3b82f6)",color:"#fff",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700,cursor:novoCaixaNome.trim()?"pointer":"default",opacity:novoCaixaNome.trim()?1:0.5,flexShrink:0}}>OK</button>
              <button onClick={()=>{setShowAddCaixa(false);setNovoCaixaNome("");}} style={{padding:"9px 10px",borderRadius:9,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.04)",color:"#6B7280",cursor:"pointer",flexShrink:0,fontSize:12}}>✕</button>
            </div>
          ) : (
            <button onClick={()=>setShowAddCaixa(true)} style={{alignSelf:"flex-start",display:"flex",alignItems:"center",gap:5,padding:"6px 12px",borderRadius:8,border:"1px dashed rgba(59,130,246,0.3)",background:"transparent",color:"#4B5563",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,transition:"all 0.15s"}}
              onMouseEnter={e=>{e.currentTarget.style.borderColor="rgba(59,130,246,0.6)";e.currentTarget.style.color="#60a5fa";}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor="rgba(59,130,246,0.3)";e.currentTarget.style.color="#4B5563";}}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Adicionar outro caixa
            </button>
          )}
        </div>
      </div>

      {/* Mensalistas */}
      <div>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
          <div className="men-section-title" style={{ color:"#60a5fa",marginBottom:0,display:"flex",alignItems:"center",gap:6 }}><Icon id="users" size={14} style={{color:"#60a5fa"}}/> MENSALISTAS ({(data?.pagamentos||[]).length})</div>
          <span style={{ fontSize:11,color:"#34d399",fontWeight:700 }}>{pagosMensalistas} pagos</span>
        </div>
        {(data?.pagamentos||[]).length === 0 ? (
          <div style={{ textAlign:"center",padding:"18px",color:"#4B5563",fontSize:12,border:"1px dashed rgba(255,255,255,0.07)",borderRadius:12 }}>Nenhum mensalista cadastrado na agenda</div>
        ) : (
          <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
            {(data?.pagamentos||[]).map(p=><PlayerRow key={p.id} item={p} tipo="mensalista"/>)}
          </div>
        )}
      </div>

      {/* Avulsos */}
      <div>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
          <div className="men-section-title" style={{ color:"#FBBF24",marginBottom:0,display:"flex",alignItems:"center",gap:6 }}><Icon id="lightning" size={14} style={{color:"#FBBF24"}}/> AVULSOS ({(data?.avulsos||[]).length})</div>
          <button onClick={()=>setShowAddAvulso(true)} style={{ background:"rgba(251,191,36,0.12)",border:"1px solid rgba(251,191,36,0.3)",borderRadius:8,padding:"5px 12px",color:"#FBBF24",fontSize:11,fontWeight:700,cursor:"pointer" }}>+ Adicionar</button>
        </div>
        {(data?.avulsos||[]).length === 0 ? (
          <div style={{ textAlign:"center",padding:"16px",color:"#4B5563",fontSize:12,border:"1px dashed rgba(255,255,255,0.07)",borderRadius:12 }}>Nenhum avulso neste mês</div>
        ) : (
          <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
            {(data?.avulsos||[]).map(a=><PlayerRow key={a.id} item={a} tipo="avulso"/>)}
          </div>
        )}
      </div>

      {/* Gastos */}
      <div>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
          <div className="men-section-title" style={{ color:"#F87171",marginBottom:0,display:"flex",alignItems:"center",gap:6 }}><Icon id="receipt" size={14} style={{color:"#F87171"}}/> GASTOS / SAÍDAS</div>
          <button onClick={()=>setShowGasto(true)} style={{ background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.25)",borderRadius:8,padding:"5px 12px",color:"#F87171",fontSize:11,fontWeight:700,cursor:"pointer" }}>+ Registrar</button>
        </div>
        {(data?.gastos||[]).length === 0 ? (
          <div style={{ textAlign:"center",padding:"16px",color:"#4B5563",fontSize:12,border:"1px dashed rgba(255,255,255,0.07)",borderRadius:12 }}>Nenhum gasto registrado</div>
        ) : (
          <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
            {(data?.gastos||[]).map(g=>(
              <div key={g.id} style={{ background:"rgba(239,68,68,0.06)",border:"1px solid rgba(239,68,68,0.15)",borderRadius:12,padding:"12px 14px",display:"flex",alignItems:"center",gap:10 }}>
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ color:"#FCA5A5",fontWeight:700,fontSize:13 }}>{g.desc}</div>
                  <div style={{ color:"#6B7280",fontSize:11,marginTop:2 }}>{g.data}</div>
                </div>
                <div style={{ color:"#F87171",fontFamily:"'Bebas Neue',sans-serif",fontSize:18,letterSpacing:1,flexShrink:0 }}>R$ {g.valor||"0"}</div>
                <button onClick={()=>setShowDeleteGasto(g.id)} style={{ width:28,height:28,borderRadius:7,border:"1px solid rgba(239,68,68,0.2)",background:"rgba(239,68,68,0.08)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"#F87171",flexShrink:0 }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Extrato para WhatsApp ── */}
      {!loading && data && (
        <div style={{ background:"linear-gradient(135deg,rgba(37,99,235,0.08),rgba(29,78,216,0.04))", border:"1px solid rgba(59,130,246,0.2)", borderRadius:16, padding:"16px" }}>
          <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:15, color:"#60a5fa", letterSpacing:1, marginBottom:10, display:"flex",alignItems:"center",gap:6 }}><Icon id="clipboard" size={14} style={{color:"#60a5fa"}}/> EXTRATO PARA WHATSAPP</div>
          <textarea
            readOnly
            value={(() => {
              const mesLabel = `${MESES[mes].toUpperCase()} ${ano}`;
              const agendaName = agenda.name.toUpperCase();
              const localStr = agendaInfo?.local || "-";
              const horarioStr = agendaInfo?.horario || "-";
              let txt = `💰 FINANCEIRO — ${agendaName}\n`;
              txt += `📅 ${mesLabel}\n`;
              txt += `📍 ${localStr} | 🕐 ${horarioStr}\n`;
              txt += `${"─".repeat(30)}\n\n`;
              const pags = data?.pagamentos || [];
              txt += `👥 MENSALISTAS (${pags.length})\n`;
              pags.forEach(p => {
                const s = p.pago ? `✅ PAGO${p.dataPagamento?` (${p.dataPagamento})`:""}` : "❌ PENDENTE";
                txt += `  ${p.name} — ${s}${p.obs?` | ${p.obs}`:""}\n`;
              });
              const avs = data?.avulsos || [];
              if (avs.length > 0) {
                txt += `\n⚡ AVULSOS (${avs.length})\n`;
                avs.forEach(a => {
                  const s = a.pago ? `✅ PAGO${a.dataPagamento?` (${a.dataPagamento})`:""}` : "❌ PENDENTE";
                  txt += `  ${a.name}${a.valor?` R$ ${a.valor}`:""} — ${s}\n`;
                });
              }
              txt += `\n${"─".repeat(30)}\n`;
              txt += `💵 Arrecadado: R$ ${totalArrecadado.toFixed(2).replace(".",",")}\n`;
              if (valorCampoNum > 0) txt += `🏟️ Campo: R$ ${valorCampoNum.toFixed(2).replace(".",",")}\n`;
              const gts = data?.gastos || [];
              if (gts.length > 0) {
                txt += `🧾 Gastos:\n`;
                gts.forEach(g => { txt += `  • ${g.desc}: R$ ${g.valor||"0"}\n`; });
              }
              txt += `\n${"─".repeat(30)}\n`;
              txt += `${saldo >= 0 ? "✅" : "⚠️"} SALDO: R$ ${saldo.toFixed(2).replace(".",",")}`;
              return txt;
            })()}
            style={{ width:"100%", background:"rgba(0,0,0,0.35)", border:"1px solid rgba(59,130,246,0.15)", borderRadius:12, padding:"12px", color:"#D1FAE5", fontFamily:"'Courier New',monospace", fontSize:11.5, lineHeight:1.7, whiteSpace:"pre-wrap", wordBreak:"break-word", resize:"none", outline:"none", minHeight:160, boxSizing:"border-box" }}
          />
          <button
            onClick={() => {
              const mesLabel = `${MESES[mes].toUpperCase()} ${ano}`;
              const agendaName = agenda.name.toUpperCase();
              const localStr = agendaInfo?.local || "-";
              const horarioStr = agendaInfo?.horario || "-";
              let txt = `💰 FINANCEIRO — ${agendaName}\n`;
              txt += `📅 ${mesLabel}\n`;
              txt += `📍 ${localStr} | 🕐 ${horarioStr}\n`;
              txt += `${"─".repeat(30)}\n\n`;
              const pags = data?.pagamentos || [];
              txt += `👥 MENSALISTAS (${pags.length})\n`;
              pags.forEach(p => {
                const s = p.pago ? `✅ PAGO${p.dataPagamento?` (${p.dataPagamento})`:""}` : "❌ PENDENTE";
                txt += `  ${p.name} — ${s}${p.obs?` | ${p.obs}`:""}\n`;
              });
              const avs = data?.avulsos || [];
              if (avs.length > 0) {
                txt += `\n⚡ AVULSOS (${avs.length})\n`;
                avs.forEach(a => {
                  const s = a.pago ? `✅ PAGO${a.dataPagamento?` (${a.dataPagamento})`:""}` : "❌ PENDENTE";
                  txt += `  ${a.name}${a.valor?` R$ ${a.valor}`:""} — ${s}\n`;
                });
              }
              txt += `\n${"─".repeat(30)}\n`;
              txt += `💵 Arrecadado: R$ ${totalArrecadado.toFixed(2).replace(".",",")}\n`;
              if (valorCampoNum > 0) txt += `🏟️ Campo: R$ ${valorCampoNum.toFixed(2).replace(".",",")}\n`;
              const gts = data?.gastos || [];
              if (gts.length > 0) {
                txt += `🧾 Gastos:\n`;
                gts.forEach(g => { txt += `  • ${g.desc}: R$ ${g.valor||"0"}\n`; });
              }
              txt += `\n${"─".repeat(30)}\n`;
              txt += `${saldo >= 0 ? "✅" : "⚠️"} SALDO: R$ ${saldo.toFixed(2).replace(".",",")}`;
              const fallback = () => { const ta=document.createElement("textarea"); ta.value=txt; ta.style.cssText="position:fixed;top:-9999px;opacity:0;"; document.body.appendChild(ta); ta.focus(); ta.select(); try{document.execCommand("copy");}catch(e){} document.body.removeChild(ta); };
              if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(txt).then(()=>{}).catch(fallback); } else { fallback(); }
              setCopiedReport(true); showToast("Extrato copiado!"); setTimeout(()=>setCopiedReport(false),2500);
            }}
            style={{ width:"100%", marginTop:10, padding:"13px", borderRadius:12, border:`1px solid ${copiedReport?"rgba(52,211,153,0.4)":"rgba(59,130,246,0.3)"}`, background:copiedReport?"rgba(52,211,153,0.12)":"rgba(59,130,246,0.1)", color:copiedReport?"#34d399":"#60a5fa", fontFamily:"'DM Sans',sans-serif", fontWeight:700, fontSize:14, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:8, transition:"all 0.2s" }}
          >
            {copiedReport
              ? <><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg> Copiado!</>
              : <><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copiar Extrato</>
            }
          </button>
        </div>
      )}

      </>)}

      {showAddAvulso && (
        <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(4px)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:300 }}>
          <div style={{ background:"#0d1828",borderRadius:"24px 24px 0 0",padding:"28px 20px 44px",width:"100%",maxWidth:520,border:"1px solid rgba(251,191,36,0.2)",borderBottom:"none" }}>
            <div style={{ fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:"#FBBF24",letterSpacing:1.5,marginBottom:16 }}>ADICIONAR AVULSO</div>
            <input className="men-input" style={{ marginBottom:16 }} placeholder="Nome do jogador avulso..." value={avulsoName} onChange={e=>setAvulsoName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addAvulso()} autoFocus/>
            <div style={{ display:"flex",gap:10 }}>
              <button onClick={()=>{setShowAddAvulso(false);setAvulsoName("");}} style={{ flex:1,background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:12,padding:"12px",color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:14,cursor:"pointer" }}>Cancelar</button>
              <button onClick={addAvulso} disabled={!avulsoName.trim()} style={{ flex:2,background:"linear-gradient(135deg,#b45309,#f59e0b)",border:"none",borderRadius:12,padding:"12px",color:"#fff",fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer",opacity:avulsoName.trim()?1:0.5 }}>Adicionar</button>
            </div>
          </div>
        </div>
      )}

      {showGasto && (
        <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(4px)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:300 }}>
          <div style={{ background:"#0d1828",borderRadius:"24px 24px 0 0",padding:"28px 20px 44px",width:"100%",maxWidth:520,border:"1px solid rgba(239,68,68,0.2)",borderBottom:"none" }}>
            <div style={{ fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:"#F87171",letterSpacing:1.5,marginBottom:16 }}>REGISTRAR GASTO</div>
            <div style={{ marginBottom:12 }}>
              <label className="men-label">DESCRIÇÃO (Ex: Churrasco, Resenha, Bola...)</label>
              <input className="men-input" placeholder="Ex: Churrasco pós-jogo" value={gastoDesc} onChange={e=>setGastoDesc(e.target.value)} autoFocus/>
            </div>
            <div style={{ marginBottom:16 }}>
              <label className="men-label">VALOR (R$)</label>
              <input className="men-input" placeholder="Ex: 150,00" value={gastoValor} onChange={e=>setGastoValor(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addGasto()}/>
            </div>
            <div style={{ display:"flex",gap:10 }}>
              <button onClick={()=>{setShowGasto(false);setGastoDesc("");setGastoValor("");}} style={{ flex:1,background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:12,padding:"12px",color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:14,cursor:"pointer" }}>Cancelar</button>
              <button onClick={addGasto} disabled={!gastoDesc.trim()} style={{ flex:2,background:"linear-gradient(135deg,#dc2626,#ef4444)",border:"none",borderRadius:12,padding:"12px",color:"#fff",fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer",opacity:gastoDesc.trim()?1:0.5 }}>Registrar</button>
            </div>
          </div>
        </div>
      )}

      {showDeleteGasto && (
        <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300,padding:"0 24px" }}>
          <div style={{ background:"#0d1828",borderRadius:20,padding:"24px 20px",width:"100%",maxWidth:320,border:"1px solid rgba(239,68,68,0.2)" }}>
            <div style={{ fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:"#F87171",marginBottom:8 }}>REMOVER GASTO?</div>
            <div style={{ color:"#9CA3AF",fontSize:13,marginBottom:18 }}>Esta saída será removida do caixa.</div>
            <div style={{ display:"flex",gap:10 }}>
              <button onClick={()=>setShowDeleteGasto(null)} style={{ flex:1,background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:12,padding:"11px",color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13,cursor:"pointer" }}>Cancelar</button>
              <button onClick={()=>removeGasto(showDeleteGasto)} style={{ flex:1,background:"linear-gradient(135deg,#dc2626,#ef4444)",border:"none",borderRadius:12,padding:"11px",color:"#fff",fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:13,cursor:"pointer" }}>Remover</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="men-toast">{toast}</div>}
    </div>
  );
}

  const [tab, setTab] = useState("info"); // "info" | "players" | "mensalidade" | "export"
  const [info, setInfo] = useState({ local: agenda.local||"", horario: agenda.horario||"", mensalidade: agenda.mensalidade||"" });
  const [players, setPlayers] = useState(agenda.players || []);

  // Para agendas colaborativas: sincronizar players e info quando o
  // onSnapshot do doc raiz atualizar `agenda` (edição de outro membro).
  useEffect(() => {
    if (!agenda.isCollab) return;
    setPlayers(agenda.players || []);
    setInfo({ local: agenda.local||"", horario: agenda.horario||"", mensalidade: agenda.mensalidade||"" });
  }, [
    JSON.stringify(agenda.players),
    agenda.local, agenda.horario, agenda.mensalidade, agenda.isCollab
  ]);
  const [toast, setToast] = useState(null);
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [newPlayer, setNewPlayer] = useState({ name: "", stars: 3 });
  const [deletePlayerConfirm, setDeletePlayerConfirm] = useState(null);
  // Export tab state
  const [numConfirmados, setNumConfirmados] = useState(18);
  const [numNaoPode, setNumNaoPode] = useState(3);
  const [numEspera, setNumEspera] = useState(1);
  const [copied, setCopied] = useState(false);
  const saveTimer = useRef(null);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2000); };

  const saveToFirestore = async (updatedInfo, updatedPlayers) => {
    const fb = getFirebase();
    if (!fb || !uid) return;
    const { db, doc, setDoc } = fb;
    const path = agenda.isCollab
      ? "collab_agendas/" + agenda.id
      : "users/" + uid + "/mensalistas/" + agenda.id;
    await setDoc(doc(db, path), {
      ...agenda,
      ...updatedInfo,
      players: updatedPlayers,
    }, { merge: true });
  };

  const handleInfoChange = (field, val) => {
    const next = { ...info, [field]: val };
    setInfo(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { saveToFirestore(next, players); }, 1000);
  };

  const addPlayer = async () => {
    const name = newPlayer.name.trim();
    if (!name) return;
    const p = { id: genUUID(), name, stars: newPlayer.stars };
    const next = [...players, p];
    setPlayers(next);
    setShowAddPlayer(false);
    setNewPlayer({ name:"", stars:3 });
    await saveToFirestore(info, next);
    showToast("Jogador adicionado!");
  };

  const removePlayer = async (id) => {
    const next = players.filter(p => p.id !== id);
    setPlayers(next);
    setDeletePlayerConfirm(null);
    await saveToFirestore(info, next);
    showToast("Jogador removido");
  };

  // ── Gera o texto da lista para WhatsApp ──────────────────────────────────
  const generateWhatsAppList = () => {
    const agendaName = agenda.name.toUpperCase();
    const localStr = info.local ? `LOCAL: ${info.local.toUpperCase()}` : "LOCAL: -";
    const horarioStr = info.horario ? info.horario.toUpperCase() : "";
    const header = `CONFIRMADOS - ${agendaName}${horarioStr ? ` - ${horarioStr}` : ""}\n${localStr}\n`;

    const confirmLines = Array.from({ length: numConfirmados }, (_, i) => `${i+1}- `).join("\n");
    const naoPodeLines = Array.from({ length: numNaoPode }, (_, i) => `${i+1}- `).join("\n");
    const esperaLines = Array.from({ length: numEspera }, (_, i) => `${i+1}- `).join("\n");

    return `${header}\n${confirmLines}\n\nNÃO PODERÁ IR\n${naoPodeLines}\n\nLISTA DE ESPERA AVULSOS\n${esperaLines}`;
  };

  const handleCopy = () => {
    const text = generateWhatsAppList();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        showToast("Lista copiada!");
        setTimeout(() => setCopied(false), 2500);
      }).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  };

  const fallbackCopy = (text) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand("copy"); setCopied(true); showToast("Lista copiada!"); setTimeout(()=>setCopied(false),2500); } catch(e) {}
    document.body.removeChild(ta);
  };

  const handleWhatsApp = () => {
    const text = generateWhatsAppList();
    const encoded = encodeURIComponent(text);
    window.open(`https://wa.me/?text=${encoded}`, "_blank");
  };

  return (
    <div style={{ minHeight:"100vh",background:"#050c0a",fontFamily:"'DM Sans',sans-serif",display:"flex",flexDirection:"column" }}>
      <style>{`
        .ad-input{width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(59,130,246,0.2);border-radius:12px;padding:13px 15px;color:#fff;font-family:'DM Sans',sans-serif;font-size:14px;outline:none;transition:border-color 0.2s,background 0.2s;}
        .ad-input:focus{border-color:rgba(96,165,250,0.55);background:rgba(59,130,246,0.07);}
        .ad-tab{flex:1;padding:10px 2px;background:none;border:none;cursor:pointer;font-family:'DM Sans',sans-serif;font-size:11.5px;font-weight:700;letter-spacing:0.3px;transition:color 0.15s;position:relative;}
        .ad-player-row{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:13px 15px;display:flex;align-items:center;gap:12px;animation:ms-fadeUp 0.25s ease both;}
        .ad-btn-primary{background:linear-gradient(135deg,#1d4ed8,#3b82f6);border:none;border-radius:12px;padding:13px 20px;color:#fff;font-family:'DM Sans',sans-serif;font-weight:700;font-size:14px;cursor:pointer;}
        .ad-btn-ghost{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:12px 20px;color:#9CA3AF;font-family:'DM Sans',sans-serif;font-size:14px;cursor:pointer;}
        .ad-toast{position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:#1d4ed8;color:#fff;padding:10px 22px;border-radius:20px;font-size:13px;font-weight:600;z-index:999;white-space:nowrap;pointer-events:none;animation:toastIn 0.25s ease;}
        .ad-num-btn{width:36px;height:36px;border-radius:10px;border:1px solid rgba(59,130,246,0.25);background:rgba(59,130,246,0.1);color:#60a5fa;font-size:18px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s;flex-shrink:0;}
        .ad-num-btn:active{background:rgba(59,130,246,0.25);}
        .ad-preview{width:100%;background:rgba(0,0,0,0.4);border:1px solid rgba(59,130,246,0.15);border-radius:14px;padding:16px;color:#D1FAE5;font-family:'Courier New',monospace;font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word;resize:none;outline:none;min-height:200px;}
        @keyframes ms-fadeUp{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:translateY(0);}}
        @keyframes waPulse{0%,100%{box-shadow:0 6px 20px rgba(37,211,102,0.4);}50%{box-shadow:0 6px 32px rgba(37,211,102,0.7);}}
      `}</style>

      {/* Header */}
      <div style={{ padding:"52px 20px 0",background:"linear-gradient(175deg,#050e1f 0%,#050c0a 100%)",borderBottom:"1px solid rgba(59,130,246,0.12)",position:"relative" }}>
        <button onClick={onBack} style={{ position:"absolute",top:16,left:16,width:36,height:36,borderRadius:12,border:"1px solid rgba(59,130,246,0.2)",background:"rgba(59,130,246,0.08)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"#60a5fa",zIndex:2 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>

        <div style={{ textAlign:"center",paddingBottom:16 }}>
          <div style={{ fontFamily:"'Bebas Neue',sans-serif",fontSize:24,color:"#fff",letterSpacing:2,lineHeight:1 }}>{agenda.name}</div>
          <div style={{ color:"#374ea8",fontSize:11,fontWeight:700,letterSpacing:1,marginTop:4,display:"flex",alignItems:"center",justifyContent:"center",gap:4 }}><img src="/assets/images/ball.png" alt="bola" style={{width:12,height:12,objectFit:"contain"}}/> AGENDA DE FUTEBOL</div>
        </div>

        {/* Tabs */}
        <div style={{ display:"flex",gap:0,borderTop:"1px solid rgba(59,130,246,0.1)",marginTop:4 }}>
          {[
            { key:"info", label:"Info", iconId:"info" },
            { key:"players", label:"Jogadores", iconId:"users" },
            { key:"mensalidade", label:"Finanças", iconId:"credit-card" },
            { key:"export", label:"WhatsApp", iconId:"upload" },
          ].map(t => (
            <button key={t.key} className="ad-tab" onClick={() => setTab(t.key)} style={{ color: tab===t.key ? "#60a5fa" : "#6B7280" }}>
              <Icon id={t.iconId} size={14}/> {t.label}
              {tab===t.key && <div style={{ position:"absolute",bottom:0,left:"8%",right:"8%",height:2,background:"linear-gradient(90deg,#1d4ed8,#60a5fa)",borderRadius:2 }}/>}
            </button>
          ))}
        </div>
      </div>

      {/* Tab: Info */}
      {tab === "info" && (
        <div style={{ flex:1,padding:"24px 20px 40px",overflowY:"auto",display:"flex",flexDirection:"column",gap:20 }}>
          <div>
            <div style={{ color:"#9CA3AF",fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:8,textTransform:"uppercase",display:"flex",alignItems:"center",gap:5 }}><Icon id="map-pin" size={11}/> Localização do Campo</div>
            <input className="ad-input" placeholder="Ex: Campo do Zé, Rua das Flores, 120" value={info.local} onChange={e => handleInfoChange("local", e.target.value)}/>
          </div>
          <div>
            <div style={{ color:"#9CA3AF",fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:8,textTransform:"uppercase",display:"flex",alignItems:"center",gap:5 }}><Icon id="clock" size={11}/> Horário do Jogo</div>
            <input className="ad-input" placeholder="Ex: Terças às 20h" value={info.horario} onChange={e => handleInfoChange("horario", e.target.value)}/>
          </div>
          <div>
            <div style={{ color:"#9CA3AF",fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:8,textTransform:"uppercase",display:"flex",alignItems:"center",gap:5 }}><Icon id="money-bag" size={11}/> Valor da Mensalidade</div>
            <input className="ad-input" placeholder="Ex: R$ 80,00" value={info.mensalidade} onChange={e => handleInfoChange("mensalidade", e.target.value)}/>
          </div>
          <div style={{ background:"linear-gradient(135deg,rgba(59,130,246,0.08),rgba(29,78,216,0.05))",border:"1px solid rgba(59,130,246,0.15)",borderRadius:14,padding:"14px 16px",display:"flex",alignItems:"center",gap:10 }}>
            <span style={{ fontSize:18 }}><Icon id="bulb" size={18} style={{color:"#60a5fa"}}/></span>
            <span style={{ color:"#6B7280",fontSize:12,lineHeight:1.5 }}>As informações são salvas automaticamente enquanto você digita.</span>
          </div>
        </div>
      )}

      {/* Tab: Players */}
      {tab === "players" && (
        <div style={{ flex:1,padding:"20px 20px 100px",overflowY:"auto" }}>
          {players.length === 0 ? (
            <div style={{ textAlign:"center",paddingTop:50,color:"#4B5563" }}>
              <div style={{ marginBottom:12 }}><Icon id="person" size={44} style={{color:"#4B5563"}}/></div>
              <div style={{ fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:"#6B7280",letterSpacing:1,marginBottom:6 }}>NENHUM JOGADOR</div>
              <div style={{ fontSize:12,color:"#374151" }}>Adicione os mensalistas desta agenda</div>
            </div>
          ) : (
            <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
              {players.map((p, i) => (
                <div key={p.id} className="ad-player-row" style={{ animationDelay:`${i*0.05}s` }}>
                  <div style={{ width:38,height:38,borderRadius:10,background:"linear-gradient(135deg,#1e3a5f,#1d4ed8)",display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:16,flexShrink:0 }}>
                    {p.name.charAt(0).toUpperCase()}
                  </div>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ color:"#fff",fontWeight:700,fontSize:14,lineHeight:1.2 }}>{p.name}</div>
                    <div style={{ display:"flex",gap:1,marginTop:2 }}>
                      {[1,2,3,4,5].map(s => (
                        <span key={s} style={{ fontSize:12,color: s<=(p.stars||3) ? "#FBBF24" : "#374151" }}>★</span>
                      ))}
                    </div>
                  </div>
                  <button onClick={() => setDeletePlayerConfirm(p.id)} style={{ width:30,height:30,borderRadius:8,border:"1px solid rgba(239,68,68,0.2)",background:"rgba(239,68,68,0.07)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"#F87171",flexShrink:0 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* FAB add player */}
          <button onClick={() => setShowAddPlayer(true)} style={{ position:"fixed",bottom:28,right:24,width:56,height:56,borderRadius:18,background:"linear-gradient(135deg,#1d4ed8,#3b82f6)",border:"none",boxShadow:"0 8px 24px rgba(59,130,246,0.45)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",zIndex:50 }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
        </div>
      )}

      {/* Tab: Mensalidade */}
      {tab === "mensalidade" && (
        <MensalidadeTab
          agenda={agenda}
          uid={uid}
          mensalistasPlayers={players}
          valorMensalidade={info.mensalidade}
          agendaInfo={info}
        />
      )}

      {/* Tab: Export / WhatsApp */}
      {tab === "export" && (
        <div style={{ flex:1,padding:"20px 20px 40px",overflowY:"auto",display:"flex",flexDirection:"column",gap:18 }}>

          {/* Configurações da lista */}
          <div style={{ background:"rgba(255,255,255,0.03)",border:"1px solid rgba(59,130,246,0.15)",borderRadius:16,padding:"18px 16px",display:"flex",flexDirection:"column",gap:14 }}>
            <div style={{ color:"#9CA3AF",fontSize:11,fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:2,display:"flex",alignItems:"center",gap:5 }}><Icon id="settings" size={12}/> Configurar Lista</div>

            {[
              { label:"Vagas — Confirmados", value:numConfirmados, set:setNumConfirmados, color:"#34d399" },
              { label:"Não Poderá Ir", value:numNaoPode, set:setNumNaoPode, color:"#F87171" },
              { label:"Lista de Espera Avulsos", value:numEspera, set:setNumEspera, color:"#FBBF24" },
            ].map(row => (
              <div key={row.label} style={{ display:"flex",alignItems:"center",gap:12 }}>
                <div style={{ flex:1,color:"#D1D5DB",fontSize:13,fontWeight:600 }}>{row.label}</div>
                <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                  <button className="ad-num-btn" onClick={() => row.set(v => Math.max(1,v-1))}>-</button>
                  <span style={{ color:row.color,fontFamily:"'Bebas Neue',sans-serif",fontSize:22,minWidth:28,textAlign:"center" }}>{row.value}</span>
                  <button className="ad-num-btn" onClick={() => row.set(v => Math.min(50,v+1))}>+</button>
                </div>
              </div>
            ))}
          </div>

          {/* Preview da lista */}
          <div>
            <div style={{ color:"#9CA3AF",fontSize:11,fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:8,display:"flex",alignItems:"center",gap:5 }}><Icon id="eye" size={11}/> Pré-visualização</div>
            <textarea
              className="ad-preview"
              readOnly
              value={generateWhatsAppList()}
            />
          </div>

          {/* Botões de ação */}
          <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
            <button
              onClick={handleCopy}
              style={{ width:"100%",padding:"15px",borderRadius:14,border:`1px solid ${copied ? "rgba(52,211,153,0.4)" : "rgba(59,130,246,0.3)"}`,background: copied ? "rgba(52,211,153,0.12)" : "rgba(59,130,246,0.1)",color: copied ? "#34d399" : "#60a5fa",fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,transition:"all 0.2s" }}
            >
              {copied
                ? <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg> Copiado!</>
                : <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copiar Lista</>
              }
            </button>

            <button
              onClick={handleWhatsApp}
              style={{ width:"100%",padding:"15px",borderRadius:14,border:"none",background:"linear-gradient(135deg,#128C7E,#25D366)",color:"#fff",fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,animation:"waPulse 2.5s ease-in-out infinite" }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.554 4.12 1.522 5.855L.057 23.882a.5.5 0 00.61.61l6.027-1.466A11.944 11.944 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.794 9.794 0 01-5.006-1.374l-.36-.213-3.717.904.922-3.617-.234-.372A9.792 9.792 0 012.182 12C2.182 6.57 6.57 2.182 12 2.182S21.818 6.57 21.818 12 17.43 21.818 12 21.818z"/></svg>
              Enviar pelo WhatsApp
            </button>
          </div>

          <div style={{ background:"rgba(37,211,102,0.06)",border:"1px solid rgba(37,211,102,0.15)",borderRadius:12,padding:"12px 14px",display:"flex",gap:8,alignItems:"flex-start" }}>
            <span style={{ fontSize:16 }}><Icon id="bulb" size={16} style={{color:"#37d399"}}/></span>
            <span style={{ color:"#6B7280",fontSize:12,lineHeight:1.6 }}>A lista é gerada com vagas em branco para os jogadores preencherem no grupo. Ajuste as quantidades acima conforme sua pelada.</span>
          </div>
        </div>
      )}

      {/* Modal adicionar jogador */}
      {showAddPlayer && (
        <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(4px)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:200 }}>
          <div style={{ background:"#0d1828",borderRadius:"24px 24px 0 0",padding:"28px 24px 44px",width:"100%",maxWidth:520,border:"1px solid rgba(59,130,246,0.2)",borderBottom:"none" }}>
            <div style={{ fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#fff",letterSpacing:1.5,marginBottom:20 }}>ADICIONAR JOGADOR</div>
            <div style={{ marginBottom:16 }}>
              <div style={{ color:"#9CA3AF",fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:8 }}>NOME</div>
              <input className="ad-input" placeholder="Nome do jogador..." value={newPlayer.name} onChange={e => setNewPlayer(p => ({...p, name:e.target.value}))} onKeyDown={e => e.key==="Enter" && addPlayer()} autoFocus/>
            </div>
            <div style={{ marginBottom:24 }}>
              <div style={{ color:"#9CA3AF",fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:10 }}>NÍVEL (ESTRELAS)</div>
              <div style={{ display:"flex",gap:6 }}>
                {[1,2,3,4,5].map(s => (
                  <button key={s} onClick={() => setNewPlayer(p => ({...p,stars:s}))} style={{ background:"none",border:"none",cursor:"pointer",padding:"4px 2px",fontSize:28,color: s<=newPlayer.stars ? "#FBBF24":"#374151",transition:"color 0.1s,transform 0.1s" }}>★</button>
                ))}
              </div>
            </div>
            <div style={{ display:"flex",gap:10 }}>
              <button className="ad-btn-ghost" style={{ flex:1 }} onClick={() => { setShowAddPlayer(false); setNewPlayer({name:"",stars:3}); }}>Cancelar</button>
              <button className="ad-btn-primary" style={{ flex:2, opacity: !newPlayer.name.trim()?0.6:1 }} onClick={addPlayer} disabled={!newPlayer.name.trim()}>Adicionar</button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm delete player */}
      {deletePlayerConfirm && (
        <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:"0 24px" }}>
          <div style={{ background:"#0d1828",borderRadius:20,padding:"28px 24px",width:"100%",maxWidth:340,border:"1px solid rgba(239,68,68,0.2)" }}>
            <div style={{ fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:"#F87171",letterSpacing:1,marginBottom:10 }}>REMOVER JOGADOR?</div>
            <div style={{ color:"#9CA3AF",fontSize:13,marginBottom:20 }}>O jogador será removido desta agenda.</div>
            <div style={{ display:"flex",gap:10 }}>
              <button className="ad-btn-ghost" style={{ flex:1 }} onClick={() => setDeletePlayerConfirm(null)}>Cancelar</button>
              <button onClick={() => removePlayer(deletePlayerConfirm)} style={{ flex:1,background:"linear-gradient(135deg,#dc2626,#ef4444)",border:"none",borderRadius:12,padding:"12px",color:"#fff",fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer" }}>Remover</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="ad-toast">{toast}</div>}
    </div>
  );
}

// ─── Sorteio Lista Screen ─────────────────────────────────────────────────────
function SorteioListaScreen({ onBack, uid }) {
  const TEAM_COLORS = [
    { label:"Verde",    value:"#22c55e", img:"/assets/images/tampinha-green.png"  },
    { label:"Vermelho", value:"#ef4444", img:"/assets/images/tampinha-red.png"    },
    { label:"Azul",     value:"#3b82f6", img:"/assets/images/tampinha-blue.png"   },
    { label:"Amarelo",  value:"#f59e0b", img:"/assets/images/tampinha-yellow.png" },
    { label:"Roxo",     value:"#a855f7", img:"/assets/images/tampinha-purple.png" },
    { label:"Laranja",  value:"#f97316", img:"/assets/images/tampinha-orange.png" },
    { label:"Rosa",     value:"#ec4899", img:"/assets/images/tampinha-pink.png"   },
    { label:"Ciano",    value:"#06b6d4", img:"/assets/images/tampinha-ciano.png"  },
    { label:"Branco",   value:"#e5e7eb", img:"/assets/images/tampinha-white.png"  },
    { label:"Preto",    value:"#374151", img:"/assets/images/tampinha-black.png"  },
  ];
  // Map color value → tampinha image
  const COLOR_IMG = Object.fromEntries(TEAM_COLORS.map(c => [c.value, c.img]));

  const SKILL_LABELS = ["Fraco","Regular","Bom","Ótimo","Craque"];
  const SKILL_COLORS = ["#6B7280","#60a5fa","#34d399","#f59e0b","#f43f5e"];
  const SKILL_EMOJI  = ["skill-1","skill-2","skill-3","skill-4","star"];

  // ── Steps: "setup" | "players" | "result"
  const [step, setStep] = useState("setup");

  // ── Setup state
  const [numTeams, setNumTeams] = useState(2);
  const [playersPerTeam, setPlayersPerTeam] = useState(5);
  const [teamColors, setTeamColors] = useState([TEAM_COLORS[0].value,TEAM_COLORS[1].value,TEAM_COLORS[2].value,TEAM_COLORS[3].value,TEAM_COLORS[4].value,TEAM_COLORS[5].value]);
  const [teamNames, setTeamNames] = useState(["Time A","Time B","Time C","Time D","Time E","Time F"]);
  const [drawMode, setDrawMode] = useState("balanced"); // "random" | "balanced"

  // ── Players state: [{id, name, skill:1-5, source, agendaName?}]
  const [players, setPlayers] = useState([]);
  const [agendas, setAgendas] = useState([]);
  const [loadingAgendas, setLoadingAgendas] = useState(false);
  const [showAgendaModal, setShowAgendaModal] = useState(false);
  const [avulsoName, setAvulsoName] = useState("");
  const [avulsoSkill, setAvulsoSkill] = useState(3);
  const [manualName, setManualName] = useState("");
  const [manualSkill, setManualSkill] = useState(3);
  const [showManualInput, setShowManualInput] = useState(false);
  const [showAvulsoInput, setShowAvulsoInput] = useState(false);
  const [editingSkill, setEditingSkill] = useState(null); // player id being edited

  // ── Result state
  const [teams, setTeams] = useState([]);
  const [manualAssign, setManualAssign] = useState(null);
  const [lastMode, setLastMode] = useState("balanced");
  const [toast, setToast] = useState(null);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2200); };

  // Load agendas from Firestore
  useEffect(() => {
    if (!uid) return;
    const fb = getFirebase(); if (!fb) return;
    setLoadingAgendas(true);
    const { db, collection, query, orderBy, getDocs } = fb;
    getDocs(query(collection(db, `users/${uid}/mensalistas`), orderBy("createdAt","asc")))
      .then(snap => { setAgendas(snap.docs.map(d => ({ id:d.id, ...d.data() }))); setLoadingAgendas(false); })
      .catch(() => setLoadingAgendas(false));
  }, [uid]);

  const totalSlots = numTeams * playersPerTeam;

  // ── Skill bar mini component
  const SkillBar = ({ value, onChange, size = "md" }) => {
    const sz = size === "sm" ? 22 : 28;
    return (
      <div style={{ display:"flex", gap:3 }}>
        {[1,2,3,4,5].map(v => (
          <button key={v} onClick={() => onChange && onChange(v)} style={{
            width:sz, height:sz, borderRadius:6, border:"none", cursor: onChange ? "pointer" : "default",
            background: v <= value ? SKILL_COLORS[value-1] : "rgba(255,255,255,0.07)",
            transition:"background 0.15s", display:"flex", alignItems:"center", justifyContent:"center",
            fontSize: size === "sm" ? 9 : 11, fontWeight:700, color: v <= value ? "#000" : "#4B5563"
          }}>{v <= value ? "★" : "☆"}</button>
        ))}
      </div>
    );
  };

  // ── Add players from agenda (inherit stars as skill if available)
  const addFromAgenda = (agenda) => {
    const existing = new Set(players.map(p => p.id));
    const toAdd = (agenda.players || [])
      .filter(p => !existing.has(`agenda_${agenda.id}_${p.id}`))
      .map(p => ({ id:`agenda_${agenda.id}_${p.id}`, name:p.name, skill: p.stars || 3, source:"agenda", agendaName:agenda.name }));
    if (toAdd.length === 0) { showToast("Todos já foram adicionados"); return; }
    setPlayers(prev => [...prev, ...toAdd]);
    showToast(`${toAdd.length} jogador(es) de ${agenda.name}`);
    setShowAgendaModal(false);
  };

  const addAvulso = () => {
    const name = avulsoName.trim(); if (!name) return;
    setPlayers(prev => [...prev, { id:genUUID(), name, skill:avulsoSkill, source:"avulso" }]);
    setAvulsoName(""); setShowAvulsoInput(false);
    showToast("Avulso adicionado!");
  };

  const addManual = () => {
    const name = manualName.trim(); if (!name) return;
    setPlayers(prev => [...prev, { id:genUUID(), name, skill:manualSkill, source:"manual" }]);
    setManualName("");
  };

  const removePlayer = (id) => setPlayers(prev => prev.filter(p => p.id !== id));

  const updateSkill = (id, skill) => {
    setPlayers(prev => prev.map(p => p.id === id ? { ...p, skill } : p));
    setEditingSkill(null);
  };

  // ── Balanced draw: snake draft by skill (desc sort → distribute round-robin alternating direction)
  const doBalancedDraw = (pool, n) => {
    const sorted = [...pool].sort((a, b) => (b.skill||3) - (a.skill||3) + (Math.random() - 0.5) * 0.01);
    const result = Array.from({ length: n }, (_, i) => ({
      name: teamNames[i] || `Time ${i+1}`,
      color: teamColors[i] || TEAM_COLORS[i % TEAM_COLORS.length].value,
      players: [], skillSum: 0,
    }));
    // Snake draft: 0,1,2 then 2,1,0 then 0,1,2...
    let dir = 1, cur = 0;
    sorted.forEach(p => {
      result[cur].players.push(p);
      result[cur].skillSum = (result[cur].skillSum || 0) + (p.skill || 3);
      cur += dir;
      if (cur >= n) { cur = n - 1; dir = -1; }
      else if (cur < 0) { cur = 0; dir = 1; }
    });
    return result;
  };

  // ── Random draw
  const doRandomDraw = (pool, n) => {
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const result = Array.from({ length: n }, (_, i) => ({
      name: teamNames[i] || `Time ${i+1}`,
      color: teamColors[i] || TEAM_COLORS[i % TEAM_COLORS.length].value,
      players: [], skillSum: 0,
    }));
    shuffled.forEach((p, i) => {
      const t = i % n;
      result[t].players.push(p);
      result[t].skillSum = (result[t].skillSum || 0) + (p.skill || 3);
    });
    return result;
  };

  const doSorteio = (mode) => {
    if (players.length < 2) { showToast("Adicione pelo menos 2 jogadores"); return; }
    const m = mode || drawMode;
    const result = m === "balanced" ? doBalancedDraw(players, numTeams) : doRandomDraw(players, numTeams);
    setTeams(result);
    setLastMode(m);
    setStep("result");
  };

  // ── Manual reassign
  const reassignPlayer = (playerId, toTeamIdx) => {
    setTeams(prev => {
      const next = prev.map(t => ({ ...t, players: t.players.filter(p => p.id !== playerId) }));
      const player = prev.flatMap(t => t.players).find(p => p.id === playerId);
      if (player) {
        next[toTeamIdx].players.push(player);
        next.forEach(t => { t.skillSum = t.players.reduce((s,p) => s+(p.skill||3), 0); });
      }
      return next;
    });
    setManualAssign(null);
    showToast("Jogador movido!");
  };

  const resorteio = () => { setTeams([]); setStep("players"); };
  const startOver = () => { setPlayers([]); setTeams([]); setStep("setup"); };

  // ── Color picker
  const ColorPicker = ({ value, onChange }) => (
    <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
      {TEAM_COLORS.map(c => (
        <button key={c.value} onClick={() => onChange(c.value)} title={c.label} style={{
          width:26, height:26, borderRadius:"50%", background:c.value, border:`2px solid ${value===c.value?"#fff":"transparent"}`,
          cursor:"pointer", outline:"none", boxShadow:value===c.value?"0 0 0 2px rgba(255,255,255,0.4)":"none"
        }}/>
      ))}
    </div>
  );

  const SL_STYLES = `
    .sl-input{width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(52,211,153,0.2);border-radius:10px;padding:10px 12px;color:#fff;font-family:'DM Sans',sans-serif;font-size:14px;outline:none;}
    .sl-input:focus{border-color:rgba(52,211,153,0.5);}
    .sl-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:14px;border-radius:14px;border:none;font-family:'DM Sans',sans-serif;font-weight:700;font-size:15px;cursor:pointer;transition:opacity 0.15s;}
    .sl-btn:active{opacity:0.8;}
    .sl-stepper{display:flex;align-items:center;gap:12px;}
    .sl-step-btn{width:36px;height:36px;border-radius:10px;border:1px solid rgba(52,211,153,0.3);background:rgba(52,211,153,0.08);color:#34d399;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-weight:700;}
    .sl-step-val{font-size:24px;font-family:'Bebas Neue',sans-serif;color:#fff;min-width:32px;text-align:center;letter-spacing:1px;}
    .sl-player-row{display:flex;align-items:center;gap:10px;padding:10px 12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;}
    .sl-team-card{border-radius:16px;padding:14px;}
    .sl-p-chip{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);cursor:pointer;}
    .sl-p-chip:active{opacity:0.75;}
    .sl-mode-btn{flex:1;padding:12px 8px;border-radius:12px;border:2px solid;font-family:'DM Sans',sans-serif;font-weight:700;font-size:12px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4;transition:all 0.15s;}
  `;

  const BackBtn = ({ onClick }) => (
    <button onClick={onClick} style={{ position:"absolute",top:16,left:16,width:36,height:36,borderRadius:12,border:"1px solid rgba(52,211,153,0.2)",background:"rgba(52,211,153,0.08)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"#34d399",zIndex:2 }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
    </button>
  );

  // ─────────────── STEP: SETUP ───────────────
  if (step === "setup") return (
    <div style={{ minHeight:"100vh", background:"#050c0a", fontFamily:"'DM Sans',sans-serif", display:"flex", flexDirection:"column" }}>
      <style>{SL_STYLES}</style>
      <div style={{ padding:"52px 20px 20px", background:"linear-gradient(175deg,#050e1f 0%,#050c0a 100%)", borderBottom:"1px solid rgba(52,211,153,0.1)", position:"relative" }}>
        <BackBtn onClick={onBack}/>
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:8 }}>
          <div style={{ marginBottom: 8 }}><img src="/assets/images/dado-colete.png" alt="Dado com colete" style={{ width: 56, height: 56, objectFit: "contain" }} /></div>
          <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:26, color:"#fff", letterSpacing:2 }}>SORTEIO DE TIMES</div>
          <div style={{ color:"#34d399", fontSize:11, fontWeight:700, letterSpacing:1.2, textTransform:"uppercase" }}>Configure o sorteio</div>
        </div>
      </div>

      <div style={{ flex:1, padding:"24px 20px 40px", display:"flex", flexDirection:"column", gap:20, overflowY:"auto" }}>

        {/* Modo de sorteio */}
        <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(52,211,153,0.1)", borderRadius:16, padding:16 }}>
          <div style={{ color:"#9CA3AF", fontSize:10, fontWeight:700, letterSpacing:1, textTransform:"uppercase", marginBottom:12 }}>Modo de Sorteio</div>
          <div style={{ display:"flex", gap:10 }}>
            <button className="sl-mode-btn" onClick={() => setDrawMode("balanced")} style={{
              borderColor: drawMode==="balanced" ? "#34d399" : "rgba(255,255,255,0.08)",
              background: drawMode==="balanced" ? "rgba(52,211,153,0.1)" : "rgba(255,255,255,0.03)",
              color: drawMode==="balanced" ? "#34d399" : "#9CA3AF"
            }}>
              <Icon id="balance" size={22}/>
              <span>Equilibrado</span>
              <span style={{ fontSize:10, fontWeight:400, opacity:0.7, textAlign:"center" }}>Distribui bons e fracos nos times</span>
            </button>
            <button className="sl-mode-btn" onClick={() => setDrawMode("random")} style={{
              borderColor: drawMode==="random" ? "#a855f7" : "rgba(255,255,255,0.08)",
              background: drawMode==="random" ? "rgba(168,85,247,0.1)" : "rgba(255,255,255,0.03)",
              color: drawMode==="random" ? "#a855f7" : "#9CA3AF"
            }}>
              <Icon id="dice" size={22}/>
              <span>Aleatório</span>
              <span style={{ fontSize:10, fontWeight:400, opacity:0.7, textAlign:"center" }}>Sorteio puro sem considerar nível</span>
            </button>
          </div>
        </div>

        {/* Número de times */}
        <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(52,211,153,0.1)", borderRadius:16, padding:16 }}>
          <div style={{ color:"#9CA3AF", fontSize:10, fontWeight:700, letterSpacing:1, textTransform:"uppercase", marginBottom:12 }}>Número de Times</div>
          <div className="sl-stepper">
            <button className="sl-step-btn" onClick={() => setNumTeams(n => Math.max(2, n-1))}>-</button>
            <span className="sl-step-val">{numTeams}</span>
            <button className="sl-step-btn" onClick={() => setNumTeams(n => Math.min(6, n+1))}>+</button>
            <span style={{ color:"#6B7280", fontSize:12, marginLeft:4 }}>times (máx. 6)</span>
          </div>
        </div>

        {/* Jogadores por time */}
        <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(52,211,153,0.1)", borderRadius:16, padding:16 }}>
          <div style={{ color:"#9CA3AF", fontSize:10, fontWeight:700, letterSpacing:1, textTransform:"uppercase", marginBottom:12 }}>Jogadores por Time</div>
          <div className="sl-stepper">
            <button className="sl-step-btn" onClick={() => setPlayersPerTeam(n => Math.max(1, n-1))}>-</button>
            <span className="sl-step-val">{playersPerTeam}</span>
            <button className="sl-step-btn" onClick={() => setPlayersPerTeam(n => Math.min(20, n+1))}>+</button>
            <span style={{ color:"#6B7280", fontSize:12, marginLeft:4 }}>por time</span>
          </div>
          <div style={{ marginTop:10, color:"#4B5563", fontSize:11 }}>Total de vagas: <span style={{ color:"#34d399", fontWeight:700 }}>{totalSlots}</span> jogadores</div>
        </div>

        {/* Times — nome e cor */}
        <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(52,211,153,0.1)", borderRadius:16, padding:16 }}>
          <div style={{ color:"#9CA3AF", fontSize:10, fontWeight:700, letterSpacing:1, textTransform:"uppercase", marginBottom:12 }}>Times</div>
          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            {Array.from({ length: numTeams }, (_, i) => (
              <div key={i} style={{ display:"flex", flexDirection:"column", gap:8 }}>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <div style={{ width:14, height:14, borderRadius:4, background:teamColors[i]||TEAM_COLORS[i%TEAM_COLORS.length].value, flexShrink:0 }}/>
                  <input className="sl-input" style={{ flex:1, padding:"8px 10px", fontSize:13 }}
                    value={teamNames[i] || `Time ${String.fromCharCode(65+i)}`}
                    onChange={e => setTeamNames(prev => { const n=[...prev]; n[i]=e.target.value; return n; })}
                    placeholder={`Nome do Time ${i+1}`}/>
                </div>
                <ColorPicker value={teamColors[i]||TEAM_COLORS[i%TEAM_COLORS.length].value}
                  onChange={c => setTeamColors(prev => { const n=[...prev]; n[i]=c; return n; })}/>
              </div>
            ))}
          </div>
        </div>

        <button className="sl-btn" style={{ background:"linear-gradient(135deg,#059669,#34d399)", color:"#fff" }} onClick={() => setStep("players")}>
          Próximo — Adicionar Jogadores →
        </button>
      </div>
    </div>
  );

  // ─────────────── STEP: PLAYERS ───────────────
  if (step === "players") return (
    <div style={{ minHeight:"100vh", background:"#050c0a", fontFamily:"'DM Sans',sans-serif", display:"flex", flexDirection:"column" }}>
      <style>{SL_STYLES}</style>
      <div style={{ padding:"52px 20px 16px", background:"linear-gradient(175deg,#050e1f 0%,#050c0a 100%)", borderBottom:"1px solid rgba(52,211,153,0.1)", position:"relative" }}>
        <BackBtn onClick={() => setStep("setup")}/>
        <div style={{ textAlign:"center" }}>
          <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:24, color:"#fff", letterSpacing:2 }}>JOGADORES</div>
          <div style={{ color:"#34d399", fontSize:11, fontWeight:700 }}>
            <span style={{ color: players.length >= totalSlots ? "#34d399" : "#f59e0b" }}>{players.length}</span>
            {" "}/ {totalSlots} vagas
            {drawMode === "balanced" && <span style={{ color:"#6B7280", marginLeft:6, display:"inline-flex",alignItems:"center",gap:3 }}>· <Icon id="balance" size={11}/> Modo Equilibrado</span>}
          </div>
        </div>
      </div>

      <div style={{ flex:1, padding:"16px 16px 130px", display:"flex", flexDirection:"column", gap:14, overflowY:"auto" }}>

        {/* Fontes */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          <button onClick={() => setShowAgendaModal(true)} style={{ padding:"12px 8px", borderRadius:12, border:"1px solid rgba(52,211,153,0.25)", background:"rgba(52,211,153,0.07)", color:"#34d399", fontFamily:"'DM Sans',sans-serif", fontWeight:700, fontSize:12, cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:4 }}>
            <Icon id="clipboard" size={20}/><span>Da Agenda</span>
          </button>
          <button onClick={() => { setShowAvulsoInput(v=>!v); setShowManualInput(false); }} style={{ padding:"12px 8px", borderRadius:12, border:"1px solid rgba(251,191,36,0.25)", background:"rgba(251,191,36,0.07)", color:"#FBBF24", fontFamily:"'DM Sans',sans-serif", fontWeight:700, fontSize:12, cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:4 }}>
            <Icon id="lightning" size={20}/><span>Avulso</span>
          </button>
        </div>

        {/* Input avulso */}
        {showAvulsoInput && (
          <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(251,191,36,0.2)", borderRadius:12, padding:12, display:"flex", flexDirection:"column", gap:10 }}>
            <div style={{ display:"flex", gap:8 }}>
              <input className="sl-input" autoFocus style={{ flex:1, borderColor:"rgba(251,191,36,0.3)" }}
                placeholder="Nome do jogador avulso" value={avulsoName}
                onChange={e => setAvulsoName(e.target.value)} onKeyDown={e => e.key==="Enter" && addAvulso()}/>
              <button onClick={addAvulso} style={{ padding:"10px 14px", borderRadius:10, border:"none", background:"#f59e0b", color:"#000", fontWeight:700, fontSize:13, cursor:"pointer" }}>+</button>
            </div>
            <div>
              <div style={{ color:"#6B7280", fontSize:10, fontWeight:700, letterSpacing:0.8, marginBottom:6 }}>NÍVEL DE HABILIDADE</div>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <SkillBar value={avulsoSkill} onChange={setAvulsoSkill}/>
                <span style={{ color:SKILL_COLORS[avulsoSkill-1], fontSize:12, fontWeight:700, display:"flex",alignItems:"center",gap:4 }}><Icon id={SKILL_EMOJI[avulsoSkill-1]} size={14}/> {SKILL_LABELS[avulsoSkill-1]}</span>
              </div>
            </div>
          </div>
        )}

        {/* Input manual */}
        <div style={{ borderTop:"1px solid rgba(255,255,255,0.05)", paddingTop:10 }}>
          <button onClick={() => { setShowManualInput(v=>!v); setShowAvulsoInput(false); }} style={{ width:"100%", padding:"10px", borderRadius:10, border:"1px solid rgba(255,255,255,0.08)", background:"rgba(255,255,255,0.03)", color:"#9CA3AF", fontFamily:"'DM Sans',sans-serif", fontWeight:600, fontSize:12, cursor:"pointer" }}>
            <Icon id="edit" size={14}/> Adicionar na lista (sem cadastro)
          </button>
          {showManualInput && (
            <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:12, padding:12, marginTop:8, display:"flex", flexDirection:"column", gap:10 }}>
              <div style={{ display:"flex", gap:8 }}>
                <input className="sl-input" autoFocus style={{ flex:1 }} placeholder="Nome do jogador"
                  value={manualName} onChange={e => setManualName(e.target.value)}
                  onKeyDown={e => e.key==="Enter" && addManual()}/>
                <button onClick={addManual} style={{ padding:"10px 14px", borderRadius:10, border:"none", background:"#34d399", color:"#000", fontWeight:700, fontSize:13, cursor:"pointer" }}>+</button>
              </div>
              <div>
                <div style={{ color:"#6B7280", fontSize:10, fontWeight:700, letterSpacing:0.8, marginBottom:6 }}>NÍVEL DE HABILIDADE</div>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <SkillBar value={manualSkill} onChange={setManualSkill}/>
                  <span style={{ color:SKILL_COLORS[manualSkill-1], fontSize:12, fontWeight:700, display:"flex",alignItems:"center",gap:4 }}><Icon id={SKILL_EMOJI[manualSkill-1]} size={14}/> {SKILL_LABELS[manualSkill-1]}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Lista de jogadores */}
        {players.length > 0 && (
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            <div style={{ color:"#6B7280", fontSize:10, fontWeight:700, letterSpacing:1, textTransform:"uppercase" }}>Jogadores ({players.length})</div>
            {players.map(p => (
              <div key={p.id}>
                <div className="sl-player-row">
                  <div style={{ width:24, height:24, borderRadius:6, background: p.source==="agenda"?"rgba(52,211,153,0.15)":p.source==="avulso"?"rgba(251,191,36,0.15)":"rgba(96,165,250,0.15)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                    <Icon id={p.source==="agenda"?"clipboard":p.source==="avulso"?"lightning":"edit"} size={13}/>
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ color:"#E5E7EB", fontSize:13, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.name}</div>
                    <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:3 }}>
                      <SkillBar value={p.skill||3} size="sm"/>
                      <span style={{ fontSize:10, color:SKILL_COLORS[(p.skill||3)-1], fontWeight:700 }}>{SKILL_LABELS[(p.skill||3)-1]}</span>
                    </div>
                  </div>
                  <button onClick={() => setEditingSkill(editingSkill===p.id?null:p.id)} style={{ background:"none", border:"1px solid rgba(255,255,255,0.1)", borderRadius:6, color:"#6B7280", cursor:"pointer", fontSize:11, padding:"3px 7px", display:"flex",alignItems:"center",gap:3 }}><Icon id="edit" size={11}/></button>
                  <button onClick={() => removePlayer(p.id)} style={{ background:"none", border:"none", color:"#EF4444", cursor:"pointer", fontSize:16, padding:"2px 4px", lineHeight:1 }}>×</button>
                </div>
                {editingSkill === p.id && (
                  <div style={{ margin:"4px 0 0 34px", padding:"10px 12px", background:"rgba(255,255,255,0.04)", borderRadius:10, display:"flex", alignItems:"center", gap:10 }}>
                    <SkillBar value={p.skill||3} onChange={v => updateSkill(p.id, v)}/>
                    <span style={{ fontSize:11, color:SKILL_COLORS[(p.skill||3)-1], fontWeight:700, display:"flex",alignItems:"center",gap:4 }}><Icon id={SKILL_EMOJI[(p.skill||3)-1]} size={13}/> {SKILL_LABELS[(p.skill||3)-1]}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {players.length === 0 && (
          <div style={{ textAlign:"center", color:"#4B5563", padding:"40px 20px", fontSize:13 }}>
            Nenhum jogador adicionado ainda.<br/>Use os botões acima para adicionar.
          </div>
        )}
      </div>

      {/* Botão fixo */}
      <div style={{ position:"fixed", bottom:0, left:0, right:0, padding:"16px 20px 32px", background:"linear-gradient(to top,#050c0a 60%,transparent)", zIndex:50 }}>
        <button onClick={() => doSorteio(drawMode)} disabled={players.length < 2} style={{
          display:"flex", alignItems:"center", justifyContent:"center", gap:10, width:"100%", padding:16, borderRadius:14, border:"none",
          background: players.length>=2 ? (drawMode==="balanced"?"linear-gradient(135deg,#059669,#34d399)":"linear-gradient(135deg,#7c3aed,#a855f7)") : "rgba(255,255,255,0.05)",
          color: players.length>=2?"#fff":"#4B5563", fontFamily:"'Bebas Neue',sans-serif", fontSize:20, letterSpacing:1.5, cursor: players.length>=2?"pointer":"not-allowed"
        }}>
          {drawMode==="balanced"?<><Icon id="balance" size={20}/> SORTEAR EQUILIBRADO</>:<><Icon id="dice" size={20}/> SORTEAR ALEATÓRIO</>}
        </button>
      </div>

      {/* Modal agendas */}
      {showAgendaModal && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.85)", zIndex:200, display:"flex", alignItems:"flex-end" }} onClick={() => setShowAgendaModal(false)}>
          <div onClick={e=>e.stopPropagation()} style={{ background:"#0d1f17", borderRadius:"20px 20px 0 0", width:"100%", maxHeight:"70vh", overflowY:"auto", padding:"20px 20px 40px" }}>
            <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:20, color:"#fff", letterSpacing:1, marginBottom:4 }}>ESCOLHER AGENDA</div>
            <div style={{ color:"#6B7280", fontSize:11, marginBottom:14 }}>O nível de estrelas dos jogadores será importado automaticamente.</div>
            {loadingAgendas ? (
              <div style={{ textAlign:"center", color:"#6B7280", padding:20 }}>Carregando...</div>
            ) : agendas.length === 0 ? (
              <div style={{ textAlign:"center", color:"#6B7280", fontSize:13, padding:20 }}>Nenhuma agenda cadastrada em Mensalistas.</div>
            ) : (
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                {agendas.map(ag => (
                  <button key={ag.id} onClick={() => addFromAgenda(ag)} style={{ padding:"12px 14px", borderRadius:12, border:"1px solid rgba(52,211,153,0.2)", background:"rgba(52,211,153,0.06)", color:"#E5E7EB", textAlign:"left", cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <span style={{ fontWeight:700, fontSize:13 }}>{ag.name}</span>
                    <span style={{ fontSize:11, color:"#34d399" }}>{(ag.players||[]).length} jog.</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {toast && <div style={{ position:"fixed", bottom:100, left:"50%", transform:"translateX(-50%)", background:"#1d4ed8", color:"#fff", padding:"10px 22px", borderRadius:20, fontSize:13, fontWeight:600, zIndex:999, whiteSpace:"nowrap", pointerEvents:"none" }}>{toast}</div>}
    </div>
  );

  // ─────────────── STEP: RESULT ───────────────
  const teamSkillAvg = (t) => t.players.length ? ((t.skillSum||0)/t.players.length).toFixed(1) : "—";

  return (
    <div style={{ minHeight:"100vh", background:"#050c0a", fontFamily:"'DM Sans',sans-serif", display:"flex", flexDirection:"column" }}>
      <style>{SL_STYLES}</style>
      <div style={{ padding:"52px 20px 16px", background:"linear-gradient(175deg,#050e1f 0%,#050c0a 100%)", borderBottom:"1px solid rgba(52,211,153,0.1)", position:"relative" }}>
        <BackBtn onClick={resorteio}/>
        <div style={{ textAlign:"center" }}>
          <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:24, color:"#fff", letterSpacing:2 }}>TIMES SORTEADOS</div>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:6, marginTop:2 }}>
            <span style={{ fontSize:11, color:"#6B7280", fontWeight:600, display:"flex",alignItems:"center",gap:4 }}>{lastMode==="balanced"?<><Icon id="balance" size={12}/> Equilibrado</>:<><Icon id="dice" size={12}/> Aleatório</>}</span>
            <span style={{ color:"#374151" }}>·</span>
            <span style={{ fontSize:11, color:"#34d399", fontWeight:600 }}>Toque para mover jogador</span>
          </div>
        </div>
      </div>

      <div style={{ flex:1, padding:"16px 16px 140px", display:"flex", flexDirection:"column", gap:14, overflowY:"auto" }}>
        {teams.map((team, teamIdx) => (
          <div key={teamIdx} className="sl-team-card" style={{ border:`1.5px solid ${team.color}30`, background:`${team.color}0d` }}>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
              <div style={{ width:14, height:14, borderRadius:4, background:team.color, flexShrink:0 }}/>
              <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:18, color:team.color, letterSpacing:1 }}>{team.name}</div>
              <div style={{ marginLeft:"auto", display:"flex", gap:8, alignItems:"center" }}>
                <span style={{ fontSize:10, color:"#6B7280", fontWeight:600 }}>{team.players.length} jog.</span>
                {lastMode==="balanced" && team.players.length > 0 && (
                  <span style={{ fontSize:10, fontWeight:700, color:team.color, background:`${team.color}18`, padding:"2px 7px", borderRadius:6, display:"flex",alignItems:"center",gap:3 }}>
                    <Icon id="star" size={10}/> {teamSkillAvg(team)}
                  </span>
                )}
              </div>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
              {team.players.map((p, pi) => (
                <div key={p.id} className="sl-p-chip" onClick={() => setManualAssign({ playerId:p.id, playerName:p.name })}>
                  <div style={{ width:20, height:20, borderRadius:"50%", background:team.color, display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, fontWeight:700, color:"#000", flexShrink:0 }}>{pi+1}</div>
                  <span style={{ flex:1, color:"#E5E7EB", fontSize:13 }}>{p.name}</span>
                  <Icon id={SKILL_EMOJI[(p.skill||3)-1]} size={12} style={{color:SKILL_COLORS[(p.skill||3)-1],marginRight:4}}/>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2" strokeLinecap="round"><path d="M15 3h6v6M14 10l6.1-6.1M9 21H3v-6M10 14l-6.1 6.1"/></svg>
                </div>
              ))}
              {team.players.length === 0 && <div style={{ color:"#4B5563", fontSize:12, padding:"8px 0", textAlign:"center" }}>Sem jogadores</div>}
            </div>
          </div>
        ))}
      </div>

      {/* Botões fixos */}
      <div style={{ position:"fixed", bottom:0, left:0, right:0, padding:"12px 20px 32px", background:"linear-gradient(to top,#050c0a 60%,transparent)", zIndex:50, display:"flex", flexDirection:"column", gap:8 }}>
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={() => doSorteio("balanced")} style={{ flex:1, padding:"12px 8px", borderRadius:12, border:`2px solid ${lastMode==="balanced"?"#34d399":"rgba(52,211,153,0.2)"}`, background:lastMode==="balanced"?"rgba(52,211,153,0.12)":"rgba(255,255,255,0.03)", color:lastMode==="balanced"?"#34d399":"#6B7280", fontFamily:"'DM Sans',sans-serif", fontWeight:700, fontSize:12, cursor:"pointer", display:"flex",alignItems:"center",justifyContent:"center",gap:6 }}>
            <Icon id="balance" size={14}/> Equilibrado
          </button>
          <button onClick={() => doSorteio("random")} style={{ flex:1, padding:"12px 8px", borderRadius:12, border:`2px solid ${lastMode==="random"?"#a855f7":"rgba(168,85,247,0.2)"}`, background:lastMode==="random"?"rgba(168,85,247,0.12)":"rgba(255,255,255,0.03)", color:lastMode==="random"?"#a855f7":"#6B7280", fontFamily:"'DM Sans',sans-serif", fontWeight:700, fontSize:12, cursor:"pointer", display:"flex",alignItems:"center",justifyContent:"center",gap:6 }}>
            <Icon id="dice" size={14}/> Aleatório
          </button>
        </div>
        <button className="sl-btn" style={{ background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.1)", color:"#9CA3AF", fontSize:13 }} onClick={startOver}>
          Começar do zero
        </button>
      </div>

      {/* Modal: mover jogador */}
      {manualAssign && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.85)", zIndex:200, display:"flex", alignItems:"flex-end" }} onClick={() => setManualAssign(null)}>
          <div onClick={e=>e.stopPropagation()} style={{ background:"#0d1f17", borderRadius:"20px 20px 0 0", width:"100%", padding:"20px 20px 40px" }}>
            <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:18, color:"#fff", letterSpacing:1, marginBottom:4 }}>MOVER JOGADOR</div>
            <div style={{ color:"#34d399", fontSize:13, fontWeight:600, marginBottom:16 }}>{manualAssign.playerName}</div>
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {teams.map((t, i) => (
                <button key={i} onClick={() => reassignPlayer(manualAssign.playerId, i)} style={{ padding:"12px 14px", borderRadius:12, border:`1px solid ${t.color}40`, background:`${t.color}12`, color:"#E5E7EB", textAlign:"left", cursor:"pointer", display:"flex", alignItems:"center", gap:10 }}>
                  <div style={{ width:12, height:12, borderRadius:3, background:t.color, flexShrink:0 }}/>
                  <span style={{ fontWeight:700, fontSize:13 }}>{t.name}</span>
                  <span style={{ marginLeft:"auto", color:"#6B7280", fontSize:11 }}>{t.players.length} jog.</span>
                  {lastMode==="balanced" && t.players.length > 0 && <span style={{ fontSize:11, color:t.color, fontWeight:700 }}>⭐ {teamSkillAvg(t)}</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {toast && <div style={{ position:"fixed", bottom:140, left:"50%", transform:"translateX(-50%)", background:"#059669", color:"#fff", padding:"10px 22px", borderRadius:20, fontSize:13, fontWeight:600, zIndex:999, whiteSpace:"nowrap", pointerEvents:"none" }}>{toast}</div>}
    </div>
  );
}

// ─── Pelada Mensal Screen ─────────────────────────────────────────────────────

// ─── Sorteio Tampinhas Screen ─────────────────────────────────────────────────
function SorteioTampinhasScreen({ onBack }) {
  const TEAM_COLORS = [
    { label:"Verde",    value:"#22c55e", img:"/assets/images/tampinha-green.png"  },
    { label:"Vermelho", value:"#ef4444", img:"/assets/images/tampinha-red.png"    },
    { label:"Azul",     value:"#3b82f6", img:"/assets/images/tampinha-blue.png"   },
    { label:"Amarelo",  value:"#f59e0b", img:"/assets/images/tampinha-yellow.png" },
    { label:"Roxo",     value:"#a855f7", img:"/assets/images/tampinha-purple.png" },
    { label:"Laranja",  value:"#f97316", img:"/assets/images/tampinha-orange.png" },
    { label:"Rosa",     value:"#ec4899", img:"/assets/images/tampinha-pink.png"   },
    { label:"Ciano",    value:"#06b6d4", img:"/assets/images/tampinha-ciano.png"  },
    { label:"Branco",   value:"#e5e7eb", img:"/assets/images/tampinha-white.png"  },
    { label:"Preto",    value:"#374151", img:"/assets/images/tampinha-black.png"  },
  ];
  const COLOR_IMG = Object.fromEntries(TEAM_COLORS.map(c => [c.value, c.img]));

  // ── Steps: "setup" | "draw"
  const [step, setStep] = useState("setup");

  // ── Setup
  const [numTeams, setNumTeams] = useState(2);
  const [playersPerTeam, setPlayersPerTeam] = useState(5);
  const [teamColors, setTeamColors] = useState([
    TEAM_COLORS[0].value, TEAM_COLORS[1].value, TEAM_COLORS[2].value,
    TEAM_COLORS[3].value, TEAM_COLORS[4].value, TEAM_COLORS[5].value,
  ]);
  const [teamNames, setTeamNames] = useState(["Time A","Time B","Time C","Time D","Time E","Time F"]);

  // ── Draw state
  // bag: shuffled array of team indices yet to be drawn, one slot per player
  const [bag, setBag] = useState([]);
  const [drawn, setDrawn] = useState([]); // [{teamIdx, color, name}]
  const [revealing, setRevealing] = useState(false);
  const [revealed, setRevealed] = useState(null); // current result shown
  const [done, setDone] = useState(false);
  const animRef = useRef(null);

  const totalSlots = numTeams * playersPerTeam;

  // ── Color picker
  const ColorPicker = ({ value, onChange }) => (
    <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
      {TEAM_COLORS.map(c => (
        <button key={c.value} onClick={() => onChange(c.value)} title={c.label} style={{
          width:26, height:26, borderRadius:"50%", background:c.value,
          border:`2px solid ${value===c.value?"#fff":"transparent"}`,
          cursor:"pointer", outline:"none",
          boxShadow:value===c.value?"0 0 0 2px rgba(255,255,255,0.4)":"none"
        }}/>
      ))}
    </div>
  );

  // ── Build shuffled bag: each team appears playersPerTeam times
  const buildBag = () => {
    const slots = [];
    for (let t = 0; t < numTeams; t++) {
      for (let p = 0; p < playersPerTeam; p++) slots.push(t);
    }
    // Fisher-Yates shuffle
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    return slots;
  };

  const startDraw = () => {
    setBag(buildBag());
    setDrawn([]);
    setRevealed(null);
    setDone(false);
    setStep("draw");
  };

  // ── Player presses the button
  const handlePress = () => {
    if (revealing || done || bag.length === 0) return;
    setRevealing(true);
    setRevealed(null);

    // Slot machine animation: rapid color flicker then settle
    let ticks = 0;
    const totalTicks = 18;
    const teamIdx = bag[0];

    const tick = () => {
      const fakeIdx = Math.floor(Math.random() * numTeams);
      setRevealed({ teamIdx: fakeIdx, color: teamColors[fakeIdx], img: COLOR_IMG[teamColors[fakeIdx]], name: teamNames[fakeIdx] || `Time ${fakeIdx+1}`, fake: true });
      ticks++;
      const delay = ticks < 10 ? 60 : ticks < 15 ? 100 : 180;
      if (ticks < totalTicks) {
        animRef.current = setTimeout(tick, delay);
      } else {
        // Final result
        const result = { teamIdx, color: teamColors[teamIdx], img: COLOR_IMG[teamColors[teamIdx]], name: teamNames[teamIdx] || `Time ${teamIdx+1}`, fake: false };
        setRevealed(result);
        const nextBag = bag.slice(1);
        const nextDrawn = [...drawn, result];
        setBag(nextBag);
        setDrawn(nextDrawn);
        if (nextBag.length === 0) setDone(true);
        setRevealing(false);
      }
    };
    animRef.current = setTimeout(tick, 60);
  };

  useEffect(() => () => clearTimeout(animRef.current), []);

  const reset = () => {
    clearTimeout(animRef.current);
    setBag([]); setDrawn([]); setRevealed(null); setDone(false); setRevealing(false);
    setStep("setup");
  };

  const restartDraw = () => {
    clearTimeout(animRef.current);
    setBag(buildBag()); setDrawn([]); setRevealed(null); setDone(false); setRevealing(false);
  };

  // ── Tally: how many of each team have been drawn
  const tally = Array.from({ length: numTeams }, (_, i) => ({
    idx: i, name: teamNames[i]||`Time ${i+1}`, color: teamColors[i],
    count: drawn.filter(d => d.teamIdx === i).length,
  }));

  const ST_STYLES = `
    .st-input{width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(52,211,153,0.2);border-radius:10px;padding:10px 12px;color:#fff;font-family:'DM Sans',sans-serif;font-size:14px;outline:none;}
    .st-input:focus{border-color:rgba(52,211,153,0.5);}
    .st-stepper{display:flex;align-items:center;gap:12px;}
    .st-step-btn{width:36px;height:36px;border-radius:10px;border:1px solid rgba(52,211,153,0.3);background:rgba(52,211,153,0.08);color:#34d399;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-weight:700;}
    .st-step-val{font-size:24px;font-family:'Bebas Neue',sans-serif;color:#fff;min-width:32px;text-align:center;letter-spacing:1px;}
    @keyframes st-pop{0%{transform:scale(0.7);opacity:0;}60%{transform:scale(1.12);}100%{transform:scale(1);opacity:1;}}
    @keyframes st-flicker{0%,100%{opacity:1;}50%{opacity:0.6;}}
    @keyframes st-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,255,255,0.15);}50%{box-shadow:0 0 0 20px rgba(255,255,255,0);}}
    @keyframes st-done-glow{0%,100%{box-shadow:0 0 32px rgba(52,211,153,0.3);}50%{box-shadow:0 0 64px rgba(52,211,153,0.6);}}
  `;

  const BackBtn = ({ onClick }) => (
    <button onClick={onClick} style={{ position:"absolute",top:16,left:16,width:36,height:36,borderRadius:12,border:"1px solid rgba(52,211,153,0.2)",background:"rgba(52,211,153,0.08)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"#34d399",zIndex:2 }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
    </button>
  );

  // ─────────────── STEP: SETUP ───────────────
  if (step === "setup") return (
    <div style={{ minHeight:"100vh", background:"#050c0a", fontFamily:"'DM Sans',sans-serif", display:"flex", flexDirection:"column" }}>
      <style>{ST_STYLES}</style>
      <div style={{ padding:"52px 20px 20px", background:"linear-gradient(175deg,#050e1f 0%,#050c0a 100%)", borderBottom:"1px solid rgba(52,211,153,0.1)", position:"relative" }}>
        <BackBtn onClick={onBack}/>
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:8 }}>
          <img src="/assets/images/tampinha-ouro.png" alt="Tampinha" style={{ width:52, height:52, objectFit:"contain" }}/>
          <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:26, color:"#fff", letterSpacing:2 }}>SORTEIO TAMPINHAS</div>
          <div style={{ color:"#34d399", fontSize:11, fontWeight:700, letterSpacing:1.2, textTransform:"uppercase" }}>Configure os times</div>
        </div>
      </div>

      <div style={{ flex:1, padding:"24px 20px 40px", display:"flex", flexDirection:"column", gap:20, overflowY:"auto" }}>

        {/* Número de times */}
        <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(52,211,153,0.1)", borderRadius:16, padding:16 }}>
          <div style={{ color:"#9CA3AF", fontSize:10, fontWeight:700, letterSpacing:1, textTransform:"uppercase", marginBottom:12 }}>Número de Times</div>
          <div className="st-stepper">
            <button className="st-step-btn" onClick={() => setNumTeams(n => Math.max(2, n-1))}>-</button>
            <span className="st-step-val">{numTeams}</span>
            <button className="st-step-btn" onClick={() => setNumTeams(n => Math.min(6, n+1))}>+</button>
            <span style={{ color:"#6B7280", fontSize:12, marginLeft:4 }}>times (máx. 6)</span>
          </div>
        </div>

        {/* Jogadores por time */}
        <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(52,211,153,0.1)", borderRadius:16, padding:16 }}>
          <div style={{ color:"#9CA3AF", fontSize:10, fontWeight:700, letterSpacing:1, textTransform:"uppercase", marginBottom:12 }}>Jogadores por Time</div>
          <div className="st-stepper">
            <button className="st-step-btn" onClick={() => setPlayersPerTeam(n => Math.max(1, n-1))}>-</button>
            <span className="st-step-val">{playersPerTeam}</span>
            <button className="st-step-btn" onClick={() => setPlayersPerTeam(n => Math.min(20, n+1))}>+</button>
            <span style={{ color:"#6B7280", fontSize:12, marginLeft:4 }}>por time</span>
          </div>
          <div style={{ marginTop:10, color:"#4B5563", fontSize:11 }}>Total: <span style={{ color:"#34d399", fontWeight:700 }}>{totalSlots}</span> jogadores</div>
        </div>

        {/* Times */}
        <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(52,211,153,0.1)", borderRadius:16, padding:16 }}>
          <div style={{ color:"#9CA3AF", fontSize:10, fontWeight:700, letterSpacing:1, textTransform:"uppercase", marginBottom:12 }}>Times e Cores</div>
          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            {Array.from({ length: numTeams }, (_, i) => (
              <div key={i} style={{ display:"flex", flexDirection:"column", gap:8 }}>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <div style={{ width:14, height:14, borderRadius:4, background:teamColors[i]||TEAM_COLORS[i%TEAM_COLORS.length].value, flexShrink:0 }}/>
                  <input className="st-input" style={{ flex:1, padding:"8px 10px", fontSize:13 }}
                    value={teamNames[i] || `Time ${String.fromCharCode(65+i)}`}
                    onChange={e => setTeamNames(prev => { const n=[...prev]; n[i]=e.target.value; return n; })}
                    placeholder={`Nome do Time ${i+1}`}/>
                </div>
                <ColorPicker value={teamColors[i]||TEAM_COLORS[i%TEAM_COLORS.length].value}
                  onChange={c => setTeamColors(prev => { const n=[...prev]; n[i]=c; return n; })}/>
              </div>
            ))}
          </div>
        </div>

        <button onClick={startDraw} style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:10, width:"100%", padding:16, borderRadius:14, border:"none", background:"linear-gradient(135deg,#d97706,#f59e0b)", color:"#000", fontFamily:"'Bebas Neue',sans-serif", fontSize:20, letterSpacing:1.5, cursor:"pointer", fontWeight:700 }}>
          <img src="/assets/images/tampinha-ouro.png" alt="" style={{ width:24, height:24, objectFit:"contain" }}/> INICIAR SORTEIO
        </button>
      </div>
    </div>
  );

  // ─────────────── STEP: DRAW ───────────────
  const remaining = bag.length;
  const drawnCount = drawn.length;

  return (
    <div style={{ minHeight:"100vh", background:"#050c0a", fontFamily:"'DM Sans',sans-serif", display:"flex", flexDirection:"column" }}>
      <style>{ST_STYLES}</style>

      {/* Header */}
      <div style={{ padding:"52px 20px 16px", background:"linear-gradient(175deg,#050e1f 0%,#050c0a 100%)", borderBottom:"1px solid rgba(52,211,153,0.1)", position:"relative" }}>
        <BackBtn onClick={reset}/>
        <div style={{ textAlign:"center" }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
            <img src="/assets/images/tampinha-ouro.png" alt="" style={{ width:26, height:26, objectFit:"contain" }}/>
            <span style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:22, color:"#fff", letterSpacing:2 }}>SORTEIO TAMPINHAS</span>
            <img src="/assets/images/tampinha-ouro.png" alt="" style={{ width:26, height:26, objectFit:"contain" }}/>
          </div>
          <div style={{ color:"#6B7280", fontSize:11, fontWeight:700, marginTop:2 }}>
            {done
              ? <span style={{ color:"#34d399", display:"inline-flex",alignItems:"center",gap:4 }}><Icon id="check-circle" size={14}/> Todos os times formados!</span>
              : <span><span style={{ color:"#f59e0b" }}>{drawnCount}</span> / {totalSlots} jogadores sorteados</span>}
          </div>
        </div>
      </div>

      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"space-between", padding:"24px 20px 32px", overflowY:"auto" }}>

        {/* Placar dos times */}
        <div style={{ width:"100%", display:"flex", flexWrap:"wrap", gap:8, justifyContent:"center", marginBottom:8 }}>
          {tally.map(t => (
            <div key={t.idx} style={{ display:"flex", alignItems:"center", gap:6, padding:"6px 12px", borderRadius:20, background:`${t.color}18`, border:`1.5px solid ${t.color}50` }}>
              <img src={COLOR_IMG[t.color]||""} alt="" style={{ width:18, height:18, objectFit:"contain" }}/>
              <span style={{ color:"#E5E7EB", fontSize:12, fontWeight:700 }}>{t.name}</span>
              <span style={{ color:t.color, fontSize:13, fontWeight:700, fontFamily:"'Bebas Neue',sans-serif", letterSpacing:1 }}>{t.count}/{playersPerTeam}</span>
            </div>
          ))}
        </div>

        {/* Resultado atual */}
        <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:20, width:"100%" }}>

          {/* Área de revelação */}
          {revealed ? (
            <div style={{
              display:"flex", flexDirection:"column", alignItems:"center", gap:10,
              animation: revealed.fake ? "st-flicker 0.12s linear infinite" : "st-pop 0.35s cubic-bezier(.34,1.56,.64,1) forwards"
            }}>
              <img
                src={revealed.img || ""}
                alt={revealed.name}
                style={{
                  width:110, height:110, objectFit:"contain",
                  filter: revealed.fake ? "brightness(0.7)" : `drop-shadow(0 0 16px ${revealed.color}90)`,
                  transition:"filter 0.05s",
                }}
              />
              {!revealed.fake && (
                <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:28, color: revealed.color, letterSpacing:2, textShadow:`0 0 20px ${revealed.color}80` }}>
                  {revealed.name}
                </div>
              )}
            </div>
          ) : (
            <div style={{ width:110, height:110, opacity:0.2 }}>
              <img src="/assets/images/tampinha-white.png" alt="" style={{ width:"100%", height:"100%", objectFit:"contain", filter:"grayscale(1)" }}/>
            </div>
          )}

          {/* BOTÃO CENTRAL GRANDE */}
          {!done ? (
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:14 }}>
              <button
                onClick={handlePress}
                disabled={revealing}
                style={{
                  width:200, height:200, borderRadius:"50%",
                  background:"transparent",
                  border:"none", cursor: revealing ? "not-allowed" : "pointer",
                  display:"flex", alignItems:"center", justifyContent:"center", padding:0,
                  transition:"all 0.2s",
                  animation: !revealing && !revealed ? "st-pulse 2s ease-in-out infinite" : "none",
                  transform: revealing ? "scale(0.93)" : "scale(1)",
                  opacity: revealing ? 0.7 : 1,
                  filter: revealing ? "brightness(0.75)" : "drop-shadow(0 8px 24px rgba(245,158,11,0.55))",
                }}
              >
                <img src="/assets/images/tampinha-ouro.png" alt="Sortear" style={{ width:200, height:200, objectFit:"contain", pointerEvents:"none" }}/>
              </button>
              <span style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:22, color: revealing ? "#6B7280" : "#f5c542", letterSpacing:3, fontWeight:700, textShadow: revealing ? "none" : "0 0 16px rgba(245,197,66,0.5)" }}>
                {revealing ? "SORTEANDO..." : "TOCA AQUI!"}
              </span>
            </div>
          ) : (
            <div style={{ textAlign:"center", display:"flex", flexDirection:"column", alignItems:"center", gap:16 }}>
              <Icon id="party" size={60} style={{color:"#34d399"}}/>
              <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:22, color:"#34d399", letterSpacing:2 }}>TIMES FORMADOS!</div>
            </div>
          )}
        </div>

        {/* Histórico recente */}
        {drawn.length > 0 && (
          <div style={{ width:"100%", marginTop:8 }}>
            <div style={{ color:"#4B5563", fontSize:10, fontWeight:700, letterSpacing:1, textTransform:"uppercase", marginBottom:8, textAlign:"center" }}>
              Últimos sorteados
            </div>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap", justifyContent:"center" }}>
              {[...drawn].reverse().slice(0, 12).map((d, i) => (
                <img key={i} src={d.img||""} alt="" style={{ width:32, height:32, objectFit:"contain", filter:`drop-shadow(0 2px 6px ${d.color}80)`, flexShrink:0, transition:"all 0.2s" }}/>
              ))}
            </div>
          </div>
        )}

        {/* Botões de controle */}
        <div style={{ width:"100%", display:"flex", gap:8, marginTop:16 }}>
          {done && (
            <button onClick={restartDraw} style={{ flex:1, padding:"12px", borderRadius:12, border:"1px solid rgba(245,158,11,0.3)", background:"rgba(245,158,11,0.08)", color:"#f59e0b", fontFamily:"'DM Sans',sans-serif", fontWeight:700, fontSize:13, cursor:"pointer", display:"flex",alignItems:"center",justifyContent:"center",gap:6 }}>
              <Icon id="repeat" size={14}/> Ressortear
            </button>
          )}
          <button onClick={reset} style={{ flex:1, padding:"12px", borderRadius:12, border:"1px solid rgba(255,255,255,0.08)", background:"rgba(255,255,255,0.03)", color:"#6B7280", fontFamily:"'DM Sans',sans-serif", fontWeight:700, fontSize:13, cursor:"pointer", display:"flex",alignItems:"center",justifyContent:"center",gap:6 }}>
            <Icon id="settings" size={14}/> Reconfigurar
          </button>
        </div>
      </div>
    </div>
  );
}

function PeladaMensalScreen({onBack, onSelect, uid}) {
  function ripple(e, cb) {
    const b=e.currentTarget;
    const r=document.createElement("span");
    r.className="pm-ripple";
    const rect=b.getBoundingClientRect();
    r.style.left=(e.clientX-rect.left)+"px";
    r.style.top=(e.clientY-rect.top)+"px";
    b.appendChild(r);
    b.classList.add("pm-pressing");
    setTimeout(()=>{r.remove();b.classList.remove("pm-pressing");cb&&cb();},400);
  }

  const cards = [
    {
      key: "mensalistas",
      title: "Mensalistas",
      desc: "Gerencie os mensalistas da pelada, controle pagamentos e presenças de cada jogador.",
      tags: ["Jogadores","Pagamento","Presença","Histórico"],
      imgSrc: "/assets/images/mensalistas.png", // ← coloque o caminho da imagem aqui
      bg: "linear-gradient(135deg,#1e3a8a 0%,#1d4ed8 60%,#3b82f6 100%)",
      overlayTop: "linear-gradient(135deg,rgba(29,78,216,0.45) 0%,transparent 65%)",
      overlayBot: "linear-gradient(180deg,rgba(5,10,30,0.12) 0%,rgba(5,10,30,0.38) 40%,rgba(5,10,30,0.92) 100%)",
      tagStyle: {background:"rgba(59,130,246,0.22)",color:"#93c5fd",border:"1px solid rgba(96,165,250,0.28)"},
    },
    {
      key: "sorteio-lista",
      title: "Sorteio — Lista",
      desc: "Adicione os jogadores disponíveis e sorteie os times de forma rápida e justa.",
      tags: ["Sorteio","Times","Aleatorio","Justo"],
      imgSrc: "/assets/images/sorteio-lista.png", // ← coloque o caminho da imagem aqui
      bg: "linear-gradient(135deg,#0c1d4d 0%,#1e40af 60%,#2563eb 100%)",
      overlayTop: "linear-gradient(135deg,rgba(37,99,235,0.4) 0%,transparent 65%)",
      overlayBot: "linear-gradient(180deg,rgba(5,10,30,0.12) 0%,rgba(5,10,30,0.4) 40%,rgba(5,10,30,0.93) 100%)",
      tagStyle: {background:"rgba(37,99,235,0.22)",color:"#93c5fd",border:"1px solid rgba(96,165,250,0.28)"},
    },
    {
      key: "sorteio-tampinhas",
      title: "Sorteio — Tampinhas",
      desc: "Simule o clássico sorteio com tampinhas para montar os times da pelada.",
      tags: ["Tampinhas","Clássico","Sorteio","Diversão"],
      imgSrc: "/assets/images/sorteio-tampinhas.png", // ← coloque o caminho da imagem aqui
      bg: "linear-gradient(135deg,#0f2460 0%,#1e3a8a 55%,#2563eb 100%)",
      overlayTop: "linear-gradient(135deg,rgba(30,58,138,0.5) 0%,transparent 65%)",
      overlayBot: "linear-gradient(180deg,rgba(5,10,30,0.12) 0%,rgba(5,10,30,0.42) 40%,rgba(5,10,30,0.94) 100%)",
      tagStyle: {background:"rgba(30,58,138,0.28)",color:"#93c5fd",border:"1px solid rgba(96,165,250,0.28)"},
    },
  ];

  return (
    <div style={{minHeight:"100vh",background:"#050c0a",display:"flex",flexDirection:"column",fontFamily:"'DM Sans',sans-serif"}}>
      <style>{`
        @keyframes pm-ripple{0%{transform:scale(0);opacity:0.5;}100%{transform:scale(4);opacity:0;}}
        @keyframes pm-card-press{0%{transform:scale(1);}50%{transform:scale(0.97);}100%{transform:scale(1);}}
        .pm-card{position:relative;width:100%;border:none;border-radius:20px;cursor:pointer;text-align:left;overflow:hidden;display:block;padding:0;background:none;-webkit-tap-highlight-color:transparent;box-shadow:0 8px 32px rgba(0,0,0,0.55);transition:transform 0.18s cubic-bezier(.25,.46,.45,.94),box-shadow 0.18s;}
        .pm-card:hover{transform:translateY(-3px);box-shadow:0 16px 48px rgba(0,0,0,0.7);}
        .pm-card.pm-pressing{animation:pm-card-press 0.35s cubic-bezier(.25,.46,.45,.94) forwards;}
        .pm-ripple{position:absolute;border-radius:50%;background:rgba(255,255,255,0.35);width:80px;height:80px;margin-top:-40px;margin-left:-40px;animation:pm-ripple 0.6s linear forwards;pointer-events:none;z-index:10;}
        .pm-card-img-wrap{width:100%;height:160px;overflow:hidden;border-radius:20px;position:relative;display:flex;align-items:center;justify-content:center;}
        .pm-card-overlay{position:absolute;inset:0;border-radius:20px;pointer-events:none;}
        .pm-card-body{position:absolute;bottom:0;left:0;right:0;padding:16px 20px 18px;pointer-events:none;}
        .pm-card-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:800;letter-spacing:0.8px;margin-bottom:8px;backdrop-filter:blur(6px);}
        .pm-card-title{color:#fff;font-family:'Bebas Neue',sans-serif;font-size:24px;letter-spacing:1.5px;line-height:1.1;margin-bottom:6px;text-shadow:0 2px 8px rgba(0,0,0,0.5);}
        .pm-card-desc{color:rgba(255,255,255,0.72);font-size:11.5px;line-height:1.5;margin-bottom:10px;text-shadow:0 1px 4px rgba(0,0,0,0.6);}
        .pm-tags{display:flex;gap:5px;flex-wrap:wrap;}
        .pm-tag{border-radius:6px;padding:2px 9px;font-size:10px;font-weight:700;backdrop-filter:blur(6px);}
        .pm-card-arrow{position:absolute;top:16px;right:16px;width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,0.15);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;pointer-events:none;}
        .pm-card:active .pm-card-img-wrap{opacity:0.9;}
        @media(min-width:480px){.pm-card-img-wrap{height:185px;}}
        .pms-icon-wrap{position:absolute;top:50%;left:50%;transform:translate(-50%,-60%);opacity:0.22;pointer-events:none;}
      `}</style>

      {/* Header */}
      <div style={{padding:"52px 20px 20px",background:"linear-gradient(175deg,#050e1f 0%,#050c0a 100%)",borderBottom:"1px solid rgba(59,130,246,0.1)",position:"relative",overflow:"hidden"}}>
        {/* Decorative pitch lines — blue tinted */}
        <svg style={{position:"absolute",inset:0,width:"100%",height:"100%",opacity:0.04,pointerEvents:"none"}} viewBox="0 0 360 130" preserveAspectRatio="xMidYMid slice">
          <rect x="12" y="8" width="336" height="114" fill="none" stroke="#3b82f6" strokeWidth="1.5" rx="3"/>
          <line x1="12" y1="65" x2="348" y2="65" stroke="#3b82f6" strokeWidth="1"/>
          <circle cx="180" cy="65" r="22" fill="none" stroke="#3b82f6" strokeWidth="1"/>
          <rect x="12" y="28" width="54" height="74" fill="none" stroke="#3b82f6" strokeWidth="0.8"/>
          <rect x="294" y="28" width="54" height="74" fill="none" stroke="#3b82f6" strokeWidth="0.8"/>
        </svg>
        {/* Back button */}
        <button onClick={onBack} style={{position:"absolute",top:16,left:16,width:36,height:36,borderRadius:12,border:"1px solid rgba(59,130,246,0.2)",background:"rgba(59,130,246,0.08)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"#60a5fa",zIndex:2}}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:10,position:"relative",zIndex:1}}>
          <div style={{width:54,height:54,borderRadius:16,overflow:"hidden",boxShadow:"0 6px 24px rgba(96,165,250,0.4)"}}>
            <img src={LOGO_URI2} alt="Pelada Mensal" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
          </div>
          <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:28,color:"#fff",letterSpacing:2,lineHeight:1}}>PELADA MENSAL</div>
          <div style={{color:"#374ea8",fontSize:11,fontWeight:700,letterSpacing:1.2,textTransform:"uppercase"}}>Selecione uma opção</div>
        </div>
      </div>

      {/* Cards */}
      <div style={{flex:1,padding:"24px 20px 32px",display:"flex",flexDirection:"column",gap:14,maxWidth:480,width:"100%",margin:"0 auto",boxSizing:"border-box"}}>
        {cards.map(card=>(
          <button
            key={card.key}
            className="pm-card"
            onClick={(e)=>ripple(e, ()=>onSelect&&onSelect(card.key))}
            aria-label={card.title}
          >
            <div className="pm-card-img-wrap" style={{background:card.bg}}>
              <img
                className="pm-card-img"
                src={card.imgSrc}
                alt={card.title}
                loading="eager"
                onError={e=>{e.target.style.display="none";}}
                style={{width:"100%",height:"100%",objectFit:"cover",display:"block",transition:"transform 0.35s cubic-bezier(.25,.46,.45,.94)"}}
              />
              <div className="pm-card-overlay" style={{background:card.overlayBot}}/>
              <div className="pm-card-overlay" style={{background:card.overlayTop}}/>
            </div>
            <div className="pm-card-body">
              <div className="pm-card-title">{card.title}</div>
              <div className="pm-card-desc">{card.desc}</div>
              <div className="pm-tags">
                {card.tags.map(tag=>(
                  <span key={tag} className="pm-tag" style={card.tagStyle}>{tag}</span>
                ))}
              </div>
            </div>
            <div className="pm-card-arrow">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function HomePage({teams,onSelectTeam,onNewTeam,onDeleteTeam,onEditTeam,user,onLogout,syncStatus,onRetrySync,isPremium,onTogglePremium,onBackToMenu,onImportDone,onEnableCollab,onManageCollab,onJoinCollab}) {
  const [confirmDel,setConfirmDel]=useState(null);
  const [shareTeam,setShareTeam]=useState(null);
  const [showImport,setShowImport]=useState(false);
  const [showTutorialPrompt,setShowTutorialPrompt]=useState(false);
  const [showTutorial,setShowTutorial]=useState(false);
  const [showCollabUpsell,setShowCollabUpsell]=useState(false);
  return (
    <div style={{minHeight:"100vh",background:"#050c0a",fontFamily:"'DM Sans',sans-serif",position:"relative"}}>
      {/* Botao de tutorial */}
      <TutorialButton style={{position:"fixed",top:14,right:14,zIndex:800}} onClick={()=>setShowTutorialPrompt(true)}/>
      {showTutorialPrompt&&<TutorialPrompt screenName="Times" onConfirm={()=>{setShowTutorialPrompt(false);setShowTutorial(true);}} onCancel={()=>setShowTutorialPrompt(false)}/>}
      {showTutorial&&<TutorialOverlay steps={TUTORIAL_HOME} onClose={()=>setShowTutorial(false)}/>}
      <style>{`
        @keyframes fadeUp{from{opacity:0;transform:translateY(18px);}to{opacity:1;transform:translateY(0);}}
        @keyframes shimmer{0%{background-position:-200% 0;}100%{background-position:200% 0;}}
        @keyframes tc-ripple{0%{transform:scale(0);opacity:0.45;}100%{transform:scale(5);opacity:0;}}
        @keyframes tc-press{0%{transform:scale(1);}50%{transform:scale(0.984);}100%{transform:scale(1);}}
        .tc-ripple-el{position:absolute;border-radius:50%;background:rgba(255,255,255,0.28);width:80px;height:80px;margin-top:-40px;margin-left:-40px;animation:tc-ripple 0.55s linear forwards;pointer-events:none;z-index:8;}
        .team-card.tc-pressing{animation:tc-press 0.32s cubic-bezier(.25,.46,.45,.94) forwards;}
      `}</style>

      {/* Header hero */}
      <div style={{padding:"48px 20px 24px",background:"linear-gradient(175deg,#071a0f 0%,#050c0a 100%)",borderBottom:"1px solid rgba(52,211,153,0.07)",position:"relative",overflow:"hidden"}}>
        {/* Decorative pitch lines */}
        <svg style={{position:"absolute",inset:0,width:"100%",height:"100%",opacity:0.04,pointerEvents:"none"}} viewBox="0 0 360 170" preserveAspectRatio="xMidYMid slice">
          <rect x="12" y="10" width="336" height="150" fill="none" stroke="#34d399" strokeWidth="1.5" rx="3"/>
          <line x1="12" y1="85" x2="348" y2="85" stroke="#34d399" strokeWidth="1"/>
          <circle cx="180" cy="85" r="28" fill="none" stroke="#34d399" strokeWidth="1"/>
          <circle cx="180" cy="85" r="2.5" fill="#34d399"/>
          <rect x="12" y="55" width="36" height="60" fill="none" stroke="#34d399" strokeWidth="1"/>
          <rect x="312" y="55" width="36" height="60" fill="none" stroke="#34d399" strokeWidth="1"/>
        </svg>

        <div style={{position:"relative",display:"flex",alignItems:"center",gap:14}}>
          {onBackToMenu&&(
            <button onClick={onBackToMenu} title="Voltar ao menu" aria-label="Voltar ao menu principal" style={{
              flexShrink:0,width:36,height:36,borderRadius:10,border:"1px solid rgba(255,255,255,0.1)",
              background:"rgba(255,255,255,0.04)",cursor:"pointer",display:"flex",alignItems:"center",
              justifyContent:"center",color:"#9CA3AF"
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
          )}
          <div style={{width:52,height:52,borderRadius:14,overflow:"hidden",
            boxShadow:"0 6px 24px rgba(52,211,153,0.4)",flexShrink:0}}>
            <img src={LOGO_URI} alt="Escalação FC" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
          </div>
          <div style={{flex:1}}>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:30,color:"#fff",letterSpacing:2,lineHeight:1}}>ESCALAÇÃO FC</div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginTop:2,flexWrap:"wrap",rowGap:4}}>
              <span style={{color:"#4ade80",fontSize:12,fontWeight:700,letterSpacing:1}}>GERENCIE SEUS TIMES</span>
              <SyncIndicator status={syncStatus} onRetry={onRetrySync}/>
            </div>
          </div>
          {user&&(
            <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
              {/* Badge de plano. Em localhost vira botão DEV para testes. */}
              {IS_DEV?(
                <button onClick={onTogglePremium} title="[DEV] Alternar plano localmente" style={{
                  display:"flex",alignItems:"center",gap:4,padding:"6px 9px",borderRadius:8,cursor:"pointer",
                  border:isPremium?"1px dashed rgba(250,204,21,0.5)":"1px dashed rgba(255,255,255,0.2)",
                  background:isPremium?"rgba(250,204,21,0.12)":"rgba(255,255,255,0.04)",
                  color:isPremium?"#facc15":"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:800
                }}>
                  {isPremium
                    ?<><svg width="10" height="10" viewBox="0 0 24 24" fill="#facc15"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>PRO</>
                    :"FREE"}
                  <span style={{fontSize:8,color:"#6b7280",marginLeft:1}}>DEV</span>
                </button>
              ):(
                <div style={{
                  display:"flex",alignItems:"center",gap:4,padding:"6px 9px",borderRadius:8,
                  border:isPremium?"1px solid rgba(250,204,21,0.4)":"1px solid rgba(255,255,255,0.1)",
                  background:isPremium?"rgba(250,204,21,0.12)":"rgba(255,255,255,0.04)",
                  color:isPremium?"#facc15":"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:800,
                  userSelect:"none"
                }}>
                  {isPremium
                    ?<><svg width="10" height="10" viewBox="0 0 24 24" fill="#facc15"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>PRO</>
                    :"FREE"}
                </div>
              )}
              {user.photoURL?(
                <img src={user.photoURL} alt={user.displayName||""} style={{width:36,height:36,borderRadius:"50%",border:"2px solid rgba(52,211,153,0.4)"}}/>
              ):(
                <div style={{width:36,height:36,borderRadius:"50%",background:"#166534",display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:700,fontSize:14,border:"2px solid rgba(52,211,153,0.4)"}}>
                  {(user.displayName||user.email||"U")[0].toUpperCase()}
                </div>
              )}
              <button onClick={onLogout} style={{background:"rgba(239,68,68,0.12)",border:"1px solid rgba(239,68,68,0.25)",borderRadius:9,padding:"7px 10px",color:"#f87171",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700}}>Sair</button>
            </div>
          )}
        </div>

        <div style={{marginTop:20,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
          <div className="home-times-counter">
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:44,color:"#fff",lineHeight:1,letterSpacing:1}}>{teams.length}</div>
            <div style={{color:"#4B5563",fontSize:11,fontWeight:700,letterSpacing:1,textTransform:"uppercase"}}>{teams.length===1?"Time cadastrado":"Times cadastrados"}</div>
          </div>
          <div style={{display:"flex",gap:7,flexShrink:0}}>
            <button onClick={()=>setShowImport(true)} title="Importar copia de time via codigo" className="home-import-btn" style={{
              display:"flex",alignItems:"center",gap:5,padding:"10px 12px",
              background:"rgba(52,211,153,0.07)",border:"1px solid rgba(52,211,153,0.22)",
              borderRadius:12,color:"#34d399",cursor:"pointer",
              fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,letterSpacing:0.3,
              transition:"background 0.15s,border-color 0.15s"
            }}
              onMouseEnter={e=>{e.currentTarget.style.background="rgba(52,211,153,0.14)";e.currentTarget.style.borderColor="rgba(52,211,153,0.4)";}}
              onMouseLeave={e=>{e.currentTarget.style.background="rgba(52,211,153,0.07)";e.currentTarget.style.borderColor="rgba(52,211,153,0.22)";}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Copia
            </button>
            <button onClick={()=>onJoinCollab&&onJoinCollab("")} title="Entrar em time colaborativo" style={{
              display:"flex",alignItems:"center",gap:5,padding:"10px 12px",
              background:"rgba(59,130,246,0.07)",border:"1px solid rgba(59,130,246,0.22)",
              borderRadius:12,color:"#60a5fa",cursor:"pointer",
              fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,letterSpacing:0.3,
              transition:"background 0.15s,border-color 0.15s"
            }}
              onMouseEnter={e=>{e.currentTarget.style.background="rgba(59,130,246,0.14)";e.currentTarget.style.borderColor="rgba(59,130,246,0.4)";}}
              onMouseLeave={e=>{e.currentTarget.style.background="rgba(59,130,246,0.07)";e.currentTarget.style.borderColor="rgba(59,130,246,0.22)";}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              Colaborar
            </button>
          </div>
        </div>
      </div>

      {/* Team list */}
      <style>{`
        @keyframes cardFadeUp{from{opacity:0;transform:translateY(16px);}to{opacity:1;transform:translateY(0);}}
        .team-card{background:rgba(255,255,255,0.025);border:1px solid rgba(255,255,255,0.07);border-radius:18px;overflow:hidden;transition:border-color 0.2s,box-shadow 0.2s,transform 0.18s;cursor:pointer;}
        .team-card:hover{transform:translateY(-2px);box-shadow:0 12px 36px rgba(0,0,0,0.4);}
        .tc-action-btn{border-radius:9px;padding:8px 10px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s,border-color 0.15s;}
        .tc-action-btn:active{transform:scale(0.9);}
        .tc-footer{border-top:1px solid rgba(255,255,255,0.04);padding:9px 16px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;transition:background 0.15s;}
        .tc-footer:hover{background:rgba(255,255,255,0.02);}
        /* FAB */
        .home-fab{position:fixed;bottom:calc(60px + env(safe-area-inset-bottom,0px) + 16px);right:20px;z-index:850;width:56px;height:56px;border-radius:18px;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#15803d,#34d399);box-shadow:0 6px 24px rgba(52,211,153,0.45),0 2px 8px rgba(0,0,0,0.4),inset 0 1px 0 rgba(255,255,255,0.15);transition:transform 0.18s,box-shadow 0.18s;-webkit-tap-highlight-color:transparent;}
        .home-fab:hover{transform:scale(1.07) translateY(-2px);box-shadow:0 10px 30px rgba(52,211,153,0.55),0 4px 12px rgba(0,0,0,0.4);}
        .home-fab:active{transform:scale(0.95);box-shadow:0 4px 14px rgba(52,211,153,0.35);}
      `}</style>

      <div style={{padding:"16px 16px 120px",display:"flex",flexDirection:"column",gap:12,maxWidth:480,width:"100%",margin:"0 auto",boxSizing:"border-box"}}>
        {teams.length===0&&(
          <div style={{textAlign:"center",padding:"64px 20px 32px",animation:"cardFadeUp 0.4s ease"}}>
            {/* Pitch icon */}
            <div style={{width:72,height:72,borderRadius:20,background:"rgba(52,211,153,0.07)",border:"1px solid rgba(52,211,153,0.14)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 20px"}}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="1.5" strokeLinecap="round">
                <rect x="2" y="3" width="20" height="18" rx="2.5"/>
                <line x1="12" y1="3" x2="12" y2="21"/>
                <circle cx="12" cy="12" r="3" fill="none"/>
                <rect x="2" y="8" width="4" height="8" fill="none"/>
                <rect x="18" y="8" width="4" height="8" fill="none"/>
              </svg>
            </div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:24,color:"#fff",letterSpacing:1,marginBottom:8}}>Nenhum time ainda</div>
            <div style={{color:"#4B5563",fontSize:13,lineHeight:1.7,maxWidth:260,margin:"0 auto"}}>Toque no <strong style={{color:"#34d399"}}>+</strong> para criar seu primeiro time e começar a montar escalações.</div>
          </div>
        )}

        {teams.map((team,i)=>{
          const [c1,c2]=SHIELD_COLORS[(team.colorIdx||0)%SHIELD_COLORS.length];
          const escalados=(team.lineup||[]).filter(l=>l.playerId).length;
          const slots=FORMATIONS[team.formation]?.slots||FORMATIONS["4-4-2"].slots;
          return (
            <div key={team.id} className="team-card" style={{animation:`cardFadeUp 0.32s ease ${i*0.055}s both`,position:"relative",overflow:"hidden"}}
              onMouseEnter={e=>e.currentTarget.style.borderColor=`${c1}44`}
              onMouseLeave={e=>e.currentTarget.style.borderColor="rgba(255,255,255,0.07)"}
              onClick={e=>{
                const b=e.currentTarget;
                const r=document.createElement("span");
                r.className="tc-ripple-el";
                const rect=b.getBoundingClientRect();
                r.style.left=(e.clientX-rect.left)+"px";
                r.style.top=(e.clientY-rect.top)+"px";
                b.appendChild(r);
                b.classList.add("tc-pressing");
                setTimeout(()=>{r.remove();b.classList.remove("tc-pressing");},550);
              }}>

              {/* Gradient accent bar */}
              <div style={{height:2,background:`linear-gradient(90deg,${c1},${c2},transparent)`,opacity:0.9}}/>

              <div style={{padding:"14px 16px",display:"flex",alignItems:"center",gap:14}}>
                <TeamShield team={team} size={56}/>

                <div style={{flex:1,minWidth:0}} onClick={()=>onSelectTeam(team)}>
                  <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:21,color:"#fff",letterSpacing:0.8,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",lineHeight:1.2,marginBottom:6}}>{team.name}</div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                    <span style={{background:`${c1}1a`,color:c1,border:`1px solid ${c1}33`,borderRadius:6,padding:"2px 8px",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:800,letterSpacing:0.3}}>{team.formation}</span>
                    <span style={{display:"flex",alignItems:"center",gap:3,background:"rgba(255,255,255,0.06)",color:"#9CA3AF",border:"1px solid rgba(255,255,255,0.08)",borderRadius:6,padding:"2px 8px",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700}}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/></svg>
                      {team.players.length} jog.
                    </span>
                    <span style={{background:"rgba(255,255,255,0.06)",color:"#9CA3AF",border:"1px solid rgba(255,255,255,0.08)",borderRadius:6,padding:"2px 8px",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700}}>
                      {escalados}/{slots.length} escal.
                    </span>
                    {team.isCollab&&(
                      <span style={{display:"flex",alignItems:"center",gap:3,background:"rgba(59,130,246,0.12)",color:"#60a5fa",border:"1px solid rgba(59,130,246,0.25)",borderRadius:6,padding:"2px 8px",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700}}>
                        🤝 {team.ownerUid===user?.uid?"Colab · Dono":"Colab · Editor"}
                      </span>
                    )}
                  </div>
                </div>

                <div style={{display:"flex",flexDirection:"column",gap:5,flexShrink:0}}>
                  <button onClick={e=>{e.stopPropagation();onEditTeam(team);}} aria-label={`Editar ${team.name}`} className="tc-action-btn"
                    style={{background:"rgba(59,130,246,0.1)",border:"1px solid rgba(59,130,246,0.2)",color:"#60a5fa"}}><Ico.Edit/></button>
                  {/* Botao COPIA — sempre visível para o dono; oculto para editores collab */}
                  {(!team.isCollab || team.ownerUid===user?.uid)&&(
                    <button onClick={e=>{e.stopPropagation();setShareTeam(team);}} aria-label={`Compartilhar copia de ${team.name}`} title="Compartilhar copia" className="tc-action-btn"
                      style={{background:"rgba(52,211,153,0.08)",border:"1px solid rgba(52,211,153,0.2)",color:"#34d399"}}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    </button>
                  )}
                  {/* Botao COLABORAR — somente para o dono (ativar, gerenciar ou reativar) */}
                  {(!team.isCollab || team.ownerUid===user?.uid)&&(
                    <button onClick={e=>{e.stopPropagation();
                      if(!isPremium){ setShowCollabUpsell(true); return; }
                      // Se está ativo ou já foi dono antes → modal de gerenciar (inclui toggle reativar)
                      if (team.isCollab || team.ownerUid===user?.uid) { onManageCollab&&onManageCollab(team); }
                      else { onEnableCollab&&onEnableCollab(team); }
                    }} aria-label={team.isCollab?"Gerenciar colaboração":"Colaboração"} title={!isPremium?"Colaboração (premium)":team.isCollab?"Gerenciar colaboração":"Colaboração"} className="tc-action-btn"
                      style={{background:team.isCollab?"rgba(59,130,246,0.18)":"rgba(59,130,246,0.08)",border:team.isCollab?"1px solid rgba(59,130,246,0.45)":"1px solid rgba(59,130,246,0.2)",color:"#60a5fa",position:"relative",opacity:isPremium?1:0.65}}>
                      {!isPremium&&<span style={{position:"absolute",top:-3,right:-3,fontSize:8,lineHeight:1}}>🔒</span>}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                    </button>
                  )}
                  <button onClick={e=>{e.stopPropagation();setConfirmDel(team.id);}} aria-label={team.isCollab&&team.ownerUid!==user?.uid?`Sair de ${team.name}`:`Excluir ${team.name}`} className="tc-action-btn"
                    title={team.isCollab?(team.ownerUid===user?.uid?"Encerrar colaboração":"Sair do time"):undefined}
                    style={{background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.2)",color:"#f87171"}}>
                    {team.isCollab&&team.ownerUid!==user?.uid
                      ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                      : <Ico.Trash/>}
                  </button>
                </div>
              </div>

              <div className="tc-footer" onClick={()=>onSelectTeam(team)}>
                <span style={{color:"#374151",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:600}}>Abrir prancheta tática</span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#374151" strokeWidth="2" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
              </div>
            </div>
          );
        })}
      </div>

      {/* FAB — Novo Time */}
      <button className="home-fab" onClick={onNewTeam} aria-label="Criar novo time" title="Novo time">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </button>

      {/* Confirm delete overlay */}
      {confirmDel&&(()=>{
        const delTeam = teams.find(t => t.id === confirmDel);
        const isCollabTeam = delTeam?.isCollab;
        const isCollabOwner = isCollabTeam && delTeam?.ownerUid === user?.uid;
        const title = isCollabTeam ? (isCollabOwner ? "Encerrar colaboração?" : "Sair do time?") : "Excluir time?";
        const desc  = isCollabTeam
          ? (isCollabOwner ? "A colaboração será encerrada e o time voltará a ser pessoal. Seus dados (jogadores, stats, partidas) serão preservados." : "Você sairá deste time colaborativo. O time continuará existindo para os outros membros.")
          : "Esta ação é irreversível. Todos os jogadores e escalações serão perdidos.";
        const btnLabel = isCollabTeam ? (isCollabOwner ? "Encerrar" : "Sair") : "Excluir";
        return (
          <div style={{position:"fixed",inset:0,zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.75)",backdropFilter:"blur(6px)",padding:20}}
            onClick={()=>setConfirmDel(null)}>
            <div onClick={e=>e.stopPropagation()} style={{background:"#0c1b14",border:"1px solid rgba(239,68,68,0.25)",borderRadius:22,padding:"28px 22px",maxWidth:320,width:"100%",textAlign:"center",boxShadow:"0 24px 64px rgba(0,0,0,0.9)"}}>
              <div style={{width:56,height:56,borderRadius:16,background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.2)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px"}}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="1.8" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
              </div>
              <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#fff",letterSpacing:1,marginBottom:8}}>{title}</div>
              <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:13,lineHeight:1.6,marginBottom:22}}>{desc}</div>
              <div style={{display:"flex",gap:10}}>
                <button onClick={()=>setConfirmDel(null)} style={{flex:1,padding:"13px 0",borderRadius:12,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.04)",color:"#9CA3AF",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700}}>Cancelar</button>
                <button onClick={()=>{onDeleteTeam(confirmDel);setConfirmDel(null);}} style={{flex:1,padding:"13px 0",borderRadius:12,border:"none",background:"linear-gradient(135deg,#dc2626,#ef4444)",color:"#fff",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:800,boxShadow:"0 4px 16px rgba(220,38,38,0.4)"}}
                  onMouseEnter={e=>e.currentTarget.style.transform="scale(1.02)"}
                  onMouseLeave={e=>e.currentTarget.style.transform="scale(1)"}>{btnLabel}</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Share modal */}
      {shareTeam&&(
        <ShareTeamModal
          team={shareTeam}
          user={user}
          onClose={()=>setShareTeam(null)}
        />
      )}

      {/* Import modal */}
      {showImport&&(
        <ImportTeamModal
          user={user}
          onClose={()=>setShowImport(false)}
          onImported={(newTeamId)=>{setShowImport(false);onImportDone&&onImportDone(newTeamId);}}
        />
      )}
      {showCollabUpsell&&<PremiumUpsellModal
        title="Colaboração premium"
        description="Ativar colaboração em tempo real é um recurso exclusivo do plano premium. Faça upgrade para convidar outros usuários para editar e gerir o time junto com você."
        onClose={()=>setShowCollabUpsell(false)}
      />}
    </div>
  );
}


// ─── Share Team Modal ─────────────────────────────────────────────────────────
// Somente copia (snapshot 24h). Colaboracao e gerenciada via botao separado no card.
function ShareTeamModal({team, user, onClose}) {
  const [options, setOptions] = useState({includeStats:true, includeMatches:true, includeLineups:true});
  const [step, setStep] = useState("options"); // "options" | "loading" | "done" | "error"
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const toggle = k => setOptions(o => ({...o, [k]:!o[k]}));

  const handleGenerate = async () => {
    setStep("loading");
    const result = await publishTeamShare(user.uid, user.displayName || user.email, team, options);
    if (result) { setCode(result); setStep("done"); }
    else setStep("error");
  };

  const handleCopy = async () => {
    const msg = `Oi! Te envio uma copia do meu time no Escalacao FC\nTime: ${team.name}\nCodigo: ${code}\nValido por 24h — abra o app, clique em "Copia" e insira o codigo!`;
    try {
      if (navigator.share) { await navigator.share({title:"Escalacao FC",text:msg}); }
      else { await navigator.clipboard.writeText(msg); setCopied(true); setTimeout(()=>setCopied(false),2500); }
    } catch {
      try { await navigator.clipboard.writeText(msg); setCopied(true); setTimeout(()=>setCopied(false),2500); } catch {}
    }
  };

  const OptionRow = ({k, icon, label, desc}) => (
    <button onClick={()=>toggle(k)} style={{
      display:"flex",alignItems:"center",gap:12,padding:"10px 12px",borderRadius:11,border:"1px solid",cursor:"pointer",textAlign:"left",
      borderColor:options[k]?"rgba(52,211,153,0.35)":"rgba(255,255,255,0.08)",
      background:options[k]?"rgba(52,211,153,0.07)":"rgba(255,255,255,0.02)",transition:"all 0.12s"
    }}>
      <Icon id={icon} size={20} style={{color:options[k]?"#34d399":"#6B7280",flexShrink:0}}/>
      <div style={{flex:1}}>
        <div style={{color:options[k]?"#e5e7eb":"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700}}>{label}</div>
        <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:11}}>{desc}</div>
      </div>
      <div style={{width:20,height:20,borderRadius:6,border:"2px solid",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,
        borderColor:options[k]?"#34d399":"rgba(255,255,255,0.15)",background:options[k]?"#34d399":"transparent"}}>
        {options[k]&&<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><polyline points="2,6 5,9 10,3" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      </div>
    </button>
  );

  return (
    <div style={{position:"fixed",inset:0,zIndex:1100,display:"flex",alignItems:"flex-end",justifyContent:"center",background:"rgba(0,0,0,0.8)",backdropFilter:"blur(6px)"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#0d1f17",border:"1px solid rgba(255,255,255,0.1)",borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"20px 18px 36px",display:"flex",flexDirection:"column",gap:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#fff",letterSpacing:1}}>COMPARTILHAR COPIA</span>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer",fontSize:20}}>✕</button>
        </div>

        <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:"rgba(52,211,153,0.06)",borderRadius:11,border:"1px solid rgba(52,211,153,0.15)"}}>
          <TeamShield team={team} size={40}/>
          <div>
            <div style={{color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:17,letterSpacing:0.5}}>{team.name}</div>
            <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:11}}>{(team.players||[]).length} jogadores · {team.formation}</div>
          </div>
        </div>

        {step==="options"&&(<>
          <div>
            <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>O que incluir na copia?</div>
            <div style={{display:"flex",flexDirection:"column",gap:7}}>
              <div style={{padding:"9px 12px",borderRadius:11,border:"1px solid rgba(52,211,153,0.2)",background:"rgba(52,211,153,0.04)"}}>
                <div style={{color:"#34d399",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:6}}>
                  <Icon id="jersey" size={16}/> Elenco (sempre incluido)
                </div>
                <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:11,marginTop:2}}>Nome, posicao, pe, estrelas e status de todos os jogadores</div>
              </div>
              <OptionRow k="includeLineups" icon="clipboard" label="Escalacoes salvas" desc="Todas as formacoes e posicoes definidas"/>
              <OptionRow k="includeStats" icon="chart-bar" label="Estatisticas" desc="Gols, assistencias e presencas dos jogadores"/>
              <OptionRow k="includeMatches" icon="calendar" label="Calendario de partidas" desc="Historico de jogos e resultados"/>
            </div>
          </div>
          <div style={{padding:"10px 12px",background:"rgba(250,204,21,0.06)",borderRadius:10,border:"1px solid rgba(250,204,21,0.15)"}}>
            <div style={{color:"#fbbf24",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:5}}><Icon id="stopwatch" size={11}/> Codigo valido por 24 horas</div>
            <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:11,marginTop:2}}>O outro usuario recebera uma copia independente — alteracoes dele nao afetam seu time.</div>
          </div>
          <button onClick={handleGenerate} style={{padding:"14px 0",borderRadius:13,border:"none",cursor:"pointer",background:"linear-gradient(135deg,#166534,#34d399)",color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:17,letterSpacing:1.5,boxShadow:"0 6px 20px rgba(52,211,153,0.35)"}}>GERAR CODIGO DE COPIA</button>
        </>)}

        {step==="loading"&&(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:14,padding:"30px 0"}}>
            <div style={{width:40,height:40,border:"3px solid rgba(52,211,153,0.2)",borderTopColor:"#34d399",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
            <span style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13}}>Publicando snapshot do time...</span>
          </div>
        )}

        {step==="done"&&(<>
          <div style={{textAlign:"center",padding:"8px 0"}}>
            <Icon id="link" size={48} style={{color:"#34d399",marginBottom:8}}/>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:"#fff",letterSpacing:1,marginBottom:4}}>CODIGO GERADO!</div>
            <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:12}}>Envie para o outro usuario do Escalacao FC</div>
          </div>
          <div style={{display:"flex",justifyContent:"center"}}>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:44,letterSpacing:8,color:"#34d399",background:"rgba(52,211,153,0.08)",border:"2px dashed rgba(52,211,153,0.35)",borderRadius:16,padding:"14px 28px",textAlign:"center"}}>{code}</div>
          </div>
          <div style={{display:"flex",gap:6,alignItems:"center",justifyContent:"center"}}>
            <span style={{color:"#f87171",fontSize:12,display:"flex",alignItems:"center"}}><Icon id="stopwatch" size={12}/></span>
            <span style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11}}>Expira em 24h · copia independente do seu time</span>
          </div>
          <button onClick={handleCopy} style={{padding:"14px 0",borderRadius:13,border:"1px solid rgba(52,211,153,0.35)",cursor:"pointer",background:copied?"rgba(52,211,153,0.15)":"rgba(52,211,153,0.08)",color:"#34d399",fontFamily:"'Bebas Neue',sans-serif",fontSize:16,letterSpacing:1,transition:"all 0.15s"}}>{copied?"COPIADO!":<><Icon id="upload" size={16}/> COMPARTILHAR CONVITE</>}</button>
          <button onClick={onClose} style={{padding:"10px 0",borderRadius:11,border:"1px solid rgba(255,255,255,0.1)",background:"transparent",color:"#6B7280",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:600}}>Fechar</button>
        </>)}

        {step==="error"&&(<>
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <Icon id="warning" size={44} style={{color:"#f87171",marginBottom:8}}/>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:"#fff",letterSpacing:1,marginBottom:4}}>ERRO AO GERAR CODIGO</div>
            <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:12}}>Verifique sua conexao e tente novamente.</div>
          </div>
          <button onClick={()=>setStep("options")} style={{padding:"13px 0",borderRadius:12,border:"none",cursor:"pointer",background:"rgba(255,255,255,0.06)",color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700}}>Tentar novamente</button>
        </>)}
      </div>
    </div>
  );
}

// ─── Import Team Modal ────────────────────────────────────────────────────────
// Somente para codigos de COPIA (6 chars, gerados por publishTeamShare).
// Codigos colaborativos (7 chars, comecam com C) sao tratados em JoinCollabModal.
function ImportTeamModal({user, onClose, onImported}) {
  const [code, setCode] = useState("");
  const [step, setStep] = useState("input"); // "input"|"preview"|"loading"|"done"|"error"
  const [shareData, setShareData] = useState(null);
  const [options, setOptions] = useState({includeStats:true, includeMatches:true, includeLineups:true});
  const [errMsg, setErrMsg] = useState("");
  const toggle = k => setOptions(o => ({...o, [k]:!o[k]}));

  const handleLookup = async () => {
    const q = code.trim().toUpperCase();
    if (q.length !== 6) return;
    setStep("loading");
    const data = await fetchTeamShare(q);
    if (!data) { setErrMsg("Codigo nao encontrado ou expirado. Verifique e tente novamente."); setStep("error"); return; }
    setShareData(data);
    const snap = data.teamSnapshot || {};
    setOptions({
      includeStats: Object.keys(snap.stats||{}).length > 0,
      includeMatches: (snap.matches||[]).length > 0,
      includeLineups: (snap.lineups||[]).length > 0,
    });
    setStep("preview");
  };

  const handleImport = async () => {
    setStep("loading");
    const newId = await importTeamShare(user.uid, shareData, options);
    if (newId) setStep("done");
    else { setErrMsg("Erro ao importar. Verifique sua conexao."); setStep("error"); }
  };

  const snap = shareData?.teamSnapshot || {};
  const OptionCheck = ({k, icon, label, count}) => (
    <button onClick={()=>toggle(k)} style={{
      display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:10,border:"1px solid",cursor:"pointer",textAlign:"left",
      borderColor:options[k]?"rgba(52,211,153,0.3)":"rgba(255,255,255,0.08)",
      background:options[k]?"rgba(52,211,153,0.06)":"rgba(255,255,255,0.02)",transition:"all 0.12s"
    }}>
      <Icon id={icon} size={18} style={{color:options[k]?"#34d399":"#6B7280",flexShrink:0}}/>
      <div style={{flex:1}}>
        <div style={{color:options[k]?"#e5e7eb":"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700}}>{label}</div>
        <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:11}}>{count}</div>
      </div>
      <div style={{width:18,height:18,borderRadius:5,border:"2px solid",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,
        borderColor:options[k]?"#34d399":"rgba(255,255,255,0.15)",background:options[k]?"#34d399":"transparent"}}>
        {options[k]&&<svg width="10" height="10" viewBox="0 0 12 12" fill="none"><polyline points="2,6 5,9 10,3" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      </div>
    </button>
  );

  return (
    <div style={{position:"fixed",inset:0,zIndex:1100,display:"flex",alignItems:"flex-end",justifyContent:"center",background:"rgba(0,0,0,0.8)",backdropFilter:"blur(6px)"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#0d1f17",border:"1px solid rgba(255,255,255,0.1)",borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"20px 18px 36px",display:"flex",flexDirection:"column",gap:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#fff",letterSpacing:1}}>IMPORTAR COPIA DE TIME</span>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer",fontSize:20}}>✕</button>
        </div>

        {step==="input"&&(<>
          <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13,lineHeight:1.6}}>
            Insira o codigo de 6 letras gerado pelo dono do time. Voce recebera uma copia independente para editar.
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            <label style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1}}>Codigo de copia (6 caracteres)</label>
            <input
              value={code}
              onChange={e=>setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,6))}
              placeholder="Ex: AB3C7D"
              maxLength={6}
              style={{...{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:12,padding:"12px 14px",color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:28,letterSpacing:8,textAlign:"center"},colorScheme:"dark"}}
              onFocus={e=>e.target.style.borderColor="#34d399"}
              onBlur={e=>e.target.style.borderColor="rgba(255,255,255,0.12)"}
              autoCapitalize="characters"
            />
            <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:10,textAlign:"center"}}>
              Para entrar em um time colaborativo, use o botao "Colaborar" na tela principal
            </div>
          </div>
          <button onClick={handleLookup} disabled={code.length!==6} style={{
            padding:"14px 0",borderRadius:13,border:"none",cursor:code.length!==6?"default":"pointer",
            background:code.length!==6?"rgba(255,255,255,0.06)":"linear-gradient(135deg,#166534,#34d399)",
            color:code.length!==6?"#4B5563":"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:17,letterSpacing:1.5
          }}>BUSCAR TIME</button>
        </>)}

        {step==="loading"&&(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:14,padding:"30px 0"}}>
            <div style={{width:40,height:40,border:"3px solid rgba(52,211,153,0.2)",borderTopColor:"#34d399",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
            <span style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13}}>Buscando time...</span>
          </div>
        )}

        {step==="preview"&&(<>
          <div style={{padding:"12px",background:"rgba(52,211,153,0.05)",borderRadius:12,border:"1px solid rgba(52,211,153,0.15)"}}>
            <div style={{color:"#34d399",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,marginBottom:6}}>TIME ENCONTRADO</div>
            <div style={{color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:20,letterSpacing:0.5}}>{shareData?.teamName || "Time"}</div>
            <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11,marginTop:2}}>
              Compartilhado por {shareData?.ownerName || "Usuario"} · {(snap.players||[]).length} jogadores
            </div>
          </div>

          <div>
            <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>O que importar?</div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              <div style={{padding:"9px 12px",borderRadius:10,border:"1px solid rgba(52,211,153,0.2)",background:"rgba(52,211,153,0.04)"}}>
                <div style={{color:"#34d399",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:5}}><Icon id="jersey" size={14}/> Elenco — {(snap.players||[]).length} jogadores (sempre incluido)</div>
              </div>
              {(snap.lineups||[]).length>0&&<OptionCheck k="includeLineups" icon="clipboard" label="Escalacoes" count={`${(snap.lineups||[]).length} formacao(oes) salva(s)`}/>}
              {Object.keys(snap.stats||{}).length>0&&<OptionCheck k="includeStats" icon="chart-bar" label="Estatisticas" count="Gols, assistencias e presencas"/>}
              {(snap.matches||[]).length>0&&<OptionCheck k="includeMatches" icon="calendar" label="Partidas" count={`${(snap.matches||[]).length} partida(s) no calendario`}/>}
            </div>
          </div>

          <div style={{padding:"10px 12px",background:"rgba(59,130,246,0.06)",borderRadius:10,border:"1px solid rgba(59,130,246,0.15)"}}>
            <div style={{color:"#60a5fa",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700}}>Copia independente</div>
            <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:11,marginTop:2}}>Voce recebera o time como "{shareData?.teamName} (copia)". Suas edicoes nao afetam o time original.</div>
          </div>

          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>setStep("input")} style={{flex:1,padding:"12px 0",borderRadius:11,border:"1px solid rgba(255,255,255,0.12)",background:"rgba(255,255,255,0.04)",color:"#9CA3AF",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700}}>Voltar</button>
            <button onClick={handleImport} style={{flex:2,padding:"12px 0",borderRadius:11,border:"none",cursor:"pointer",background:"linear-gradient(135deg,#166534,#34d399)",color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:16,letterSpacing:1,boxShadow:"0 4px 14px rgba(52,211,153,0.3)"}}>IMPORTAR AGORA</button>
          </div>
        </>)}

        {step==="done"&&(<>
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <Icon id="party" size={52} style={{color:"#34d399",marginBottom:8}}/>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#fff",letterSpacing:1,marginBottom:6}}>TIME IMPORTADO!</div>
            <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13,lineHeight:1.6}}>
              "{shareData?.teamName} (copia)" foi adicionado a sua lista de times. E totalmente seu para editar!
            </div>
          </div>
          <button onClick={()=>onImported()} style={{padding:"14px 0",borderRadius:13,border:"none",cursor:"pointer",background:"linear-gradient(135deg,#166534,#34d399)",color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:17,letterSpacing:1.5,boxShadow:"0 6px 20px rgba(52,211,153,0.35)"}}>VER MEUS TIMES</button>
        </>)}

        {step==="error"&&(<>
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <Icon id="sad" size={44} style={{color:"#6B7280",marginBottom:8}}/>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:"#fff",letterSpacing:1,marginBottom:6}}>OPS!</div>
            <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13}}>{errMsg}</div>
          </div>
          <button onClick={()=>setStep("input")} style={{padding:"13px 0",borderRadius:12,border:"none",cursor:"pointer",background:"rgba(255,255,255,0.06)",color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700}}>Tentar novamente</button>
        </>)}
      </div>
    </div>
  );
}

// ─── Player Form ──────────────────────────────────────────────────────────────
function PlayerFormModal({initial,onSave,onClose,teamColor,isGuest}) {
  const [form,setForm]=useState(initial||{name:"",number:"",photo:"",foot:"Destro",position:"Goleiro",position2:"",status:"active",stars:3,isGuest:isGuest||false});
  const [saving,setSaving]=useState(false);
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  // For guests, number is not required (auto-assigned as "C1", "C2", etc.)
  const valid=!!(form.name.trim()&&(form.isGuest||String(form.number).trim()!==""));
  const [c1]=SHIELD_COLORS[teamColor%SHIELD_COLORS.length];
  const handleSave=async()=>{
    if(!valid||saving)return;
    setSaving(true);
    try{ await withTimeout(onSave(form), 8000); }catch(e){ console.error("PlayerFormModal save error:",e); }
    setSaving(false);
  };
  return (
    <div style={{position:"fixed",inset:0,zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.82)",backdropFilter:"blur(6px)",padding:"12px"}}>
      <div style={{background:"#0d1f17",border:`1px solid ${form.isGuest?"rgba(251,146,60,0.35)":"rgba(255,255,255,0.1)"}`,borderRadius:20,width:"100%",maxWidth:420,maxHeight:"92vh",overflowY:"auto",boxShadow:"0 24px 80px rgba(0,0,0,0.9)"}}>
        <div style={{padding:"16px 18px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:"1px solid rgba(255,255,255,0.08)"}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {form.isGuest&&<span style={{background:"rgba(251,146,60,0.18)",color:"#fb923c",borderRadius:8,padding:"2px 8px",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:800,textTransform:"uppercase",letterSpacing:0.5,display:"flex",alignItems:"center",gap:4}}><Icon id="ticket" size={10}/> Convidado</span>}
            <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:21,color:"#fff",letterSpacing:1}}>{initial?"Editar":(form.isGuest?"Novo Convidado":"Novo Jogador")}</span>
          </div>
          <button onClick={onClose} aria-label="Fechar" style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer",padding:4}}><Ico.Close/></button>
        </div>
        <div style={{padding:"16px 18px 20px",display:"flex",flexDirection:"column",gap:15}}>
          {form.isGuest&&(
            <div style={{background:"rgba(251,146,60,0.07)",border:"1px solid rgba(251,146,60,0.2)",borderRadius:12,padding:"10px 13px",fontFamily:"'DM Sans',sans-serif",fontSize:12,color:"#fb923c",lineHeight:1.5,display:"flex",alignItems:"flex-start",gap:6}}>
              <Icon id="ticket" size={14} style={{flexShrink:0,marginTop:1}}/> Jogadores convidados não contam para as estatísticas do time e aparecem separados nos relatórios.
            </div>
          )}
          <PhotoPicker photo={form.photo} onChange={v=>set("photo",v)}/>

          <div style={{display:"flex",flexDirection:"column",gap:5}}>
            <label htmlFor="player-name" style={LT}>Nome</label>
            <input id="player-name" value={form.name} onChange={e=>set("name",e.target.value)} placeholder={form.isGuest?"Nome do convidado":"Nome do jogador"} style={IS}
              onFocus={e=>e.target.style.borderColor="#34d399"} onBlur={e=>e.target.style.borderColor="rgba(255,255,255,0.1)"}/>
          </div>
          <div style={{display:"flex",gap:10}}>
            {!form.isGuest&&(
            <div style={{display:"flex",flexDirection:"column",gap:5,flex:"0 0 80px"}}>
              <label htmlFor="player-number" style={LT}>Número</label>
              <input id="player-number" type="number" min={1} max={99} value={form.number} onChange={e=>set("number",e.target.value)} placeholder="10" style={IS}
                onFocus={e=>e.target.style.borderColor="#34d399"} onBlur={e=>e.target.style.borderColor="rgba(255,255,255,0.1)"}/>
            </div>
            )}
            <div style={{display:"flex",flexDirection:"column",gap:5,flex:1}}>
              <label htmlFor="player-position" style={LT}>Posição</label>
              <select id="player-position" value={form.position} onChange={e=>set("position",e.target.value)} style={{...IS,appearance:"none"}}>
                {POSITIONS.map(p=><option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:5}}>
            <span style={LT}>Pé Dominante</span>
            <div style={{display:"flex",gap:8}}>
              {["Destro","Canhoto","Ambidestro"].map(f=>(
                <button key={f} onClick={()=>set("foot",f)} style={{
                  flex:1,padding:"9px 0",borderRadius:10,border:"1px solid",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,transition:"all 0.2s",
                  borderColor:form.foot===f?c1:"rgba(255,255,255,0.1)",
                  background:form.foot===f?`${c1}25`:"rgba(255,255,255,0.03)",
                  color:form.foot===f?"#34d399":"#9CA3AF",
                }}>{f==="Ambidestro"?"Ambidex.":f}</button>
              ))}
            </div>
          </div>
          {!form.isGuest&&(
          <div style={{display:"flex",flexDirection:"column",gap:5}}>
            <label style={LT}>Posição Secundária <span style={{color:"#4B5563",fontWeight:400,textTransform:"none"}}>(opcional)</span></label>
            <select value={form.position2||""} onChange={e=>set("position2",e.target.value)} style={{...IS,appearance:"none"}}>
              <option value="">— Nenhuma —</option>
              {POSITIONS.filter(p=>p!==form.position).map(p=><option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          )}
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            <span style={LT}>Status</span>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6}}>
              {PLAYER_STATUSES.map(s=>(
                <button key={s.id} onClick={()=>set("status",s.id)} style={{
                  display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:"8px 4px",
                  borderRadius:10,border:"2px solid",cursor:"pointer",
                  borderColor:(form.status||"active")===s.id?s.color:"rgba(255,255,255,0.08)",
                  background:(form.status||"active")===s.id?`${s.color}18`:"rgba(255,255,255,0.02)",
                  transition:"all 0.15s"
                }}>
                  <Icon id={s.icon} size={16} style={{color:s.color}}/>
                  <span style={{color:(form.status||"active")===s.id?s.color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:8,fontWeight:800,textTransform:"uppercase"}}>{s.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:5}}>
            <span style={LT}>Habilidade</span>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <StarRating value={form.stars} onChange={v=>set("stars",v)}/>
              <span style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:12}}>{["","Iniciante","Regular","Bom","Ótimo","Elite"][form.stars]}</span>
            </div>
          </div>
          <button onClick={handleSave} disabled={saving||!valid} style={{
            marginTop:2,padding:"13px 0",borderRadius:12,border:"none",cursor:(valid&&!saving)?"pointer":"not-allowed",
            background:(valid&&!saving)
              ?(form.isGuest?"linear-gradient(135deg,#9a3412,#fb923c)":"linear-gradient(135deg,#166534,#34d399)")
              :"rgba(255,255,255,0.07)",
            color:(valid&&!saving)?"#fff":"#6B7280",fontFamily:"'Bebas Neue',sans-serif",fontSize:18,letterSpacing:1.5,transition:"all 0.2s",
            boxShadow:(valid&&!saving)?(form.isGuest?"0 4px 20px rgba(251,146,60,0.3)":"0 4px 20px rgba(52,211,153,0.3)"):"none",
            display:"flex",alignItems:"center",justifyContent:"center",gap:8
          }}>
            {saving&&<div style={{width:16,height:16,border:"2px solid rgba(255,255,255,0.3)",borderTopColor:"#fff",borderRadius:"50%",animation:"spin 0.7s linear infinite",flexShrink:0}}/>}
            {saving?"SALVANDO...":(form.isGuest?"SALVAR CONVIDADO":"SALVAR JOGADOR")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Formation Picker ─────────────────────────────────────────────────────────
function FormationPicker({current,onChange}) {
  const idx=FKEYS.indexOf(current);
  const prev=()=>onChange(FKEYS[(idx-1+FKEYS.length)%FKEYS.length]);
  const next=()=>onChange(FKEYS[(idx+1)%FKEYS.length]);
  return (
    <div style={{display:"flex",alignItems:"center",gap:0,background:"rgba(0,0,0,0.45)",borderRadius:10,border:"1px solid rgba(255,255,255,0.1)",overflow:"hidden",flexShrink:0}}>
      <button onClick={prev} aria-label="Formação anterior" style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer",padding:"6px 10px",display:"flex",alignItems:"center"}}><Ico.ChevL/></button>
      <div style={{padding:"5px 8px",fontFamily:"'Bebas Neue',sans-serif",fontSize:17,color:"#34d399",letterSpacing:1.5,minWidth:76,textAlign:"center"}}>{current}</div>
      <button onClick={next} aria-label="Próxima formação" style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer",padding:"6px 10px",display:"flex",alignItems:"center"}}><Ico.ChevR/></button>
    </div>
  );
}

// ─── Formation List Modal ─────────────────────────────────────────────────────
function FormationListModal({current,onSelect,onClose}) {
  return (
    <div style={{position:"fixed",inset:0,zIndex:1000,display:"flex",alignItems:"flex-end",justifyContent:"center",background:"rgba(0,0,0,0.75)",backdropFilter:"blur(4px)"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#0d1f17",border:"1px solid rgba(255,255,255,0.1)",borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,maxHeight:"75vh",overflow:"hidden",display:"flex",flexDirection:"column"}}>
        <div style={{padding:"16px 18px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:"1px solid rgba(255,255,255,0.08)",flexShrink:0}}>
          <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:"#fff",letterSpacing:1}}>Escolher Formação</span>
          <button onClick={onClose} aria-label="Fechar" style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer"}}><Ico.Close/></button>
        </div>
        <div style={{overflowY:"auto",padding:"10px 14px 20px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          {FKEYS.map(k=>(
            <button key={k} onClick={()=>{onSelect(k);onClose();}} style={{
              padding:"12px 10px",borderRadius:12,border:"1.5px solid",cursor:"pointer",transition:"all 0.15s",
              borderColor:k===current?"#34d399":"rgba(255,255,255,0.1)",
              background:k===current?"rgba(52,211,153,0.12)":"rgba(255,255,255,0.03)",
              color:k===current?"#34d399":"#fff",
              fontFamily:"'Bebas Neue',sans-serif",fontSize:18,letterSpacing:1.5,textAlign:"center"
            }}>{k}{k===current&&<span style={{fontSize:11,display:"block",letterSpacing:0,fontFamily:"sans-serif",marginTop:2,opacity:0.8}}>atual</span>}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Slot Picker Sheet ────────────────────────────────────────────────────────
const SLOT_SORT_OPTIONS = [
  { key:"name",   label:"Nome",    icon:"A→Z" },
  { key:"number", label:"Nº",      icon:"#"   },
  { key:"position",label:"Pos.",   icon:"pos" },
  { key:"stars",  label:"Nível",   icon:"★"   },
];
function sortPlayers(list, sortBy, asc) {
  return [...list].sort((a,b)=>{
    let va, vb;
    if(sortBy==="name")     { va=a.name.toLowerCase();    vb=b.name.toLowerCase(); }
    else if(sortBy==="number") { va=parseInt(a.number)||0; vb=parseInt(b.number)||0; }
    else if(sortBy==="position") { va=a.position;           vb=b.position; }
    else if(sortBy==="stars")  { va=a.stars||0;             vb=b.stars||0; }
    if(va<vb) return asc?-1:1;
    if(va>vb) return asc?1:-1;
    return 0;
  });
}

function SlotPickerModal({slotLabel,players,lineup,onPick,onClear,onClose,team}) {
  const [sortBy,setSortBy]=useState("name");
  const [sortAsc,setSortAsc]=useState(true);
  const toggleSort=(key)=>{ if(sortBy===key) setSortAsc(a=>!a); else{setSortBy(key);setSortAsc(true);} };
  const available=sortPlayers(players.filter(p=>!lineup.find(l=>l.playerId===p.id)),sortBy,sortAsc);
  const inField=sortPlayers(players.filter(p=>lineup.find(l=>l.playerId===p.id)),sortBy,sortAsc);
  return (
    <div style={{position:"fixed",inset:0,zIndex:1000,display:"flex",alignItems:"flex-end",justifyContent:"center",background:"rgba(0,0,0,0.72)",backdropFilter:"blur(4px)"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#0d1f17",border:"1px solid rgba(255,255,255,0.1)",borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,maxHeight:"72vh",overflow:"hidden",display:"flex",flexDirection:"column"}}>
        <div style={{padding:"15px 17px 11px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:"1px solid rgba(255,255,255,0.08)",flexShrink:0}}>
          <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:19,color:"#fff",letterSpacing:1}}>Posição: {slotLabel}</span>
          <button onClick={onClose} aria-label="Fechar" style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer"}}><Ico.Close/></button>
        </div>
        {/* Sort bar */}
        <div style={{display:"flex",alignItems:"center",gap:5,padding:"8px 13px 6px",borderBottom:"1px solid rgba(255,255,255,0.06)",flexShrink:0,overflowX:"auto"}}>
          <span style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:0.5,flexShrink:0}}>Ordenar:</span>
          {SLOT_SORT_OPTIONS.map(opt=>{
            const active=sortBy===opt.key;
            return (
              <button key={opt.key} onClick={()=>toggleSort(opt.key)} style={{
                display:"flex",alignItems:"center",gap:3,padding:"4px 9px",borderRadius:7,
                border:"1px solid",flexShrink:0,cursor:"pointer",
                fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,transition:"all 0.15s",
                borderColor:active?"#34d399":"rgba(255,255,255,0.1)",
                background:active?"rgba(52,211,153,0.14)":"rgba(255,255,255,0.03)",
                color:active?"#34d399":"#6B7280",
              }}>
                <span style={{fontSize:9}}>{opt.icon}</span>{opt.label}
                {active&&<span style={{fontSize:9,opacity:0.75}}>{sortAsc?"↑":"↓"}</span>}
              </button>
            );
          })}
        </div>
        <div style={{overflowY:"auto",padding:"10px 13px 20px",display:"flex",flexDirection:"column",gap:7}}>
          {onClear&&<button onClick={onClear} style={{display:"flex",alignItems:"center",gap:9,padding:"10px 13px",background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:11,cursor:"pointer",color:"#f87171",fontFamily:"'DM Sans',sans-serif",fontSize:13}}>
            <Ico.Trash/> Remover jogador desta posição
          </button>}
          {available.length>0&&(
            <>
              <div style={{padding:"4px 2px",color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:0.5}}>Disponíveis</div>
              {available.map((p,i)=>{
                const isGuest=!!p.isGuest;
                const guestIdx=players.filter(x=>x.isGuest).indexOf(p)+1;
                return (
                <button key={p.id} onClick={()=>onPick(p.id)} style={{display:"flex",alignItems:"center",gap:11,padding:"10px 13px",background:isGuest?"rgba(251,146,60,0.04)":"rgba(255,255,255,0.04)",border:isGuest?"1px solid rgba(251,146,60,0.18)":"1px solid rgba(255,255,255,0.08)",borderRadius:11,cursor:"pointer",transition:"all 0.14s",textAlign:"left"}}
                  onMouseEnter={e=>{e.currentTarget.style.background=isGuest?"rgba(251,146,60,0.12)":"rgba(52,211,153,0.1)";e.currentTarget.style.borderColor=isGuest?"rgba(251,146,60,0.45)":"rgba(52,211,153,0.4)";}}
                  onMouseLeave={e=>{e.currentTarget.style.background=isGuest?"rgba(251,146,60,0.04)":"rgba(255,255,255,0.04)";e.currentTarget.style.borderColor=isGuest?"rgba(251,146,60,0.18)":"rgba(255,255,255,0.08)";}}>
                  <PlayerAvatar player={p} size={42} style={{border:isGuest?"2px solid rgba(251,146,60,0.4)":"2px solid rgba(255,255,255,0.18)"}} team={team}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <span style={{color:"#fff",fontFamily:"'DM Sans',sans-serif",fontSize:14,fontWeight:700}}>{p.name}</span>
                      {isGuest&&<span style={{background:"rgba(251,146,60,0.18)",color:"#fb923c",borderRadius:5,padding:"1px 5px",fontSize:9,fontWeight:800,display:"inline-flex",alignItems:"center",gap:2}}><Icon id="ticket" size={8}/> C{guestIdx}</span>}
                    </div>
                    <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:11,marginTop:1}}>{isGuest?`Convidado · `:`#${p.number} · `}{p.position} · {p.foot}</div>
                    <div style={{marginTop:3}}><StarRating value={p.stars} readonly/></div>
                  </div>
                </button>
                );
              })}
            </>
          )}
          {inField.length>0&&(
            <>
              <div style={{padding:"4px 2px",color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:0.5,marginTop:4}}>Já escalados (trocar posição)</div>
              {inField.map(p=>{
                const isGuest=!!p.isGuest;
                const guestIdx=players.filter(x=>x.isGuest).indexOf(p)+1;
                return (
                <button key={p.id} onClick={()=>onPick(p.id)} style={{display:"flex",alignItems:"center",gap:11,padding:"10px 13px",background:"rgba(250,204,21,0.04)",border:"1px solid rgba(250,204,21,0.15)",borderRadius:11,cursor:"pointer",transition:"all 0.14s",textAlign:"left"}}
                  onMouseEnter={e=>{e.currentTarget.style.background="rgba(250,204,21,0.1)";e.currentTarget.style.borderColor="rgba(250,204,21,0.4)";}}
                  onMouseLeave={e=>{e.currentTarget.style.background="rgba(250,204,21,0.04)";e.currentTarget.style.borderColor="rgba(250,204,21,0.15)";}}>
                  <PlayerAvatar player={p} size={42} style={{border:"2px solid rgba(250,204,21,0.4)"}} team={team}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <span style={{color:"#fff",fontFamily:"'DM Sans',sans-serif",fontSize:14,fontWeight:700}}>{p.name}</span>
                      {isGuest&&<span style={{background:"rgba(251,146,60,0.18)",color:"#fb923c",borderRadius:5,padding:"1px 5px",fontSize:9,fontWeight:800,display:"inline-flex",alignItems:"center",gap:2}}><Icon id="ticket" size={8}/> C{guestIdx}</span>}
                    </div>
                    <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:11,marginTop:1}}>{isGuest?`Convidado`:`#${p.number}`} · {p.position}</div>
                  </div>
                </button>
                );
              })}
            </>
          )}
          {players.length===0&&<div style={{textAlign:"center",padding:"28px 0",color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:13}}>
            Nenhum jogador cadastrado.<br/><span style={{color:"#34d399"}}>Vá em "Elenco" e cadastre jogadores.</span>
          </div>}
        </div>
      </div>
    </div>
  );
}

// ─── Football Field ───────────────────────────────────────────────────────────
function FootballField({slots,lineup,players,onLineupChange,onSlotTap,team,freeMode,onFreeMoveEnd}) {
  const fieldRef=useRef();
  const dragState=useRef(null);
  const [ghost,setGhost]=useState(null);
  const [highlight,setHighlight]=useState(null);
  const getFieldRect=()=>fieldRef.current?.getBoundingClientRect();

  // Raio de detecção de slot em % do campo — slots têm ~8% de raio de toque
  const SLOT_HIT_RADIUS = 8;

  const getNearestSlot=useCallback((cx,cy)=>{
    const rect=getFieldRect();if(!rect)return null;
    const px=((cx-rect.left)/rect.width)*100;
    const py=((cy-rect.top)/rect.height)*100;
    let best=null,bestDist=SLOT_HIT_RADIUS;
    for(const s of slots){const d=Math.hypot(s.x-px,s.y-py);if(d<bestDist){bestDist=d;best=s.id;}}
    return best;
  },[slots]);

  // Versão mais ampla para detectar slot alvo durante drag (snap zone maior)
  const getSlotUnder=useCallback((cx,cy)=>{
    const rect=getFieldRect();if(!rect)return null;
    const px=((cx-rect.left)/rect.width)*100;
    const py=((cy-rect.top)/rect.height)*100;
    let best=null,bestDist=9;
    for(const s of slots){const d=Math.hypot(s.x-px,s.y-py);if(d<bestDist){bestDist=d;best=s.id;}}
    return best;
  },[slots]);

  const clientXY=e=>e.touches?{cx:e.touches[0].clientX,cy:e.touches[0].clientY}:{cx:e.clientX,cy:e.clientY};

  // onPointerDown chamado pelos slots individualmente
  const onPointerDown=(e,slotId)=>{
    const{cx,cy}=clientXY(e);
    dragState.current={slotId,startX:cx,startY:cy,curX:cx,curY:cy,isDragging:false,isScroll:false};
  };

  const onMouseMove=useCallback(e=>{
    if(!dragState.current)return;
    const{cx,cy}=clientXY(e);
    const dist=Math.hypot(cx-dragState.current.startX,cy-dragState.current.startY);
    if(!dragState.current.isDragging&&dist<6)return;
    dragState.current.isDragging=true;
    dragState.current.curX=cx;dragState.current.curY=cy;
    const rect=getFieldRect();if(!rect)return;
    const player=players.find(p=>p.id===lineup.find(l=>l.slotId===dragState.current.slotId)?.playerId);
    setGhost({slotId:dragState.current.slotId,x:cx-rect.left,y:cy-rect.top,player});
    if(!freeMode) setHighlight(getSlotUnder(cx,cy));
  },[lineup,players,getSlotUnder,freeMode]);

  const finishDrag=useCallback((cx,cy)=>{
    if(!dragState.current)return;
    const{slotId,isDragging}=dragState.current;
    dragState.current=null;setGhost(null);setHighlight(null);
    if(!isDragging){onSlotTap(slotId,slots.find(s=>s.id===slotId)?.label||"");return;}

    // ── Free mode: reposition player to wherever the user dropped ──
    if(freeMode){
      const rect=getFieldRect();if(!rect)return;
      const px=Math.min(98,Math.max(2,((cx-rect.left)/rect.width)*100));
      const py=Math.min(98,Math.max(2,((cy-rect.top)/rect.height)*100));
      if(onFreeMoveEnd) onFreeMoveEnd(slotId,px,py);
      return;
    }

    const targetSlotId=getSlotUnder(cx,cy);
    if(targetSlotId===null||targetSlotId===slotId)return;
    onLineupChange(prev=>{
      const src=prev.find(l=>l.slotId===slotId);
      const tgt=prev.find(l=>l.slotId===targetSlotId);
      const next=prev.filter(l=>l.slotId!==slotId&&l.slotId!==targetSlotId);
      if(src)next.push({slotId:targetSlotId,playerId:src.playerId});
      if(tgt)next.push({slotId,playerId:tgt.playerId});
      return next;
    });
  },[slots,getSlotUnder,onLineupChange,onSlotTap,freeMode,onFreeMoveEnd]);

  const onMouseUp=useCallback(e=>{const{cx,cy}=clientXY(e);finishDrag(cx,cy);},[finishDrag]);

  useEffect(()=>{
    // touchmove: só bloqueia scroll nativo se estiver arrastando um jogador
    const tm=e=>{
      if(!dragState.current)return;
      if(dragState.current.isScroll)return; // deixa o browser rolar
      e.preventDefault(); // bloqueia scroll apenas durante drag de jogador
      onMouseMove(e);
    };
    const tu=e=>{
      if(!dragState.current)return;
      if(dragState.current.isScroll){dragState.current=null;return;}
      const t=e.changedTouches[0];
      finishDrag(t.clientX,t.clientY);
    };
    window.addEventListener("mousemove",onMouseMove);
    window.addEventListener("mouseup",onMouseUp);
    window.addEventListener("touchmove",tm,{passive:false});
    window.addEventListener("touchend",tu);
    return()=>{
      window.removeEventListener("mousemove",onMouseMove);
      window.removeEventListener("mouseup",onMouseUp);
      window.removeEventListener("touchmove",tm);
      window.removeEventListener("touchend",tu);
    };
  },[onMouseMove,onMouseUp,finishDrag]);

  // Touch direto no campo (área vazia) — inicia scroll manual via scrollBy
  const onFieldTouchStart=useCallback(e=>{
    // Se o toque começou sobre um slot, o slot já chamou onPointerDown — ignorar aqui
    if(dragState.current)return;
    const{cx,cy}=clientXY(e);
    // Verificar se está perto de algum slot; se sim, não interferir
    if(getNearestSlot(cx,cy)!==null)return;
    // Área vazia: preparar scroll nativo liberando touchAction
    // Não precisa fazer nada — o campo tem touchAction:"pan-y" por padrão
    // quando dragState é null, o touchmove não chama preventDefault
  },[getNearestSlot]);

  // In freeMode, slots come from lineup entries (with x/y); otherwise from formation slots
  const displaySlots = freeMode
    ? lineup.filter(e=>e.playerId).map(e=>{
        const formSlot = slots.find(s=>s.id===e.slotId);
        return { id:e.slotId, label:formSlot?.label||"", x:e.x??formSlot?.x??50, y:e.y??formSlot?.y??50 };
      })
    : slots;

  return (
    <div ref={fieldRef}
      onTouchStart={onFieldTouchStart}
      style={{position:"relative",width:"100%",aspectRatio:"0.65",borderRadius:12,overflow:"hidden",userSelect:"none",
        touchAction:"pan-y",
        outline: freeMode ? "2px solid rgba(250,204,21,0.5)" : "none",
        boxShadow: freeMode ? "0 0 24px rgba(250,204,21,0.18)" : "none",
      }}>
      {freeMode&&(
        <div style={{position:"absolute",top:6,left:"50%",transform:"translateX(-50%)",zIndex:20,background:"rgba(250,204,21,0.18)",border:"1px solid rgba(250,204,21,0.5)",borderRadius:20,padding:"3px 12px",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:800,color:"#facc15",letterSpacing:0.5,pointerEvents:"none",whiteSpace:"nowrap"}}>
          ✦ FORMAÇÃO LIVRE — arraste livremente
        </div>
      )}
      <svg width="100%" height="100%" viewBox="0 0 100 154" preserveAspectRatio="none" style={{position:"absolute",inset:0,display:"block"}}>
        {[...Array(8)].map((_,i)=><rect key={i} x={0} y={i*19.25} width={100} height={9.625} fill={i%2===0?"#1c7a40":"#18703a"}/>)}
        <rect x="3" y="3" width="94" height="148" fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="0.65"/>
        <line x1="3" y1="77" x2="97" y2="77" stroke="rgba(255,255,255,0.75)" strokeWidth="0.5"/>
        <circle cx="50" cy="77" r="10" fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="0.5"/>
        <circle cx="50" cy="77" r="0.8" fill="rgba(255,255,255,0.8)"/>
        <rect x="22" y="3" width="56" height="22" fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="0.5"/>
        <rect x="22" y="129" width="56" height="22" fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="0.5"/>
        <rect x="35" y="3" width="30" height="10" fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="0.5"/>
        <rect x="35" y="141" width="30" height="10" fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="0.5"/>
        <rect x="42" y="1.2" width="16" height="3" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.5)" strokeWidth="0.4"/>
        <rect x="42" y="149.8" width="16" height="3" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.5)" strokeWidth="0.4"/>
        <circle cx="50" cy="18" r="0.8" fill="rgba(255,255,255,0.8)"/>
        <circle cx="50" cy="136" r="0.8" fill="rgba(255,255,255,0.8)"/>
        {[[3,3],[97,3],[3,151],[97,151]].map(([cx,cy],i)=>(
          <circle key={i} cx={cx} cy={cy} r="3" fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="0.5"/>
        ))}
      </svg>

      {/* In normal mode: also render empty slots (no player). In freeMode: only occupied positions. */}
      {(!freeMode ? slots : displaySlots).map(slot=>{
        const entry=lineup.find(l=>l.slotId===slot.id);
        const player=entry?players.find(p=>p.id===entry.playerId):null;
        const isHL=highlight===slot.id;
        const isDragged=ghost?.slotId===slot.id;
        const slotX = freeMode ? (entry?.x??slot.x) : slot.x;
        const slotY = freeMode ? (entry?.y??slot.y) : slot.y;
        // Long-press de 180ms para iniciar drag; toque rápido = tap; scroll vertical livre enquanto não confirma drag
        const handleSlotTouchStart=e=>{
          const touch=e.touches[0];
          const startX=touch.clientX,startY=touch.clientY;
          let longPressTimer=null;
          let moved=false;
          const onMove=ev=>{
            const t=ev.touches[0];
            const dx=Math.abs(t.clientX-startX),dy=Math.abs(t.clientY-startY);
            if(dx>8||dy>8){moved=true;clearTimeout(longPressTimer);cleanup();}
          };
          const onEnd=()=>{clearTimeout(longPressTimer);cleanup();};
          const cleanup=()=>{
            window.removeEventListener("touchmove",onMove);
            window.removeEventListener("touchend",onEnd);
          };
          longPressTimer=setTimeout(()=>{
            cleanup();
            if(moved)return;
            onPointerDown(e,slot.id);
          },180);
          window.addEventListener("touchmove",onMove,{passive:true});
          window.addEventListener("touchend",onEnd,{once:true});
        };
        return (
          <div key={slot.id}
            onMouseDown={e=>onPointerDown(e,slot.id)}
            onTouchStart={handleSlotTouchStart}
            style={{position:"absolute",left:`${slotX}%`,top:`${slotY}%`,transform:"translate(-50%,-50%)",display:"flex",flexDirection:"column",alignItems:"center",gap:2,cursor:"grab",zIndex:10,padding:4,opacity:isDragged?0.25:1,transition:isDragged?"opacity 0.12s":"opacity 0.12s, left 0.0s, top 0.0s"}}>
            {player?(
              <>
                <div style={{width:54,height:54,borderRadius:"50%",overflow:"hidden",border:isHL?"3px solid #facc15":"2.5px solid #34d399",boxShadow:isHL?"0 0 22px rgba(250,204,21,0.9)":"0 0 16px rgba(52,211,153,0.6)",transition:"border 0.12s,box-shadow 0.12s",flexShrink:0}}>
                  <div style={{position:"relative"}}>
                    <PlayerAvatar player={player} size={54} team={team} style={player?.status&&player.status!=="active"?{opacity:0.65}:{}}/>
                    {player?.status&&player.status!=="active"&&(
                      <div style={{position:"absolute",top:-3,right:-3,lineHeight:1}} title={getPlayerStatus(player).label}><Icon id={getPlayerStatus(player).icon} size={14} style={{color:getPlayerStatus(player).color}}/></div>
                    )}
                  </div>
                </div>
                <div style={{background:"rgba(0,0,0,0.88)",borderRadius:6,padding:"2px 7px",color:"#fff",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:800,whiteSpace:"nowrap",maxWidth:72,overflow:"hidden",textOverflow:"ellipsis"}}>
                  {player.name.split(" ")[0].toUpperCase()}
                </div>
              </>
            ):(
              // Empty slots only shown in normal mode
              freeMode ? null : <>
                <div style={{width:48,height:48,borderRadius:"50%",border:isHL?"2.5px solid #facc15":"2px dashed rgba(255,255,255,0.4)",background:isHL?"rgba(250,204,21,0.18)":"rgba(0,0,0,0.3)",display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.12s",boxShadow:isHL?"0 0 16px rgba(250,204,21,0.6)":"none"}}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.65)" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                </div>
                <div style={{background:"rgba(0,0,0,0.65)",borderRadius:5,padding:"2px 6px",color:"rgba(255,255,255,0.8)",fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:800}}>{slot.label}</div>
              </>
            )}
          </div>
        );
      })}
      {ghost&&(
        <div style={{position:"absolute",left:ghost.x,top:ghost.y,transform:"translate(-50%,-50%)",pointerEvents:"none",zIndex:100,display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
          <div style={{width:62,height:62,borderRadius:"50%",overflow:"hidden",border:"3px solid #facc15",boxShadow:"0 0 28px rgba(250,204,21,0.95)",opacity:0.97,transform:"scale(1.12)"}}>
            <PlayerAvatar player={ghost.player} size={62} team={team}/>
          </div>
          {ghost.player&&<div style={{background:"rgba(0,0,0,0.92)",borderRadius:6,padding:"2px 8px",color:"#facc15",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:800,whiteSpace:"nowrap"}}>{ghost.player.name.split(" ")[0].toUpperCase()}</div>}
        </div>
      )}
    </div>
  );
}

// ─── Export Modal ─────────────────────────────────────────────────────────────
// Export theme options — shown as a horizontal carousel (3 visible at a time)
const THEME_OPTIONS = [
  {key:"modern",    label:"Moderno",       desc:"Verde escuro"},
  {key:"clean",     label:"Simples",       desc:"Fundo claro"},
  {key:"retro",     label:"Retrô",         desc:"Vintage"},
  {key:"neon",      label:"Neon",          desc:"E-sports"},
  {key:"mono",      label:"Mono",          desc:"P&B"},
  {key:"custom",    label:"Personalizado", desc:"Suas cores"},
];

function ExportModal({slots,lineup,players,teamName,formation,team,coach,benchPlayerIds,onClose,isPremium}) {
  const canvasRef=useRef();
  const [generating,setGenerating]=useState(false);
  const [imgUrl,setImgUrl]=useState(null);
  const [exportError,setExportError]=useState(false);
  const [theme,setTheme]=useState("modern"); // "modern" | "clean" | "retro" | "neon" | "mono"
  const [logo,setLogo]=useState("");
  const logoRef=useRef("");
  const [logoPosition,setLogoPosition]=useState("br"); // "tl" | "tr" | "bl" | "br"
  const logoPositionRef=useRef("br");
  const drewRef=useRef(false);
  const themeCarouselRef=useRef(null);
  const [showWatermarkPanel,setShowWatermarkPanel]=useState(false);
  const [showFullPreview,setShowFullPreview]=useState(false);
  const [showThemeUpsell,setShowThemeUpsell]=useState(false);
  const [showWatermarkUpsell,setShowWatermarkUpsell]=useState(false);

  // Bench players, sorted by jersey number for a predictable export order
  const benchPlayers=useMemo(()=>{
    const idSet=new Set((benchPlayerIds||[]).map(String));
    return (players||[])
      .filter(p=>idSet.has(String(p.id)))
      .sort((a,b)=>(parseInt(a.number)||0)-(parseInt(b.number)||0));
  },[players,benchPlayerIds]);

  // ── Shared: draw the bench ("Banco de Reservas") player chip list ───────────
  // Wraps chips within `maxWidth`, up to `maxRows` rows. If more players don't
  // fit, shows a "+N" indicator chip instead of overflowing the box.
  const drawBenchChips=(ctx,x,y,maxWidth,maxRows,isModern,accent="#34d399")=>{
    if(!benchPlayers.length){
      ctx.fillStyle=isModern?"#4B5563":"#9CA3AF";
      ctx.font=`13px 'DM Sans',sans-serif`;
      ctx.textAlign="left";ctx.textBaseline="middle";
      ctx.fillText("Nenhum jogador no banco",x,y+13);
      return;
    }
    const chipH=28,gap=8,padX=13;
    let cx=x,cy=y,row=0;
    ctx.font=`bold 14px 'DM Sans',sans-serif`;
    ctx.textAlign="left";ctx.textBaseline="middle";
    for(let i=0;i<benchPlayers.length;i++){
      const p=benchPlayers[i];
      const guestIdx=p.isGuest?benchPlayers.filter(x=>x.isGuest).indexOf(p)+1:0;
      const label=p.isGuest?`C${guestIdx} ${p.name.split(" ")[0]}`:`#${p.number} ${p.name.split(" ")[0]}`;
      const tw=ctx.measureText(label).width;
      let chipW=tw+padX*2;
      // If this chip doesn't fit on the current row, wrap to the next
      if(cx+chipW>x+maxWidth&&cx>x){
        row++;cx=x;cy+=chipH+gap;
      }
      // If we've run out of rows, replace this chip with a "+N" indicator
      if(row>=maxRows){
        const remaining=benchPlayers.length-i;
        const moreLabel=`+${remaining}`;
        const mtw=ctx.measureText(moreLabel).width;
        const mChipW=mtw+padX*2;
        ctx.fillStyle=isModern?"rgba(255,255,255,0.06)":"rgba(22,101,52,0.08)";
        ctx.strokeStyle=isModern?hexToRgba(accent,0.25):"rgba(22,101,52,0.2)";
        ctx.lineWidth=1;
        ctx.beginPath();ctx.roundRect(cx,cy,mChipW,chipH,chipH/2);ctx.fill();ctx.stroke();
        ctx.fillStyle=isModern?"#9CA3AF":"#166534";
        ctx.fillText(moreLabel,cx+padX,cy+chipH/2+1);
        return;
      }
      ctx.fillStyle=isModern?"rgba(255,255,255,0.06)":"rgba(22,101,52,0.08)";
      ctx.strokeStyle=isModern?hexToRgba(accent,0.25):"rgba(22,101,52,0.2)";
      ctx.lineWidth=1;
      ctx.beginPath();ctx.roundRect(cx,cy,chipW,chipH,chipH/2);ctx.fill();ctx.stroke();
      ctx.fillStyle=isModern?"#e5e7eb":"#166534";
      ctx.fillText(label,cx+padX,cy+chipH/2+1);
      cx+=chipW+gap;
    }
  };

  // ── Shared: pre-load images ──────────────────────────────────────────────
  // Each image load is guarded by a timeout so a single broken/slow URL
  // (e.g. an old, now-inaccessible Storage link) can never hang the whole
  // export — it just falls back to the placeholder avatar/shield for that item.
  const IMAGE_LOAD_TIMEOUT = 6000;
  const loadImages=async()=>{
    const cache={};
    const loadImg=(src)=>{
      if(cache[src])return Promise.resolve(cache[src]);
      return new Promise(resolve=>{
        let settled=false;
        const finish=(val)=>{ if(!settled){ settled=true; cache[src]=val; resolve(val); } };
        const timer=setTimeout(()=>finish(null),IMAGE_LOAD_TIMEOUT);
        const img=new Image();
        // Allow cross-origin data URIs (base64 photos) to draw without tainting the canvas
        img.crossOrigin="anonymous";
        img.onload=()=>{clearTimeout(timer);finish(img);};
        img.onerror=()=>{
          clearTimeout(timer);
          // Retry without crossOrigin for data URIs that reject the attribute
          let settled2=false;
          const finish2=(val)=>{ if(!settled2){ settled2=true; finish(val); } };
          const timer2=setTimeout(()=>finish2(null),IMAGE_LOAD_TIMEOUT);
          const img2=new Image();
          img2.onload=()=>{clearTimeout(timer2);finish2(img2);};
          img2.onerror=()=>{clearTimeout(timer2);finish2(null);};
          img2.src=src;
        };
        img.src=src;
      });
    };
    await Promise.all(slots.map(async slot=>{
      const entry=lineup.find(l=>l.slotId===slot.id);
      const player=entry?players.find(p=>p.id===entry.playerId):null;
      if(player?.photo) await loadImg(player.photo);
    }));
    // Also preload team shield photo if present
    if(team?.photo) await loadImg(team.photo);
    // Preload kit uniform images if any kit has teamKitIcon set
    for(const kit of (team?.kits||[])){
      if(kit.teamKitIcon?.file){
        const f=kit.teamKitIcon.folder==="europa"?"icones_uniformes_europa":kit.teamKitIcon.folder==="selecoes"?"icones_uniformes_selecoes":"icones_uniformes_brasil";
        await loadImg(`/assets/images/icones_uniformes/${f}/${kit.teamKitIcon.file}`);
      }
    }
    // Also preload the user's custom watermark/logo, if set
    if(logoRef.current) await loadImg(logoRef.current);
    return cache;
  };

  // ── Shared: draw the user's custom logo/watermark in a corner ───────────
  const drawWatermarkLogo=(ctx,imageCache,FX,FY,FW,FH)=>{
    const logoVal=logoRef.current;
    if(!logoVal)return;
    const img=imageCache[logoVal];
    if(!img)return;
    const size=42,pad=10,r=9;
    let x,y;
    switch(logoPositionRef.current){
      case "tl": x=FX+pad;y=FY+pad;break;
      case "tr": x=FX+FW-pad-size;y=FY+pad;break;
      case "bl": x=FX+pad;y=FY+FH-pad-size;break;
      default:   x=FX+FW-pad-size;y=FY+FH-pad-size;
    }
    ctx.save();
    ctx.fillStyle="rgba(255,255,255,0.92)";
    ctx.shadowColor="rgba(0,0,0,0.35)";ctx.shadowBlur=8;ctx.shadowOffsetY=2;
    ctx.beginPath();ctx.roundRect(x,y,size,size,r);ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath();ctx.roundRect(x,y,size,size,r);ctx.clip();
    const iw=img.naturalWidth||img.width||1,ih=img.naturalHeight||img.height||1;
    // Contain (not cover) so the whole logo stays visible, with small padding
    const inner=size-8;
    const scale=Math.min(inner/iw,inner/ih);
    const sw=iw*scale,sh=ih*scale;
    ctx.drawImage(img,x+(size-sw)/2,y+(size-sh)/2,sw,sh);
    ctx.restore();
  };

  // ── Shared: draw team shield in header ───────────────────────────────────
  const drawShieldInHeader=(ctx,imageCache,x,y,size,isModern,accent="#34d399")=>{
    const [c1s,c2s]=SHIELD_COLORS[(team?.colorIdx||0)%SHIELD_COLORS.length];
    const shape=SHIELD_SHAPES.find(s=>s.id===team?.shieldShapeId);
    const r=size*0.18;
    const cachedShield=team?.photo?imageCache[team.photo]:null;

    // Transparent PNG mode: draw image as-is without shape/background
    if(team?.shieldTransparent&&cachedShield){
      ctx.save();
      ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";
      const iw=cachedShield.naturalWidth||cachedShield.width||1;
      const ih=cachedShield.naturalHeight||cachedShield.height||1;
      const scale=Math.min(size/iw,size/ih);
      const sw=iw*scale,sh=ih*scale;
      ctx.drawImage(cachedShield,x+(size-sw)/2,y+(size-sh)/2,sw,sh);
      ctx.restore();
      return;
    }

    if(shape){
      // Custom SVG shield shape — drawn in a 0..100 local space, scaled to `size`
      const sc=size/100;
      const path=new Path2D(shape.path);
      ctx.save();
      ctx.translate(x,y);ctx.scale(sc,sc);
      ctx.clip(path);
      if(cachedShield){
        ctx.fillStyle="#fff";ctx.fillRect(0,0,100,100);
        ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";
        const iw=cachedShield.naturalWidth||cachedShield.width||1;
        const ih=cachedShield.naturalHeight||cachedShield.height||1;
        const scale=Math.max(100/iw,100/ih);
        const sw=iw*scale,sh=ih*scale;
        ctx.drawImage(cachedShield,(100-sw)/2,(100-sh)/2,sw,sh);
      } else {
        const sg=ctx.createLinearGradient(0,0,100,100);
        sg.addColorStop(0,c1s);sg.addColorStop(1,c2s);
        ctx.fillStyle=sg;ctx.fillRect(0,0,100,100);
        ctx.font=`52px serif`;
        ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillStyle="#fff";
        ctx.fillText(team?.shieldEmoji||"🛡️",50,54);
      }
      ctx.restore();
      // Border glow (un-scaled stroke width/blur)
      ctx.save();
      ctx.translate(x,y);ctx.scale(sc,sc);
      ctx.strokeStyle=isModern?hexToRgba(accent,0.5):"rgba(22,101,52,0.3)";
      ctx.lineWidth=(isModern?2:2.5)/sc;
      if(isModern){ctx.shadowColor=hexToRgba(accent,0.4);ctx.shadowBlur=8/sc;}
      ctx.stroke(path);
      ctx.restore();
      return;
    }

    // Default: rounded-square (legacy style)
    ctx.save();
    ctx.beginPath();ctx.roundRect(x,y,size,size,r);ctx.clip();
    if(cachedShield){
      ctx.fillStyle="#fff";ctx.fillRect(x,y,size,size);
      ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";
      const iw=cachedShield.naturalWidth||cachedShield.width||1;
      const ih=cachedShield.naturalHeight||cachedShield.height||1;
      const scale=Math.max(size/iw,size/ih);
      const sw=iw*scale,sh=ih*scale;
      ctx.drawImage(cachedShield,x+(size-sw)/2,y+(size-sh)/2,sw,sh);
    } else {
      const sg=ctx.createLinearGradient(x,y,x+size,y+size);
      sg.addColorStop(0,c1s);sg.addColorStop(1,c2s);
      ctx.fillStyle=sg;ctx.fillRect(x,y,size,size);
      // Emoji shield
      ctx.restore();ctx.save();
      ctx.font=`${size*0.52}px serif`;
      ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillStyle="#fff";
      ctx.fillText(team?.shieldEmoji||"🛡️",x+size/2,y+size/2+size*0.04);
    }
    ctx.restore();
    // Border glow
    ctx.save();
    ctx.strokeStyle=isModern?hexToRgba(accent,0.5):"rgba(22,101,52,0.3)";
    ctx.lineWidth=isModern?2:2.5;
    if(isModern){ctx.shadowColor=hexToRgba(accent,0.4);ctx.shadowBlur=8;}
    ctx.beginPath();ctx.roundRect(x,y,size,size,r);ctx.stroke();
    ctx.restore();
  };

  // ── Shared: draw one player avatar circle ────────────────────────────────
  // DPR=2 canvas: all coordinates passed in are LOGICAL (pre-scale) pixels.
  // ctx has already been scaled by DPR before this is called.
  const showCircleRef=useRef(true);
  const [showCircle,setShowCircle]=useState(true);
  const circleColorRef=useRef(null); // null = usa cor do tema (accent)
  const [circleColor,setCircleColor]=useState(null);

  const customAccentRef=useRef("#34d399");
  const [customAccent,setCustomAccent]=useState("#34d399");
  const customBgRef=useRef("#060e0a");
  const [customBg,setCustomBg]=useState("#060e0a");
  const customFieldRef=useRef("#1c7a40");
  const [customField,setCustomField]=useState("#1c7a40");

  const darkenHex=(hex,f)=>{
    const c=hex.replace("#","");
    const r=parseInt(c.slice(0,2),16),g=parseInt(c.slice(2,4),16),b=parseInt(c.slice(4,6),16);
    return `#${Math.round(r*f).toString(16).padStart(2,"0")}${Math.round(g*f).toString(16).padStart(2,"0")}${Math.round(b*f).toString(16).padStart(2,"0")}`;
  };

  const drawPlayerCircle=(ctx,slot,imageCache,R,isModern,FX,FY,FW,accent="#34d399")=>{
    const entry=lineup.find(l=>l.slotId===slot.id);
    const player=entry?players.find(p=>p.id===entry.playerId):null;
    const FH=FW/0.65;
    const cx=FX+(slot.x/100)*FW;
    const cy=FY+(slot.y/100)*FH;
    const cachedImg=player?.photo?imageCache[player.photo]:null;
    const cClr=circleColorRef.current||accent; // cor efetiva do círculo

    if(showCircleRef.current){
      if(isModern){
        // Outer glow halo
        ctx.save();
        const halo=ctx.createRadialGradient(cx,cy,R*0.8,cx,cy,R*1.9);
        halo.addColorStop(0,player?hexToRgba(cClr,0.22):"rgba(255,255,255,0.05)");
        halo.addColorStop(1,"rgba(0,0,0,0)");
        ctx.fillStyle=halo;
        ctx.beginPath();ctx.arc(cx,cy,R*2,0,Math.PI*2);ctx.fill();
        ctx.restore();
        // Glowing ring
        ctx.save();
        ctx.strokeStyle=player?cClr:"rgba(255,255,255,0.25)";
        ctx.lineWidth=player?3:1.5;
        ctx.shadowColor=player?hexToRgba(cClr,0.7):"transparent";
        ctx.shadowBlur=player?10:0;
        ctx.beginPath();ctx.arc(cx,cy,R+2,0,Math.PI*2);ctx.stroke();
        ctx.restore();
      } else {
        // Clean: subtle shadow behind circle
        ctx.save();
        ctx.shadowColor="rgba(0,0,0,0.25)";ctx.shadowBlur=10;ctx.shadowOffsetY=3;
        ctx.fillStyle=player?getPlayerJersey(team,player).primary:"#d1d5db";
        ctx.beginPath();ctx.arc(cx,cy,R+3,0,Math.PI*2);ctx.fill();
        ctx.restore();
        // White border
        ctx.save();
        ctx.strokeStyle="#ffffff";ctx.lineWidth=3;
        ctx.beginPath();ctx.arc(cx,cy,R+2,0,Math.PI*2);ctx.stroke();
        ctx.restore();
      }
    }

    // Avatar fill (clipped circle)
    ctx.save();
    ctx.beginPath();ctx.arc(cx,cy,R,0,Math.PI*2);ctx.clip();
    if(cachedImg){
      ctx.fillStyle="#fff";ctx.fillRect(cx-R,cy-R,R*2,R*2);
      // High-quality image rendering — critical for sharp player photos
      ctx.imageSmoothingEnabled=true;
      ctx.imageSmoothingQuality="high";
      const iw=cachedImg.naturalWidth||cachedImg.width||1;
      const ih=cachedImg.naturalHeight||cachedImg.height||1;
      // Cover crop: scale so the shortest side fills the circle diameter
      const scale=Math.max((R*2)/iw,(R*2)/ih);
      const sw=iw*scale,sh=ih*scale;
      ctx.drawImage(cachedImg,cx-(sw/2),cy-(sh/2),sw,sh);
    } else if(player){
      const playerKit=getPlayerKit(team,player);
      const tki=playerKit?.teamKitIcon;
      if(tki?.file){
        const f=tki.folder==="europa"?"icones_uniformes_europa":tki.folder==="selecoes"?"icones_uniformes_selecoes":"icones_uniformes_brasil";
        const kitImg=imageCache[`/assets/images/icones_uniformes/${f}/${tki.file}`];
        if(kitImg){
          ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";
          const kw=kitImg.naturalWidth||kitImg.width||1;
          const kh=kitImg.naturalHeight||kitImg.height||1;
          const scale=Math.min((R*2.5)/kw,(R*2.5)/kh);
          const sw=kw*scale,sh=kh*scale;
          ctx.drawImage(kitImg,cx-(sw/2),cy-(sh/2),sw,sh);
          ctx.restore();
          // Shield overlay (outside circle clip)
          if(tki.shield){
            const sc=tki.shieldScale||1;
            const sSize=Math.round(R*0.76*sc);
            const sx=cx-R+(tki.shieldX??50)/100*(R*2)-sSize/2;
            const sy=cy-R+(tki.shieldY??30)/100*(R*2)-sSize/2;
            drawShieldInHeader(ctx,imageCache,sx,sy,sSize,isModern,accent);
          }
          // Draw captain badge and name tag before exiting kit path
          if(player&&team?.captainPlayerId&&String(team.captainPlayerId)===String(player.id)){
            const br=R*0.32;
            const bx=cx+R*0.74,by=cy-R*0.74;
            ctx.save();
            ctx.fillStyle="#F59E0B";
            ctx.strokeStyle=isModern?"#050c0a":"#ffffff";
            ctx.lineWidth=2;
            ctx.beginPath();ctx.arc(bx,by,br,0,Math.PI*2);ctx.fill();ctx.stroke();
            ctx.fillStyle="#1a1a0a";
            ctx.font=`bold ${br*1.25}px 'Bebas Neue',sans-serif`;
            ctx.textAlign="center";ctx.textBaseline="middle";
            ctx.fillText("C",bx,by+br*0.08);
            ctx.restore();
          }
          ctx.textAlign="center";ctx.textBaseline="top";
          const kitTag=player.name.split(" ")[0].toUpperCase();
          ctx.font=`bold 18px 'Bebas Neue',sans-serif`;
          if(isModern&&ctx.letterSpacing!==undefined) ctx.letterSpacing="1px";
          const ktw=ctx.measureText(kitTag).width;
          if(isModern){
            ctx.fillStyle="rgba(3,12,8,0.88)";
            ctx.strokeStyle=hexToRgba(accent,0.35);ctx.lineWidth=1;
            ctx.beginPath();ctx.roundRect(cx-ktw/2-9,cy+R+4,ktw+18,26,6);ctx.fill();ctx.stroke();
            ctx.fillStyle="#ffffff";
          } else {
            ctx.fillStyle="rgba(26,47,36,0.88)";
            ctx.beginPath();ctx.roundRect(cx-ktw/2-8,cy+R+4,ktw+16,26,5);ctx.fill();
            ctx.fillStyle="#ffffff";
          }
          ctx.fillText(kitTag,cx,cy+R+7);
          if(isModern&&ctx.letterSpacing!==undefined) ctx.letterSpacing="0px";
          return;
        }
      }
      const jersey=getPlayerJersey(team,player);
      drawJerseyFill(ctx,cx,cy,R,jersey);
      if(isModern){
        // Subtle gradient sheen
        const sheen=ctx.createRadialGradient(cx-R*0.3,cy-R*0.3,R*0.05,cx,cy,R);
        sheen.addColorStop(0,"rgba(255,255,255,0.22)");sheen.addColorStop(1,"rgba(0,0,0,0.15)");
        ctx.fillStyle=sheen;ctx.fillRect(cx-R,cy-R,R*2,R*2);
      }
      ctx.save();
      ctx.shadowColor="rgba(0,0,0,0.45)";ctx.shadowBlur=4;
      ctx.fillStyle="#fff";
      ctx.font=`bold ${R*0.75}px '${getJerseyFontName(jersey)}',sans-serif`;
      ctx.textAlign="center";ctx.textBaseline="middle";
      ctx.fillText(player.isGuest?"G":player.number||"?",cx,cy+1);
      ctx.restore();
    } else {
      ctx.fillStyle=isModern?"rgba(0,0,0,0.4)":"rgba(209,213,219,0.7)";
      ctx.fillRect(cx-R,cy-R,R*2,R*2);
      // Plus icon for empty slot
      ctx.strokeStyle=isModern?"rgba(255,255,255,0.3)":"rgba(107,114,128,0.6)";
      ctx.lineWidth=1.5;
      ctx.beginPath();ctx.moveTo(cx-6,cy);ctx.lineTo(cx+6,cy);ctx.stroke();
      ctx.beginPath();ctx.moveTo(cx,cy-6);ctx.lineTo(cx,cy+6);ctx.stroke();
    }
    ctx.restore();

    // Captain badge — small "C" circle on top-right of the avatar
    if(player&&team?.captainPlayerId&&String(team.captainPlayerId)===String(player.id)){
      const br=R*0.32;
      const bx=cx+R*0.74,by=cy-R*0.74;
      ctx.save();
      ctx.fillStyle="#F59E0B";
      ctx.strokeStyle=isModern?"#050c0a":"#ffffff";
      ctx.lineWidth=2;
      ctx.beginPath();ctx.arc(bx,by,br,0,Math.PI*2);ctx.fill();ctx.stroke();
      ctx.fillStyle="#1a1a0a";
      ctx.font=`bold ${br*1.25}px 'Bebas Neue',sans-serif`;
      ctx.textAlign="center";ctx.textBaseline="middle";
      ctx.fillText("C",bx,by+br*0.08);
      ctx.restore();
    }

    // Name tag below
    ctx.textAlign="center";ctx.textBaseline="top";
    if(player){
      const tag=player.name.split(" ")[0].toUpperCase();
      ctx.font=`bold 18px 'Bebas Neue',sans-serif`;
      if(isModern&&ctx.letterSpacing!==undefined) ctx.letterSpacing="1px";
      const tw=ctx.measureText(tag).width;
      if(isModern){
        ctx.fillStyle="rgba(3,12,8,0.88)";
        ctx.strokeStyle=hexToRgba(accent,0.35);ctx.lineWidth=1;
        ctx.beginPath();ctx.roundRect(cx-tw/2-9,cy+R+4,tw+18,26,6);ctx.fill();ctx.stroke();
        ctx.fillStyle="#ffffff";
      } else {
        ctx.fillStyle="rgba(26,47,36,0.88)";
        ctx.beginPath();ctx.roundRect(cx-tw/2-8,cy+R+4,tw+16,26,5);ctx.fill();
        ctx.fillStyle="#ffffff";
      }
      ctx.fillText(tag,cx,cy+R+7);
      if(isModern&&ctx.letterSpacing!==undefined) ctx.letterSpacing="0px";
    } else {
      const lbl=slot.label;
      ctx.font="bold 11px sans-serif";
      const tw=ctx.measureText(lbl).width;
      ctx.fillStyle=isModern?"rgba(0,0,0,0.6)":"rgba(0,0,0,0.25)";
      ctx.beginPath();ctx.roundRect(cx-tw/2-5,cy+R+4,tw+10,17,4);ctx.fill();
      ctx.fillStyle=isModern?"rgba(255,255,255,0.65)":"rgba(107,114,128,0.9)";
      ctx.fillText(lbl,cx,cy+R+6);
    }
  };

  // ── Generic "card" layout shared by Moderno, Retrô, Neon and Mono ────────
  // Each theme is just a different color/style configuration over the same
  // structure: header card (shield, name, técnico, formação), field, players,
  // bench card, watermark.
  const drawThemedCard=async(canvas,imageCache,cfg)=>{
    const W=540,H=1072;
    const DPR=2;
    canvas.width=W*DPR;canvas.height=H*DPR;
    canvas.style.width=W+"px";canvas.style.height=H+"px";
    const ctx=canvas.getContext("2d");
    ctx.scale(DPR,DPR);
    ctx.imageSmoothingEnabled=true;
    ctx.imageSmoothingQuality="high";

    // Background
    const bg=ctx.createLinearGradient(0,0,W,H);
    cfg.bg.forEach(([stop,color])=>bg.addColorStop(stop,color));
    ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);

    // Subtle radial glow
    const glow=ctx.createRadialGradient(W/2,H*0.52,0,W/2,H*0.52,W*0.58);
    glow.addColorStop(0,cfg.glow);glow.addColorStop(1,"rgba(0,0,0,0)");
    ctx.fillStyle=glow;ctx.fillRect(0,0,W,H);

    // Top accent bar (gradient line)
    const topBar=ctx.createLinearGradient(0,0,W,0);
    topBar.addColorStop(0,"transparent");topBar.addColorStop(0.2,cfg.topBar[0]);
    topBar.addColorStop(0.8,cfg.topBar[1]);topBar.addColorStop(1,"transparent");
    ctx.fillStyle=topBar;ctx.fillRect(0,0,W,3);

    // Header card
    ctx.save();
    ctx.fillStyle=cfg.cardBg;
    ctx.strokeStyle=cfg.cardBorder;ctx.lineWidth=1;
    ctx.beginPath();ctx.roundRect(14,12,W-28,112,14);ctx.fill();ctx.stroke();
    ctx.restore();

    // Shield — real team photo/emoji/color (tamanho aumentado)
    drawShieldInHeader(ctx,imageCache,20,16,80,true,cfg.accent);

    // Team name
    ctx.fillStyle=cfg.textPrimary;
    ctx.font="bold 30px 'Bebas Neue',sans-serif";
    ctx.textAlign="left";ctx.textBaseline="middle";
    ctx.fillText(teamName.toUpperCase(),108,40);

    // Sub info
    const escalados=lineup.filter(l=>l.playerId).length;
    ctx.fillStyle=cfg.textSecondary;
    ctx.font="bold 11px 'DM Sans',sans-serif";
    ctx.textAlign="left";ctx.textBaseline="middle";
    ctx.fillText(`${players.length} jogadores  ·  ${escalados}/${slots.length} escalados`,108,64);

    // Coach (técnico)
    if(coach&&coach.trim()){
      ctx.fillStyle=cfg.accent;
      ctx.font="bold 11px 'DM Sans',sans-serif";
      ctx.textAlign="left";ctx.textBaseline="middle";
      ctx.fillText(`TÉCNICO: ${coach.trim().toUpperCase()}`,108,84);
    }

    // Formation — no pill background, large & bold for emphasis
    ctx.fillStyle=cfg.textSecondary;
    ctx.font="bold 9px 'DM Sans',sans-serif";
    ctx.textAlign="right";ctx.textBaseline="alphabetic";
    ctx.fillText("FORMAÇÃO",W-22,36);
    ctx.fillStyle=cfg.accent;
    ctx.font="bold 40px 'Bebas Neue',sans-serif";
    ctx.textAlign="right";ctx.textBaseline="middle";
    if(ctx.letterSpacing!==undefined) ctx.letterSpacing="1px";
    ctx.fillText(formation,W-22,68);
    if(ctx.letterSpacing!==undefined) ctx.letterSpacing="0px";

    // Field
    const FX=16,FY=132,FW=W-32,FH=FW/0.65;
    ctx.save();
    ctx.beginPath();ctx.roundRect(FX,FY,FW,FH,14);ctx.clip();
    for(let i=0;i<8;i++){
      ctx.fillStyle=i%2===0?cfg.fieldStripes[0]:cfg.fieldStripes[1];
      ctx.fillRect(FX,FY+i*(FH/8),FW,FH/8);
    }
    ctx.strokeStyle=cfg.fieldLine;ctx.lineWidth=1.4;
    ctx.strokeRect(FX+7,FY+7,FW-14,FH-14);
    ctx.beginPath();ctx.moveTo(FX+7,FY+FH/2);ctx.lineTo(FX+FW-7,FY+FH/2);ctx.stroke();
    ctx.beginPath();ctx.arc(FX+FW/2,FY+FH/2,FW*0.09,0,Math.PI*2);ctx.stroke();
    ctx.beginPath();ctx.arc(FX+FW/2,FY+FH/2,0.9,0,Math.PI*2);ctx.fillStyle=cfg.fieldLine;ctx.fill();
    // Penalty areas
    ctx.strokeStyle=cfg.fieldPenalty;ctx.lineWidth=1;
    ctx.strokeRect(FX+FW*0.22,FY+7,FW*0.56,FH*0.14);
    ctx.strokeRect(FX+FW*0.22,FY+FH-7-FH*0.14,FW*0.56,FH*0.14);
    ctx.restore();

    // Field border glow
    ctx.save();
    ctx.strokeStyle=cfg.fieldGlow;ctx.lineWidth=2;
    ctx.beginPath();ctx.roundRect(FX,FY,FW,FH,14);ctx.stroke();
    ctx.restore();

    // Players — R=38 (logical pixels; ctx is pre-scaled by DPR)
    const R=38;
    if(cfg.grayscalePlayers){
      ctx.save();
      try{ ctx.filter="grayscale(1)"; }catch(e){}
      for(const slot of slots) drawPlayerCircle(ctx,slot,imageCache,R,true,FX,FY,FW,cfg.accent);
      ctx.restore();
    } else {
      for(const slot of slots) drawPlayerCircle(ctx,slot,imageCache,R,true,FX,FY,FW,cfg.accent);
    }

    // Bottom card — Banco de Reservas
    const BY=FY+FH+16;
    ctx.fillStyle=cfg.benchBg;
    ctx.strokeStyle=cfg.benchBorder;ctx.lineWidth=1;
    ctx.beginPath();ctx.roundRect(14,BY,W-28,112,12);ctx.fill();ctx.stroke();
    ctx.fillStyle=cfg.accent;ctx.font="bold 13px 'DM Sans',sans-serif";
    ctx.textAlign="left";ctx.textBaseline="alphabetic";
    if(ctx.letterSpacing!==undefined) ctx.letterSpacing="1px";
    ctx.fillText("BANCO DE RESERVAS",28,BY+26);
    if(ctx.letterSpacing!==undefined) ctx.letterSpacing="0px";
    drawBenchChips(ctx,28,BY+40,W-56,2,true,cfg.accent);

    // Watermark
    ctx.fillStyle=cfg.watermark;ctx.font="bold 13px 'DM Sans',sans-serif";
    ctx.textAlign="center";ctx.textBaseline="bottom";
    ctx.fillText("⚽ ESCALAÇÃO FC",W/2,H-8);

    // User's custom logo/watermark (if set)
    drawWatermarkLogo(ctx,imageCache,FX,FY,FW,FH);

    return canvas.toDataURL("image/png");
  };

  // ── Theme A: Moderno (verde escuro, padrão) ──────────────────────────────
  const MODERN_CFG={
    bg:[[0,"#060e0a"],[0.45,"#091509"],[1,"#060c0f"]],
    glow:"rgba(52,211,153,0.07)",
    topBar:["#34d399","#6ee7b7"],
    cardBg:"rgba(255,255,255,0.035)", cardBorder:"rgba(52,211,153,0.18)",
    accent:"#34d399",
    textPrimary:"#ffffff", textSecondary:"#4B5563",
    fieldStripes:["#1c7a40","#18703a"], fieldLine:"rgba(255,255,255,0.65)", fieldPenalty:"rgba(255,255,255,0.55)",
    fieldGlow:"rgba(52,211,153,0.3)",
    benchBg:"rgba(255,255,255,0.035)", benchBorder:"rgba(255,255,255,0.07)",
    watermark:"rgba(52,211,153,0.25)",
    grayscalePlayers:false,
  };
  const drawModern=(canvas,imageCache)=>drawThemedCard(canvas,imageCache,MODERN_CFG);

  // ── Theme C: Retrô (tons sépia/dourado, estilo vintage) ──────────────────
  const RETRO_CFG={
    bg:[[0,"#2a1c10"],[0.45,"#3a2613"],[1,"#1f140a"]],
    glow:"rgba(245,158,11,0.10)",
    topBar:["#f59e0b","#fde68a"],
    cardBg:"rgba(255,237,213,0.06)", cardBorder:"rgba(245,158,11,0.25)",
    accent:"#f59e0b",
    textPrimary:"#fef3c7", textSecondary:"#a8907a",
    fieldStripes:["#5a7c3a","#4d6b32"], fieldLine:"rgba(254,243,199,0.55)", fieldPenalty:"rgba(254,243,199,0.45)",
    fieldGlow:"rgba(245,158,11,0.3)",
    benchBg:"rgba(255,237,213,0.05)", benchBorder:"rgba(245,158,11,0.18)",
    watermark:"rgba(245,158,11,0.3)",
    grayscalePlayers:false,
  };
  const drawRetro=(canvas,imageCache)=>drawThemedCard(canvas,imageCache,RETRO_CFG);

  // ── Theme D: Neon / E-sports (paleta ciano/magenta sobre fundo escuro) ───
  const NEON_CFG={
    bg:[[0,"#0a0118"],[0.5,"#13042b"],[1,"#05010d"]],
    glow:"rgba(34,211,238,0.12)",
    topBar:["#22d3ee","#ec4899"],
    cardBg:"rgba(34,211,238,0.05)", cardBorder:"rgba(34,211,238,0.3)",
    accent:"#22d3ee",
    textPrimary:"#f0fdff", textSecondary:"#7dd3fc",
    fieldStripes:["#1a0a2e","#150823"], fieldLine:"rgba(34,211,238,0.5)", fieldPenalty:"rgba(236,72,153,0.4)",
    fieldGlow:"rgba(236,72,153,0.35)",
    benchBg:"rgba(34,211,238,0.04)", benchBorder:"rgba(34,211,238,0.2)",
    watermark:"rgba(34,211,238,0.35)",
    grayscalePlayers:false,
  };
  const drawNeon=(canvas,imageCache)=>drawThemedCard(canvas,imageCache,NEON_CFG);

  // ── Theme E: Mono (preto e branco, minimalista) ──────────────────────────
  const MONO_CFG={
    bg:[[0,"#1a1a1a"],[0.5,"#0f0f0f"],[1,"#000000"]],
    glow:"rgba(255,255,255,0.06)",
    topBar:["#e5e7eb","#9CA3AF"],
    cardBg:"rgba(255,255,255,0.04)", cardBorder:"rgba(255,255,255,0.15)",
    accent:"#e5e7eb",
    textPrimary:"#ffffff", textSecondary:"#9CA3AF",
    fieldStripes:["#3a3a3a","#2e2e2e"], fieldLine:"rgba(255,255,255,0.5)", fieldPenalty:"rgba(255,255,255,0.4)",
    fieldGlow:"rgba(255,255,255,0.2)",
    benchBg:"rgba(255,255,255,0.03)", benchBorder:"rgba(255,255,255,0.1)",
    watermark:"rgba(255,255,255,0.25)",
    grayscalePlayers:true,
  };
  const drawMono=(canvas,imageCache)=>drawThemedCard(canvas,imageCache,MONO_CFG);

  // ── Theme F: Personalizado (cores livres do usuário) ─────────────────────
  const drawCustom=(canvas,imageCache)=>{
    const acc=customAccentRef.current||"#34d399";
    const bg=customBgRef.current||"#060e0a";
    const fld=customFieldRef.current||"#1c7a40";
    const fldDark=darkenHex(fld,0.88);
    const CUSTOM_CFG={
      bg:[[0,bg],[0.45,bg],[1,darkenHex(bg,0.85)]],
      glow:hexToRgba(acc,0.08),
      topBar:[acc,hexToRgba(acc,0.6)],
      cardBg:"rgba(255,255,255,0.04)", cardBorder:hexToRgba(acc,0.22),
      accent:acc,
      textPrimary:"#ffffff", textSecondary:"rgba(255,255,255,0.45)",
      fieldStripes:[fld,fldDark], fieldLine:"rgba(255,255,255,0.65)", fieldPenalty:"rgba(255,255,255,0.5)",
      fieldGlow:hexToRgba(acc,0.3),
      benchBg:"rgba(255,255,255,0.035)", benchBorder:"rgba(255,255,255,0.07)",
      watermark:hexToRgba(acc,0.25),
      grayscalePlayers:false,
    };
    return drawThemedCard(canvas,imageCache,CUSTOM_CFG);
  };

  // ── Theme B: Clean / Light ───────────────────────────────────────────────
  const drawClean=async(canvas,imageCache)=>{
    const W=540,H=1120;
    // Render at 2× for crisp output on all screens (retina-quality export)
    const DPR=2;
    canvas.width=W*DPR;canvas.height=H*DPR;
    canvas.style.width=W+"px";canvas.style.height=H+"px";
    const ctx=canvas.getContext("2d");
    ctx.scale(DPR,DPR);
    ctx.imageSmoothingEnabled=true;
    ctx.imageSmoothingQuality="high";

    // White background with very subtle texture
    ctx.fillStyle="#f5f7f5";ctx.fillRect(0,0,W,H);
    // Faint diagonal pattern
    ctx.save();ctx.strokeStyle="rgba(22,101,52,0.04)";ctx.lineWidth=1;
    for(let i=-H;i<W+H;i+=18){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i+H,H);ctx.stroke();}
    ctx.restore();

    // Top solid accent bar
    ctx.fillStyle="#166534";ctx.fillRect(0,0,W,5);

    // Shield — real team photo/emoji/color (left side, tamanho aumentado)
    drawShieldInHeader(ctx,imageCache,14,10,80,false);

    // Header row — name and info offset to the right of the shield
    ctx.fillStyle="#0f1f16";
    ctx.font="bold 32px 'Bebas Neue',sans-serif";
    ctx.textAlign="left";ctx.textBaseline="top";
    ctx.fillText(teamName.toUpperCase(),102,14);

    // Formation — no badge background, large & bold for emphasis
    ctx.fillStyle="#9CA3AF";
    ctx.font="bold 9px 'DM Sans',sans-serif";
    ctx.textAlign="left";ctx.textBaseline="alphabetic";
    ctx.fillText("FORMAÇÃO",102,56);
    ctx.fillStyle="#166534";
    ctx.font="bold 34px 'Bebas Neue',sans-serif";
    ctx.textAlign="left";ctx.textBaseline="middle";
    if(ctx.letterSpacing!==undefined) ctx.letterSpacing="1px";
    ctx.fillText(formation,102,80);
    if(ctx.letterSpacing!==undefined) ctx.letterSpacing="0px";

    // Player count
    const escalados=lineup.filter(l=>l.playerId).length;
    ctx.fillStyle="#6B7280";ctx.font="12px 'DM Sans',sans-serif";
    ctx.textAlign="left";ctx.textBaseline="middle";
    ctx.fillText(`${players.length} jogadores  ·  ${escalados}/${slots.length} escalados`,102,102);

    // Coach (técnico)
    if(coach&&coach.trim()){
      ctx.fillStyle="#166534";
      ctx.font="bold 12px 'DM Sans',sans-serif";
      ctx.textAlign="left";ctx.textBaseline="middle";
      ctx.fillText(`TÉCNICO: ${coach.trim().toUpperCase()}`,102,120);
    }

    // Thin separator
    ctx.strokeStyle="#e5e7eb";ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(16,146);ctx.lineTo(W-16,146);ctx.stroke();

    // Field
    const FX=16,FY=152,FW=W-32,FH=FW/0.65;
    ctx.save();
    ctx.beginPath();ctx.roundRect(FX,FY,FW,FH,10);ctx.clip();
    for(let i=0;i<8;i++){
      ctx.fillStyle=i%2===0?"#1c7a40":"#18703a";
      ctx.fillRect(FX,FY+i*(FH/8),FW,FH/8);

    }
    ctx.strokeStyle="rgba(255,255,255,0.7)";ctx.lineWidth=1.4;
    ctx.strokeRect(FX+7,FY+7,FW-14,FH-14);
    ctx.beginPath();ctx.moveTo(FX+7,FY+FH/2);ctx.lineTo(FX+FW-7,FY+FH/2);ctx.stroke();
    ctx.beginPath();ctx.arc(FX+FW/2,FY+FH/2,FW*0.09,0,Math.PI*2);ctx.stroke();
    ctx.strokeStyle="rgba(255,255,255,0.5)";ctx.lineWidth=1;
    ctx.strokeRect(FX+FW*0.22,FY+7,FW*0.56,FH*0.14);
    ctx.strokeRect(FX+FW*0.22,FY+FH-7-FH*0.14,FW*0.56,FH*0.14);
    ctx.restore();

    // Field border
    ctx.save();ctx.strokeStyle="#166534";ctx.lineWidth=2.5;
    ctx.beginPath();ctx.roundRect(FX,FY,FW,FH,10);ctx.stroke();
    ctx.restore();

    // Players — R=36 (logical pixels; ctx is pre-scaled by DPR)
    const R=36;
    for(const slot of slots) drawPlayerCircle(ctx,slot,imageCache,R,false,FX,FY,FW);

    // Bottom card — Banco de Reservas
    const LY=FY+FH+16;
    ctx.strokeStyle="#e5e7eb";ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(16,LY);ctx.lineTo(W-16,LY);ctx.stroke();

    ctx.fillStyle="#166534";ctx.font="bold 15px 'DM Sans',sans-serif";
    ctx.textAlign="left";ctx.textBaseline="alphabetic";
    if(ctx.letterSpacing!==undefined) ctx.letterSpacing="0.5px";
    ctx.fillText("BANCO DE RESERVAS",16,LY+26);
    if(ctx.letterSpacing!==undefined) ctx.letterSpacing="0px";
    drawBenchChips(ctx,16,LY+40,W-32,3,false);

    // Watermark
    ctx.fillStyle="rgba(22,101,52,0.2)";ctx.font="11px 'DM Sans',sans-serif";
    ctx.textAlign="center";ctx.textBaseline="bottom";
    ctx.fillText("Escalação FC",W/2,H-8);

    // User's custom logo/watermark (if set)
    drawWatermarkLogo(ctx,imageCache,FX,FY,FW,FH);

    return canvas.toDataURL("image/png");
  };

  // ── Main draw dispatcher ─────────────────────────────────────────────────
  const draw=async(selectedTheme)=>{
    if(!canvasRef.current)return;
    setGenerating(true);setImgUrl(null);setExportError(false);
    try{
      // Overall safety net: even if loadImages/canvas drawing somehow hangs
      // (e.g. unexpected browser quirk), never leave the UI stuck on "Gerando...".
      const url=await withTimeout((async()=>{
        const imageCache=await loadImages();
        const drawFn={modern:drawModern,clean:drawClean,retro:drawRetro,neon:drawNeon,mono:drawMono,custom:drawCustom}[selectedTheme]||drawModern;
        return await drawFn(canvasRef.current,imageCache);
      })(), 20000);
      if(url){ setImgUrl(url); }
      else { setExportError(true); }
    }catch(e){
      console.error("Export draw error:",e);
      setExportError(true);
    }finally{
      setGenerating(false);
    }
  };

  useEffect(()=>{if(!drewRef.current){drewRef.current=true;draw(theme);}},[]);

  const handleThemeChange=(t)=>{
    if(!isPremium&&!FREE_EXPORT_THEMES.includes(t)){ setShowThemeUpsell(true); return; }
    setTheme(t);
    drewRef.current=false;
    draw(t);
    drewRef.current=true;
  };

  const handleLogoChange=(val)=>{
    logoRef.current=val;
    setLogo(val);
    drewRef.current=false;
    draw(theme);
    drewRef.current=true;
  };
  const handleLogoPositionChange=(pos)=>{
    logoPositionRef.current=pos;
    setLogoPosition(pos);
    if(!logoRef.current)return;
    drewRef.current=false;
    draw(theme);
    drewRef.current=true;
  };

  const handleCircleColorChange=(val)=>{
    const c=val||null;
    circleColorRef.current=c;setCircleColor(c);
    drewRef.current=false;draw(theme);drewRef.current=true;
  };
  const handleCustomColor=(ref,setter,val)=>{
    ref.current=val;setter(val);
    drewRef.current=false;draw("custom");drewRef.current=true;
  };

  const download=()=>{const a=document.createElement("a");a.href=imgUrl;a.download=`${teamName.replace(/\s+/g,"_")}_escalacao_${theme}.png`;a.click();};
  const share=async()=>{if(!imgUrl)return;try{const res=await fetch(imgUrl);const blob=await res.blob();const file=new File([blob],`escalacao.png`,{type:"image/png"});if(navigator.canShare&&navigator.canShare({files:[file]})){await navigator.share({files:[file],title:`Escalação ${teamName}`,text:`Formação ${formation}`});}else{download();}}catch(e){download();}};

  return (
    <>
    <div style={{position:"fixed",inset:0,zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.88)",backdropFilter:"blur(8px)",padding:"12px"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#0d1f17",border:"1px solid rgba(255,255,255,0.1)",borderRadius:20,width:"100%",maxWidth:440,maxHeight:"92vh",overflow:"hidden",display:"flex",flexDirection:"column"}}>

        {/* Header */}
        <div style={{padding:"15px 18px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:"1px solid rgba(255,255,255,0.08)",flexShrink:0}}>
          <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:21,color:"#fff",letterSpacing:1}}>Exportar Escalação</span>
          <button onClick={onClose} aria-label="Fechar" style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer",padding:4}}><Ico.Close/></button>
        </div>

        <div style={{overflowY:"auto",padding:"14px 16px 20px",display:"flex",flexDirection:"column",gap:14,alignItems:"center"}}>

          {/* Theme selector — carousel: 3 visible, scroll or arrows for the rest */}
          <div style={{width:"100%",display:"flex",alignItems:"center",gap:6}}>
            <button onClick={()=>themeCarouselRef.current?.scrollBy({left:-(themeCarouselRef.current.clientWidth/3+6),behavior:"smooth"})}
              aria-label="Temas anteriores" style={{flexShrink:0,background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:9,padding:"8px 6px",color:"#9CA3AF",cursor:"pointer",display:"flex",alignItems:"center"}}>
              <Ico.ChevL/>
            </button>
            <div ref={themeCarouselRef} style={{flex:1,display:"flex",gap:8,overflowX:"auto",scrollSnapType:"x mandatory",scrollBehavior:"smooth",paddingBottom:2}}>
              {THEME_OPTIONS.map(opt=>{
                const locked=!isPremium&&!FREE_EXPORT_THEMES.includes(opt.key);
                return (
                <button key={opt.key} onClick={()=>handleThemeChange(opt.key)} style={{
                  flex:"0 0 calc((100% - 16px)/3)",scrollSnapAlign:"start",position:"relative",
                  padding:"10px 6px",borderRadius:12,cursor:"pointer",transition:"all 0.18s",
                  border:theme===opt.key?"1.5px solid #34d399":"1px solid rgba(255,255,255,0.1)",
                  background:theme===opt.key?"rgba(52,211,153,0.1)":"rgba(255,255,255,0.03)",
                  display:"flex",flexDirection:"column",alignItems:"center",gap:3,
                  opacity:locked?0.55:1,
                }}>
                  {locked&&<span style={{position:"absolute",top:4,right:6}}><Icon id="lock" size={11} style={{color:"#9CA3AF"}}/></span>}
                  <span style={{fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700,color:theme===opt.key?"#34d399":"#9CA3AF",whiteSpace:"nowrap"}}>{opt.label}</span>
                  <span style={{fontFamily:"'DM Sans',sans-serif",fontSize:10,color:"#6B7280",whiteSpace:"nowrap"}}>{opt.desc}</span>
                </button>
                );
              })}
            </div>
            <button onClick={()=>themeCarouselRef.current?.scrollBy({left:themeCarouselRef.current.clientWidth/3+6,behavior:"smooth"})}
              aria-label="Mais temas" style={{flexShrink:0,background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:9,padding:"8px 6px",color:"#9CA3AF",cursor:"pointer",display:"flex",alignItems:"center"}}>
              <Ico.ChevR/>
            </button>
          </div>

          {/* Painel de cores do tema Personalizado */}
          {theme==="custom"&&(
            <div style={{width:"100%",display:"flex",flexDirection:"column",gap:8,padding:"10px 12px",borderRadius:12,background:"rgba(255,255,255,0.025)",border:"1px solid rgba(255,255,255,0.07)"}}>
              <span style={{fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700,color:"#9CA3AF",textTransform:"uppercase",letterSpacing:0.5}}>Cores do tema</span>
              {[
                {label:"Cor de fundo",ref:customBgRef,val:customBg,setter:setCustomBg},
                {label:"Cor de destaque",ref:customAccentRef,val:customAccent,setter:setCustomAccent},
                {label:"Cor do campo",ref:customFieldRef,val:customField,setter:setCustomField},
              ].map(({label,ref,val,setter})=>(
                <div key={label} style={{display:"flex",alignItems:"center",gap:10}}>
                  <span style={{fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:600,color:"#e5e7eb",flex:1}}>{label}</span>
                  <div style={{position:"relative",display:"flex",alignItems:"center",gap:6}}>
                    <div style={{width:22,height:22,borderRadius:6,background:val,border:"2px solid rgba(255,255,255,0.2)",flexShrink:0}}/>
                    <input type="color" value={val} onChange={e=>handleCustomColor(ref,setter,e.target.value)}
                      style={{width:60,height:28,padding:"0 4px",border:"1px solid rgba(255,255,255,0.1)",borderRadius:6,cursor:"pointer",background:"rgba(255,255,255,0.05)",color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:11}}/>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Toggle: círculo ao redor dos jogadores + cor do círculo */}
          <div style={{width:"100%",display:"flex",flexDirection:"column",gap:6}}>
            <button onClick={()=>{
              const next=!showCircleRef.current;
              showCircleRef.current=next;
              setShowCircle(next);
              drewRef.current=false;
              draw(theme);
              drewRef.current=true;
            }} style={{
              width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,
              padding:"10px 12px",borderRadius:12,cursor:"pointer",
              background:"rgba(255,255,255,0.025)",border:"1px solid rgba(255,255,255,0.06)",
              color:"#9CA3AF",transition:"all 0.15s"
            }}>
              <span style={{display:"flex",alignItems:"center",gap:8,fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700}}>
                <Icon id="circle" size={14}/> Círculo ao redor dos jogadores
              </span>
              <div style={{
                width:36,height:20,borderRadius:10,transition:"background 0.2s",position:"relative",flexShrink:0,
                background:showCircle?"#34d399":"rgba(255,255,255,0.1)"
              }}>
                <div style={{
                  position:"absolute",top:3,left:showCircle?16:3,width:14,height:14,borderRadius:"50%",
                  background:"#fff",transition:"left 0.2s",boxShadow:"0 1px 3px rgba(0,0,0,0.3)"
                }}/>
              </div>
            </button>
            {showCircle&&(
              <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",borderRadius:10,background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.05)"}}>
                <span style={{fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,color:"#9CA3AF",flex:1}}>Cor do círculo</span>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <input type="color" value={circleColor||"#34d399"} onChange={e=>handleCircleColorChange(e.target.value)}
                    style={{width:36,height:28,padding:2,border:"1px solid rgba(255,255,255,0.15)",borderRadius:8,cursor:"pointer",background:"rgba(255,255,255,0.05)"}}
                    title="Escolher cor do círculo"/>
                  {circleColor&&(
                    <button onClick={()=>handleCircleColorChange(null)} style={{background:"none",border:"none",color:"#6B7280",cursor:"pointer",padding:"0 2px",fontFamily:"'DM Sans',sans-serif",fontSize:14}} title="Usar cor do tema">↺</button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Marca d'água personalizada — colapsada por padrão */}
          <div style={{width:"100%",display:"flex",flexDirection:"column",gap:8}}>
            <button onClick={()=>{
              if(!isPremium){setShowWatermarkUpsell(true);return;}
              setShowWatermarkPanel(v=>!v);
            }} style={{
              width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,
              padding:"10px 12px",borderRadius:12,cursor:"pointer",
              background:showWatermarkPanel?"rgba(52,211,153,0.08)":"rgba(255,255,255,0.025)",
              border:showWatermarkPanel?"1px solid rgba(52,211,153,0.25)":"1px solid rgba(255,255,255,0.06)",
              color:logo?"#34d399":"#9CA3AF",transition:"all 0.15s",opacity:isPremium?1:0.7
            }}>
              <span style={{display:"flex",alignItems:"center",gap:8,fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700}}>
                <Icon id="tag" size={14}/> Marca d'água{logo&&<span style={{background:"rgba(52,211,153,0.18)",color:"#34d399",borderRadius:5,padding:"1px 6px",fontSize:10}}>ativa</span>}
              </span>
              {isPremium
                ?<span style={{display:"flex",transform:showWatermarkPanel?"rotate(180deg)":"none",transition:"transform 0.2s"}}><Ico.ChevDown/></span>
                :<Icon id="lock" size={13} style={{color:"#9CA3AF"}}/>}
            </button>

            {showWatermarkPanel&&(
              <div style={{width:"100%",display:"flex",flexDirection:"column",gap:8,padding:"10px 12px",borderRadius:12,background:"rgba(255,255,255,0.025)",border:"1px solid rgba(255,255,255,0.06)"}}>
                <span style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:0.5}}>Sua marca/logo (opcional)</span>
                <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
                  <div style={{flexShrink:0}}>
                    <PhotoPicker photo={logo} onChange={handleLogoChange}/>
                  </div>
                  {logo&&(
                    <div style={{display:"flex",flexDirection:"column",gap:6,flex:1}}>
                      <span style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:0.5}}>Posição no campo</span>
                      <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:6,width:"100%",maxWidth:140}}>
                        {[
                          {key:"tl",label:"↖"},{key:"tr",label:"↗"},
                          {key:"bl",label:"↙"},{key:"br",label:"↘"},
                        ].map(opt=>(
                          <button key={opt.key} onClick={()=>handleLogoPositionChange(opt.key)} aria-label={`Posicionar marca no canto ${opt.key}`} style={{
                            aspectRatio:"1",borderRadius:9,border:"2px solid",cursor:"pointer",fontSize:16,
                            borderColor:logoPosition===opt.key?"#34d399":"rgba(255,255,255,0.1)",
                            background:logoPosition===opt.key?"rgba(52,211,153,0.12)":"rgba(255,255,255,0.03)",
                            color:logoPosition===opt.key?"#34d399":"#9CA3AF",transition:"all 0.15s"
                          }}>{opt.label}</button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <canvas ref={canvasRef} style={{display:"none"}}/>

          {/* Preview */}
          {generating?(
            <div style={{width:"100%",aspectRatio:"0.63",background:"rgba(255,255,255,0.03)",borderRadius:14,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:10,border:"1px solid rgba(255,255,255,0.08)"}}>
              <div style={{width:36,height:36,border:"3px solid #34d399",borderTopColor:"transparent",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
              <span style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:13}}>Gerando imagem...</span>
            </div>
          ):exportError?(
            <div style={{width:"100%",aspectRatio:"0.63",background:"rgba(239,68,68,0.06)",borderRadius:14,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:12,border:"1px solid rgba(239,68,68,0.2)",padding:20,textAlign:"center"}}>
              <Icon id="warning" size={28} style={{color:"#f87171"}}/>
              <span style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:13}}>Não foi possível gerar a imagem.<br/>Verifique sua conexão e tente novamente.</span>
              <button onClick={()=>draw(theme)} aria-label="Tentar gerar a imagem novamente" style={{padding:"10px 20px",borderRadius:10,border:"1px solid rgba(255,255,255,0.15)",background:"rgba(255,255,255,0.05)",color:"#fff",cursor:"pointer",fontFamily:"'Bebas Neue',sans-serif",fontSize:15,letterSpacing:1}}>TENTAR NOVAMENTE</button>
            </div>
          ):imgUrl?(
            <div onClick={()=>setShowFullPreview(true)} role="button" tabIndex={0} aria-label="Ampliar e rolar a imagem da escalação" style={{width:"100%",borderRadius:14,overflow:"hidden",border:"1px solid rgba(255,255,255,0.12)",cursor:"pointer",position:"relative"}}>
              <img src={imgUrl} alt="Escalação" style={{width:"100%",display:"block"}}/>
              <div style={{position:"absolute",bottom:8,right:8,background:"rgba(0,0,0,0.55)",borderRadius:8,padding:"4px 10px",display:"flex",alignItems:"center",gap:5,color:"#fff",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700}}>
                <Icon id="search" size={10}/> Toque para ampliar
              </div>
            </div>
          ):null}

          {/* Action buttons */}
          {imgUrl&&!generating&&(
            <div style={{display:"flex",flexDirection:"column",gap:9,width:"100%"}}>
              <button onClick={share} style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10,padding:"15px 0",borderRadius:13,border:"none",cursor:"pointer",background:"linear-gradient(135deg,#166534,#34d399)",color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:20,letterSpacing:1.5,boxShadow:"0 6px 20px rgba(52,211,153,0.4)"}}>
                <Ico.Share/> COMPARTILHAR
              </button>
              <button onClick={download} style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10,padding:"13px 0",borderRadius:13,border:"1px solid rgba(255,255,255,0.15)",cursor:"pointer",background:"rgba(255,255,255,0.05)",color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:18,letterSpacing:1.5}}>
                <Ico.Download/> BAIXAR IMAGEM
              </button>
            </div>
          )}
        </div>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg);}}`}</style>
    </div>

    {/* Full-size scrollable preview overlay */}
    {showFullPreview&&imgUrl&&(
      <div onClick={()=>setShowFullPreview(false)} style={{position:"fixed",inset:0,zIndex:2100,background:"rgba(0,0,0,0.95)",overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
        <button onClick={()=>setShowFullPreview(false)} aria-label="Fechar visualização" style={{position:"fixed",top:14,right:14,zIndex:2101,background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.25)",borderRadius:"50%",width:38,height:38,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",cursor:"pointer"}}>
          <Ico.Close/>
        </button>
        <img src={imgUrl} alt="Escalação - visualização completa" onClick={e=>e.stopPropagation()} style={{width:"100%",display:"block"}}/>
      </div>
    )}
    {showThemeUpsell&&<PremiumUpsellModal
      title="Temas premium"
      description="No plano gratuito a exportação fica disponível apenas no tema Moderno. Desbloqueie os temas Simples, Retrô, Neon e Mono com o premium."
      onClose={()=>setShowThemeUpsell(false)}
    />}
    {showWatermarkUpsell&&<PremiumUpsellModal
      title="Marca d'água personalizada"
      description="Adicionar seu próprio logo/marca d'água na exportação é um recurso premium."
      onClose={()=>setShowWatermarkUpsell(false)}
    />}
    </>
  );
}

// ─── Player Card ──────────────────────────────────────────────────────────────
function PlayerCard({player,onEdit,onDelete,isCaptain,onToggleCaptain,team,guestIndex}) {
  const isGuest=!!player.isGuest;
  const displayNum=isGuest?`C${guestIndex||1}`:player.number;
  return (
    <div className="player-card" style={{background:isGuest?"rgba(251,146,60,0.05)":"rgba(255,255,255,0.04)",border:isCaptain?"1px solid rgba(245,158,11,0.4)":isGuest?"1px solid rgba(251,146,60,0.2)":"1px solid rgba(255,255,255,0.08)",borderRadius:14,padding:"12px 13px",display:"flex",alignItems:"center",gap:12}}>
      <div style={{position:"relative",flexShrink:0}}>
        <PlayerAvatar player={player} size={52} style={{border:isGuest?"2px solid rgba(251,146,60,0.4)":"2px solid rgba(255,255,255,0.14)"}} team={team}/>
        {isCaptain&&(
          <div style={{position:"absolute",top:-4,right:-4,width:20,height:20,borderRadius:"50%",background:"#F59E0B",border:"2px solid #050c0a",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue',sans-serif",fontSize:11,fontWeight:900,color:"#1a1a0a"}}>C</div>
        )}
        {isGuest&&!isCaptain&&(
          <div style={{position:"absolute",top:-4,right:-4,width:20,height:20,borderRadius:"50%",background:"#fb923c",border:"2px solid #050c0a",display:"flex",alignItems:"center",justifyContent:"center"}}><Icon id="ticket" size={10} style={{color:"#fff"}}/></div>
        )}
      </div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{color:"#fff",fontFamily:"'DM Sans',sans-serif",fontSize:14,fontWeight:700}}>{player.name}</span>
          <span style={{background:isGuest?"rgba(251,146,60,0.18)":"rgba(52,211,153,0.15)",color:isGuest?"#fb923c":"#34d399",borderRadius:5,padding:"1px 6px",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700}}>{isGuest?`C${guestIndex||1}`:(`#${player.number}`)}</span>
        </div>
        <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:11,marginTop:2}}>{player.position} · {player.foot}{isGuest&&<span style={{color:"#fb923c",marginLeft:6,fontWeight:700}}>· Convidado</span>}</div>
        <div style={{marginTop:3}}><StarRating value={player.stars} readonly/></div>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:6}}>
        <button onClick={onToggleCaptain} aria-label={isCaptain?`Remover ${player.name} da capitania`:`Definir ${player.name} como capitão`} title={isCaptain?"Remover capitania":"Definir como capitão"} style={{
          background:isCaptain?"rgba(245,158,11,0.18)":"rgba(255,255,255,0.05)",
          border:isCaptain?"1px solid rgba(245,158,11,0.5)":"1px solid rgba(255,255,255,0.12)",
          borderRadius:8,padding:"7px 10px",color:isCaptain?"#F59E0B":"#6B7280",cursor:"pointer",
          fontFamily:"'Bebas Neue',sans-serif",fontSize:13,fontWeight:900,lineHeight:1,
          display:"flex",alignItems:"center",justifyContent:"center",minWidth:30
        }}>C</button>
        <button onClick={onEdit} aria-label={`Editar ${player.name}`} style={{background:"rgba(59,130,246,0.15)",border:"1px solid rgba(59,130,246,0.3)",borderRadius:8,padding:"7px 10px",color:"#60a5fa",cursor:"pointer"}}><Ico.Edit/></button>
        <button onClick={onDelete} aria-label={`Excluir ${player.name}`} style={{background:"rgba(239,68,68,0.12)",border:"1px solid rgba(239,68,68,0.25)",borderRadius:8,padding:"7px 10px",color:"#f87171",cursor:"pointer"}}><Ico.Trash/></button>
      </div>
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function Toast({msg,onDone}) {
  useEffect(()=>{const t=setTimeout(onDone,2200);return()=>clearTimeout(t);},[onDone]);
  return (
    <div style={{position:"fixed",top:22,left:"50%",transform:"translateX(-50%)",
      background:"rgba(22,101,52,0.97)",color:"#fff",padding:"9px 18px",
      borderRadius:30,fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700,
      zIndex:3000,boxShadow:"0 4px 20px rgba(0,0,0,0.5)",animation:"toastIn 0.25s ease",
      whiteSpace:"nowrap",border:"1px solid rgba(52,211,153,0.3)"}}>
      ✓ {msg}
    </div>
  );
}

// ─── Players Tab with Filter/Sort ────────────────────────────────────────────
const SORT_OPTIONS = [
  { key: "name",     label: "Nome",    icon: "A→Z" },
  { key: "number",   label: "Número",  icon: "#" },
  { key: "position", label: "Posição", icon: "pos" },
  { key: "stars",    label: "Nível",   icon: "★" },
];

const PLAYERS_PAGE_SIZE = 20;

function PlayersTab({ players, onEdit, onDelete, teamColor, captainPlayerId, onToggleCaptain, team }) {
  const [search, setSearch]     = useState("");
  const [sortBy, setSortBy]     = useState("name");
  const [sortAsc, setSortAsc]   = useState(true);
  const [filterPos, setFilterPos] = useState("Todas");
  const [page, setPage]         = useState(1);
  const [c1, c2] = SHIELD_COLORS[teamColor % SHIELD_COLORS.length];
  // Reset to page 1 whenever filter/sort changes
  useEffect(() => { setPage(1); }, [search, sortBy, sortAsc, filterPos]);

  // Separate guests from regular players
  const regularPlayers = useMemo(() => players.filter(p => !p.isGuest), [players]);
  const guestPlayers   = useMemo(() => players.filter(p => !!p.isGuest), [players]);

  const allPositions = useMemo(
    () => ["Todas", ...Array.from(new Set(regularPlayers.map(p => p.position)))],
    [regularPlayers]
  );

  const allFiltered = useMemo(() => regularPlayers
    .filter(p => {
      const matchSearch = !search || p.name.toLowerCase().includes(search.toLowerCase()) || String(p.number).includes(search);
      const matchPos    = filterPos === "Todas" || p.position === filterPos;
      return matchSearch && matchPos;
    })
    .sort((a, b) => {
      let va, vb;
      if (sortBy === "name")     { va = a.name.toLowerCase();    vb = b.name.toLowerCase(); }
      else if (sortBy === "number") { va = parseInt(a.number)||0; vb = parseInt(b.number)||0; }
      else if (sortBy === "position") { va = a.position;           vb = b.position; }
      else if (sortBy === "stars")  { va = a.stars||0;             vb = b.stars||0; }
      if (va < vb) return sortAsc ? -1 : 1;
      if (va > vb) return sortAsc ? 1 : -1;
      return 0;
    }), [regularPlayers, search, filterPos, sortBy, sortAsc]);

  // Guests also filtered by search
  const filteredGuests = useMemo(() => guestPlayers.filter(p =>
    !search || p.name.toLowerCase().includes(search.toLowerCase())
  ), [guestPlayers, search]);

  const totalPages = Math.ceil(allFiltered.length / PLAYERS_PAGE_SIZE);
  const filtered = useMemo(
    () => allFiltered.slice(0, page * PLAYERS_PAGE_SIZE),
    [allFiltered, page]
  );
  const hasMore = filtered.length < allFiltered.length;

  const toggleSort = (key) => {
    if (sortBy === key) setSortAsc(a => !a);
    else { setSortBy(key); setSortAsc(true); }
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      {/* Search bar */}
      <div style={{ position:"relative" }}>
        <svg style={{ position:"absolute", left:11, top:"50%", transform:"translateY(-50%)", pointerEvents:"none" }}
          width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4B5563" strokeWidth="2.5" strokeLinecap="round">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar por nome ou número..."
          aria-label="Buscar jogador por nome ou número"
          style={{ ...IS, paddingLeft:34, background:"rgba(255,255,255,0.05)", fontSize:13 }}
          onFocus={e => e.target.style.borderColor = c1}
          onBlur={e => e.target.style.borderColor = "rgba(255,255,255,0.1)"}
        />
        {search && (
          <button onClick={() => setSearch("")} aria-label="Limpar busca" style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)",
            background:"none", border:"none", color:"#6B7280", cursor:"pointer", padding:2, display:"flex", alignItems:"center" }}>
            <Ico.Close/>
          </button>
        )}
      </div>

      {/* Sort buttons */}
      <div style={{ display:"flex", gap:6, alignItems:"center" }}>
        <span style={{ ...LT, flexShrink:0, fontSize:9 }}>Ordenar:</span>
        <div style={{ display:"flex", gap:5, flex:1, overflowX:"auto", paddingBottom:2 }}>
          {SORT_OPTIONS.map(opt => {
            const active = sortBy === opt.key;
            return (
              <button key={opt.key} onClick={() => toggleSort(opt.key)} style={{
                display:"flex", alignItems:"center", gap:4,
                padding:"5px 10px", borderRadius:8, border:"1px solid",
                flexShrink:0, cursor:"pointer",
                fontFamily:"'DM Sans',sans-serif", fontSize:11, fontWeight:700,
                transition:"all 0.15s",
                borderColor: active ? c1 : "rgba(255,255,255,0.1)",
                background: active ? `${c1}20` : "rgba(255,255,255,0.03)",
                color: active ? c2 : "#6B7280",
              }}>
                <span style={{ fontSize:10 }}>{opt.icon}</span>
                {opt.label}
                {active && (
                  <span style={{ fontSize:9, opacity:0.8 }}>{sortAsc ? "↑" : "↓"}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Position filter pills */}
      {regularPlayers.length > 0 && allPositions.length > 2 && (
        <div style={{ display:"flex", gap:5, overflowX:"auto", paddingBottom:2 }}>
          {allPositions.map(pos => {
            const active = filterPos === pos;
            return (
              <button key={pos} onClick={() => setFilterPos(pos)} style={{
                padding:"4px 11px", borderRadius:20, border:"1px solid",
                flexShrink:0, cursor:"pointer",
                fontFamily:"'DM Sans',sans-serif", fontSize:11, fontWeight:700,
                transition:"all 0.15s",
                borderColor: active ? c1 : "rgba(255,255,255,0.1)",
                background: active ? `${c1}22` : "rgba(255,255,255,0.03)",
                color: active ? c2 : "#6B7280",
              }}>
                {pos}
              </button>
            );
          })}
        </div>
      )}

      {/* Results count */}
      {regularPlayers.length > 0 && (
        <div style={{ fontFamily:"'DM Sans',sans-serif", fontSize:11, color:"#4B5563", paddingLeft:2 }}>
          {allFiltered.length === regularPlayers.length
            ? `${regularPlayers.length} jogador${regularPlayers.length !== 1 ? "es" : ""}`
            : `${allFiltered.length} de ${regularPlayers.length} jogadores`}
          {hasMore && <span style={{color:"#34d399",marginLeft:6}}>· mostrando {filtered.length}</span>}
        </div>
      )}

      {/* Empty states */}
      {regularPlayers.length === 0 && guestPlayers.length === 0 && (
        <div style={{ textAlign:"center", padding:"52px 20px", color:"#4B5563" }}>
          <div style={{display:"flex",justifyContent:"center",opacity:0.3,marginBottom:12}}><Ico.Players/></div>
          <div style={{ fontSize:16, fontWeight:700, color:"#6B7280" }}>Nenhum jogador ainda</div>
          <div style={{ fontSize:13, marginTop:6 }}>Toque no <span style={{ color:"#34d399" }}>+</span> para cadastrar</div>
        </div>
      )}
      {regularPlayers.length > 0 && filtered.length === 0 && filteredGuests.length === 0 && (
        <div style={{ textAlign:"center", padding:"36px 20px", color:"#4B5563" }}>
          <Icon id="search" size={40} style={{color:"#4B5563",marginBottom:10}}/>
          <div style={{ fontSize:14, fontWeight:700, color:"#6B7280" }}>Nenhum resultado</div>
          <div style={{ fontSize:12, marginTop:5 }}>Tente outro filtro ou termo de busca</div>
        </div>
      )}

      {/* Regular player list */}
      {filtered.map(p => (
        <PlayerCard key={p.id} player={p}
          onEdit={() => onEdit(p)}
          onDelete={() => onDelete(p.id)}
          isCaptain={String(captainPlayerId)===String(p.id)}
          onToggleCaptain={() => onToggleCaptain(p.id)}
          team={team}
        />
      ))}

      {/* Load more button */}
      {hasMore && (
        <button onClick={() => setPage(p => p + 1)} style={{
          width:"100%", padding:"12px 0", borderRadius:12,
          border:"1px solid rgba(52,211,153,0.3)",
          background:"rgba(52,211,153,0.06)", color:"#34d399",
          cursor:"pointer", fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:700,
          transition:"all 0.18s"
        }}
          onMouseEnter={e=>{e.currentTarget.style.background="rgba(52,211,153,0.14)";}}
          onMouseLeave={e=>{e.currentTarget.style.background="rgba(52,211,153,0.06)";}}>
          Carregar mais ({allFiltered.length - filtered.length} restantes)
        </button>
      )}

      {/* Guest players section */}
      {(guestPlayers.length > 0 || (!search && regularPlayers.length > 0)) && (
        <div style={{marginTop:8}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
            <div style={{flex:1,height:1,background:"rgba(251,146,60,0.2)"}}/>
            <span style={{color:"#fb923c",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:800,textTransform:"uppercase",letterSpacing:0.7,flexShrink:0,display:"flex",alignItems:"center",gap:4}}><Icon id="ticket" size={10}/> Convidados ({filteredGuests.length})</span>
            <div style={{flex:1,height:1,background:"rgba(251,146,60,0.2)"}}/>
          </div>
          {filteredGuests.length === 0 && !search && (
            <div style={{textAlign:"center",padding:"14px 0",color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:12}}>
              Nenhum convidado cadastrado
            </div>
          )}
          {filteredGuests.map((p, i) => (
            <div key={p.id} style={{marginBottom:8}}>
              <PlayerCard player={p}
                onEdit={() => onEdit(p)}
                onDelete={() => onDelete(p.id)}
                isCaptain={String(captainPlayerId)===String(p.id)}
                onToggleCaptain={() => onToggleCaptain(p.id)}
                team={team}
                guestIndex={i+1}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ─── Lineup Manager Modal ─────────────────────────────────────────────────────
const LINEUP_TYPES = [
  { key: "titular",      label: "Titular",      color: "#34d399", icon: "star" },
  { key: "reserva",      label: "Reserva",       color: "#60a5fa", icon: "refresh" },
  { key: "personalizada",label: "Personalizada", color: "#f59e0b", icon: "edit" },
];

// ─── Premium upsell modal ───────────────────────────────────────────────────
// Generic paywall placeholder shown whenever a free-plan limit is reached or
// a premium-only option is tapped. Reusable across features (lineups, export
// themes, shields, jerseys, watermark, etc.) — just pass a title/description.
// `onUpgrade` has no real purchase flow yet (that requires Play Billing after
// the Capacitor wrap); it's left as a hook for that integration.
function PremiumUpsellModal({title,description,onClose,onUpgrade}) {
  return (
    <div style={{position:"fixed",inset:0,zIndex:1500,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.78)",backdropFilter:"blur(5px)",padding:"16px"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#0d1f17",border:"1px solid rgba(250,204,21,0.25)",borderRadius:18,width:"100%",maxWidth:380,padding:"24px 22px",display:"flex",flexDirection:"column",alignItems:"center",gap:12,textAlign:"center",boxShadow:"0 24px 80px rgba(0,0,0,0.7)"}}>
        <div style={{width:54,height:54,borderRadius:"50%",background:"rgba(250,204,21,0.12)",border:"1px solid rgba(250,204,21,0.3)",display:"flex",alignItems:"center",justifyContent:"center"}}><Icon id="crown" size={26} style={{color:"#facc15"}}/></div>
        <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#fff",letterSpacing:1}}>{title||"Recurso Premium"}</div>
        <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:13,color:"#9CA3AF",lineHeight:1.5}}>{description||"Esse recurso faz parte do plano premium."}</div>
        <button onClick={onUpgrade||onClose} style={{width:"100%",padding:"13px 0",borderRadius:12,border:"none",cursor:"pointer",
          background:"linear-gradient(135deg,#b45309,#facc15)",color:"#1a1305",fontFamily:"'Bebas Neue',sans-serif",fontSize:17,letterSpacing:1.5,
          boxShadow:"0 6px 20px rgba(250,204,21,0.3)",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}><Icon id="star" size={16} style={{color:"#1a1305"}}/> CONHECER O PREMIUM</button>
        <button onClick={onClose} style={{width:"100%",padding:"11px 0",borderRadius:12,border:"1px solid rgba(255,255,255,0.1)",cursor:"pointer",background:"rgba(255,255,255,0.04)",color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700}}>Agora não</button>
      </div>
    </div>
  );
}

function LineupManagerModal({team, onClose, onActivate, onRename, onCreate, onDelete, isPremium}) {
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("titular");
  const [renamingId, setRenamingId] = useState(null);
  const [renameVal, setRenameVal] = useState("");
  const [confirmDelId, setConfirmDelId] = useState(null);
  const [showUpsell, setShowUpsell] = useState(false);
  const [c1, c2] = SHIELD_COLORS[(team.colorIdx||0) % SHIELD_COLORS.length];
  const lineups = team.lineups || [];
  const atLineupLimit = !isPremium && lineups.length >= FREE_LINEUP_LIMIT;

  const handleNewClick = () => {
    if (atLineupLimit) { setShowUpsell(true); return; }
    setCreatingNew(true); setNewName(""); setNewType("titular");
  };

  const typeInfo = (type) => LINEUP_TYPES.find(t => t.key === type) || LINEUP_TYPES[0];

  return (
    <>
    <div style={{position:"fixed",inset:0,zIndex:1000,display:"flex",alignItems:"flex-end",justifyContent:"center",background:"rgba(0,0,0,0.78)",backdropFilter:"blur(5px)"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#0d1f17",border:"1px solid rgba(255,255,255,0.1)",borderRadius:"22px 22px 0 0",width:"100%",maxWidth:500,maxHeight:"80vh",overflow:"hidden",display:"flex",flexDirection:"column"}}>

        {/* Header */}
        <div style={{padding:"16px 18px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:"1px solid rgba(255,255,255,0.08)",flexShrink:0}}>
          <div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:21,color:"#fff",letterSpacing:1}}>Escalações</div>
            <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:11,color:"#4B5563",marginTop:1}}>
              {lineups.length} escalação{lineups.length!==1?"s":""} · toque para ativar
              {!isPremium&&<span style={{color:"#facc15",marginLeft:6}}>· {Math.min(lineups.length,FREE_LINEUP_LIMIT)}/{FREE_LINEUP_LIMIT} no plano free</span>}
            </div>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <button onClick={handleNewClick} style={{
              display:"flex",alignItems:"center",gap:5,padding:"7px 11px",borderRadius:9,
              background:`${c1}25`,border:`1px solid ${c1}60`,color:c2,cursor:"pointer",
              fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:800
            }}><Ico.Plus/>Nova</button>
            <button onClick={onClose} aria-label="Fechar" style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer",padding:4}}><Ico.Close/></button>
          </div>
        </div>

        <div style={{overflowY:"auto",padding:"10px 14px 24px",display:"flex",flexDirection:"column",gap:8}}>

          {/* Create new form */}
          {creatingNew && (
            <div style={{background:"rgba(52,211,153,0.06)",border:"1px solid rgba(52,211,153,0.2)",borderRadius:14,padding:"14px 14px 12px",display:"flex",flexDirection:"column",gap:10}}>
              <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700,color:"#34d399"}}>Nova escalação</div>
              <input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="Nome da escalação..." aria-label="Nome da nova escalação" style={{...IS,fontSize:13}}
                onFocus={e=>e.target.style.borderColor="#34d399"} onBlur={e=>e.target.style.borderColor="rgba(255,255,255,0.1)"}/>
              <div style={{display:"flex",gap:6}}>
                {LINEUP_TYPES.map(t=>(
                  <button key={t.key} onClick={()=>setNewType(t.key)} style={{
                    flex:1,padding:"7px 4px",borderRadius:9,border:"1.5px solid",cursor:"pointer",
                    borderColor:newType===t.key?t.color:"rgba(255,255,255,0.1)",
                    background:newType===t.key?`${t.color}20`:"rgba(255,255,255,0.03)",
                    fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,
                    color:newType===t.key?t.color:"#6B7280",
                  }}><Icon id={t.icon} size={16} style={{color:newType===t.key?t.color:"#6B7280"}}/> {t.label}</button>
                ))}
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={()=>setCreatingNew(false)} style={{flex:1,padding:"9px 0",borderRadius:9,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.04)",color:"#9CA3AF",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700}}>Cancelar</button>
                <button onClick={()=>{if(!newName.trim())return;if(atLineupLimit){setCreatingNew(false);setShowUpsell(true);return;}onCreate(newType,newName.trim());setCreatingNew(false);}} style={{
                  flex:2,padding:"9px 0",borderRadius:9,border:"none",cursor:newName.trim()?"pointer":"not-allowed",
                  background:newName.trim()?"linear-gradient(135deg,#166534,#34d399)":"rgba(255,255,255,0.06)",
                  color:newName.trim()?"#fff":"#4B5563",fontFamily:"'Bebas Neue',sans-serif",fontSize:16,letterSpacing:1,
                }}>CRIAR</button>
              </div>
            </div>
          )}

          {/* Lineup list */}
          {lineups.map((lineup, idx) => {
            const isActive = String(lineup.id) === String(team.activeLineupId) || lineup.isActive;
            const ti = typeInfo(lineup.type);
            const escalados = (lineup.entries||[]).filter(e=>e.playerId).length;
            const slots = FORMATIONS[lineup.formation]?.slots || FORMATIONS["4-4-2"].slots;
            const isRenaming = renamingId === lineup.id;
            const isConfirmDel = confirmDelId === lineup.id;

            return (
              <div key={lineup.id} style={{
                background: isActive ? `${c1}12` : "rgba(255,255,255,0.03)",
                border: `1.5px solid ${isActive ? c1 + "55" : "rgba(255,255,255,0.08)"}`,
                borderRadius: 14, overflow: "hidden",
                transition: "all 0.18s",
              }}>
                {/* Active indicator bar */}
                {isActive && <div style={{height:3,background:`linear-gradient(90deg,${c1},${c2})`}}/>}

                <div style={{padding:"12px 14px",display:"flex",alignItems:"center",gap:12,cursor:"pointer"}} onClick={()=>{if(!isActive)onActivate(lineup.id);}}>
                  {/* Type badge */}
                  <div style={{width:38,height:38,borderRadius:10,background:`${ti.color}20`,border:`1px solid ${ti.color}40`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon id={ti.icon} size={18} style={{color:ti.color}}/></div>

                  <div style={{flex:1,minWidth:0}}>
                    {isRenaming ? (
                      <div style={{display:"flex",gap:6,alignItems:"center"}}>
                        <input value={renameVal} onChange={e=>setRenameVal(e.target.value)} autoFocus aria-label="Novo nome da escalação"
                          style={{...IS,fontSize:13,flex:1,padding:"5px 10px"}}
                          onFocus={e=>e.target.style.borderColor=c1} onBlur={e=>e.target.style.borderColor="rgba(255,255,255,0.1)"}
                          onKeyDown={e=>{if(e.key==="Enter"&&renameVal.trim()){onRename(lineup.id,renameVal.trim());setRenamingId(null);}if(e.key==="Escape")setRenamingId(null);}}/>
                        <button onClick={e=>{e.stopPropagation();if(renameVal.trim()){onRename(lineup.id,renameVal.trim());setRenamingId(null);}}} aria-label="Confirmar novo nome" style={{background:"rgba(52,211,153,0.2)",border:"1px solid rgba(52,211,153,0.4)",borderRadius:7,padding:"5px 10px",color:"#34d399",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"'DM Sans',sans-serif",flexShrink:0}}>OK</button>
                        <button onClick={e=>{e.stopPropagation();setRenamingId(null);}} aria-label="Cancelar renomeação" style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:7,padding:"5px 8px",color:"#9CA3AF",cursor:"pointer",flexShrink:0}}><Ico.Close/></button>
                      </div>
                    ) : (
                      <>
                        <div style={{display:"flex",alignItems:"center",gap:6}}>
                          <span style={{fontFamily:"'DM Sans',sans-serif",fontSize:14,fontWeight:700,color:isActive?c2:"#fff"}}>{lineup.name}</span>
                          {isActive && <span style={{background:c1,color:"#000",borderRadius:5,padding:"1px 7px",fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:900,flexShrink:0}}>ATIVA</span>}
                        </div>
                        <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:11,color:"#6B7280",marginTop:1}}>
                          {lineup.formation} · {escalados}/{slots.length} escalados · <span style={{color:ti.color}}>{ti.label}</span>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Action buttons */}
                  {!isRenaming && (
                    <div style={{display:"flex",gap:5,flexShrink:0}}>
                      <button onClick={e=>{e.stopPropagation();setRenamingId(lineup.id);setRenameVal(lineup.name);}} aria-label={`Renomear ${lineup.name}`} style={{background:"rgba(59,130,246,0.12)",border:"1px solid rgba(59,130,246,0.25)",borderRadius:7,padding:"6px 8px",color:"#60a5fa",cursor:"pointer"}}><Ico.Edit/></button>
                      {lineups.length > 1 && (
                        <button onClick={e=>{e.stopPropagation();setConfirmDelId(lineup.id);}} aria-label={`Excluir ${lineup.name}`} style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.22)",borderRadius:7,padding:"6px 8px",color:"#f87171",cursor:"pointer"}}><Ico.Trash/></button>
                      )}
                    </div>
                  )}
                </div>

                {/* Confirm delete */}
                {isConfirmDel && (
                  <div onClick={e=>e.stopPropagation()} style={{borderTop:"1px solid rgba(239,68,68,0.15)",background:"rgba(239,68,68,0.07)",padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}>
                    <span style={{flex:1,fontFamily:"'DM Sans',sans-serif",fontSize:12,color:"#f87171"}}>Excluir esta escalação?</span>
                    <button onClick={()=>setConfirmDelId(null)} style={{padding:"5px 10px",borderRadius:7,border:"1px solid rgba(255,255,255,0.12)",background:"transparent",color:"#9CA3AF",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700}}>Não</button>
                    <button onClick={()=>{onDelete(lineup.id);setConfirmDelId(null);}} style={{padding:"5px 12px",borderRadius:7,border:"none",background:"rgba(239,68,68,0.8)",color:"#fff",cursor:"pointer",fontFamily:"'Bebas Neue',sans-serif",fontSize:13,letterSpacing:0.5}}>EXCLUIR</button>
                  </div>
                )}
              </div>
            );
          })}

          {lineups.length === 0 && (
            <div style={{textAlign:"center",padding:"36px 20px",color:"#4B5563"}}>
              <Icon id="clipboard" size={40} style={{color:"#4B5563",marginBottom:10}}/>
              <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:14,color:"#6B7280"}}>Nenhuma escalação ainda</div>
            </div>
          )}
        </div>
      </div>
    </div>
    {showUpsell&&<PremiumUpsellModal
      title="Limite de escalações"
      description={`No plano gratuito você pode salvar ${FREE_LINEUP_LIMIT} escalação por time. Faça upgrade para o premium e crie quantas quiser.`}
      onClose={()=>setShowUpsell(false)}
    />}
    </>
  );
}

// ─── Team Tactical View (existing app logic) ──────────────────────────────────
function TeamView({team,onUpdateTeam,onBack,onForceSave,onSavePlayer,onDeletePlayerCloud,onSaveLineup,onDeleteLineup,syncStatus,isPremium,uid}) {
  const [tab,setTab]=useState("field");
  const [editingName,setEditingName]=useState(false);
  const [showForm,setShowForm]=useState(false);
  const [editingPlayer,setEditingPlayer]=useState(null);
  const [activeSlot,setActiveSlot]=useState(null);
  const [showExport,setShowExport]=useState(false);
  const [showPlayerLimitUpsell,setShowPlayerLimitUpsell]=useState(false);
  const [showFList,setShowFList]=useState(false);
  const [toast,setToast]=useState(null);
  const [showEditTeam,setShowEditTeam]=useState(false);
  const [showLineupMgr,setShowLineupMgr]=useState(false);
  const [freeMode,setFreeMode]=useState(false);
  const [saveStatus,setSaveStatus]=useState("idle"); // "idle" | "saving" | "saved" | "error"
  const [showTutorialPrompt,setShowTutorialPrompt]=useState(false);
  const [showTutorial,setShowTutorial]=useState(false);
  // Appearances per player (computed from match presentPlayerIds, loaded lazily)
  const [teamAppearances,setTeamAppearances]=useState({});
  useEffect(()=>{
    if(!uid||!team?.id)return;
    loadMatchesCloud(uid,team.id).then(matches=>{
      const agg={};
      (matches||[]).forEach(m=>(m.presentPlayerIds||[]).forEach(pid=>{ agg[pid]=(agg[pid]||0)+1; }));
      setTeamAppearances(agg);
    }).catch(()=>{});
  },[uid,team?.id]);
  const [showGuestLimitUpsell,setShowGuestLimitUpsell]=useState(false);
  const [showGuestForm,setShowGuestForm]=useState(false);
  // ID generation: crypto.randomUUID() (with fallback) avoids any chance of
  // collision, even across teams/components remounted in quick succession.
  const [c1,c2]=SHIELD_COLORS[(team.colorIdx||0)%SHIELD_COLORS.length];

  const slots=FORMATIONS[team.formation]?.slots||FORMATIONS["4-4-2"].slots;
  const activeLineup=getActiveLineup(team,team.lineups||[]);
  // Local draft for the coach name input — only persisted when the user
  // confirms with the OK button (or presses Enter), avoiding a save on
  // every keystroke.
  const [coachInput,setCoachInput]=useState(activeLineup?.coach||"");
  const [coachSaved,setCoachSaved]=useState(false);
  useEffect(()=>{ setCoachInput(activeLineup?.coach||""); },[activeLineup?.id]);
  const confirmCoach=()=>{
    setCoach(coachInput);
    setCoachSaved(true);
    setTimeout(()=>setCoachSaved(false),1500);
  };
  // upd sempre usa o team atual da prop (TeamView recebe team atualizado do pai via setTeams)
  const upd=(patch)=>onUpdateTeam({...team,...patch});

  const setCoach=(coachName)=>{
    const updatedLineups=(team.lineups||[]).map(l=>
      String(l.id)===String(activeLineup?.id)?{...l,coach:coachName}:l
    );
    upd({lineups:updatedLineups});
    if(onSaveLineup){
      const al=updatedLineups.find(l=>String(l.id)===String(activeLineup?.id));
      if(al)onSaveLineup(team.id,al);
    }
  };

  const toggleCaptain=(playerId)=>{
    upd({captainPlayerId: String(team.captainPlayerId)===String(playerId) ? null : playerId});
  };

  const toggleBenchPlayer=(playerId)=>{
    const current=activeLineup?.benchPlayerIds||[];
    const next=current.includes(playerId)?current.filter(id=>id!==playerId):[...current,playerId];
    const updatedLineups=(team.lineups||[]).map(l=>
      String(l.id)===String(activeLineup?.id)?{...l,benchPlayerIds:next}:l
    );
    upd({lineups:updatedLineups});
    if(onSaveLineup){
      const al=updatedLineups.find(l=>String(l.id)===String(activeLineup?.id));
      if(al)onSaveLineup(team.id,al);
    }
  };

  const savePlayer=async(form)=>{
    try{
      const isEditing=editingPlayer;
      const newId=isEditing?isEditing.id:genUUID();
      // For guest players, auto-assign a "guest slot" number string (not used for display but stored)
      let savedPlayer={...form,id:newId};
      if(savedPlayer.isGuest&&!isEditing){
        const existingGuests=(team.players||[]).filter(p=>p.isGuest);
        savedPlayer={...savedPlayer,number:`G${existingGuests.length+1}`};
      }
      // Use functional updater via onUpdateTeam to always read latest players list
      onUpdateTeam(current=>{
        const curPlayers=current.players||[];
        const updatedPlayers=isEditing
          ?curPlayers.map(p=>p.id===isEditing.id?savedPlayer:p)
          :[...curPlayers,savedPlayer];
        return {...current,players:updatedPlayers};
      });
      if(onSavePlayer) onSavePlayer(team.id,savedPlayer);
      setShowForm(false);setEditingPlayer(null);setToast("Jogador salvo!");
    }catch(e){
      console.error("savePlayer error:",e);
      setToast("\u26a0\ufe0f Erro ao salvar jogador. Tente novamente.");
    }
  };
  const deletePlayer=(id)=>{
    // Remove from all lineups
    const updatedLineups=(team.lineups||[]).map(l=>({...l,entries:(l.entries||[]).filter(e=>e.playerId!==id)}));
    const activeLineup=getActiveLineup(team,updatedLineups);
    upd({
      players:team.players.filter(p=>p.id!==id),
      lineups:updatedLineups,
      lineup:activeLineup?.entries||[],
      captainPlayerId: String(team.captainPlayerId)===String(id) ? null : team.captainPlayerId,
    });
    // Remove player doc from subcollection + save updated lineups
    if(onDeletePlayerCloud) onDeletePlayerCloud(team.id, id);
    if(onSaveLineup) updatedLineups.forEach(l=>onSaveLineup(team.id,l));
  };
  const handleFormationChange=(f)=>{
    const oldSlots=FORMATIONS[team.formation||"4-4-2"].slots;
    const newSlots=FORMATIONS[f].slots;
    const migratedEntries=migrateLineup(team.lineup||[],oldSlots,newSlots);
    // Update active lineup formation + entries
    const updatedLineups=(team.lineups||[]).map(l=>{
      if(String(l.id)===String(team.activeLineupId)||(l.isActive&&!team.activeLineupId))
        return{...l,formation:f,entries:migratedEntries};
      return l;
    });
    upd({formation:f,lineup:migratedEntries,lineups:updatedLineups});
    if(onSaveLineup){const al=getActiveLineup(team,updatedLineups);if(al)onSaveLineup(team.id,al);}
    setToast(`Formação ${f}`);
  };
  const handleSlotTap=(slotId,label)=>setActiveSlot({slotId,label});
  const pickPlayer=(playerId)=>{
    const l=team.lineup||[];
    const existingEntry=l.find(e=>e.playerId===playerId);
    const currentEntry=l.find(e=>e.slotId===activeSlot.slotId);
    let next=l.filter(e=>e.slotId!==activeSlot.slotId&&e.playerId!==playerId);
    next.push({slotId:activeSlot.slotId,playerId});
    if(existingEntry&&currentEntry)next.push({slotId:existingEntry.slotId,playerId:currentEntry.playerId});
    const updatedLineups=(team.lineups||[]).map(l2=>{
      if(String(l2.id)===String(team.activeLineupId)||(l2.isActive&&!team.activeLineupId)){
        // A player can't be on the field and on the bench at the same time
        const benchPlayerIds=(l2.benchPlayerIds||[]).filter(id=>String(id)!==String(playerId));
        return{...l2,entries:next,benchPlayerIds};
      }
      return l2;
    });
    upd({lineup:next,lineups:updatedLineups});
    if(onSaveLineup){const al=getActiveLineup(team,updatedLineups);if(al)onSaveLineup(team.id,al);}
    setActiveSlot(null);
  };
  const clearSlot=()=>{
    const next=(team.lineup||[]).filter(e=>e.slotId!==activeSlot.slotId);
    const updatedLineups=(team.lineups||[]).map(l=>{
      if(String(l.id)===String(team.activeLineupId)||(l.isActive&&!team.activeLineupId))
        return{...l,entries:next};
      return l;
    });
    upd({lineup:next,lineups:updatedLineups});
    if(onSaveLineup){const al=getActiveLineup(team,updatedLineups);if(al)onSaveLineup(team.id,al);}
    setActiveSlot(null);
  };
  const escalados=(team.lineup||[]).filter(l=>l.playerId).length;

  // ── Free mode: persist new x/y for a player after drag ──────────────────
  const handleFreeMoveEnd=(slotId,px,py)=>{
    const updatedLineup=(team.lineup||[]).map(e=>
      e.slotId===slotId ? {...e,x:Math.round(px*10)/10,y:Math.round(py*10)/10} : e
    );
    const updatedLineups=(team.lineups||[]).map(l=>{
      if(String(l.id)===String(team.activeLineupId)||(l.isActive&&!team.activeLineupId))
        return{...l,entries:updatedLineup};
      return l;
    });
    upd({lineup:updatedLineup,lineups:updatedLineups});
    if(onSaveLineup){const al=getActiveLineup(team,updatedLineups);if(al)onSaveLineup(team.id,al);}
  };

  const handleForceSave=async()=>{
    if(saveStatus==="saving")return;
    setSaveStatus("saving");
    try{
      const ok=await onForceSave();
      setSaveStatus(ok?"saved":"error");
      setToast(ok?"✅ Dados salvos com sucesso!":"⚠️ Erro ao salvar. Tente novamente.");
    }catch(e){
      setSaveStatus("error");
      setToast("⚠️ Erro ao salvar. Tente novamente.");
    }
    setTimeout(()=>setSaveStatus("idle"),3000);
  };

  return (
    <div style={{minHeight:"100vh",background:"#050c0a",fontFamily:"'DM Sans',sans-serif",color:"#fff",maxWidth:480,margin:"0 auto",position:"relative"}}>
      {/* Botao de tutorial */}
      <TutorialButton style={{position:"fixed",top:14,right:14,zIndex:800}} onClick={()=>setShowTutorialPrompt(true)}/>
      {showTutorialPrompt&&<TutorialPrompt screenName="Escalacao" onConfirm={()=>{setShowTutorialPrompt(false);setShowTutorial(true);}} onCancel={()=>setShowTutorialPrompt(false)}/>}
      {showTutorial&&<TutorialOverlay steps={tab==="field"?TUTORIAL_TACTIC_FIELD:TUTORIAL_TACTIC_PLAYERS} onClose={()=>setShowTutorial(false)}/>}
      {toast&&<Toast msg={toast} onDone={()=>setToast(null)}/>}

      {/* Header */}
      <div style={{background:`linear-gradient(180deg,#0a1f12 0%,#050c0a 100%)`,borderBottom:`1px solid ${c1}30`,padding:"12px 14px 10px",position:"sticky",top:0,zIndex:50}}>
        {/* Top row */}
        <div className="teamview-header" style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
          <button onClick={onBack} aria-label="Voltar para a lista de times" style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,padding:"7px 9px",color:"#9CA3AF",cursor:"pointer",display:"flex",alignItems:"center",flexShrink:0,transition:"all 0.15s"}}
            onMouseEnter={e=>{e.currentTarget.style.background="rgba(255,255,255,0.12)";e.currentTarget.style.color="#fff";}}
            onMouseLeave={e=>{e.currentTarget.style.background="rgba(255,255,255,0.06)";e.currentTarget.style.color="#9CA3AF";}}>
            <Ico.Back/>
          </button>

          <div role="button" tabIndex={0} aria-label="Editar dados do time" onKeyDown={e=>{if(e.key==="Enter")setShowEditTeam(true);}} style={{cursor:"pointer",display:"flex",alignItems:"center",gap:10,flex:1,minWidth:0}} onClick={()=>setShowEditTeam(true)}>
            <TeamShield team={team} size={40}/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:"flex",alignItems:"center",gap:5}}>
                <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:"#fff",letterSpacing:0.8,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{team.name}</span>
                <span style={{color:"#4B5563",flexShrink:0}}><Ico.Edit/></span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8,marginTop:1,flexWrap:"wrap",rowGap:3}}>
                <span style={{color:"#4B5563",fontSize:10,fontWeight:600}}>
                  {getActiveLineup(team,team.lineups||[])?.name||"Titular"} · {escalados}/{slots.length} escalados
                </span>
                <SyncIndicator status={syncStatus} onRetry={handleForceSave}/>
              </div>
            </div>
          </div>

          {tab==="field"&&(
            <button className="teamview-export-btn" onClick={()=>setShowExport(true)} style={{
              display:"flex",alignItems:"center",gap:6,padding:"8px 12px",
              background:`${c1}25`,border:`1px solid ${c1}60`,
              borderRadius:10,color:c2,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:800,
              transition:"all 0.15s",flexShrink:0,letterSpacing:0.5
            }}>
              <Ico.Share/>EXPORTAR
            </button>
          )}

          {/* Botão de salvar forçado — sempre visível */}
          <button className="teamview-save-btn" onClick={handleForceSave} disabled={saveStatus==="saving"} title="Salvar dados agora" style={{
            display:"flex",alignItems:"center",justifyContent:"center",gap:5,
            padding:"8px 11px",borderRadius:10,border:"1px solid",
            cursor:saveStatus==="saving"?"wait":"pointer",flexShrink:0,
            transition:"all 0.2s",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:800,letterSpacing:0.3,
            ...(saveStatus==="saved"
              ? {background:"rgba(52,211,153,0.2)",borderColor:"rgba(52,211,153,0.6)",color:"#34d399"}
              : saveStatus==="error"
              ? {background:"rgba(239,68,68,0.15)",borderColor:"rgba(239,68,68,0.5)",color:"#f87171"}
              : saveStatus==="saving"
              ? {background:"rgba(255,255,255,0.06)",borderColor:"rgba(255,255,255,0.15)",color:"#9CA3AF"}
              : {background:"rgba(255,255,255,0.06)",borderColor:"rgba(255,255,255,0.18)",color:"#9CA3AF"}
            )
          }}>
            {saveStatus==="saving"
              ? <div style={{width:14,height:14,border:"2px solid #4B5563",borderTopColor:"#34d399",borderRadius:"50%",animation:"spin 0.7s linear infinite"}}/>
              : saveStatus==="saved"
              ? <><span style={{fontSize:13}}>✓</span>SALVO</>
              : saveStatus==="error"
              ? <><span style={{fontSize:13}}>!</span>ERRO</>
              : <><Ico.Save/>SALVAR</>
            }
          </button>
        </div>

        {/* Mode + Formation row */}
        <div style={{display:"flex",gap:7,alignItems:"center"}}>
          <div style={{flex:1,padding:"5px 12px",borderRadius:8,border:`1px solid ${c1}40`,background:`${c1}12`,textAlign:"center"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"center"}}><Icon id="soccer-ball" size={12} style={{color:c2}}/></div>
            <div style={{fontSize:8,fontWeight:700,color:c2}}>Campo</div>
          </div>
          <div className="teamview-formation-row" style={{display:"flex",gap:5,alignItems:"center"}}>
            <FormationPicker current={team.formation} onChange={handleFormationChange}/>
            <button onClick={()=>setShowFList(true)} aria-label="Ver lista de formações" style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:9,padding:"7px 9px",color:"#9CA3AF",cursor:"pointer",display:"flex",alignItems:"center"}}>
              <Ico.List/>
            </button>
            <button onClick={()=>setShowLineupMgr(true)} title="Gerenciar escalações" aria-label="Gerenciar escalações" style={{background:`${c1}18`,border:`1px solid ${c1}40`,borderRadius:9,padding:"7px 9px",color:c2,cursor:"pointer",display:"flex",alignItems:"center",gap:4,fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:800}}>
              <Ico.Lineup/>{(team.lineups||[]).length>1?<span style={{background:c1,color:"#000",borderRadius:4,padding:"0 4px",fontSize:9,fontWeight:900}}>{(team.lineups||[]).length}</span>:null}
            </button>
            {/* Formação Livre — premium only */}
            {isPremium?(
              <button className="teamview-freemode-btn" onClick={()=>setFreeMode(f=>!f)} title={freeMode?"Voltar à formação fixa":"Ativar formação livre"} style={{
                background:freeMode?"rgba(250,204,21,0.2)":"rgba(255,255,255,0.06)",
                border:freeMode?"1px solid rgba(250,204,21,0.6)":"1px solid rgba(255,255,255,0.12)",
                borderRadius:9,padding:"7px 9px",color:freeMode?"#facc15":"#9CA3AF",
                cursor:"pointer",display:"flex",alignItems:"center",gap:4,
                fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:800,letterSpacing:0.3,whiteSpace:"nowrap"
              }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                {freeMode?"FIXO":"LIVRE"}
              </button>
            ):(
              <button className="teamview-freemode-btn" onClick={()=>setToast("⭐ Formação Livre é exclusiva para usuários Premium!")} title="Formação Livre — Premium" style={{
                background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",
                borderRadius:9,padding:"7px 9px",color:"#4B5563",
                cursor:"pointer",display:"flex",alignItems:"center",gap:4,
                fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:800,letterSpacing:0.3,whiteSpace:"nowrap"
              }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#facc15" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                LIVRE
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="teamview-tabs" style={{display:"flex",background:"rgba(255,255,255,0.02)",borderBottom:"1px solid rgba(255,255,255,0.07)"}}>
        {[{key:"field",label:"Escalação",I:Ico.Tactic},{key:"players",label:`Elenco (${(team.players||[]).filter(p=>!p.isGuest).length})`,I:Ico.Users}].map(t=>(
          <button key={t.key} onClick={()=>setTab(t.key)} style={{
            flex:1,padding:"12px 0",background:"none",border:"none",
            borderBottom:tab===t.key?`2px solid ${c1}`:"2px solid transparent",
            color:tab===t.key?c2:"#6B7280",
            cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",
            gap:7,fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700,transition:"all 0.2s"
          }}><t.I/>{t.label}</button>
        ))}
      </div>

      {/* Content */}
      <div style={{padding:tab==="field"?"12px 11px 100px":"12px 14px 100px"}}>
        {tab==="field"&&(
          <>
            <div style={{marginBottom:9,display:"flex",alignItems:"center",gap:8}}>
              <div style={{flex:1,padding:"6px 12px",background:"rgba(255,255,255,0.03)",borderRadius:9,border:"1px solid rgba(255,255,255,0.06)",fontFamily:"'DM Sans',sans-serif",fontSize:11,color:"#6B7280"}}>
                <Icon id="bulb" size={14} style={{color:"#6B7280",flexShrink:0}}/>
                {freeMode
                  ? <span> <b style={{color:"#facc15"}}>Livre</b> — arraste jogadores para qualquer posição</span>
                  : <span> <b style={{color:"#9CA3AF"}}>Toque</b> para escalar · <b style={{color:"#9CA3AF"}}>Segure</b> para arrastar</span>
                }
              </div>
              <button onClick={()=>{
                const updatedLineups=(team.lineups||[]).map(l=>String(l.id)===String(activeLineup?.id)?{...l,entries:[]}:l);
                upd({lineup:[],lineups:updatedLineups});
                if(onSaveLineup){const al=updatedLineups.find(l=>String(l.id)===String(activeLineup?.id));if(al)onSaveLineup(team.id,al);}
              }} title="Limpar escalação" aria-label="Limpar todos os jogadores escalados" style={{
                flexShrink:0,padding:"7px 12px",borderRadius:9,border:"1px solid rgba(239,68,68,0.25)",
                background:"rgba(239,68,68,0.08)",color:"#f87171",cursor:"pointer",
                fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap"
              }}><Icon id="refresh" size={13}/> Resetar</button>
            </div>
            <div style={{marginBottom:9,display:"flex",flexDirection:"column",gap:5}}>
              <label htmlFor="coach-name" style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:0.5}}>Técnico</label>
              <div style={{display:"flex",gap:8}}>
                <input id="coach-name" value={coachInput} onChange={e=>setCoachInput(e.target.value)} placeholder="Nome do técnico" style={{...IS,flex:1}}
                  onFocus={e=>e.target.style.borderColor=c1} onBlur={e=>e.target.style.borderColor="rgba(255,255,255,0.1)"}
                  onKeyDown={e=>{if(e.key==="Enter"){e.target.blur();confirmCoach();}}}/>
                <button onClick={confirmCoach} aria-label="Confirmar nome do técnico" title="Confirmar" style={{
                  flexShrink:0,padding:"0 18px",borderRadius:10,border:"none",cursor:"pointer",
                  background:coachSaved?"rgba(52,211,153,0.25)":`linear-gradient(135deg,${c1},${c2})`,
                  color:coachSaved?"#34d399":"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:15,letterSpacing:1,
                  display:"flex",alignItems:"center",justifyContent:"center",gap:5,transition:"all 0.2s",
                  boxShadow:coachSaved?"none":`0 2px 10px ${c1}50`
                }}>
                  {coachSaved?<>✓ OK</>:"OK"}
                </button>
              </div>
            </div>
            <div className="football-field-wrap"><FootballField slots={slots} lineup={team.lineup} players={team.players} onLineupChange={l=>upd({lineup:typeof l==="function"?l(team.lineup):l})} onSlotTap={freeMode?()=>{}:handleSlotTap} team={team} freeMode={freeMode} onFreeMoveEnd={handleFreeMoveEnd}/></div>

            {/* Banco de reservas */}
            <div className="teamview-bench" style={{marginTop:14,display:"flex",flexDirection:"column",gap:7}}>
              <span style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:0.5}}>
                Banco de Reservas {(activeLineup?.benchPlayerIds||[]).length>0&&`(${(activeLineup?.benchPlayerIds||[]).length})`}
              </span>
              {(()=>{
                const onFieldIds=new Set((team.lineup||[]).filter(e=>e.playerId).map(e=>String(e.playerId)));
                const candidates=(team.players||[]).filter(p=>!onFieldIds.has(String(p.id)));
                if(candidates.length===0){
                  return (
                    <div style={{padding:"10px 12px",borderRadius:10,background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.06)",color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:11,textAlign:"center"}}>
                      Nenhum jogador disponível para o banco
                    </div>
                  );
                }
                const benchSet=new Set((activeLineup?.benchPlayerIds||[]).map(String));
                const guestPlayersInBench=candidates.filter(p=>p.isGuest);
                return (
                  <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                    {candidates.map(p=>{
                      const onBench=benchSet.has(String(p.id));
                      const isGuestP=!!p.isGuest;
                      const guestIdx=isGuestP?guestPlayersInBench.indexOf(p)+1:0;
                      return (
                        <button key={p.id} onClick={()=>toggleBenchPlayer(p.id)}
                          aria-pressed={onBench}
                          aria-label={onBench?`Remover ${p.name} do banco de reservas`:`Adicionar ${p.name} ao banco de reservas`}
                          style={{
                            display:"flex",alignItems:"center",gap:6,padding:"6px 12px",borderRadius:20,cursor:"pointer",
                            border:onBench?`1.5px solid ${isGuestP?"#fb923c":c1}`:isGuestP?"1px solid rgba(251,146,60,0.2)":"1px solid rgba(255,255,255,0.1)",
                            background:onBench?(isGuestP?"rgba(251,146,60,0.2)":`${c1}22`):(isGuestP?"rgba(251,146,60,0.05)":"rgba(255,255,255,0.03)"),
                            color:onBench?(isGuestP?"#fb923c":c2):(isGuestP?"#fb923c90":"#9CA3AF"),
                            fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700,transition:"all 0.15s"
                          }}>
                          <span style={{opacity:0.7}}>{isGuestP?`C${guestIdx}`:`#${p.number}`}</span>{p.name.split(" ")[0]}
                          {onBench&&<span style={{fontSize:13,lineHeight:1}}>✓</span>}
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </>
        )}
        {tab==="players"&&(
          <PlayersTab
            players={team.players}
            onEdit={(p)=>{setEditingPlayer(p);setShowForm(true);}}
            onDelete={deletePlayer}
            teamColor={team.colorIdx}
            captainPlayerId={team.captainPlayerId}
            onToggleCaptain={toggleCaptain}
            team={team}
          />
        )}
      </div>

      {/* FAB */}
      {tab==="players"&&(
        <>
        <button className="players-fab" onClick={()=>{
          if(!isPremium&&(team.players||[]).filter(p=>!p.isGuest).length>=FREE_PLAYER_LIMIT){setShowPlayerLimitUpsell(true);return;}
          setEditingPlayer(null);setShowGuestForm(false);setShowForm(true);
        }} style={{
          position:"fixed",bottom:80,right:20,width:56,height:56,borderRadius:"50%",
          background:`linear-gradient(135deg,${c1},${c2})`,border:"none",cursor:"pointer",
          display:"flex",alignItems:"center",justifyContent:"center",
          boxShadow:`0 6px 24px ${c1}70`,zIndex:100,transition:"transform 0.15s"
        }}
          onMouseEnter={e=>e.currentTarget.style.transform="scale(1.1)"}
          onMouseLeave={e=>e.currentTarget.style.transform="scale(1)"}
          aria-label="Adicionar novo jogador">
          <Ico.Plus/>
        </button>
        {/* Add Guest FAB — secondary button above the main FAB */}
        <button className="players-guest-fab" onClick={()=>{
          const guests=(team.players||[]).filter(p=>p.isGuest);
          if(!isPremium&&guests.length>=FREE_GUEST_LIMIT){setShowGuestLimitUpsell(true);return;}
          setEditingPlayer(null);setShowGuestForm(true);setShowForm(true);
        }} style={{
          position:"fixed",bottom:148,right:20,
          padding:"8px 14px",borderRadius:28,
          background:"rgba(251,146,60,0.18)",border:"1.5px solid rgba(251,146,60,0.5)",cursor:"pointer",
          display:"flex",alignItems:"center",gap:6,
          color:"#fb923c",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:800,letterSpacing:0.4,
          boxShadow:"0 4px 16px rgba(251,146,60,0.25)",zIndex:100,transition:"all 0.15s"
        }}
          onMouseEnter={e=>{e.currentTarget.style.background="rgba(251,146,60,0.28)";}}
          onMouseLeave={e=>{e.currentTarget.style.background="rgba(251,146,60,0.18)";}}
          aria-label="Adicionar jogador convidado">
          <Icon id="ticket" size={12}/> + Convidado
        </button>
        </>
      )}

      {showForm&&<PlayerFormModal initial={editingPlayer} onSave={savePlayer} teamColor={team.colorIdx} isGuest={showGuestForm&&!editingPlayer} onClose={()=>{setShowForm(false);setEditingPlayer(null);setShowGuestForm(false);}}/>}
      {activeSlot&&<SlotPickerModal slotLabel={activeSlot.label} players={team.players} lineup={team.lineup.filter(l=>l.slotId!==activeSlot.slotId)} onPick={pickPlayer} onClear={team.lineup.find(l=>l.slotId===activeSlot.slotId)?clearSlot:null} onClose={()=>setActiveSlot(null)} team={team}/>}
      {showExport&&<ExportModal slots={slots} lineup={team.lineup} players={team.players} teamName={team.name} formation={team.formation} team={team} coach={activeLineup?.coach||""} benchPlayerIds={activeLineup?.benchPlayerIds||[]} isPremium={isPremium} onClose={()=>setShowExport(false)}/>}
      {showFList&&<FormationListModal current={team.formation} onSelect={handleFormationChange} onClose={()=>setShowFList(false)}/>}
      {showLineupMgr&&<LineupManagerModal team={team} isPremium={isPremium} onClose={()=>setShowLineupMgr(false)}
        onActivate={(lineupId)=>{
          const lu=team.lineups||[];
          const updated=lu.map(l=>({...l,isActive:String(l.id)===String(lineupId)}));
          const al=updated.find(l=>l.isActive)||updated[0];
          upd({lineups:updated,activeLineupId:String(lineupId),formation:al?.formation||"4-4-2",lineup:al?.entries||[]});
        }}
        onRename={(lineupId,newName)=>{
          const updated=(team.lineups||[]).map(l=>l.id===lineupId?{...l,name:newName}:l);
          upd({lineups:updated});
          const tgt=updated.find(l=>String(l.id)===String(lineupId));
          if(tgt&&onSaveLineup)onSaveLineup(team.id,tgt);
        }}
        onCreate={(type,name)=>{
          const slots=FORMATIONS[team.formation]?.slots||FORMATIONS["4-4-2"].slots;
          const newL=makeLineup({id:genUUID(),name,type,formation:team.formation||"4-4-2",entries:[],isActive:false});
          const updated=[...(team.lineups||[]),newL];
          upd({lineups:updated});
          if(onSaveLineup)onSaveLineup(team.id,newL);
          setToast(`Escalação "${name}" criada!`);
        }}
        onDelete={(lineupId)=>{
          const lu=team.lineups||[];
          if(lu.length<=1){setToast("Mantenha ao menos 1 escalação.");return;}
          const updated=lu.filter(l=>String(l.id)!==String(lineupId));
          // If we deleted the active one, activate the first remaining
          let newActive=team.activeLineupId;
          if(String(team.activeLineupId)===String(lineupId)){
            updated[0].isActive=true;
            newActive=updated[0].id;
          }
          const al=getActiveLineup({activeLineupId:newActive},updated)||updated[0];
          upd({lineups:updated,activeLineupId:String(newActive),formation:al?.formation||"4-4-2",lineup:al?.entries||[]});
          if(onDeleteLineup)onDeleteLineup(team.id,lineupId);
          setToast("Escalação removida.");
        }}
      />}
      {showEditTeam&&<TeamFormModal initial={team} isPremium={isPremium} onSave={async(f)=>{
        // PhotoPicker already compressed the image (≤300x300, JPEG 75%) — use it as-is.
        upd(f);setShowEditTeam(false);setToast("Time atualizado!");
      }} onClose={()=>setShowEditTeam(false)}/>}
      {showPlayerLimitUpsell&&<PremiumUpsellModal
        title="Limite de jogadores"
        description={`No plano gratuito você pode cadastrar até ${FREE_PLAYER_LIMIT} jogadores por time. Faça upgrade para o premium e cadastre jogadores ilimitados.`}
        onClose={()=>setShowPlayerLimitUpsell(false)}
      />}
      {showGuestLimitUpsell&&<PremiumUpsellModal
        title="Limite de convidados"
        description={`No plano gratuito você pode adicionar ${FREE_GUEST_LIMIT} jogador convidado por time. Faça upgrade para o premium e adicione convidados ilimitados.`}
        onClose={()=>setShowGuestLimitUpsell(false)}
      />}
    </div>
  );
}

// ─── Login Screen ─────────────────────────────────────────────────────────────
function LoginScreen({onLogin, loading}) {
  return (
    <div style={{minHeight:"100vh",background:"#050c0a",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"24px",fontFamily:"'DM Sans',sans-serif",position:"relative",overflow:"hidden"}}>
      {/* Field bg decoration */}
      <svg style={{position:"absolute",inset:0,width:"100%",height:"100%",opacity:0.04,pointerEvents:"none"}} viewBox="0 0 400 800" preserveAspectRatio="xMidYMid slice">
        <rect x="20" y="20" width="360" height="760" fill="none" stroke="#34d399" strokeWidth="2"/>
        <line x1="20" y1="400" x2="380" y2="400" stroke="#34d399" strokeWidth="1.5"/>
        <circle cx="200" cy="400" r="70" fill="none" stroke="#34d399" strokeWidth="1.5"/>
        <circle cx="200" cy="400" r="5" fill="#34d399"/>
        <rect x="120" y="20" width="160" height="80" fill="none" stroke="#34d399" strokeWidth="1.5"/>
        <rect x="120" y="700" width="160" height="80" fill="none" stroke="#34d399" strokeWidth="1.5"/>
        <rect x="160" y="20" width="80" height="36" fill="none" stroke="#34d399" strokeWidth="1.5"/>
        <rect x="160" y="744" width="80" height="36" fill="none" stroke="#34d399" strokeWidth="1.5"/>
      </svg>

      <div style={{position:"relative",display:"flex",flexDirection:"column",alignItems:"center",gap:24,maxWidth:360,width:"100%"}}>
        {/* Logo */}
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:10}}>
          <div style={{width:90,height:90,borderRadius:24,overflow:"hidden",
            boxShadow:"0 12px 40px rgba(52,211,153,0.5)"}}>
            <img src={LOGO_URI} alt="Escalação FC" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
          </div>
          <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:42,color:"#fff",letterSpacing:3,lineHeight:1,textAlign:"center"}}>ESCALAÇÃO FC</div>
          <div style={{color:"#4ade80",fontSize:13,fontWeight:700,letterSpacing:2,textAlign:"center"}}>GERENCIE SEUS TIMES</div>
        </div>

        {/* Divider */}
        <div style={{width:"100%",height:1,background:"linear-gradient(90deg,transparent,rgba(52,211,153,0.3),transparent)"}}/>

        {/* Features */}
        <div style={{display:"flex",flexDirection:"column",gap:10,width:"100%"}}>
          {[
            {icon:"cloud",       text:"Dados salvos na nuvem, acessíveis em qualquer dispositivo"},
            {icon:"soccer-ball", text:"Crie times, monte escalações e gerencie elencos"},
            {icon:"camera",      text:"Exporte e compartilhe sua escalação como imagem"},
          ].map(({icon,text})=>(
            <div key={text} style={{display:"flex",alignItems:"center",gap:12,padding:"11px 14px",background:"rgba(255,255,255,0.03)",borderRadius:12,border:"1px solid rgba(255,255,255,0.07)"}}>
              <Icon id={icon} size={20} style={{flexShrink:0,color:"#34d399"}}/>
              <span style={{color:"#9CA3AF",fontSize:13,lineHeight:1.4}}>{text}</span>
            </div>
          ))}
        </div>

        {/* Login button */}
        <button onClick={onLogin} disabled={loading} style={{
          width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:12,
          padding:"16px 24px",borderRadius:16,border:"none",cursor:loading?"wait":"pointer",
          background:loading?"rgba(255,255,255,0.08)":"#fff",
          color:loading?"#6B7280":"#1a1a1a",
          fontFamily:"'DM Sans',sans-serif",fontSize:16,fontWeight:800,
          boxShadow:loading?"none":"0 8px 30px rgba(255,255,255,0.15)",
          transition:"all 0.2s",letterSpacing:0.3
        }}>
          {loading?(
            <>
              <div style={{width:22,height:22,border:"3px solid #4B5563",borderTopColor:"#34d399",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
              Entrando...
            </>
          ):(
            <>
              {/* Google icon */}
              <svg width="22" height="22" viewBox="0 0 48 48">
                <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 7.9 3l5.7-5.7C34.5 6.5 29.5 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.9z"/>
                <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.5 16 19 12 24 12c3.1 0 5.8 1.1 7.9 3l5.7-5.7C34.5 6.5 29.5 4 24 4c-7.7 0-14.4 4.4-17.7 10.7z"/>
                <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.1l-6.2-5.2C29.3 35.5 26.8 36 24 36c-5.2 0-9.6-3.3-11.3-8H6.1C9.4 39.4 16.1 44 24 44z"/>
                <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.3 4.1-4.2 5.5l6.2 5.2C41.2 35.5 44 30.1 44 24c0-1.3-.1-2.7-.4-3.9z"/>
              </svg>
              Entrar com Google
            </>
          )}
        </button>

        <div style={{color:"#374151",fontSize:11,textAlign:"center",lineHeight:1.5}}>
          Ao entrar, você concorda com o uso dos seus dados<br/>apenas para funcionamento do app.
        </div>
      </div>
    </div>
  );
}

// ─── Bottom Navigation Bar ────────────────────────────────────────────────────
function BottomNav({active,onChange}) {
  const tabs=[
    {id:"home",    label:"Times",      Icon:Ico.NavHome},
    {id:"tactic",  label:"Escalação",  Icon:Ico.NavTactic},
    {id:"office",  label:"Escritório", Icon:Ico.NavOffice},
  ];
  return (
    <>
      <style>{`
        @keyframes bnTabPop{0%{transform:scale(0.88);}100%{transform:scale(1);}}
        .bn-tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;background:none;border:none;cursor:pointer;padding:10px 0 6px;position:relative;-webkit-tap-highlight-color:transparent;transition:transform 0.12s;}
        .bn-tab:active{transform:scale(0.9);}
        .bn-pill{position:absolute;top:5px;left:50%;transform:translateX(-50%);width:40px;height:32px;border-radius:10px;background:rgba(52,211,153,0.12);pointer-events:none;}
        .bn-label{font-family:'DM Sans',sans-serif;font-size:9px;letter-spacing:0.5px;}
        .bn-dot{width:4px;height:4px;border-radius:50%;background:#34d399;margin-top:1px;}
      `}</style>
      <div style={{
        position:"fixed",bottom:0,left:0,right:0,zIndex:900,
        background:"rgba(3,8,6,0.97)",
        borderTop:"1px solid rgba(52,211,153,0.08)",
        backdropFilter:"blur(20px)",WebkitBackdropFilter:"blur(20px)",
        display:"flex",alignItems:"stretch",
        paddingBottom:"env(safe-area-inset-bottom,0px)",
        boxShadow:"0 -8px 32px rgba(0,0,0,0.4)"
      }}>
        {tabs.map(({id,label,Icon})=>{
          const on=active===id;
          return (
            <button key={id} className="bn-tab" onClick={()=>onChange(id)}
              style={{color:on?"#34d399":"#374151"}} aria-label={label} aria-current={on?"page":undefined}>
              {on&&<div className="bn-pill"/>}
              <Icon/>
              <span className="bn-label" style={{color:on?"#34d399":"#4B5563",fontWeight:on?800:500}}>{label}</span>
              {on&&<div className="bn-dot"/>}
            </button>
          );
        })}
      </div>
    </>
  );
}

// ─── Match Modal (add/edit a calendar event) ──────────────────────────────────
const MATCH_TYPES=[
  {id:"friendly",  label:"Amistoso",    icon:"handshake"},
  {id:"festival",  label:"Festival",    icon:"festival"},
  {id:"tournament",label:"Torneio",     icon:"trophy"},
  {id:"league",    label:"Campeonato",  icon:"competition"},
];
const MATCH_TYPES_WITH_NAME=["festival","tournament","league"];

function MatchModal({initial,players,onSave,onClose}) {
  const empty={opponent:"",date:"",time:"",location:"",notes:"",goalsFor:"",goalsAgainst:"",scorers:[],assisters:[],gkGoalsConceded:{},matchType:"friendly",competitionName:"",presentPlayerIds:[],homeAway:"home"};
  const [form,setForm]=useState(()=>initial?{...empty,...initial}:empty);
  const [playerSearch,setPlayerSearch]=useState("");
  const [expandedPlayer,setExpandedPlayer]=useState(null);
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const valid=form.opponent.trim()&&form.date;
  const hasResult=form.goalsFor!==""&&form.goalsFor!==undefined&&form.goalsFor!==null;
  const outfield=(players||[]).filter(p=>p.position!=="Goleiro");
  const goalkeepers=(players||[]).filter(p=>p.position==="Goleiro");
  const needsCompName=MATCH_TYPES_WITH_NAME.includes(form.matchType||"friendly");

  const adjustCount=(arr,pid,delta)=>{
    const list=[...(arr||[])];
    if(delta>0) list.push(pid);
    else { const idx=list.lastIndexOf(pid); if(idx>=0)list.splice(idx,1); }
    return list;
  };
  const countInArr=(arr,pid)=>(arr||[]).filter(x=>x===pid).length;

  // Filter + sort alphabetically
  const filterPlayers=(list)=>{
    const q=playerSearch.trim().toLowerCase();
    return [...list]
      .filter(p=>!q||p.name.toLowerCase().includes(q))
      .sort((a,b)=>a.name.localeCompare(b.name,"pt-BR"));
  };

  // Compute per-player summary badges for collapsed card
  const getPlayerBadges=(p,isGK)=>{
    const pid=String(p.id);
    const badges=[];
    const goals=countInArr(form.scorers,pid);
    const assists=countInArr(form.assisters,pid);
    const present=(form.presentPlayerIds||[]).includes(pid);
    const gkGA=(form.gkGoalsConceded||{})[pid]||0;
    if(present) badges.push({icon:"clipboard",val:null,color:"#34d399"});
    if(goals>0) badges.push({icon:"soccer-ball",val:goals,color:"#34d399"});
    if(assists>0) badges.push({icon:"target",val:assists,color:"#f59e0b"});
    if(isGK&&gkGA>0) badges.push({icon:"goalkeeper",val:gkGA,color:"#f87171"});
    return badges;
  };

  // Render a unified player card (outfield or GK)
  const renderPlayerCard=(p,isGK)=>{
    const pid=String(p.id);
    const isExpanded=expandedPlayer===pid;
    const present=(form.presentPlayerIds||[]).includes(pid);
    const goals=countInArr(form.scorers,pid);
    const assists=countInArr(form.assisters,pid);
    const gkGA=(form.gkGoalsConceded||{})[pid]||0;
    const badges=getPlayerBadges(p,isGK);
    const hasActivity=present||goals>0||assists>0||(isGK&&gkGA>0);

    return (
      <div key={pid} style={{borderRadius:11,border:"1px solid",overflow:"hidden",transition:"all 0.15s",
        borderColor:hasActivity?"rgba(52,211,153,0.3)":"rgba(255,255,255,0.07)",
        background:hasActivity?"rgba(52,211,153,0.04)":"rgba(255,255,255,0.02)"}}>
        {/* Collapsed header — click to expand */}
        <button onClick={()=>setExpandedPlayer(isExpanded?null:pid)} style={{
          width:"100%",display:"flex",alignItems:"center",gap:8,padding:"8px 10px",
          background:"none",border:"none",cursor:"pointer",textAlign:"left"
        }}>
          <PlayerAvatar player={p} size={30}/>
          <div style={{flex:1,minWidth:0}}>
            <div style={{color:hasActivity?"#e5e7eb":"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.name}</div>
            <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:10}}>{p.position}{p.isGuest?" · Convidado":(p.number?" · #"+p.number:"")}</div>
          </div>
          {badges.length>0&&(
            <div style={{display:"flex",gap:4,alignItems:"center"}}>
              {badges.map((b,i)=>(
                <span key={i} style={{fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700,color:b.color,background:"rgba(0,0,0,0.25)",borderRadius:6,padding:"1px 5px",display:"flex",alignItems:"center",gap:2}}>
                  <Icon id={b.icon} size={11} style={{color:b.color}}/>{b.val!==null&&<span>{b.val}</span>}
                </span>
              ))}
            </div>
          )}
          <span style={{color:"#4B5563",fontSize:14,marginLeft:2,transition:"transform 0.15s",display:"inline-block",transform:isExpanded?"rotate(180deg)":"rotate(0deg)"}}>▾</span>
        </button>

        {/* Expanded panel */}
        {isExpanded&&(
          <div style={{borderTop:"1px solid rgba(255,255,255,0.06)",padding:"10px 12px",display:"flex",flexDirection:"column",gap:10,background:"rgba(0,0,0,0.15)"}}>

            {/* Presença toggle */}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <span style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:600,display:"flex",alignItems:"center",gap:5}}>
                <span style={{fontSize:13}}><Icon id="clipboard" size={13} style={{color:"#9CA3AF"}}/></span> Presença
              </span>
              <button onClick={()=>{
                const cur=form.presentPlayerIds||[];
                set("presentPlayerIds",present?cur.filter(id=>id!==pid):[...cur,pid]);
              }} style={{
                padding:"4px 14px",borderRadius:8,border:"1px solid",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,
                borderColor:present?"rgba(52,211,153,0.5)":"rgba(255,255,255,0.12)",
                background:present?"rgba(52,211,153,0.15)":"rgba(255,255,255,0.04)",
                color:present?"#34d399":"#6B7280"
              }}>{present?"✓ Presente":"○ Ausente"}</button>
            </div>

            {/* Gols (only if hasResult && goalsFor > 0) */}
            {hasResult&&parseInt(form.goalsFor||0)>0&&(
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <span style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:600,display:"flex",alignItems:"center",gap:5}}>
                  <Icon id="soccer-ball" size={13} style={{color:"#9CA3AF"}}/> Gols
                </span>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <button onClick={()=>set("scorers",adjustCount(form.scorers,pid,-1))} disabled={goals===0}
                    style={{width:28,height:28,borderRadius:8,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.05)",color:goals===0?"#2d3748":"#9CA3AF",cursor:goals===0?"default":"pointer",fontSize:17,display:"flex",alignItems:"center",justifyContent:"center"}}>-</button>
                  <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:goals>0?"#34d399":"#4B5563",minWidth:22,textAlign:"center"}}>{goals}</span>
                  <button onClick={()=>set("scorers",adjustCount(form.scorers,pid,1))}
                    style={{width:28,height:28,borderRadius:8,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.05)",color:"#9CA3AF",cursor:"pointer",fontSize:17,display:"flex",alignItems:"center",justifyContent:"center"}}>+</button>
                </div>
              </div>
            )}

            {/* Assistências (only if hasResult && goalsFor > 0) */}
            {hasResult&&parseInt(form.goalsFor||0)>0&&(
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <span style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:600,display:"flex",alignItems:"center",gap:5}}>
                  <Icon id="target" size={13} style={{color:"#9CA3AF"}}/> Assistências
                </span>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <button onClick={()=>set("assisters",adjustCount(form.assisters,pid,-1))} disabled={assists===0}
                    style={{width:28,height:28,borderRadius:8,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.05)",color:assists===0?"#2d3748":"#9CA3AF",cursor:assists===0?"default":"pointer",fontSize:17,display:"flex",alignItems:"center",justifyContent:"center"}}>-</button>
                  <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:assists>0?"#f59e0b":"#4B5563",minWidth:22,textAlign:"center"}}>{assists}</span>
                  <button onClick={()=>set("assisters",adjustCount(form.assisters,pid,1))}
                    style={{width:28,height:28,borderRadius:8,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.05)",color:"#9CA3AF",cursor:"pointer",fontSize:17,display:"flex",alignItems:"center",justifyContent:"center"}}>+</button>
                </div>
              </div>
            )}

            {/* Gols sofridos — apenas goleiros, quando goalsAgainst > 0 */}
            {isGK&&hasResult&&parseInt(form.goalsAgainst||0)>0&&(
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <span style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:600,display:"flex",alignItems:"center",gap:5}}>
                  <Icon id="goalkeeper" size={13} style={{color:"#9CA3AF"}}/> Gols sofridos
                </span>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <button onClick={()=>set("gkGoalsConceded",{...(form.gkGoalsConceded||{}),[pid]:Math.max(0,gkGA-1)})} disabled={gkGA===0}
                    style={{width:28,height:28,borderRadius:8,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.05)",color:gkGA===0?"#2d3748":"#9CA3AF",cursor:gkGA===0?"default":"pointer",fontSize:17,display:"flex",alignItems:"center",justifyContent:"center"}}>-</button>
                  <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:gkGA>0?"#f87171":"#4B5563",minWidth:22,textAlign:"center"}}>{gkGA}</span>
                  <button onClick={()=>set("gkGoalsConceded",{...(form.gkGoalsConceded||{}),[pid]:gkGA+1})}
                    style={{width:28,height:28,borderRadius:8,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.05)",color:"#9CA3AF",cursor:"pointer",fontSize:17,display:"flex",alignItems:"center",justifyContent:"center"}}>+</button>
                </div>
              </div>
            )}

          </div>
        )}
      </div>
    );
  };

  const filteredOutfield=filterPlayers(outfield);
  const filteredGK=filterPlayers(goalkeepers);

  return (
    <div style={{position:"fixed",inset:0,zIndex:1200,display:"flex",alignItems:"flex-end",justifyContent:"center",background:"rgba(0,0,0,0.8)",backdropFilter:"blur(6px)"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#0d1f17",border:"1px solid rgba(255,255,255,0.1)",borderRadius:"18px 18px 0 0",width:"100%",maxWidth:480,maxHeight:"92vh",overflowY:"auto",padding:"18px 18px 32px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:"#fff",letterSpacing:1}}>{initial?.id?"Editar Partida":"Nova Partida"}</span>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer"}}><Ico.Close/></button>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>

          {/* Match type selector */}
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            <span style={LT}>Tipo de jogo</span>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6}}>
              {MATCH_TYPES.map(t=>(
                <button key={t.id} onClick={()=>set("matchType",t.id)} style={{
                  display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:"8px 4px",
                  borderRadius:10,border:"2px solid",cursor:"pointer",
                  borderColor:form.matchType===t.id?"#34d399":"rgba(255,255,255,0.08)",
                  background:form.matchType===t.id?"rgba(52,211,153,0.1)":"rgba(255,255,255,0.02)",
                  transition:"all 0.15s"
                }}>
                  <Icon id={t.icon} size={18} style={{color:form.matchType===t.id?"#34d399":"#9CA3AF"}}/>
                  <span style={{color:form.matchType===t.id?"#34d399":"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:800,textTransform:"uppercase"}}>{t.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Casa / Fora */}
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            <span style={LT}>Local do jogo</span>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
              {[{id:"home",label:"Casa",icon:"home"},{id:"away",label:"Fora",icon:"airplane"}].map(opt=>(
                <button key={opt.id} onClick={()=>set("homeAway",opt.id)} style={{
                  display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:"9px 4px",
                  borderRadius:10,border:"2px solid",cursor:"pointer",
                  borderColor:(form.homeAway||"home")===opt.id?"#34d399":"rgba(255,255,255,0.08)",
                  background:(form.homeAway||"home")===opt.id?"rgba(52,211,153,0.1)":"rgba(255,255,255,0.02)",
                  transition:"all 0.15s"
                }}>
                  <Icon id={opt.icon} size={18} style={{color:(form.homeAway||"home")===opt.id?"#34d399":"#9CA3AF"}}/>
                  <span style={{color:(form.homeAway||"home")===opt.id?"#34d399":"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:800,textTransform:"uppercase"}}>{opt.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Competition name */}
          {needsCompName&&(
            <div style={{display:"flex",flexDirection:"column",gap:4}}>
              <label style={LT}>Nome do {MATCH_TYPES.find(t=>t.id===form.matchType)?.label}</label>
              <input value={form.competitionName||""} onChange={e=>set("competitionName",e.target.value)}
                placeholder={`Ex: Copa São Paulo 2025`} style={IS}
                onFocus={e=>e.target.style.borderColor="#34d399"} onBlur={e=>e.target.style.borderColor="rgba(255,255,255,0.1)"}/>
            </div>
          )}

          {/* Basic fields */}
          {[
            {k:"opponent",label:"Adversário",placeholder:"Ex: Flamengo",required:true},
            {k:"date",    label:"Data",placeholder:"",type:"date",required:true},
            {k:"time",    label:"Horário",placeholder:"",type:"time"},
            {k:"location",label:"Local",placeholder:"Ex: Estádio Maracanã"},
            {k:"notes",   label:"Observações",placeholder:"Anotações sobre a partida..."},
          ].map(({k,label,placeholder,type,required})=>(
            <div key={k} style={{display:"flex",flexDirection:"column",gap:4}}>
              <label style={LT}>{label}{required&&<span style={{color:"#f87171",marginLeft:2}}>*</span>}</label>
              <input value={form[k]||""} onChange={e=>set(k,e.target.value)} type={type||"text"} placeholder={placeholder}
                style={{...IS,colorScheme:"dark"}}
                onFocus={e=>e.target.style.borderColor="#34d399"} onBlur={e=>e.target.style.borderColor="rgba(255,255,255,0.1)"}/>
            </div>
          ))}

          {/* Score */}
          <div style={{display:"flex",flexDirection:"column",gap:8,padding:"12px",background:"rgba(255,255,255,0.03)",borderRadius:12,border:"1px solid rgba(255,255,255,0.07)"}}>
            <span style={LT}>Resultado (após a partida)</span>
            <div style={{display:"flex",gap:8,alignItems:"center",justifyContent:"center"}}>
              <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                <span style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:700}}>SEU TIME</span>
                <input value={form.goalsFor||""} onChange={e=>set("goalsFor",e.target.value.replace(/\D/,""))} placeholder="0"
                  style={{...IS,width:72,textAlign:"center",fontSize:28,fontFamily:"'Bebas Neue',sans-serif",padding:"8px 0"}} inputMode="numeric"
                  onFocus={e=>e.target.style.borderColor="#34d399"} onBlur={e=>e.target.style.borderColor="rgba(255,255,255,0.1)"}/>
              </div>
              <span style={{color:"#9CA3AF",fontFamily:"'Bebas Neue',sans-serif",fontSize:30,paddingTop:16}}>×</span>
              <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                <span style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:700}}>{form.opponent||"ADVERSÁRIO"}</span>
                <input value={form.goalsAgainst||""} onChange={e=>set("goalsAgainst",e.target.value.replace(/\D/,""))} placeholder="0"
                  style={{...IS,width:72,textAlign:"center",fontSize:28,fontFamily:"'Bebas Neue',sans-serif",padding:"8px 0"}} inputMode="numeric"
                  onFocus={e=>e.target.style.borderColor="#34d399"} onBlur={e=>e.target.style.borderColor="rgba(255,255,255,0.1)"}/>
              </div>
            </div>
          </div>

          {/* ── Jogadores unificados ── */}
          {(players||[]).length>0&&(
            <div style={{display:"flex",flexDirection:"column",gap:10,padding:"12px",background:"rgba(255,255,255,0.03)",borderRadius:12,border:"1px solid rgba(255,255,255,0.07)"}}>

              {/* Header + contadores */}
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <span style={{...LT,fontSize:9,display:"flex",alignItems:"center",gap:3}}><Icon id="users" size={9}/> Jogadores</span>
                <div style={{display:"flex",gap:6}}>
                  <button onClick={()=>set("presentPlayerIds",(players||[]).map(p=>String(p.id)))} style={{
                    padding:"2px 8px",borderRadius:6,border:"1px solid rgba(52,211,153,0.3)",background:"rgba(52,211,153,0.08)",
                    color:"#34d399",fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:700,cursor:"pointer"
                  }}>Todos ✓</button>
                  <button onClick={()=>set("presentPlayerIds",[])} style={{
                    padding:"2px 8px",borderRadius:6,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.03)",
                    color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:700,cursor:"pointer"
                  }}>Limpar</button>
                </div>
              </div>

              {/* Busca */}
              <div style={{position:"relative"}}>
                <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",pointerEvents:"none",display:"flex",alignItems:"center"}}><Icon id="search" size={13} style={{color:"#6B7280"}}/></span>
                <input
                  value={playerSearch}
                  onChange={e=>{setPlayerSearch(e.target.value);setExpandedPlayer(null);}}
                  placeholder="Buscar jogador..."
                  style={{...IS,paddingLeft:32,fontSize:12}}
                  onFocus={e=>e.target.style.borderColor="#34d399"}
                  onBlur={e=>e.target.style.borderColor="rgba(255,255,255,0.1)"}
                />
              </div>

              {/* Presença total */}
              <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:10,textAlign:"right"}}>
                {(form.presentPlayerIds||[]).length}/{(players||[]).length} presentes
              </div>

              {/* Lista: Jogadores de linha */}
              {filteredOutfield.length>0&&(
                <div style={{display:"flex",flexDirection:"column",gap:0}}>
                  <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:1,marginBottom:5,paddingLeft:2,display:"flex",alignItems:"center",gap:4}}>
                    <Icon id="soccer-ball" size={9}/> Jogadores de linha ({filteredOutfield.length})
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:5}}>
                    {filteredOutfield.map(p=>renderPlayerCard(p,false))}
                  </div>
                </div>
              )}

              {/* Lista: Goleiros */}
              {filteredGK.length>0&&(
                <div style={{display:"flex",flexDirection:"column",gap:0,marginTop:filteredOutfield.length>0?8:0}}>
                  <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:1,marginBottom:5,paddingLeft:2,display:"flex",alignItems:"center",gap:4}}>
                    <Icon id="goalkeeper" size={9}/> Goleiros ({filteredGK.length})
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:5}}>
                    {filteredGK.map(p=>renderPlayerCard(p,true))}
                  </div>
                </div>
              )}

              {/* Sem resultados na busca */}
              {filteredOutfield.length===0&&filteredGK.length===0&&(
                <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:12,textAlign:"center",padding:"12px 0"}}>
                  Nenhum jogador encontrado para "{playerSearch}"
                </div>
              )}
            </div>
          )}

          <button onClick={()=>valid&&onSave(form)} disabled={!valid} style={{
            padding:"13px 0",borderRadius:12,border:"none",cursor:valid?"pointer":"default",
            background:valid?"linear-gradient(135deg,#16a34a,#34d399)":"rgba(255,255,255,0.06)",
            color:valid?"#fff":"#4B5563",fontFamily:"'Bebas Neue',sans-serif",fontSize:16,letterSpacing:1
          }}>SALVAR PARTIDA</button>
        </div>
      </div>
    </div>
  );
}

// ─── Stats View (per-player stats within OfficeView) ──────────────────────────
function StatsView({team,stats,onUpdateStat}) {
  const allPlayers=team.players||[];
  const players=allPlayers.filter(p=>!p.isGuest);
  const guests=allPlayers.filter(p=>!!p.isGuest);
  if(!allPlayers.length) return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"40px 20px",gap:10,color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:13,textAlign:"center"}}>
      <Ico.Users/><span>Cadastre jogadores no time para registrar estatísticas.</span>
    </div>
  );
  // Sort: GKs last, then by number
  const sorted=[...players].sort((a,b)=>{
    if(a.position==="Goleiro"&&b.position!=="Goleiro")return 1;
    if(a.position!=="Goleiro"&&b.position==="Goleiro")return -1;
    return (parseInt(a.number)||0)-(parseInt(b.number)||0);
  });
  const renderPlayerStatRow=(p,isGuestPlayer,guestIdx)=>{
    const st=stats[String(p.id)]||{goals:0,assists:0,goalsAgainst:0,appearances:0};
    const isGK=p.position==="Goleiro";
    const statItems=[
      {key:"appearances",  label:"Presenças",     icon:"clipboard",  color:"#60a5fa"},
      {key:"goals",        label:"Gols",          icon:"soccer-ball",color:"#34d399"},
      {key:"assists",      label:"Assistências",  icon:"target",     color:"#f59e0b"},
      ...(isGK?[{key:"goalsAgainst",label:"Gols sofridos",icon:"goalkeeper",color:"#f87171"}]:[]),
    ];
    return (
      <div key={p.id} style={{background:isGuestPlayer?"rgba(251,146,60,0.04)":"rgba(255,255,255,0.03)",border:isGuestPlayer?"1px solid rgba(251,146,60,0.15)":"1px solid rgba(255,255,255,0.07)",borderRadius:14,padding:"12px 14px",display:"flex",alignItems:"center",gap:10}}>
        <PlayerAvatar player={p} size={44} team={team}/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:5}}>
            <span style={{color:"#fff",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}</span>
            {isGuestPlayer&&<span style={{background:"rgba(251,146,60,0.18)",color:"#fb923c",borderRadius:4,padding:"1px 5px",fontSize:9,fontWeight:800,flexShrink:0}}>C{guestIdx}</span>}
          </div>
          <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11}}>{p.position}{isGuestPlayer?<span style={{color:"#fb923c"}}> · Convidado</span>:<span> · #{p.number}</span>}</div>
        </div>
        <div style={{display:"flex",gap:8}}>
          {statItems.map(({key,label,icon,color})=>(
            <div key={key} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
              <Icon id={icon} size={14} title={label} style={{color}}/>
              <div style={{display:"flex",alignItems:"center",gap:3}}>
                <button onClick={()=>onUpdateStat(p.id,key,Math.max(0,(st[key]||0)-1))}
                  style={{width:20,height:20,borderRadius:6,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.04)",color:"#9CA3AF",cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",justifyContent:"center"}}>-</button>
                <span style={{color,fontFamily:"'Bebas Neue',sans-serif",fontSize:18,minWidth:20,textAlign:"center"}}>{st[key]||0}</span>
                <button onClick={()=>onUpdateStat(p.id,key,(st[key]||0)+1)}
                  style={{width:20,height:20,borderRadius:6,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.04)",color:"#9CA3AF",cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",justifyContent:"center"}}>+</button>
              </div>
              <span style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:7,fontWeight:700,textTransform:"uppercase",textAlign:"center",maxWidth:44,lineHeight:1.2}}>{label}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };
  return (
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      {sorted.map(p=>renderPlayerStatRow(p,false,0))}
      {guests.length>0&&(
        <>
          <div style={{display:"flex",alignItems:"center",gap:8,marginTop:10}}>
            <div style={{flex:1,height:1,background:"rgba(251,146,60,0.2)"}}/>
            <span style={{color:"#fb923c",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:800,textTransform:"uppercase",letterSpacing:0.7,flexShrink:0,display:"flex",alignItems:"center",gap:4}}><Icon id="ticket" size={10}/> Convidados</span>
            <div style={{flex:1,height:1,background:"rgba(251,146,60,0.2)"}}/>
          </div>
          <div style={{background:"rgba(251,146,60,0.06)",border:"1px solid rgba(251,146,60,0.15)",borderRadius:10,padding:"8px 12px",fontFamily:"'DM Sans',sans-serif",fontSize:11,color:"#fb923c",lineHeight:1.5}}>
            ℹ️ As estatísticas de convidados não entram nos dados gerais do time.
          </div>
          {guests.map((p,i)=>renderPlayerStatRow(p,true,i+1))}
        </>
      )}
    </div>
  );
}

// ─── Share utilities ─────────────────────────────────────────────────────────
/** Shares text via Web Share API; falls back to clipboard copy. Returns true on success. */
async function shareOrCopy(text, title="Escalação FC") {
  if (navigator.share) {
    try { await navigator.share({ title, text }); return "shared"; } catch(e) {}
  }
  try {
    await (navigator.clipboard?.writeText(text) || Promise.reject());
    return "copied";
  } catch(e) {
    const ta=document.createElement("textarea");ta.value=text;
    document.body.appendChild(ta);ta.select();document.execCommand("copy");
    document.body.removeChild(ta);
    return "copied";
  }
}

/** Builds a convocation message for a match. */
function buildConvocationText(team, match, presentedPlayers) {
  const mt = MATCH_TYPES.find(t=>t.id===(match.matchType||"friendly"));
  const lines = [
    `⚽ *CONVOCAÇÃO — ${team.name.toUpperCase()}*`,
    ``,
    `${mt?.emoji||"🤝"} *${mt?.label||"Amistoso"}*${match.competitionName?` · ${match.competitionName}`:""}`,
    `🆚 *Adversário:* ${match.opponent}`,
  ];
  if (match.date) {
    const [y,mo,d]=match.date.split("-");
    lines.push(`📅 *Data:* ${d}/${mo}/${y}${match.time?` · ${match.time}`:""}`);
  }
  if (match.location) lines.push(`📍 *Local:* ${match.location}`);
  if (match.notes)    lines.push(`📝 ${match.notes}`);
  lines.push(``);
  if (presentedPlayers && presentedPlayers.length > 0) {
    lines.push(`👥 *Convocados (${presentedPlayers.length}):*`);
    presentedPlayers.forEach((p,i)=>lines.push(`  ${i+1}. ${p.name} (#${p.number} · ${p.position})`));
  }
  lines.push(``);
  lines.push(`_Enviado via Escalação FC_ ⚽`);
  return lines.join("\n");
}

// ─── Stats Export Modal ───────────────────────────────────────────────────────
function StatsExportModal({team,matches,stats,onClose,isPremium}) {
  const [statType,setStatType]=useState("goals"); // goals | assists | goalsAgainst
  const [filterType,setFilterType]=useState("all"); // all | year | period | matchType | competition | homeAway
  const [filterYear,setFilterYear]=useState(new Date().getFullYear().toString());
  const [filterDateFrom,setFilterDateFrom]=useState("");
  const [filterDateTo,setFilterDateTo]=useState("");
  const [filterMatchType,setFilterMatchType]=useState("friendly");
  const [filterCompetition,setFilterCompetition]=useState("");
  const [filterHomeAway,setFilterHomeAway]=useState("home");
  const [copied,setCopied]=useState(false);
  const [shared,setShared]=useState(false);
  const [exportMode,setExportMode]=useState("ranking"); // "ranking" | "team"

  const players=team.players.filter(p=>!p.isGuest)||[];
  const guestPlayers=team.players.filter(p=>!!p.isGuest)||[];
  const playerById=Object.fromEntries((team.players||[]).map(p=>[String(p.id),p]));

  // All unique competition names from matches
  const competitionNames=useMemo(()=>[...new Set(
    (matches||[]).filter(m=>m.competitionName).map(m=>m.competitionName.trim())
  )].sort(),[matches]);

  // Years with matches
  const matchYears=useMemo(()=>[...new Set(
    (matches||[]).filter(m=>m.date).map(m=>m.date.slice(0,4))
  )].sort((a,b)=>b-a),[matches]);

  // Filter matches based on current filter settings
  const filteredMatches=useMemo(()=>{
    let ms=matches||[];
    if(filterType==="year")
      ms=ms.filter(m=>(m.date||"").startsWith(filterYear));
    else if(filterType==="period")
      ms=ms.filter(m=>(!filterDateFrom||m.date>=filterDateFrom)&&(!filterDateTo||m.date<=filterDateTo));
    else if(filterType==="matchType")
      ms=ms.filter(m=>(m.matchType||"friendly")===filterMatchType);
    else if(filterType==="competition")
      ms=ms.filter(m=>m.competitionName&&m.competitionName.trim()===filterCompetition);
    else if(filterType==="homeAway")
      ms=ms.filter(m=>(m.homeAway||"home")===filterHomeAway);
    return ms;
  },[matches,filterType,filterYear,filterDateFrom,filterDateTo,filterMatchType,filterCompetition,filterHomeAway]);

  // Compute aggregated stat from filtered matches
  const aggregated=useMemo(()=>{
    const agg={};
    const ensure=(pid)=>{ if(!agg[pid])agg[pid]={goals:0,assists:0,goalsAgainst:0,appearances:0}; };
    for(const m of filteredMatches){
      (m.scorers||[]).forEach(pid=>{ ensure(pid); agg[pid].goals++; });
      (m.assisters||[]).forEach(pid=>{ ensure(pid); agg[pid].assists++; });
      Object.entries(m.gkGoalsConceded||{}).forEach(([pid,n])=>{ ensure(pid); agg[pid].goalsAgainst+=(parseInt(n)||0); });
      (m.presentPlayerIds||[]).forEach(pid=>{ ensure(pid); agg[pid].appearances++; });
    }
    // If no filter (showing totals), merge with manually-entered stats
    if(filterType==="all"){
      for(const [pid,st] of Object.entries(stats||{})){
        ensure(pid);
        agg[pid].goals=Math.max(agg[pid].goals,st.goals||0);
        agg[pid].assists=Math.max(agg[pid].assists,st.assists||0);
        agg[pid].goalsAgainst=Math.max(agg[pid].goalsAgainst,st.goalsAgainst||0);
        agg[pid].appearances=Math.max(agg[pid].appearances||0,st.appearances||0);
      }
    }
    return agg;
  },[filteredMatches,filterType,stats]);

  // Build sorted ranking for the chosen stat
  const ranking=useMemo(()=>{
    return players
      .map(p=>({ p, value:(aggregated[String(p.id)]||{})[statType]||0 }))
      .filter(({value})=>statType==="appearances"?true:value>0)
      .sort((a,b)=>b.value-a.value);
  },[players,aggregated,statType]);

  const STAT_META={
    appearances: {label:"Presenças",     icon:"clipboard"},
    goals:       {label:"Gols",          icon:"soccer-ball"},
    assists:     {label:"Assistências",  icon:"target"},
    goalsAgainst:{label:"Gols Sofridos", icon:"goalkeeper"},
  };

  // Build the copyable text
  const buildText=()=>{
    const sm=STAT_META[statType];
    const filterDesc=(()=>{
      if(filterType==="year")return `Ano ${filterYear}`;
      if(filterType==="period")return `${filterDateFrom||"..."} até ${filterDateTo||"..."}`;
      if(filterType==="matchType"){const mt=MATCH_TYPES.find(t=>t.id===filterMatchType);return mt?`${mt.emoji} ${mt.label}`:"";}
      if(filterType==="competition")return `🏆 ${filterCompetition}`;
      if(filterType==="homeAway")return filterHomeAway==="home"?"🏠 Casa":"✈️ Fora";
      return "Geral";
    })();
    const header=[`${sm.emoji} RANKING — ${sm.label.toUpperCase()}`,`Time: ${team.name}`,`Filtro: ${filterDesc}`,`${filteredMatches.length} partida${filteredMatches.length!==1?"s":""}`,`─────────────────────`].join("\n");
    const lines=ranking.map(({p,value},i)=>`${i+1}º ${p.name} — ${value} ${sm.label.toLowerCase()}`);
    const guestLines=guestPlayers.map((p,gi)=>{
      const st=aggregated[String(p.id)]||{goals:0,assists:0,goalsAgainst:0,appearances:0};
      return {text:`C${gi+1} ${p.name} (Convidado) — ${st[statType]||0} ${sm.label.toLowerCase()}`,val:st[statType]||0};
    }).filter(({val})=>statType==="appearances"?true:val>0).map(({text})=>text);
    let result=lines.length?[header,...lines].join("\n"):[header,"(sem dados para este filtro)"].join("\n");
    if(guestLines.length){result+="\n─────────────────────\n🎟️ CONVIDADOS\n"+guestLines.join("\n");}
    return result;
  };

  const handleCopy=()=>{
    const text=buildText();
    if(navigator.clipboard){
      navigator.clipboard.writeText(text).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2000);});
    } else {
      const ta=document.createElement("textarea");ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand("copy");document.body.removeChild(ta);
      setCopied(true);setTimeout(()=>setCopied(false),2000);
    }
  };

  const handleShare=async()=>{
    const text=buildText();
    const result=await shareOrCopy(text,"Estatísticas – "+team.name);
    if(result==="shared"||result==="copied"){ setShared(true); setTimeout(()=>setShared(false),2000); }
  };

  const [generatingImage,setGeneratingImage]=useState(false);

  /** Loads an image (base64 or URL) into an HTMLImageElement, resolving null on failure. */
  const loadImg=src=>new Promise(resolve=>{
    if(!src){resolve(null);return;}
    const img=new Image();
    img.crossOrigin="anonymous";
    img.onload=()=>resolve(img);
    img.onerror=()=>resolve(null);
    img.src=src;
  });

  /** Draws a circular clipped image (or initial-letter fallback) centered at cx,cy with given radius. */
  const drawAvatar=(ctx,img,name,cx,cy,r)=>{
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx,cy,r,0,Math.PI*2);
    ctx.closePath();
    ctx.clip();
    if(img){
      // Cover-fit the image inside the circle
      const s=Math.max((r*2)/img.width,(r*2)/img.height);
      const w=img.width*s, h=img.height*s;
      ctx.drawImage(img,cx-w/2,cy-h/2,w,h);
    }else{
      ctx.fillStyle="#16a34a";
      ctx.fillRect(cx-r,cy-r,r*2,r*2);
      ctx.fillStyle="#ffffff";
      ctx.font=`700 ${Math.round(r*1.1)}px 'DM Sans',Arial,sans-serif`;
      ctx.textAlign="center";
      ctx.textBaseline="middle";
      ctx.fillText((name||"?")[0].toUpperCase(),cx,cy+r*0.07);
    }
    ctx.restore();
    // Ring around the avatar
    ctx.beginPath();
    ctx.arc(cx,cy,r,0,Math.PI*2);
    ctx.strokeStyle="rgba(52,211,153,0.5)";
    ctx.lineWidth=2.5;
    ctx.stroke();
  };

  /** Renders the stats ranking as a high-resolution PNG image for sharing. */
  const buildImage=async()=>{
    const sm=STAT_META[statType];
    const filterDesc=(()=>{
      if(filterType==="year")return `Ano ${filterYear}`;
      if(filterType==="period")return `${filterDateFrom||"..."} até ${filterDateTo||"..."}`;
      if(filterType==="matchType"){const mt=MATCH_TYPES.find(t=>t.id===filterMatchType);return mt?`${mt.emoji} ${mt.label}`:"Tipo";}
      if(filterType==="competition")return filterCompetition||"Competição";
      if(filterType==="homeAway")return filterHomeAway==="home"?"🏠 Casa":"✈️ Fora";
      return "Geral";
    })();

    const DPR=3; // high resolution for crisp player photos
    const W=720, rowH=86, headerH=210, footerH=56, pad=28;
    const rows=ranking.length?ranking.length:1;
    const H=headerH+rows*rowH+footerH;

    const canvas=document.createElement("canvas");
    canvas.width=W*DPR; canvas.height=H*DPR;
    const ctx=canvas.getContext("2d");
    ctx.scale(DPR,DPR);

    // Background
    const bg=ctx.createLinearGradient(0,0,0,H);
    bg.addColorStop(0,"#0b1f17");
    bg.addColorStop(1,"#06140e");
    ctx.fillStyle=bg;
    ctx.fillRect(0,0,W,H);

    // Header band
    const headGrad=ctx.createLinearGradient(0,0,W,0);
    headGrad.addColorStop(0,"#16a34a");
    headGrad.addColorStop(1,"#0f7a37");
    ctx.fillStyle=headGrad;
    ctx.fillRect(0,0,W,headerH);

    // Logo / Shield: premium → team photo, free → Escalação FC logo
    const shieldSrc = (isPremium && team.photo) ? team.photo : LOGO_URI;
    const shieldR = 38;
    const shieldCx = pad + shieldR;
    const shieldCy = headerH / 2 - 10;
    const logoImg=await loadImg(shieldSrc);
    if(logoImg) drawAvatar(ctx,logoImg,team.name,shieldCx,shieldCy,shieldR);

    ctx.textAlign="left";
    ctx.fillStyle="#ffffff";
    ctx.font="800 32px 'DM Sans',Arial,sans-serif";
    ctx.fillText(team.name||"Escalação FC",pad+shieldR*2+14,shieldCy-6);
    ctx.font="600 17px 'DM Sans',Arial,sans-serif";
    ctx.fillStyle="rgba(255,255,255,0.9)";
    ctx.fillText(`${sm.emoji} Ranking — ${sm.label}`,pad+shieldR*2+14,shieldCy+18);

    ctx.font="500 13px 'DM Sans',Arial,sans-serif";
    ctx.fillStyle="rgba(255,255,255,0.75)";
    ctx.fillText(`${filterDesc} · ${filteredMatches.length} partida${filteredMatches.length!==1?"s":""}`,pad,headerH-44);

    // Column headers
    ctx.font="700 11px 'DM Sans',Arial,sans-serif";
    ctx.fillStyle="rgba(255,255,255,0.6)";
    ctx.fillText("JOGADOR",pad+58,headerH-16);
    ctx.textAlign="right";
    ctx.fillText(sm.label.toUpperCase(),W-pad,headerH-16);
    ctx.textAlign="left";

    if(!ranking.length){
      ctx.fillStyle="rgba(255,255,255,0.5)";
      ctx.font="500 16px 'DM Sans',Arial,sans-serif";
      ctx.textAlign="center";
      ctx.fillText("Sem dados para este filtro",W/2,headerH+rowH/2);
      ctx.textAlign="left";
    }

    // Pre-load all player photos in parallel
    const photoImgs=await Promise.all(ranking.map(({p})=>loadImg(p.photo||"")));

    ranking.forEach(({p,value},i)=>{
      const y=headerH+i*rowH;
      // Row background (subtle alternating)
      ctx.fillStyle=i%2===0?"rgba(255,255,255,0.03)":"rgba(255,255,255,0.0)";
      ctx.fillRect(0,y,W,rowH);
      // Divider
      ctx.strokeStyle="rgba(255,255,255,0.06)";
      ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(pad,y+rowH);ctx.lineTo(W-pad,y+rowH);ctx.stroke();

      const cy=y+rowH/2;

      // Rank number (1°, 2°, 3° with podium colors; rest dimmed)
      const rankColor=i===0?"#FFD700":i===1?"#C0C0C0":i===2?"#CD7F32":"rgba(255,255,255,0.4)";
      ctx.textAlign="center";
      ctx.fillStyle=rankColor;
      ctx.font=`800 ${i<3?20:16}px 'DM Sans',Arial,sans-serif`;
      ctx.fillText(`${i+1}°`,pad+12,cy+7);

      // Avatar
      drawAvatar(ctx,photoImgs[i],p.name,pad+62,cy,24);

      // Name + position
      ctx.textAlign="left";
      ctx.fillStyle="#f3f4f6";
      ctx.font="700 18px 'DM Sans',Arial,sans-serif";
      ctx.fillText(p.name||"",pad+96,cy-3);
      ctx.fillStyle="rgba(255,255,255,0.5)";
      ctx.font="500 13px 'DM Sans',Arial,sans-serif";
      ctx.fillText(`${p.position||""}${p.number?` · #${p.number}`:""}`,pad+96,cy+17);

      // Value
      ctx.textAlign="right";
      ctx.fillStyle="#34d399";
      ctx.font="800 30px 'Bebas Neue',Arial,sans-serif";
      ctx.fillText(String(value),W-pad,cy+10);
      ctx.textAlign="left";
    });

    // Footer
    ctx.fillStyle="rgba(255,255,255,0.35)";
    ctx.font="500 12px 'DM Sans',Arial,sans-serif";
    ctx.textAlign="center";
    ctx.fillText(`Gerado em ${new Date().toLocaleDateString("pt-BR")} via Escalação FC`,W/2,H-footerH/2+4);
    ctx.textAlign="left";

    return new Promise(resolve=>canvas.toBlob(b=>resolve(b),"image/png",1));
  };

  const buildTeamImage=async()=>{
    const withResult=(filteredMatches||[]).filter(m=>m.goalsFor!==""&&m.goalsFor!==undefined&&m.goalsFor!==null);
    const totalGF=withResult.reduce((s,m)=>s+(parseInt(m.goalsFor)||0),0);
    const totalGA=withResult.reduce((s,m)=>s+(parseInt(m.goalsAgainst)||0),0);
    const saldo=totalGF-totalGA;
    const wins=withResult.filter(m=>(parseInt(m.goalsFor)||0)>(parseInt(m.goalsAgainst)||0)).length;
    const draws=withResult.filter(m=>(parseInt(m.goalsFor)||0)===(parseInt(m.goalsAgainst)||0)).length;
    const losses=withResult.filter(m=>(parseInt(m.goalsFor)||0)<(parseInt(m.goalsAgainst)||0)).length;
    const totalGames=filteredMatches.length;

    const filterDesc=(()=>{
      if(filterType==="year")return `Ano ${filterYear}`;
      if(filterType==="period")return `${filterDateFrom||"..."} até ${filterDateTo||"..."}`;
      if(filterType==="matchType"){const mt=MATCH_TYPES.find(t=>t.id===filterMatchType);return mt?`${mt.emoji} ${mt.label}`:"Tipo";}
      if(filterType==="competition")return filterCompetition||"Competição";
      if(filterType==="homeAway")return filterHomeAway==="home"?"🏠 Casa":"✈️ Fora";
      return "Geral";
    })();

    const DPR=3;
    const W=720, headerH=210, statsH=220, footerH=56, pad=28;
    const H=headerH+statsH+footerH;

    const canvas=document.createElement("canvas");
    canvas.width=W*DPR; canvas.height=H*DPR;
    const ctx=canvas.getContext("2d");
    ctx.scale(DPR,DPR);

    // Background
    const bg=ctx.createLinearGradient(0,0,0,H);
    bg.addColorStop(0,"#0b1f17");
    bg.addColorStop(1,"#06140e");
    ctx.fillStyle=bg;
    ctx.fillRect(0,0,W,H);

    // Header band
    const headGrad=ctx.createLinearGradient(0,0,W,0);
    headGrad.addColorStop(0,"#16a34a");
    headGrad.addColorStop(1,"#0f7a37");
    ctx.fillStyle=headGrad;
    ctx.fillRect(0,0,W,headerH);

    // Shield / Logo
    const shieldSrc=(isPremium&&team.photo)?team.photo:LOGO_URI;
    const shieldR=38, shieldCx=pad+shieldR, shieldCy=headerH/2-10;
    const logoImg=await loadImg(shieldSrc);
    if(logoImg) drawAvatar(ctx,logoImg,team.name,shieldCx,shieldCy,shieldR);

    ctx.textAlign="left";
    ctx.fillStyle="#ffffff";
    ctx.font="800 32px 'DM Sans',Arial,sans-serif";
    ctx.fillText(team.name||"Escalação FC",pad+shieldR*2+14,shieldCy-6);
    ctx.font="600 17px 'DM Sans',Arial,sans-serif";
    ctx.fillStyle="rgba(255,255,255,0.9)";
    ctx.fillText("📊 Resumo do Time",pad+shieldR*2+14,shieldCy+18);

    ctx.font="500 13px 'DM Sans',Arial,sans-serif";
    ctx.fillStyle="rgba(255,255,255,0.75)";
    ctx.fillText(`${filterDesc} · ${totalGames} jogo${totalGames!==1?"s":""}`,pad,headerH-44);

    // Column headers inside header band
    ctx.font="700 11px 'DM Sans',Arial,sans-serif";
    ctx.fillStyle="rgba(255,255,255,0.6)";
    ctx.fillText("ESTATÍSTICAS GERAIS",pad,headerH-16);

    // Stats section — two rows of cards
    const cardY1=headerH+20;
    const cardY2=headerH+120;
    const cardH=80;

    const statsRow1=[
      {label:"Jogos",value:String(totalGames),color:"#60a5fa",emoji:"📅"},
      {label:"Vitórias",value:String(wins),color:"#34d399",emoji:"🏆"},
      {label:"Empates",value:String(draws),color:"#f59e0b",emoji:"🤝"},
      {label:"Derrotas",value:String(losses),color:"#f87171",emoji:"❌"},
    ];
    const statsRow2=[
      {label:"Gols marcados",value:String(totalGF),color:"#34d399",emoji:"⚽"},
      {label:"Gols sofridos",value:String(totalGA),color:"#f87171",emoji:"🧤"},
      {label:"Saldo de gols",value:(saldo>0?"+":"")+saldo,color:saldo>0?"#34d399":saldo<0?"#f87171":"#f59e0b",emoji:"📊"},
    ];

    const drawStatCards=(cards,y,cols)=>{
      const totalPad=(cols+1)*pad;
      const cardW=(W-totalPad)/cols;
      cards.forEach(({label,value,color,emoji},i)=>{
        const x=pad+i*(cardW+pad);
        // Card background
        ctx.fillStyle="rgba(255,255,255,0.06)";
        ctx.beginPath();
        ctx.roundRect(x,y,cardW,cardH,12);
        ctx.fill();
        // Color accent left border
        ctx.fillStyle=color;
        ctx.beginPath();
        ctx.roundRect(x,y,4,cardH,4);
        ctx.fill();
        // Value
        ctx.textAlign="center";
        ctx.fillStyle=color;
        ctx.font=`800 30px 'Bebas Neue',Arial,sans-serif`;
        ctx.fillText(value,x+cardW/2,y+cardH/2+4);
        // Label
        ctx.fillStyle="rgba(255,255,255,0.55)";
        ctx.font="600 11px 'DM Sans',Arial,sans-serif";
        ctx.fillText(label.toUpperCase(),x+cardW/2,y+cardH-14);
        ctx.textAlign="left";
      });
    };

    drawStatCards(statsRow1,cardY1,4);
    drawStatCards(statsRow2,cardY2,3);

    // Footer
    ctx.fillStyle="rgba(255,255,255,0.35)";
    ctx.font="500 12px 'DM Sans',Arial,sans-serif";
    ctx.textAlign="center";
    ctx.fillText(`Gerado em ${new Date().toLocaleDateString("pt-BR")} via Escalação FC`,W/2,H-footerH/2+4);
    ctx.textAlign="left";

    return new Promise(resolve=>canvas.toBlob(b=>resolve(b),"image/png",1));
  };

  const handleImage=async()=>{
    if(generatingImage)return;
    setGeneratingImage(true);
    try{
      const blob=exportMode==="team"?await buildTeamImage():await buildImage();
      if(!blob)throw new Error("Falha ao gerar imagem");
      const sm=STAT_META[statType];
      const fileName=exportMode==="team"
        ?`resumo-time-${team.name.toLowerCase().replace(/\s+/g,"-")}.png`
        :`ranking-${(sm.label||"stats").toLowerCase().replace(/\s+/g,"-")}-${team.name.toLowerCase().replace(/\s+/g,"-")}.png`;
      const shareTitle=exportMode==="team"?`Resumo – ${team.name}`:`Estatísticas – ${team.name}`;
      const shareText=exportMode==="team"?`📊 Resumo · ${team.name}`:`${sm.emoji} Ranking — ${sm.label} · ${team.name}`;
      const file=new File([blob],fileName,{type:"image/png"});

      if(navigator.canShare && navigator.canShare({files:[file]})){
        try{
          await navigator.share({files:[file],title:shareTitle,text:shareText});
          setGeneratingImage(false);
          return;
        }catch(e){ if(e?.name==="AbortError"){ setGeneratingImage(false); return; } }
      }
      // Fallback: download
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");
      a.href=url; a.download=fileName;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(()=>URL.revokeObjectURL(url),2000);
    }catch(err){
      console.error(err);
      alert("Não foi possível gerar a imagem. Tente novamente.");
    }finally{
      setGeneratingImage(false);
    }
  };

  // ── Export full stats table as CSV ────────────────────────────────────────
  const handleExportCsv=()=>{
    const headers=["Nome","Camisa","Posição","Gols","Assistências","Gols Sofridos","Presenças","Tipo"];
    const rows=players.map(p=>{
      const a=aggregated[String(p.id)]||{};
      return [
        p.name, p.number, p.position,
        a.goals||0, a.assists||0, a.goalsAgainst||0, a.appearances||0, "Titular"
      ];
    }).sort((a,b)=>(b[3]+b[4]+b[6])-(a[3]+a[4]+a[6]));
    const guestRows=guestPlayers.map((p,i)=>{
      const a=aggregated[String(p.id)]||{};
      return [
        p.name, `C${i+1}`, p.position,
        a.goals||0, a.assists||0, a.goalsAgainst||0, a.appearances||0, "Convidado"
      ];
    });
    const CRLF="\r\n";
    const allRows=[...rows,...guestRows];
    const csv=[headers,...allRows].map(r=>r.map(v=>'"'+String(v).replace(/"/g,'\"\"')+ '"').join(";")).join(CRLF);
    const blob=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;a.download=`${team.name.replace(/\s+/g,"_")}_estatisticas.csv`;
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

    return (
    <div style={{position:"fixed",inset:0,zIndex:1300,display:"flex",alignItems:"flex-end",justifyContent:"center",background:"rgba(0,0,0,0.85)",backdropFilter:"blur(6px)"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#0d1f17",border:"1px solid rgba(255,255,255,0.1)",borderRadius:"18px 18px 0 0",width:"100%",maxWidth:480,maxHeight:"92vh",overflowY:"auto",padding:"18px 18px 32px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:"#fff",letterSpacing:1}}>Exportar Estatísticas</span>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer"}}><Ico.Close/></button>
        </div>

        {/* Stat type */}
        <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:14}}>
          <span style={LT}>Estatística</span>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6}}>
            {Object.entries(STAT_META).map(([key,{label}])=>(
              <button key={key} onClick={()=>setStatType(key)} style={{
                padding:"9px 4px",borderRadius:10,border:"2px solid",cursor:"pointer",
                borderColor:statType===key?"#34d399":"rgba(255,255,255,0.08)",
                background:statType===key?"rgba(52,211,153,0.1)":"rgba(255,255,255,0.02)",
                display:"flex",flexDirection:"column",alignItems:"center",gap:3,transition:"all 0.15s",
                color:statType===key?"#34d399":"#9CA3AF"
              }}>
                {key==="appearances"&&<Ico.Players/>}
                {key==="goals"&&<Ico.Goal/>}
                {key==="assists"&&<Ico.Stats/>}
                {key==="goalsAgainst"&&<Ico.Trophy/>}
                <span style={{color:"inherit",fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:800,textTransform:"uppercase"}}>{label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Filter type */}
        <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:14}}>
          <span style={LT}>Filtrar por</span>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
            {[
              {id:"all",    label:"Geral",    icon:"stats"},
              {id:"year",   label:"Ano",      icon:"calendar"},
              {id:"period", label:"Período",  icon:"calendar"},
              {id:"matchType",label:"Tipo",   icon:"trophy"},
              {id:"competition",label:"Compet.",icon:"competition"},
              {id:"homeAway",   label:"Casa/Fora",icon:"home"},
            ].map(f=>(
              <button key={f.id} onClick={()=>setFilterType(f.id)} style={{
                padding:"8px 4px",borderRadius:10,border:"2px solid",cursor:"pointer",
                borderColor:filterType===f.id?"#34d399":"rgba(255,255,255,0.08)",
                background:filterType===f.id?"rgba(52,211,153,0.1)":"rgba(255,255,255,0.02)",
                display:"flex",flexDirection:"column",alignItems:"center",gap:3,transition:"all 0.15s",
                color:filterType===f.id?"#34d399":"#9CA3AF"
              }}>
                {f.icon==="stats"?<Ico.Stats/>:f.icon==="calendar"?<Ico.Calendar/>:<Icon id={f.icon} size={14}/>}
                <span style={{color:"inherit",fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:800,textTransform:"uppercase"}}>{f.label}</span>
              </button>
            ))}
          </div>

          {/* Filter sub-controls */}
          {filterType==="year"&&(
            <div style={{display:"flex",flexDirection:"column",gap:4}}>
              <label style={LT}>Ano</label>
              <select value={filterYear} onChange={e=>setFilterYear(e.target.value)}
                style={{...IS,colorScheme:"dark"}}>
                {matchYears.length?matchYears.map(y=><option key={y} value={y}>{y}</option>):<option value={filterYear}>{filterYear}</option>}
              </select>
            </div>
          )}
          {filterType==="period"&&(
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                <label style={LT}>De</label>
                <input type="date" value={filterDateFrom} onChange={e=>setFilterDateFrom(e.target.value)} style={{...IS,colorScheme:"dark"}}
                  onFocus={e=>e.target.style.borderColor="#34d399"} onBlur={e=>e.target.style.borderColor="rgba(255,255,255,0.1)"}/>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                <label style={LT}>Até</label>
                <input type="date" value={filterDateTo} onChange={e=>setFilterDateTo(e.target.value)} style={{...IS,colorScheme:"dark"}}
                  onFocus={e=>e.target.style.borderColor="#34d399"} onBlur={e=>e.target.style.borderColor="rgba(255,255,255,0.1)"}/>
              </div>
            </div>
          )}
          {filterType==="matchType"&&(
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6}}>
              {MATCH_TYPES.map(t=>(
                <button key={t.id} onClick={()=>setFilterMatchType(t.id)} style={{
                  padding:"7px 4px",borderRadius:9,border:"2px solid",cursor:"pointer",
                  borderColor:filterMatchType===t.id?"#34d399":"rgba(255,255,255,0.08)",
                  background:filterMatchType===t.id?"rgba(52,211,153,0.1)":"rgba(255,255,255,0.02)",
                  display:"flex",flexDirection:"column",alignItems:"center",gap:2,transition:"all 0.15s"
                }}>
                  <Icon id={t.icon} size={14} style={{color:filterMatchType===t.id?"#34d399":"#9CA3AF"}}/>
                  <span style={{color:filterMatchType===t.id?"#34d399":"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:8,fontWeight:800,textTransform:"uppercase"}}>{t.label}</span>
                </button>
              ))}
            </div>
          )}
          {filterType==="competition"&&(
            <div style={{display:"flex",flexDirection:"column",gap:4}}>
              <label style={LT}>Competição</label>
              {competitionNames.length?(
                <select value={filterCompetition} onChange={e=>setFilterCompetition(e.target.value)} style={{...IS,colorScheme:"dark"}}>
                  <option value="">Selecione...</option>
                  {competitionNames.map(n=><option key={n} value={n}>{n}</option>)}
                </select>
              ):(
                <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:12,padding:"8px 12px",background:"rgba(255,255,255,0.03)",borderRadius:9}}>
                  Nenhuma competição cadastrada ainda.
                </div>
              )}
            </div>
          )}
          {filterType==="homeAway"&&(
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
              {[{id:"home",label:"Casa",icon:"home"},{id:"away",label:"Fora",icon:"airplane"}].map(opt=>(
                <button key={opt.id} onClick={()=>setFilterHomeAway(opt.id)} style={{
                  display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:"9px 4px",
                  borderRadius:10,border:"2px solid",cursor:"pointer",
                  borderColor:filterHomeAway===opt.id?"#34d399":"rgba(255,255,255,0.08)",
                  background:filterHomeAway===opt.id?"rgba(52,211,153,0.1)":"rgba(255,255,255,0.02)",
                  transition:"all 0.15s"
                }}>
                  <Icon id={opt.icon} size={16} style={{color:filterHomeAway===opt.id?"#34d399":"#9CA3AF"}}/>
                  <span style={{color:filterHomeAway===opt.id?"#34d399":"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:800,textTransform:"uppercase"}}>{opt.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div style={{background:"rgba(0,0,0,0.3)",borderRadius:12,padding:"12px 14px",marginBottom:14,minHeight:80}}>
          <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700,marginBottom:8,textTransform:"uppercase",letterSpacing:0.5}}>
            <Icon id={STAT_META[statType].icon} size={14} style={{color:"#6B7280"}}/> {STAT_META[statType].label} · {filteredMatches.length} partida{filteredMatches.length!==1?"s":""}
          </div>
          {ranking.length===0?(
            <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:12,textAlign:"center",padding:"12px 0"}}>Sem dados para este filtro</div>
          ):(
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {ranking.map(({p,value},i)=>(
                <div key={p.id} style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:16,color:i<3?"#facc15":"#4B5563",minWidth:22}}>{i+1}º</span>
                  <PlayerAvatar player={p} size={28} team={team}/>
                  <span style={{flex:1,color:"#e5e7eb",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}</span>
                  <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:"#34d399"}}>{value}</span>
                </div>
              ))}
            </div>
          )}
          {/* Guest section */}
          {guestPlayers.length>0&&(
            <div style={{marginTop:8,paddingTop:8,borderTop:"1px solid rgba(251,146,60,0.2)"}}>
              <div style={{color:"#fb923c",fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:800,textTransform:"uppercase",letterSpacing:0.5,marginBottom:6,display:"flex",alignItems:"center",gap:4}}><Icon id="ticket" size={9}/> Convidados (não contam no ranking)</div>
              <div style={{display:"flex",flexDirection:"column",gap:5}}>
                {guestPlayers.map((p,i)=>{
                  const val=(aggregated[String(p.id)]||{})[statType]||0;
                  return (
                  <div key={p.id} style={{display:"flex",alignItems:"center",gap:8,opacity:0.8}}>
                    <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:13,color:"#fb923c",minWidth:22}}>C{i+1}</span>
                    <PlayerAvatar player={p} size={24} team={team}/>
                    <span style={{flex:1,color:"#d1d5db",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}</span>
                    <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:15,color:"#fb923c"}}>{val}</span>
                  </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div style={{display:"flex",gap:6,marginBottom:4}}>
          {[{id:"ranking",label:"Ranking jogadores",icon:"medal"},{id:"team",label:"Resumo do time",icon:"chart-bar"}].map(opt=>(
            <button key={opt.id} onClick={()=>setExportMode(opt.id)} style={{
              flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,
              padding:"9px 6px",borderRadius:10,border:"2px solid",cursor:"pointer",transition:"all 0.15s",
              borderColor:exportMode===opt.id?"#34d399":"rgba(255,255,255,0.08)",
              background:exportMode===opt.id?"rgba(52,211,153,0.1)":"rgba(255,255,255,0.02)",
              color:exportMode===opt.id?"#34d399":"#9CA3AF",
              fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:800,textTransform:"uppercase"
            }}><Icon id={opt.icon} size={14}/>{opt.label}</button>
          ))}
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {exportMode==="ranking"&&<button onClick={handleCopy} style={{
            width:"100%",padding:"12px 0",borderRadius:12,border:"none",cursor:"pointer",
            background:copied?"rgba(52,211,153,0.2)":"linear-gradient(135deg,#16a34a,#34d399)",
            color:copied?"#34d399":"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:15,letterSpacing:1,
            display:"flex",alignItems:"center",justifyContent:"center",gap:8,transition:"all 0.2s"
          }}><Ico.List/>{copied?"✓ COPIADO!":"COPIAR LISTA"}</button>}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
            <button onClick={handleShare} style={{
              padding:"11px 0",borderRadius:12,border:"1px solid rgba(96,165,250,0.3)",cursor:"pointer",
              background:shared?"rgba(96,165,250,0.2)":"rgba(96,165,250,0.08)",
              color:shared?"#93c5fd":"#60a5fa",fontFamily:"'Bebas Neue',sans-serif",fontSize:13,letterSpacing:1,
              display:"flex",alignItems:"center",justifyContent:"center",gap:5,transition:"all 0.2s"
            }}><Ico.Share/>{shared?"OK!":"COMPARTILHAR"}</button>
            <button onClick={handleImage} disabled={generatingImage} style={{
              padding:"11px 0",borderRadius:12,border:"1px solid rgba(251,191,36,0.3)",cursor:generatingImage?"default":"pointer",
              background:"rgba(251,191,36,0.08)",color:"#fbbf24",fontFamily:"'Bebas Neue',sans-serif",fontSize:13,letterSpacing:1,
              display:"flex",alignItems:"center",justifyContent:"center",gap:5,opacity:generatingImage?0.6:1
            }}><Ico.Image/>{generatingImage?"GERANDO...":"IMAGEM"}</button>
            <button onClick={handleExportCsv} style={{
              padding:"11px 0",borderRadius:12,border:"1px solid rgba(52,211,153,0.3)",cursor:"pointer",
              background:"rgba(52,211,153,0.08)",color:"#34d399",fontFamily:"'Bebas Neue',sans-serif",fontSize:13,letterSpacing:1,
              display:"flex",alignItems:"center",justifyContent:"center",gap:5
            }}><Ico.Stats/>CSV</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Office View ──────────────────────────────────────────────────────────────
// ─── Import Players Modal ─────────────────────────────────────────────────────
// Parses CSV/TSV pasted by the user and maps columns to player fields.
// Expected columns (any order, detected by header):
//   nome/name, numero/number, posicao/position, posicao2/position2,
//   pe/foot, estrelas/stars, status
// Any unrecognised columns are ignored.
const IMPORT_COL_MAP = {
  nome:"name", name:"name",
  numero:"number", number:"number", camisa:"number",
  posicao:"position", posição:"position", position:"position",
  posicao2:"position2", posição2:"position2", position2:"position2", "pos.sec":"position2",
  pe:"foot", pé:"foot", foot:"foot", "pé dominante":"foot", "pe dominante":"foot",
  estrelas:"stars", stars:"stars", nivel:"stars", nível:"stars",
  status:"status",
  // Stats columns
  gols:"goals", goals:"goals",
  assistencias:"assists", assistências:"assists", assists:"assists",
  "gols sofridos":"goalsAgainst", "gols tomados":"goalsAgainst", goalsagainst:"goalsAgainst",
  presencas:"appearances", presenças:"appearances", appearances:"appearances", jogos:"appearances",
};
const IMPORT_FOOT_MAP = {
  "destro":"Destro","direito":"Destro","right":"Destro","r":"Destro",
  "canhoto":"Canhoto","esquerdo":"Canhoto","left":"Canhoto","l":"Canhoto",
  "ambidestro":"Ambidestro","ambidextro":"Ambidestro","both":"Ambidestro","a":"Ambidestro",
};
const IMPORT_STATUS_MAP = {
  "ativo":"active","active":"active","ok":"active",
  "lesionado":"injured","lesão":"injured","injured":"injured","lesao":"injured",
  "suspenso":"suspended","suspended":"suspended",
  "inativo":"inactive","inactive":"inactive",
};

function parseCSV(text) {
  // Auto-detect delimiter: semicolon, comma, tab
  const delim = text.includes(";") ? ";" : text.includes("\t") ? "\t" : ",";
  const lines = text.trim().split(/\r?\n/).filter(l=>l.trim());
  if (lines.length < 2) return { error:"O arquivo precisa ter pelo menos um cabeçalho e uma linha de dados." };
  const headers = lines[0].split(delim).map(h=>h.trim().toLowerCase().replace(/['"]/g,""));
  const colMap = headers.map(h=>IMPORT_COL_MAP[h]||null);
  const rows = [];
  for (let i=1;i<lines.length;i++) {
    const cells = lines[i].split(delim).map(c=>c.trim().replace(/^["']|["']$/g,""));
    if (cells.every(c=>!c)) continue;
    const row = {};
    colMap.forEach((field,j)=>{ if(field && cells[j]!==undefined) row[field]=cells[j]; });
    rows.push(row);
  }
  return { rows, colMap, headers, delim };
}

function normalisePlayer(raw, existingPlayers) {
  const name = (raw.name||"").trim();
  const number = String(raw.number||"").trim();
  if (!name || !number) return null;
  // Map position to known POSITIONS list (case-insensitive partial match)
  let position = (raw.position||"").trim();
  const posMatch = POSITIONS.find(p=>p.toLowerCase()===position.toLowerCase())||
    POSITIONS.find(p=>p.toLowerCase().includes(position.toLowerCase()));
  if (posMatch) position=posMatch; else if(!position) position="Goleiro";
  let position2 = (raw.position2||"").trim();
  const pos2Match = POSITIONS.find(p=>p.toLowerCase()===position2.toLowerCase())||
    POSITIONS.find(p=>p.toLowerCase().includes(position2.toLowerCase()));
  if (pos2Match) position2=pos2Match; else position2="";
  const foot = IMPORT_FOOT_MAP[(raw.foot||"").toLowerCase().trim()]||"Destro";
  const stars = Math.min(5,Math.max(1,parseInt(raw.stars)||3));
  const status = IMPORT_STATUS_MAP[(raw.status||"").toLowerCase().trim()]||"active";
  // Stats (optional — only imported if column is present and non-empty)
  const goals     = raw.goals!==undefined&&raw.goals!==""     ? Math.max(0,parseInt(raw.goals)||0)     : undefined;
  const assists   = raw.assists!==undefined&&raw.assists!==""   ? Math.max(0,parseInt(raw.assists)||0)   : undefined;
  const goalsAgainst = raw.goalsAgainst!==undefined&&raw.goalsAgainst!=="" ? Math.max(0,parseInt(raw.goalsAgainst)||0) : undefined;
  const appearances  = raw.appearances!==undefined&&raw.appearances!==""   ? Math.max(0,parseInt(raw.appearances)||0)  : undefined;
  const hasStats = goals!==undefined||assists!==undefined||goalsAgainst!==undefined||appearances!==undefined;
  // Check if player already exists (by number or name)
  const existing = existingPlayers.find(p=>String(p.number)===number||p.name.toLowerCase()===name.toLowerCase());
  return { name, number, position, position2, foot, stars, status,
    ...(hasStats?{goals,assists,goalsAgainst,appearances}:{}),
    _existing: existing||null };
}

function ImportPlayersModal({team, onClose, onImport}) {
  const [step, setStep] = useState("paste"); // "paste" | "preview" | "done"
  const [raw, setRaw] = useState("");
  const [parsed, setParsed] = useState(null);
  const [parseError, setParseError] = useState("");
  const [importMode, setImportMode] = useState("merge"); // "merge" | "overwrite"
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState(null);
  const fileInputRef = useRef();

  const handleParse = () => {
    setParseError("");
    const result = parseCSV(raw);
    if (result.error) { setParseError(result.error); return; }
    const normalised = result.rows.map(r=>normalisePlayer(r, team.players||[])).filter(Boolean);
    if (!normalised.length) { setParseError("Nenhuma linha válida encontrada. Verifique se os dados têm nome e número."); return; }
    setParsed({...result, players: normalised});
    setStep("preview");
  };

  const handleFile = (file) => {
    const reader = new FileReader();
    reader.onload = e => { setRaw(e.target.result); };
    reader.readAsText(file, "UTF-8");
  };

  const handleImport = async () => {
    if (!parsed) return;
    setImporting(true);
    const added=[], updated=[], skipped=[];
    const newPlayers = [...(team.players||[])];
    const statsToSave = []; // [{playerId, goals, assists, goalsAgainst, appearances}]

    for (const p of parsed.players) {
      const {_existing, goals, assists, goalsAgainst, appearances, ...fields} = p;
      const hasStats = goals!==undefined||assists!==undefined||goalsAgainst!==undefined||appearances!==undefined;

      if (_existing && importMode==="merge") {
        const idx = newPlayers.findIndex(pl=>pl.id===_existing.id);
        if (idx>=0) {
          newPlayers[idx] = { ...newPlayers[idx], ...Object.fromEntries(Object.entries(fields).filter(([,v])=>v!=="")) };
          updated.push(newPlayers[idx]);
          if(hasStats) statsToSave.push({playerId:String(_existing.id),
            goals: goals!==undefined?goals:undefined,
            assists: assists!==undefined?assists:undefined,
            goalsAgainst: goalsAgainst!==undefined?goalsAgainst:undefined,
            appearances: appearances!==undefined?appearances:undefined,
          });
        }
      } else if (_existing && importMode==="overwrite") {
        const idx = newPlayers.findIndex(pl=>pl.id===_existing.id);
        if (idx>=0) {
          newPlayers[idx] = {...newPlayers[idx], ...fields};
          updated.push(newPlayers[idx]);
          if(hasStats) statsToSave.push({playerId:String(_existing.id),goals,assists,goalsAgainst,appearances});
        }
      } else if (!_existing) {
        const np = { ...fields, id:genUUID(), photo:"" };
        newPlayers.push(np);
        added.push(np);
        if(hasStats) statsToSave.push({playerId:String(np.id),goals,assists,goalsAgainst,appearances});
      }
    }
    await onImport(newPlayers, added, updated, statsToSave);
    setResults({ added:added.length, updated:updated.length, statsCount:statsToSave.length });
    setStep("done");
    setImporting(false);
  };

  return (
    <div style={{position:"fixed",inset:0,zIndex:1200,display:"flex",alignItems:"flex-end",justifyContent:"center",background:"rgba(0,0,0,0.85)",backdropFilter:"blur(6px)"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#0d1f17",border:"1px solid rgba(255,255,255,0.1)",borderRadius:"18px 18px 0 0",width:"100%",maxWidth:500,maxHeight:"92vh",overflowY:"auto",padding:"18px 18px 32px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <span style={{display:"flex",alignItems:"center",gap:8,fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:"#fff",letterSpacing:1}}><Ico.Import/>Importar Jogadores</span>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer"}}><Ico.Close/></button>
        </div>

        {step==="paste"&&(
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {/* Instructions */}
            <div style={{background:"rgba(52,211,153,0.06)",border:"1px solid rgba(52,211,153,0.2)",borderRadius:10,padding:"10px 12px"}}>
              <div style={{color:"#34d399",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,marginBottom:6,display:"flex",alignItems:"center",gap:5}}><Icon id="clipboard" size={11}/> FORMATO ESPERADO</div>
              <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:11,lineHeight:1.6}}>
                Planilha (Excel/Sheets) salva como <b style={{color:"#e5e7eb"}}>.CSV</b> ou texto copiado diretamente. Colunas reconhecidas:<br/>
                <code style={{color:"#34d399",fontSize:10}}>nome, numero, posicao, posicao2, pe, estrelas, status, gols, assistencias, gols sofridos, presencas</code>
              </div>
              <div style={{marginTop:8,padding:"6px 8px",background:"rgba(0,0,0,0.3)",borderRadius:7,fontFamily:"monospace",fontSize:10,color:"#6B7280"}}>
                nome;numero;posicao;pe;estrelas<br/>
                João Silva;10;Atacante;Destro;4<br/>
                Pedro Lima;1;Goleiro;Destro;5
              </div>
            </div>

            {/* File upload */}
            <input ref={fileInputRef} type="file" accept=".csv,.tsv,.txt" style={{display:"none"}}
              onChange={e=>{ if(e.target.files[0]) handleFile(e.target.files[0]); }}/>
            <button onClick={()=>fileInputRef.current?.click()} style={{
              width:"100%",padding:"11px 0",borderRadius:11,border:"1.5px dashed rgba(52,211,153,0.35)",
              background:"rgba(52,211,153,0.04)",color:"#34d399",cursor:"pointer",
              fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",gap:8
            }}>  <Icon id="folder-open" size={16}/> Carregar arquivo CSV</button>

            <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11,textAlign:"center"}}>— ou cole os dados abaixo —</div>

            <textarea value={raw} onChange={e=>setRaw(e.target.value)} rows={8}
              placeholder={"nome;numero;posicao;pe;estrelas\nJoão Silva;10;Atacante;Destro;4"}
              style={{...IS,resize:"vertical",fontFamily:"monospace",fontSize:11,lineHeight:1.5}}
              onFocus={e=>e.target.style.borderColor="#34d399"} onBlur={e=>e.target.style.borderColor="rgba(255,255,255,0.1)"}/>

            {parseError&&<div style={{color:"#f87171",fontFamily:"'DM Sans',sans-serif",fontSize:12,padding:"8px 10px",background:"rgba(239,68,68,0.08)",borderRadius:8}}>{parseError}</div>}

            <button onClick={handleParse} disabled={!raw.trim()} style={{
              padding:"12px 0",borderRadius:12,border:"none",cursor:raw.trim()?"pointer":"default",
              background:raw.trim()?"linear-gradient(135deg,#166534,#34d399)":"rgba(255,255,255,0.06)",
              color:raw.trim()?"#fff":"#4B5563",fontFamily:"'Bebas Neue',sans-serif",fontSize:16,letterSpacing:1
            }}>ANALISAR DADOS</button>
          </div>
        )}

        {step==="preview"&&parsed&&(
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <div style={{flex:1,background:"rgba(52,211,153,0.08)",border:"1px solid rgba(52,211,153,0.2)",borderRadius:10,padding:"8px 12px",fontFamily:"'DM Sans',sans-serif",fontSize:12,color:"#34d399",fontWeight:700}}>
                ✓ {parsed.players.length} jogadores detectados
                {parsed.players.filter(p=>p._existing).length>0&&<span style={{color:"#f59e0b",marginLeft:8}}>· {parsed.players.filter(p=>p._existing).length} já existem</span>}
              </div>
              <button onClick={()=>setStep("paste")} style={{background:"none",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"7px 10px",color:"#9CA3AF",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontSize:11,display:"flex",alignItems:"center",gap:4}}><Icon id="edit" size={12}/> Editar</button>
            </div>

            {/* Merge mode */}
            {parsed.players.some(p=>p._existing)&&(
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                <span style={LT}>Para jogadores que já existem</span>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                  {[{id:"merge",label:"Mesclar",desc:"Atualiza só campos preenchidos",icon:"shuffle"},
                    {id:"overwrite",label:"Substituir",desc:"Sobrescreve todos os campos",icon:"upload"}].map(m=>(
                    <button key={m.id} onClick={()=>setImportMode(m.id)} style={{
                      padding:"9px 8px",borderRadius:10,border:"2px solid",cursor:"pointer",
                      borderColor:importMode===m.id?"#34d399":"rgba(255,255,255,0.08)",
                      background:importMode===m.id?"rgba(52,211,153,0.1)":"rgba(255,255,255,0.02)",
                      display:"flex",flexDirection:"column",alignItems:"center",gap:3
                    }}>
                      <Icon id={m.icon} size={18} style={{color:importMode===m.id?"#34d399":"#9CA3AF"}}/>
                      <span style={{color:importMode===m.id?"#34d399":"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:800}}>{m.label}</span>
                      <span style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:9}}>{m.desc}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Preview list */}
            <div style={{display:"flex",flexDirection:"column",gap:5,maxHeight:240,overflowY:"auto"}}>
              {parsed.players.map((p,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:9,
                  background:p._existing?"rgba(245,158,11,0.06)":"rgba(52,211,153,0.04)",
                  border:`1px solid ${p._existing?"rgba(245,158,11,0.2)":"rgba(52,211,153,0.15)"}`}}>
                  <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:16,color:p._existing?"#f59e0b":"#34d399",minWidth:28}}>#{p.number}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{color:"#fff",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}</div>
                    <div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:10}}>{p.position}{p.position2?` / ${p.position2}`:""} · {p.foot} · ⭐{p.stars}</div>
                  </div>
                  <span style={{fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:700,color:p._existing?"#f59e0b":"#34d399",flexShrink:0}}>{p._existing?"ATUALIZAR":"NOVO"}</span>
                </div>
              ))}
            </div>

            <button onClick={handleImport} disabled={importing} style={{
              padding:"13px 0",borderRadius:12,border:"none",cursor:importing?"default":"pointer",
              background:importing?"rgba(255,255,255,0.06)":"linear-gradient(135deg,#166534,#34d399)",
              color:importing?"#4B5563":"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:16,letterSpacing:1,
              display:"flex",alignItems:"center",justifyContent:"center",gap:8
            }}>
              {importing&&<div style={{width:14,height:14,border:"2px solid rgba(255,255,255,0.3)",borderTopColor:"#fff",borderRadius:"50%",animation:"spin 0.7s linear infinite"}}/>}
              {importing?"IMPORTANDO...":<><Icon id="check-circle" size={16}/> CONFIRMAR IMPORTAÇÃO</>}
            </button>
          </div>
        )}

        {step==="done"&&results&&(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:16,padding:"20px 0",textAlign:"center"}}>
            <Icon id="check-circle" size={52} style={{color:"#34d399"}}/>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#fff",letterSpacing:0.5}}>Importação concluída!</div>
            <div style={{display:"flex",gap:10,flexWrap:"wrap",justifyContent:"center"}}>
              {results.added>0&&<div style={{padding:"10px 16px",borderRadius:10,background:"rgba(52,211,153,0.1)",border:"1px solid rgba(52,211,153,0.2)"}}>
                <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:28,color:"#34d399"}}>{results.added}</div>
                <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:11}}>adicionado{results.added!==1?"s":""}</div>
              </div>}
              {results.updated>0&&<div style={{padding:"10px 16px",borderRadius:10,background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.2)"}}>
                <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:28,color:"#f59e0b"}}>{results.updated}</div>
                <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:11}}>atualizado{results.updated!==1?"s":""}</div>
              </div>}
              {results.statsCount>0&&<div style={{padding:"10px 16px",borderRadius:10,background:"rgba(96,165,250,0.1)",border:"1px solid rgba(96,165,250,0.2)"}}>
                <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:28,color:"#60a5fa"}}>{results.statsCount}</div>
                <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:11}}>estat. importada{results.statsCount!==1?"s":""}</div>
              </div>}
            </div>
            <button onClick={onClose} style={{
              padding:"12px 32px",borderRadius:12,border:"none",cursor:"pointer",
              background:"linear-gradient(135deg,#166534,#34d399)",color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:16,letterSpacing:1
            }}>FECHAR</button>
          </div>
        )}
      </div>
    </div>
  );
}


function OfficeView({team,uid,onUpdateTeam,onSavePlayer,isPremium}) {
  const [officeTab,setOfficeTab]=useState("calendar"); // "calendar" | "stats" | "import"
  const [matches,setMatches]=useState(null); // null=loading, []+=loaded
  const [stats,setStats]=useState({});
  const [showMatchModal,setShowMatchModal]=useState(false);
  const [editingMatch,setEditingMatch]=useState(null);
  const [confirmDelMatch,setConfirmDelMatch]=useState(null);
  const [showExportStats,setShowExportStats]=useState(false);
  const [showImport,setShowImport]=useState(false);
  const [toast,setToast]=useState(null);
  const [showTutorialPrompt,setShowTutorialPrompt]=useState(false);
  const [showTutorial,setShowTutorial]=useState(false);
  const [c1,c2]=SHIELD_COLORS[(team.colorIdx||0)%SHIELD_COLORS.length];

  const handleImportPlayers=async(newPlayers,added,updated,statsToSave=[])=>{
    onUpdateTeam({...team,players:newPlayers});
    if(uid&&onSavePlayer){
      for(const p of [...added,...updated]) await onSavePlayer(team.id,p);
    }
    // Save stats entries if any stats were included in the import
    if(uid&&statsToSave.length>0){
      const currentStats=stats;
      const nextStats={...currentStats};
      for(const s of statsToSave){
        const existing=nextStats[s.playerId]||{goals:0,assists:0,goalsAgainst:0,appearances:0};
        const merged={
          ...existing,
          playerId:s.playerId,
          ...(s.goals!==undefined?{goals:s.goals}:{}),
          ...(s.assists!==undefined?{assists:s.assists}:{}),
          ...(s.goalsAgainst!==undefined?{goalsAgainst:s.goalsAgainst}:{}),
          ...(s.appearances!==undefined?{appearances:s.appearances}:{}),
        };
        nextStats[s.playerId]=merged;
        if(team.isCollab) saveCollabStat(team.id,merged);
        else savePlayerStatsCloud(uid,team.id,merged);
      }
      setStats(nextStats);
    }
    setToast(`Importação: ${added.length} adicionado(s), ${updated.length} atualizado(s)${statsToSave.length?`, ${statsToSave.length} estatística(s) importada(s)`:""}.`);
  };


  // Build match summary share text (result + details)
  const buildMatchShareText=(team,m)=>{
    const mt=MATCH_TYPES.find(t=>t.id===(m.matchType||"friendly"));
    const playerById=Object.fromEntries((team.players||[]).map(p=>[String(p.id),p]));
    const lines=[`⚽ *${team.name.toUpperCase()} ${m.goalsFor!==""&&m.goalsFor!==undefined?`${m.goalsFor}–${m.goalsAgainst} vs ${m.opponent}`:`vs ${m.opponent}`}*`,``];
    if(mt) lines.push(`${mt.emoji} ${mt.label}${m.competitionName?` · ${m.competitionName}`:""}`);
    if(m.date){const [y,mo,d]=m.date.split("-");lines.push(`📅 ${d}/${mo}/${y}${m.time?` · ${m.time}`:""}`);}
    if(m.location) lines.push(`📍 ${m.location}`);
    const scorerUniq=[...new Set(m.scorers||[])];
    if(scorerUniq.length){lines.push(``);lines.push(`⚽ Gols: ${scorerUniq.map(pid=>{const p=playerById[pid];const cnt=(m.scorers||[]).filter(x=>x===pid).length;return p?`${p.name}${cnt>1?` (${cnt})`:""}`:null;}).filter(Boolean).join(", ")}`);}
    const assUniq=[...new Set(m.assisters||[])];
    if(assUniq.length){lines.push(`🎯 Assist.: ${assUniq.map(pid=>{const p=playerById[pid];const cnt=(m.assisters||[]).filter(x=>x===pid).length;return p?`${p.name}${cnt>1?` (${cnt})`:""}`:null;}).filter(Boolean).join(", ")}`);}
    if(m.notes){lines.push(``);lines.push(`📝 ${m.notes}`);}
    lines.push(``);lines.push(`_Escalação FC_ ⚽`);
    return lines.join("\n");
  };

  // Load matches + stats on mount / team change
  useEffect(()=>{
    if(!uid||!team?.id)return;
    setMatches(null);
    if(team.isCollab){
      const fb=getFirebase();if(!fb)return;

      const loadCollabMatchesAndStats = async () => {
        const [matchSnap, statSnap] = await Promise.all([
          fb.getDocs(fb.collection(fb.db,"collab_teams",String(team.id),"matches")),
          fb.getDocs(fb.collection(fb.db,"collab_teams",String(team.id),"stats")),
        ]);

        const collabMatches = matchSnap.docs.map(d=>d.data());
        const collabStats = {};
        statSnap.docs.forEach(d=>{ collabStats[d.id]=d.data(); });

        // Se o dono não tem stats nem partidas no collab, tentar recuperar do path pessoal.
        // Isso cobre times ativados antes do fix de migração.
        const ownerWithNoData = team.ownerUid === uid && statSnap.empty && matchSnap.empty;
        const ownerWithNoStats = team.ownerUid === uid && statSnap.empty && !matchSnap.empty;
        if(ownerWithNoData || ownerWithNoStats){
          const result = await recoverCollabData(uid, team.id);
          if(result.stats > 0 || result.matches > 0){
            // Recarregar após recuperação
            const [m2, s2snap] = await Promise.all([
              fb.getDocs(fb.collection(fb.db,"collab_teams",String(team.id),"matches")),
              fb.getDocs(fb.collection(fb.db,"collab_teams",String(team.id),"stats")),
            ]);
            setMatches(m2.docs.map(d=>d.data()));
            const s2={};s2snap.docs.forEach(d=>{s2[d.id]=d.data();});
            setStats(s2);
            return;
          }
        }

        setMatches(collabMatches);
        setStats(collabStats);
      };

      loadCollabMatchesAndStats().catch(()=>{ setMatches([]); setStats({}); });
    } else {
      loadMatchesCloud(uid,team.id).then(m=>setMatches(m||[]));
      loadAllStatsCloud(uid,team.id).then(s=>setStats(s||{}));
    }
  },[uid,team?.id,team?.isCollab]);

  const saveMatch=async(form)=>{
    const match={...form,id:form.id||genUUID(),teamId:team.id};

    // ── Recompute player stats from all matches (source of truth) ──────────
    // This ensures manual +/- edits in StatsView are superseded by match data
    // as a "base", and the manual tab allows adding stats not tied to any match.
    setMatches(prev=>{
      const prevList=prev||[];
      const idx=prevList.findIndex(m=>m.id===match.id);
      const nextList=idx>=0?prevList.map(m=>m.id===match.id?match:m):[...prevList,match];

      // Aggregate stats from all (updated) matches
      const agg={};
      const ensure=(pid)=>{ if(!agg[pid])agg[pid]={goals:0,assists:0,goalsAgainst:0,appearances:0,playerId:pid}; };
      for(const m of nextList){
        (m.scorers||[]).forEach(pid=>{ ensure(pid); agg[pid].goals++; });
        (m.assisters||[]).forEach(pid=>{ ensure(pid); agg[pid].assists++; });
        Object.entries(m.gkGoalsConceded||{}).forEach(([pid,n])=>{ ensure(pid); agg[pid].goalsAgainst+=(parseInt(n)||0); });
        (m.presentPlayerIds||[]).forEach(pid=>{ ensure(pid); agg[pid].appearances++; });
      }

      // Merge with any stats that only exist in the manual tab (extra goals/assists
      // the user added directly, which have no match reference). We preserve the
      // "excess" — whatever the user manually added ABOVE what matches account for.
      setStats(prev=>{
        const next={...prev};
        for(const [pid,matchSt] of Object.entries(agg)){
          const manual=prev[pid]||{goals:0,assists:0,goalsAgainst:0,appearances:0};
          next[pid]={
            playerId:pid,
            goals:       Math.max(matchSt.goals,       manual.goals       ||0),
            assists:     Math.max(matchSt.assists,      manual.assists     ||0),
            goalsAgainst:Math.max(matchSt.goalsAgainst,manual.goalsAgainst||0),
            appearances: Math.max(matchSt.appearances,  manual.appearances  ||0),
          };
        }
        // Persist each modified stat
        if(uid){
          for(const st of Object.values(next)){
            if(team.isCollab) saveCollabStat(team.id,st);
            else savePlayerStatsCloud(uid,team.id,st);
          }
        }
        return next;
      });

      return nextList;
    });

    setShowMatchModal(false);setEditingMatch(null);
    if(uid){
      if(team.isCollab) saveCollabMatch(team.id,match);
      else saveMatchCloud(uid,team.id,match);
    }
  };

  const deleteMatch=async(id)=>{
    setMatches(prev=>(prev||[]).filter(m=>m.id!==id));
    setConfirmDelMatch(null);
    if(uid){
      if(team.isCollab) deleteCollabMatch(team.id,id);
      else deleteMatchCloud(uid,team.id,id);
    }
  };

  const updateStat=async(playerId,key,value)=>{
    const pid=String(playerId);
    const newSt={...(stats[pid]||{goals:0,assists:0,goalsAgainst:0,appearances:0}),[key]:value,playerId:pid};
    setStats(prev=>({...prev,[pid]:newSt}));
    if(uid){
      if(team.isCollab) saveCollabStat(team.id,newSt);
      else savePlayerStatsCloud(uid,team.id,newSt);
    }
  };

  // Sort matches: future first, then past descending
  const sortedMatches=useMemo(()=>{
    if(!matches)return[];
    const now=new Date().toISOString().slice(0,10);
    const future=(matches||[]).filter(m=>m.date>=now).sort((a,b)=>a.date.localeCompare(b.date));
    const past=(matches||[]).filter(m=>m.date<now).sort((a,b)=>b.date.localeCompare(a.date));
    return [...future,...past];
  },[matches]);

  const formatDate=(d)=>{
    if(!d)return"";
    const [y,m,day]=d.split("-");
    return `${day}/${m}/${y}`;
  };

  const resultLabel=(m)=>{
    if(m.goalsFor===""||m.goalsFor===undefined||m.goalsFor===null)return null;
    const gf=parseInt(m.goalsFor)||0,ga=parseInt(m.goalsAgainst)||0;
    const outcome=gf>ga?"V":gf<ga?"D":"E";
    const color=gf>ga?"#34d399":gf<ga?"#f87171":"#f59e0b";
    return {label:`${gf}–${ga}`,outcome,color};
  };

  return (
    <div style={{minHeight:"100vh",background:"#050c0a",paddingBottom:80}}>
      {/* Botao de tutorial */}
      <TutorialButton style={{position:"fixed",top:14,right:14,zIndex:800}} onClick={()=>setShowTutorialPrompt(true)}/>
      {showTutorialPrompt&&<TutorialPrompt screenName="Escritorio" onConfirm={()=>{setShowTutorialPrompt(false);setShowTutorial(true);}} onCancel={()=>setShowTutorialPrompt(false)}/>}
      {showTutorial&&<TutorialOverlay steps={officeTab==="calendar"?TUTORIAL_OFFICE_CALENDAR:officeTab==="stats"?TUTORIAL_OFFICE_STATS:TUTORIAL_OFFICE_IMPORT} onClose={()=>setShowTutorial(false)}/>}

      {/* Header */}
      <div className="office-header" style={{padding:"16px 16px 0",display:"flex",alignItems:"center",gap:12}}>
        <TeamShield team={team} size={40}/>
        <div>
          <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#fff",letterSpacing:1,lineHeight:1}}>{team.name}</div>
          <div style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:11}}>Escritório</div>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="office-tabs" style={{display:"flex",gap:0,margin:"14px 16px 0",background:"rgba(255,255,255,0.04)",borderRadius:12,padding:3}}>
        {[["calendar","Calendário","calendar"],["stats","Estatísticas","stats"],["import","Importar","import"]].map(([id,label,ico])=>(
          <button key={id} onClick={()=>setOfficeTab(id)} style={{
            flex:1,padding:"9px 4px",borderRadius:9,border:"none",cursor:"pointer",
            fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:800,letterSpacing:0.2,
            background:officeTab===id?`linear-gradient(135deg,${c1},${c2})`:"transparent",
            color:officeTab===id?"#fff":"#6B7280",transition:"all 0.18s",
            display:"flex",alignItems:"center",justifyContent:"center",gap:5
          }}>
            {ico==="calendar"&&<Ico.Calendar/>}
            {ico==="stats"&&<Ico.Stats/>}
            {ico==="import"&&<Ico.Import/>}
            {label}
          </button>
        ))}
      </div>

      <div style={{padding:"14px 16px"}}>
        {/* ── Calendar tab ── */}
        {officeTab==="calendar"&&(
          <>
          <button className="office-new-match-btn" onClick={()=>{setEditingMatch(null);setShowMatchModal(true);}} style={{
            width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:8,
            padding:"11px 0",borderRadius:12,border:"none",cursor:"pointer",marginBottom:14,
            background:`linear-gradient(135deg,${c1},${c2})`,color:"#fff",
            fontFamily:"'Bebas Neue',sans-serif",fontSize:16,letterSpacing:1,
            boxShadow:`0 4px 16px ${c1}55`
          }}><Ico.Plus/> NOVA PARTIDA</button>

          {matches===null?(
            <div style={{display:"flex",justifyContent:"center",padding:32}}>
              <div style={{width:30,height:30,border:"3px solid #34d399",borderTopColor:"transparent",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
            </div>
          ):sortedMatches.length===0?(
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:10,padding:"40px 20px",color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:13,textAlign:"center"}}>
              <div style={{display:"flex",justifyContent:"center",opacity:0.3,marginBottom:4}}><Ico.Calendar/></div>
              <span>Nenhuma partida cadastrada.<br/>Toque em "Nova Partida" para adicionar.</span>
            </div>
          ):(
            <div className="office-match-list" style={{display:"flex",flexDirection:"column",gap:8}}>
              {sortedMatches.map(m=>{
                const res=resultLabel(m);
                const isPast=m.date<new Date().toISOString().slice(0,10);
                return (
                  <div key={m.id} style={{
                    background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)",
                    borderRadius:14,padding:"12px 14px",display:"flex",flexDirection:"column",gap:8
                  }}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                        {res
                          ?<span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:res.color,letterSpacing:1}}>{res.label}</span>
                          :<span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:13,color:isPast?"#6B7280":"#34d399",letterSpacing:1}}>{isPast?"—":"EM BREVE"}</span>}
                        <span style={{color:"#fff",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700}}>vs {m.opponent}</span>
                        {(()=>{
                          const mt=MATCH_TYPES.find(t=>t.id===(m.matchType||"friendly"));
                          return mt&&<span style={{fontSize:10,fontFamily:"'DM Sans',sans-serif",fontWeight:700,color:"#6B7280",background:"rgba(255,255,255,0.05)",borderRadius:5,padding:"1px 6px",display:"flex",alignItems:"center",gap:3}}><Icon id={mt.icon} size={10}/> {mt.label}{m.competitionName?` · ${m.competitionName}`:""}</span>;
                        })()}
                      </div>
                      <div style={{display:"flex",gap:6}}>
                        {!isPast&&(m.presentPlayerIds||[]).length>0&&(
                          <button onClick={async()=>{
                            const presented=(team.players||[]).filter(p=>(m.presentPlayerIds||[]).includes(String(p.id)))
                              .sort((a,b)=>(parseInt(a.number)||0)-(parseInt(b.number)||0));
                            const text=buildConvocationText(team,m,presented);
                            const r=await shareOrCopy(text,"Convocação – "+team.name);
                            if(r)setToast(r==="shared"?"✅ Convocação compartilhada!":"✅ Convocação copiada!");
                          }} aria-label="Compartilhar convocação" title="Compartilhar convocação"
                          style={{background:"rgba(52,211,153,0.12)",border:"1px solid rgba(52,211,153,0.3)",borderRadius:8,padding:"5px 8px",color:"#34d399",cursor:"pointer",display:"flex",alignItems:"center",gap:4,fontFamily:"'DM Sans',sans-serif",fontSize:10,fontWeight:700}}>
                            <Ico.Bell/> CONVOCAR
                          </button>
                        )}
                        <button onClick={async()=>{
                          const text=buildMatchShareText(team,m);
                          const r=await shareOrCopy(text,"Partida – "+team.name);
                          if(r)setToast(r==="shared"?"✅ Partida compartilhada!":"✅ Copiado!");
                        }} aria-label="Compartilhar partida"
                        style={{background:"rgba(96,165,250,0.1)",border:"1px solid rgba(96,165,250,0.2)",borderRadius:8,padding:"5px 8px",color:"#60a5fa",cursor:"pointer"}}><Ico.Share/></button>
                        <button onClick={()=>{setEditingMatch(m);setShowMatchModal(true);}} aria-label="Editar partida"
                          style={{background:"rgba(59,130,246,0.12)",border:"1px solid rgba(59,130,246,0.25)",borderRadius:8,padding:"5px 8px",color:"#60a5fa",cursor:"pointer"}}><Ico.Edit/></button>
                        <button onClick={()=>setConfirmDelMatch(m.id)} aria-label="Excluir partida"
                          style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:8,padding:"5px 8px",color:"#f87171",cursor:"pointer"}}><Ico.Trash/></button>
                      </div>
                    </div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:10}}>
                      {m.date&&<span style={{display:"flex",alignItems:"center",gap:4,color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:11}}><Ico.Calendar/>{formatDate(m.date)}{m.time&&` · ${m.time}`}</span>}
                      {m.location&&<span style={{display:"flex",alignItems:"center",gap:4,color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:11}}><Ico.MapPin/>{m.location}</span>}
                      {m.homeAway&&<span style={{display:"flex",alignItems:"center",gap:4,color:m.homeAway==="home"?"#34d399":"#a78bfa",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700}}><Icon id={m.homeAway==="home"?"home":"airplane"} size={11}/> {m.homeAway==="home"?"Casa":"Fora"}</span>}
                      {(m.presentPlayerIds||[]).length>0&&<span style={{display:"flex",alignItems:"center",gap:4,color:"#60a5fa",fontFamily:"'DM Sans',sans-serif",fontSize:11}}><Icon id="clipboard" size={11}/> {m.presentPlayerIds.length} presente{m.presentPlayerIds.length!==1?"s":""}</span>}
                    </div>
                    {m.notes&&<div style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:11,borderTop:"1px solid rgba(255,255,255,0.05)",paddingTop:6}}>{m.notes}</div>}

                    {/* Scorer/assister summary */}
                    {(()=>{
                      const playerById=Object.fromEntries((team.players||[]).map(p=>[String(p.id),p]));
                      const scorerIds=[...new Set(m.scorers||[])];
                      const assisterIds=[...new Set(m.assisters||[])];
                      const gkEntries=Object.entries(m.gkGoalsConceded||{}).filter(([,n])=>parseInt(n)>0);
                      if(!scorerIds.length&&!assisterIds.length&&!gkEntries.length)return null;
                      return (
                        <div style={{display:"flex",flexDirection:"column",gap:5,borderTop:"1px solid rgba(255,255,255,0.05)",paddingTop:8}}>
                          {scorerIds.map(pid=>{
                            const p=playerById[pid];if(!p)return null;
                            const cnt=(m.scorers||[]).filter(x=>x===pid).length;
                            return <div key={pid} style={{display:"flex",alignItems:"center",gap:6,fontFamily:"'DM Sans',sans-serif",fontSize:11}}>
                              <Icon id="soccer-ball" size={11} style={{color:"#34d399"}}/><span style={{color:"#34d399",fontWeight:700}}>{p.name}</span><span style={{color:"#4B5563"}}>× {cnt}</span>
                            </div>;
                          })}
                          {assisterIds.map(pid=>{
                            const p=playerById[pid];if(!p)return null;
                            const cnt=(m.assisters||[]).filter(x=>x===pid).length;
                            return <div key={pid} style={{display:"flex",alignItems:"center",gap:6,fontFamily:"'DM Sans',sans-serif",fontSize:11}}>
                              <Icon id="target" size={11} style={{color:"#f59e0b"}}/><span style={{color:"#f59e0b",fontWeight:700}}>{p.name}</span><span style={{color:"#4B5563"}}>× {cnt}</span>
                            </div>;
                          })}
                          {gkEntries.map(([pid,n])=>{
                            const p=playerById[pid];if(!p)return null;
                            return <div key={pid} style={{display:"flex",alignItems:"center",gap:6,fontFamily:"'DM Sans',sans-serif",fontSize:11}}>
                              <Icon id="goalkeeper" size={11} style={{color:"#f87171"}}/><span style={{color:"#f87171",fontWeight:700}}>{p.name}</span><span style={{color:"#4B5563"}}>{n} gol{parseInt(n)!==1?"s":""} sofrido{parseInt(n)!==1?"s":""}</span>
                            </div>;
                          })}
                        </div>
                      );
                    })()}
                    {confirmDelMatch===m.id&&(
                      <div style={{display:"flex",gap:8,alignItems:"center",background:"rgba(239,68,68,0.08)",borderRadius:8,padding:"8px 10px"}}>
                        <span style={{flex:1,color:"#f87171",fontFamily:"'DM Sans',sans-serif",fontSize:11}}>Excluir esta partida?</span>
                        <button onClick={()=>deleteMatch(m.id)} style={{padding:"4px 10px",borderRadius:7,border:"none",background:"#dc2626",color:"#fff",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,cursor:"pointer"}}>Sim</button>
                        <button onClick={()=>setConfirmDelMatch(null)} style={{padding:"4px 10px",borderRadius:7,border:"1px solid rgba(255,255,255,0.1)",background:"transparent",color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:11,cursor:"pointer"}}>Não</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          </>
        )}

        {/* ── Stats tab ── */}
        {officeTab==="stats"&&(
          <>
          <button className="office-export-stats-btn" onClick={()=>setShowExportStats(true)} style={{
            width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:8,
            padding:"10px 0",borderRadius:12,border:"1px solid rgba(52,211,153,0.25)",cursor:"pointer",marginBottom:12,
            background:"rgba(52,211,153,0.07)",color:"#34d399",
            fontFamily:"'Bebas Neue',sans-serif",fontSize:15,letterSpacing:1
          }}><Icon id="clipboard" size={15}/> EXPORTAR / FILTRAR ESTATÍSTICAS</button>
          {/* Goal balance summary */}
          {(()=>{
            const withResult=(matches||[]).filter(m=>m.goalsFor!==""&&m.goalsFor!==undefined&&m.goalsFor!==null);
            const totalGF=withResult.reduce((s,m)=>s+(parseInt(m.goalsFor)||0),0);
            const totalGA=withResult.reduce((s,m)=>s+(parseInt(m.goalsAgainst)||0),0);
            const saldo=totalGF-totalGA;
            if(!withResult.length)return null;
            return (
              <div className="office-goal-summary" style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:12}}>
                {[
                  {label:"Gols marcados",value:totalGF,icon:"soccer-ball",color:"#34d399"},
                  {label:"Gols sofridos",value:totalGA,icon:"goalkeeper",color:"#f87171"},
                  {label:"Saldo de gols",value:(saldo>0?"+":"")+saldo,icon:"chart-bar",color:saldo>0?"#34d399":saldo<0?"#f87171":"#f59e0b"},
                ].map(({label,value,icon,color})=>(
                  <div key={label} style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:12,padding:"10px 8px",display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                    <Icon id={icon} size={18} style={{color}}/>
                    <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:24,color,letterSpacing:1,lineHeight:1}}>{value}</span>
                    <span style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:9,fontWeight:700,textTransform:"uppercase",textAlign:"center",lineHeight:1.3}}>{label}</span>
                  </div>
                ))}
              </div>
            );
          })()}
          <div className="office-stats-view"><StatsView team={team} stats={stats} onUpdateStat={updateStat}/></div>
          </>
        )}
        {/* ── Import tab ── */}
        {officeTab==="import"&&(
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <div className="office-import-card" style={{padding:"14px",background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:14}}>
              <div style={{color:"#fff",fontFamily:"'DM Sans',sans-serif",fontSize:13,fontWeight:700,marginBottom:8}}>Importar jogadores de planilha</div>
              <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:12,lineHeight:1.6,marginBottom:12}}>
                Importe um arquivo CSV exportado do Excel, Google Sheets ou similar para adicionar ou atualizar jogadores do seu elenco em massa.
              </div>
              <button onClick={()=>setShowImport(true)} style={{
                width:"100%",padding:"12px 0",borderRadius:12,border:"none",cursor:"pointer",
                background:`linear-gradient(135deg,${c1},${c2})`,color:"#fff",
                fontFamily:"'Bebas Neue',sans-serif",fontSize:16,letterSpacing:1,
                display:"flex",alignItems:"center",justifyContent:"center",gap:8,
                boxShadow:`0 4px 16px ${c1}40`
              }}><Ico.Import/>INICIAR IMPORTAÇÃO</button>
            </div>
            <div style={{padding:"12px 14px",background:"rgba(245,158,11,0.06)",border:"1px solid rgba(245,158,11,0.2)",borderRadius:12}}>
              <div style={{color:"#f59e0b",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,marginBottom:6,display:"flex",alignItems:"center",gap:5}}><Icon id="pin" size={11}/> COMO EXPORTAR DO EXCEL / GOOGLE SHEETS</div>
              <div style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:11,lineHeight:1.7}}>
                <b style={{color:"#e5e7eb"}}>Excel:</b> Arquivo → Salvar como → CSV (separado por vírgulas ou ponto-e-vírgula)<br/>
                <b style={{color:"#e5e7eb"}}>Google Sheets:</b> Arquivo → Fazer download → Valores separados por vírgula (.csv)<br/>
                <b style={{color:"#e5e7eb"}}>Dica:</b> Garanta que a primeira linha seja o cabeçalho com os nomes das colunas.
              </div>
            </div>
            <div style={{padding:"12px 14px",background:"rgba(52,211,153,0.04)",border:"1px solid rgba(52,211,153,0.15)",borderRadius:12}}>
              <div style={{color:"#34d399",fontFamily:"'DM Sans',sans-serif",fontSize:11,fontWeight:700,marginBottom:6,display:"flex",alignItems:"center",gap:5}}><Icon id="check-circle" size={11}/> COLUNAS SUPORTADAS</div>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {[
                  ["nome / name","Nome do jogador (obrigatório)"],
                  ["numero / number / camisa","Número da camisa (obrigatório)"],
                  ["posicao / position","Posição principal"],
                  ["posicao2 / position2","Posição secundária"],
                  ["pe / foot","Destro, Canhoto ou Ambidestro"],
                  ["estrelas / stars / nivel","1 a 5"],
                  ["status","ativo, lesionado, suspenso, inativo"],
                  ["gols / goals","Quantidade de gols"],
                  ["assistencias / assists","Quantidade de assistências"],
                  ["gols sofridos","Gols sofridos (goleiros)"],
                  ["presencas / jogos","Número de presenças"],
                ].map(([col,desc])=>(
                  <div key={col} style={{display:"flex",gap:8}}>
                    <code style={{color:"#34d399",fontFamily:"monospace",fontSize:10,minWidth:140,flexShrink:0}}>{col}</code>
                    <span style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:10}}>{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {showMatchModal&&<MatchModal initial={editingMatch} players={team.players||[]} onSave={saveMatch} onClose={()=>{setShowMatchModal(false);setEditingMatch(null);}}/>}
      {showExportStats&&<StatsExportModal team={team} matches={matches||[]} stats={stats} isPremium={isPremium} onClose={()=>setShowExportStats(false)}/>}
      {showImport&&<ImportPlayersModal team={team} onClose={()=>setShowImport(false)} onImport={handleImportPlayers}/>}
      {toast&&<Toast msg={toast} onDone={()=>setToast(null)}/>}
    </div>
  );
}

// ─── Tutorial System ──────────────────────────────────────────────────────────
// Componente reutilizável de tutorial passo a passo com overlay escuro.
// steps: Array<{ title, body, highlight?: string (CSS selector) }>
function TutorialOverlay({ steps, onClose }) {
  const [idx, setIdx] = useState(0);
  const [spotRect, setSpotRect] = useState(null); // viewport-relative rect after scroll settles
  const cardRef = useRef(null);
  const step = steps[idx];
  const isLast = idx === steps.length - 1;
  const PAD = 10;
  const CARD_MARGIN = 14; // gap between spotlight and card
  const VH = typeof window !== "undefined" ? window.innerHeight : 700;

  // After each step change: scroll element into view then wait for scroll to
  // settle before measuring its viewport position.
  useEffect(() => {
    setSpotRect(null); // clear while repositioning
    if (!step.highlight) return;
    const el = document.querySelector(step.highlight);
    if (!el) return;

    // Scroll so the element is visible (not necessarily centered — we need
    // space for the card too, so "nearest" is safer than "center").
    // Fixed-position elements don't need scroll.
    const elPosition = window.getComputedStyle(el).position;
    if (elPosition !== "fixed") {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    // Wait for smooth scroll to finish (~450 ms is enough for most cases),
    // then measure again so the rect matches the real painted position.
    const tid = setTimeout(() => {
      const r = el.getBoundingClientRect();
      setSpotRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    }, 480);
    return () => clearTimeout(tid);
  }, [idx, step.highlight]);

  // Decide whether card goes ABOVE or BELOW the spotlight.
  // Prefer below if there's enough room; otherwise above; fallback bottom.
  let cardStyle = {
    position: "fixed",
    left: 16, right: 16,
    bottom: 16,
  };
  if (spotRect) {
    const sr = spotRect;
    const spotBottom = sr.top + sr.height + PAD;
    const spotTop = sr.top - PAD;
    const CARD_EST_H = 220; // estimated card height
    const spaceBelow = VH - spotBottom - CARD_MARGIN;
    const spaceAbove = spotTop - CARD_MARGIN;

    if (spaceBelow >= CARD_EST_H) {
      // Place below spotlight
      cardStyle = { position: "fixed", left: 16, right: 16, top: spotBottom + CARD_MARGIN };
    } else if (spaceAbove >= CARD_EST_H) {
      // Place above spotlight
      cardStyle = { position: "fixed", left: 16, right: 16, bottom: VH - spotTop + CARD_MARGIN };
    } else {
      // Not enough room on either side — push spotlight up via scroll and place card at bottom
      cardStyle = { position: "fixed", left: 16, right: 16, bottom: 16 };
    }
  }

  const sr = spotRect;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9000, fontFamily: "'DM Sans',sans-serif" }}>
      {/* Dark overlay with spotlight cutout */}
      <svg
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <mask id="tut-mask">
            <rect width="100%" height="100%" fill="white" />
            {sr && (
              <rect
                x={sr.left - PAD}
                y={sr.top - PAD}
                width={sr.width + PAD * 2}
                height={sr.height + PAD * 2}
                rx="12"
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(0,0,0,0.82)" mask="url(#tut-mask)" />
        {sr && (
          <rect
            x={sr.left - PAD}
            y={sr.top - PAD}
            width={sr.width + PAD * 2}
            height={sr.height + PAD * 2}
            rx="12"
            fill="none"
            stroke="#34d399"
            strokeWidth="2"
            strokeDasharray="6 3"
            style={{ animation: "tut-dash 1s linear infinite" }}
          />
        )}
      </svg>

      <style>{`
        @keyframes tut-dash { to { stroke-dashoffset: -18; } }
        @keyframes tut-card-in { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
      `}</style>

      {/* Instruction card — dynamically above or below spotlight */}
      <div
        ref={cardRef}
        key={idx} // remount on step change to re-trigger animation
        style={{
          ...cardStyle,
          background: "linear-gradient(160deg,#0c1b14,#071209)",
          border: "1px solid rgba(52,211,153,0.28)",
          borderRadius: 20,
          padding: "18px 18px 16px",
          boxShadow: "0 16px 48px rgba(0,0,0,0.9)",
          animation: "tut-card-in 0.25s ease",
          zIndex: 9001,
        }}
      >
        {/* Progress dots */}
        <div style={{ display: "flex", gap: 5, marginBottom: 12, justifyContent: "center" }}>
          {steps.map((_, i) => (
            <div key={i} style={{
              width: i === idx ? 20 : 6, height: 6, borderRadius: 3,
              background: i === idx ? "#34d399" : i < idx ? "rgba(52,211,153,0.4)" : "rgba(255,255,255,0.12)",
              transition: "width 0.25s,background 0.25s",
            }} />
          ))}
        </div>

        {/* Step counter */}
        <div style={{ color: "#34d399", fontSize: 10, fontWeight: 800, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 5 }}>
          Passo {idx + 1} de {steps.length}
        </div>

        {/* Title */}
        <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 21, color: "#fff", letterSpacing: 1, marginBottom: 6, lineHeight: 1.1 }}>
          {step.title}
        </div>

        {/* Body */}
        <div style={{ color: "#9CA3AF", fontSize: 12.5, lineHeight: 1.6, marginBottom: 16 }}>
          {step.body}
        </div>

        {/* Buttons */}
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onClose}
            style={{
              flex: 1, padding: "11px 0", borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.1)",
              background: "rgba(255,255,255,0.04)",
              color: "#6B7280", cursor: "pointer",
              fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 700,
            }}
          >
            Fechar
          </button>
          <button
            onClick={() => { if (isLast) { onClose(); } else { setIdx(i => i + 1); } }}
            style={{
              flex: 2, padding: "11px 0", borderRadius: 12,
              border: "none",
              background: isLast ? "linear-gradient(135deg,#15803d,#34d399)" : "linear-gradient(135deg,#0f5a30,#1a7a42)",
              color: "#fff", cursor: "pointer",
              fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 800,
              boxShadow: "0 4px 16px rgba(52,211,153,0.3)",
            }}
          >
            {isLast ? "Concluir" : "Proximo"}
          </button>
        </div>
      </div>

      {/* Tap outside to close (overlay layer below card) */}
      <div style={{ position: "absolute", inset: 0, zIndex: 9000 }} onClick={onClose} />
    </div>
  );
}

// Botão de ajuda (?) fixo no canto superior direito
function TutorialButton({ onClick, style }) {
  return (
    <button
      onClick={onClick}
      aria-label="Abrir tutorial"
      title="Tutorial"
      style={{
        position: "absolute",
        top: 12, right: 12,
        width: 28, height: 28,
        borderRadius: "50%",
        border: "1.5px solid rgba(52,211,153,0.4)",
        background: "rgba(52,211,153,0.1)",
        color: "#34d399",
        cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "'DM Sans',sans-serif",
        fontSize: 13, fontWeight: 800,
        zIndex: 100,
        backdropFilter: "blur(4px)",
        transition: "background 0.15s,border-color 0.15s",
        ...style,
      }}
      onMouseEnter={e => { e.currentTarget.style.background = "rgba(52,211,153,0.22)"; e.currentTarget.style.borderColor = "rgba(52,211,153,0.7)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "rgba(52,211,153,0.1)"; e.currentTarget.style.borderColor = "rgba(52,211,153,0.4)"; }}
    >
      ?
    </button>
  );
}

// Modal de confirmação antes de iniciar o tutorial
function TutorialPrompt({ screenName, onConfirm, onCancel }) {
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 8900, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)" }}
      onClick={onCancel}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "linear-gradient(160deg,#0c1b14,#071209)",
          border: "1px solid rgba(52,211,153,0.25)",
          borderRadius: 22, padding: "28px 22px", maxWidth: 320, width: "100%", textAlign: "center",
          boxShadow: "0 24px 64px rgba(0,0,0,0.9)",
        }}
      >
        <div style={{
          width: 56, height: 56, borderRadius: 16,
          background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.2)",
          display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px",
        }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 22, color: "#fff", letterSpacing: 1, marginBottom: 8 }}>
          Tutorial: {screenName}
        </div>
        <div style={{ color: "#6B7280", fontFamily: "'DM Sans',sans-serif", fontSize: 13, lineHeight: 1.6, marginBottom: 24 }}>
          Quer ver um tutorial das funcionalidades desta tela?
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onCancel}
            style={{
              flex: 1, padding: "13px 0", borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.1)",
              background: "rgba(255,255,255,0.04)",
              color: "#9CA3AF", cursor: "pointer",
              fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 700,
            }}
          >
            Agora nao
          </button>
          <button
            onClick={onConfirm}
            style={{
              flex: 1, padding: "13px 0", borderRadius: 12, border: "none",
              background: "linear-gradient(135deg,#15803d,#34d399)",
              color: "#fff", cursor: "pointer",
              fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 800,
              boxShadow: "0 4px 16px rgba(52,211,153,0.3)",
            }}
          >
            Sim, ver
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Dados de tutorial por tela ───────────────────────────────────────────────
const TUTORIAL_HOME = [
  {
    title: "Tela de Times",
    body: "Esta e a tela principal do Futebol de Campo. Aqui voce gerencia todos os seus times. Vamos ver cada elemento.",
    highlight: null,
  },
  {
    title: "Seu contador de times",
    body: "Este numero mostra quantos times voce ja criou. No plano gratuito voce pode ter ate 1 time; no PRO, times ilimitados.",
    highlight: ".home-times-counter",
  },
  {
    title: "Importar time",
    body: "Use o botao Importar para adicionar um time compartilhado por outro usuario via codigo. Ideal para copiar elencos prontos.",
    highlight: ".home-import-btn",
  },
  {
    title: "Card do time",
    body: "Cada time aparece como um card. Ele mostra a formacao tatica, numero de jogadores e quantos estao escalados. Toque no card para abrir a prancheta.",
    highlight: ".team-card",
  },
  {
    title: "Editar, compartilhar e excluir",
    body: "Nos botoes laterais do card voce pode: editar o nome e cores do time (azul), compartilhar via codigo (verde), ou excluir o time (vermelho).",
    highlight: ".tc-action-btn",
  },
  {
    title: "Abrir prancheta tatica",
    body: "Toque em 'Abrir prancheta tatica' no rodape do card para entrar na tela de Escalacao, onde voce posiciona jogadores no campo.",
    highlight: ".tc-footer",
  },
  {
    title: "Criar novo time",
    body: "O botao verde + no canto inferior direito cria um novo time. Voce define nome, cores do escudo e formacao inicial.",
    highlight: ".home-fab",
  },
];

const TUTORIAL_TACTIC_FIELD = [
  {
    title: "Prancheta Tatica",
    body: "Esta e a aba de Escalacao. Aqui voce posiciona os jogadores no campo de acordo com a formacao do time. Vamos conhecer cada parte.",
    highlight: null,
  },
  {
    title: "Cabecalho do time",
    body: "Toque no escudo ou nome do time para editar cores, nome e foto. O indicador mostra quantos jogadores estao escalados e o status de sincronizacao com a nuvem.",
    highlight: ".teamview-header",
  },
  {
    title: "Exportar escalacao",
    body: "O botao EXPORTAR gera uma imagem da sua prancheta tatica pronta para compartilhar no WhatsApp, Instagram ou onde quiser.",
    highlight: ".teamview-export-btn",
  },
  {
    title: "Salvar dados",
    body: "O botao SALVAR envia todos os dados para a nuvem imediatamente. Os dados tambem sao salvos automaticamente a cada alteracao.",
    highlight: ".teamview-save-btn",
  },
  {
    title: "Formacao tatica",
    body: "Toque nas setas para trocar a formacao (ex: 4-4-2, 4-3-3). O botao de lista mostra todas as formacoes disponiveis. O botao ao lado gerencia multiplas escalacoes salvas.",
    highlight: ".teamview-formation-row",
  },
  {
    title: "Modo Livre (PRO)",
    body: "O botao LIVRE (exclusivo PRO) permite arrastar qualquer jogador para qualquer posicao no campo, sem restricao de slots.",
    highlight: ".teamview-freemode-btn",
  },
  {
    title: "Campo interativo",
    body: "Toque em qualquer posicao vazia no campo para escolher o jogador que vai ocupa-la. Para reposicionar, toque e segure o jogador e arraste.",
    highlight: ".football-field-wrap",
  },
  {
    title: "Nome do tecnico",
    body: "Digite o nome do tecnico e confirme com OK. Ele aparecera na imagem exportada da escalacao.",
    highlight: "#coach-name",
  },
  {
    title: "Banco de reservas",
    body: "Jogadores nao escalados aparecem aqui. Toque em um nome para marca-lo como reserva oficial. Reservas aparecem na imagem exportada.",
    highlight: ".teamview-bench",
  },
  {
    title: "Abas Escalacao e Elenco",
    body: "Use as abas no topo para alternar entre a prancheta tatica (Escalacao) e a lista completa de jogadores (Elenco).",
    highlight: ".teamview-tabs",
  },
];

const TUTORIAL_TACTIC_PLAYERS = [
  {
    title: "Aba Elenco",
    body: "Aqui voce ve e gerencia todos os jogadores cadastrados no time. Cada card mostra numero, nome, posicao e foto do jogador.",
    highlight: null,
  },
  {
    title: "Card do jogador",
    body: "Toque no card do jogador para ver opcoes de edicao e exclusao. O icone de coroa marca o capitao do time.",
    highlight: ".player-card",
  },
  {
    title: "Adicionar jogador",
    body: "O botao + (verde) abre o formulario para cadastrar um novo jogador: nome, numero, posicao, foto e numero de camisa.",
    highlight: ".players-fab",
  },
  {
    title: "Adicionar convidado",
    body: "O botao + Convidado adiciona um jogador temporario (pelada, reforco). Convidados aparecem em laranja e nao contam no limite de jogadores do plano gratuito.",
    highlight: ".players-guest-fab",
  },
];

const TUTORIAL_OFFICE_CALENDAR = [
  {
    title: "Aba Calendário",
    body: "Aqui voce registra todas as partidas do seu time: amistosos, campeonatos, torneios e rachas. Partidas futuras aparecem no topo; passadas abaixo em ordem decrescente.",
    highlight: null,
  },
  {
    title: "Abas do Escritório",
    body: "O Escritório tem tres abas: Calendario (partidas), Estatísticas (desempenho dos jogadores) e Importar (importacao de elenco via planilha CSV).",
    highlight: ".office-tabs",
  },
  {
    title: "Nova Partida",
    body: "Toque em NOVA PARTIDA para cadastrar uma partida. Voce pode registrar adversario, data, horario, local, tipo (amistoso, copa, etc.), resultado, gols, assistencias e presenca dos jogadores.",
    highlight: ".office-new-match-btn",
  },
  {
    title: "Card de partida",
    body: "Cada partida mostra o placar (V/E/D em cores), adversario, data e tipo. Se a partida ainda nao aconteceu, aparece 'EM BREVE' em verde.",
    highlight: ".office-match-list",
  },
  {
    title: "Convocar jogadores",
    body: "Em partidas futuras com lista de presenca preenchida, o botao CONVOCAR gera uma mensagem de convocacao pronta para enviar pelo WhatsApp.",
    highlight: ".office-match-list",
  },
];

const TUTORIAL_OFFICE_STATS = [
  {
    title: "Aba Estatísticas",
    body: "Aqui voce acompanha o desempenho de cada jogador ao longo da temporada: gols, assistencias, presencas e gols sofridos (para goleiros).",
    highlight: null,
  },
  {
    title: "Resumo de gols",
    body: "Os tres cards no topo mostram o total de gols marcados, gols sofridos e saldo de gols do time, calculados automaticamente a partir das partidas registradas.",
    highlight: ".office-goal-summary",
  },
  {
    title: "Tabela de jogadores",
    body: "Cada jogador aparece com seus numeros acumulados. Voce pode ajustar manualmente gols e assistencias usando os botoes + e - caso queira registrar estatísticas fora de partidas.",
    highlight: ".office-stats-view",
  },
  {
    title: "Exportar estatísticas",
    body: "O botao EXPORTAR / FILTRAR abre opcoes para gerar uma imagem da tabela de estatísticas, filtrar por periodo ou tipo de partida. Funcao completa disponivel no plano PRO.",
    highlight: ".office-export-stats-btn",
  },
];

const TUTORIAL_OFFICE_IMPORT = [
  {
    title: "Aba Importar",
    body: "Aqui voce pode importar um elenco inteiro de uma vez via arquivo CSV, sem precisar cadastrar jogador por jogador.",
    highlight: null,
  },
  {
    title: "Importar planilha CSV",
    body: "Toque em INICIAR IMPORTACAO, selecione o arquivo CSV exportado do Excel ou Google Sheets e o app vai adicionar ou atualizar os jogadores automaticamente.",
    highlight: ".office-import-card",
  },
];



// ─── Root App ─────────────────────────────────────────────────────────────────
function App() {
  const [authState, setAuthState] = useState("loading"); // "loading" | "loggedOut" | "loggedIn"
  const [user, setUser] = useState(null);
  const [isPremium, setIsPremium] = useState(false);
  const [navSection, setNavSection] = useState("home"); // "home" | "tactic" | "office"
  const [profileMode, setProfileMode] = useState(null); // null = main menu | "field" | "monthly"
  const [loginLoading, setLoginLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [onboardingDone, setOnboardingDone] = useState(()=>!!localStorage.getItem(ONBOARDING_KEY));
  const [migrating, setMigrating] = useState(false);
  const [teams, setTeams] = useState([]);
  const [activeTeamId, setActiveTeamId] = useState(null);
  const [showNewTeam, setShowNewTeam] = useState(false);
  const [showTeamLimitUpsell, setShowTeamLimitUpsell] = useState(false);
  const [editingTeam, setEditingTeam] = useState(null);
  const [toast, setToast] = useState(null);
  // ── Collab modals ──────────────────────────────────────────────────────────
  const [enableCollabTeam, setEnableCollabTeam] = useState(null); // team | null
  const [manageCollabTeam, setManageCollabTeam] = useState(null); // team | null
  const [showJoinCollab, setShowJoinCollab] = useState(false);
  const [joinCollabCode, setJoinCollabCode] = useState("");
  // ── Collab real-time subscriptions ────────────────────────────────────────
  // Map: teamId → unsub function
  const collabUnsubsRef = useRef({});
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  useEffect(()=>{
    const on=()=>setIsOnline(true);
    const off=()=>setIsOnline(false);
    window.addEventListener("online",on);
    window.addEventListener("offline",off);
    return()=>{window.removeEventListener("online",on);window.removeEventListener("offline",off);};
  },[]);
  // ── Global sync status (auto background saves) ─────────────────────────────
  // "idle" | "pending" | "syncing" | "synced" | "error"
  const [syncStatus, setSyncStatus] = useState("idle");
  const pendingOpsRef = useRef(0);
  const syncedTimerRef = useRef(null);
  const beginSync = useCallback(() => {
    pendingOpsRef.current += 1;
    setSyncStatus(s => s === "error" ? "error" : "pending");
  }, []);
  const startSyncing = useCallback(() => {
    setSyncStatus(s => s === "error" ? "error" : "syncing");
  }, []);
  const endSync = useCallback((success) => {
    pendingOpsRef.current = Math.max(0, pendingOpsRef.current - 1);
    if (!success) { setSyncStatus("error"); return; }
    if (pendingOpsRef.current === 0) {
      setSyncStatus("synced");
      clearTimeout(syncedTimerRef.current);
      syncedTimerRef.current = setTimeout(() => {
        setSyncStatus(s => s === "synced" ? "idle" : s);
      }, 2000);
    } else {
      setSyncStatus("pending");
    }
  }, []);
  // Track which teamIds have pending saves to debounce individually
  const saveTimersRef = useRef({}); // { [teamId]: timeoutId }
  const unsubAuthRef = useRef(null);
  // Tracks the latest `teams` state without retriggering effects — used to
  // detect whether the user edited data during a background cloud sync.
  const teamsRef = useRef(teams);
  useEffect(() => { teamsRef.current = teams; }, [teams]);

  // ── Periodic cache purge ────────────────────────────────────────────────────
  // Frees memory from expired in-memory cache entries during long sessions
  // (e.g. the app left open for hours). Runs independently of any user action.
  useEffect(() => {
    const interval = setInterval(() => _memCache.purgeExpired(), 5 * 60 * 1000); // every 5 min
    return () => clearInterval(interval);
  }, []);

  // ── Android hardware/gesture back button ────────────────────────────────────
  // Intercepts the Capacitor "backButton" event and navega entre telas do app
  // em vez de fechar o app imediatamente.
  // Hierarquia de navegação (do mais profundo para o mais raso):
  //   office/tactic → home → profileMode → menu principal (fecha o app)
  useEffect(() => {
    const handleBack = () => {
      // Dentro do modo "field": navegar entre seções
      if (profileMode === "field") {
        if (navSection === "office" || navSection === "tactic") {
          setNavSection("home");
          return;
        }
        // Em "home" dentro de "field": volta ao menu principal
        setProfileMode(null);
        setActiveTeamId(null);
        return;
      }
      // Sub-telas do modo "monthly"
      if (profileMode === "mensalistas" || profileMode === "sorteio-lista" || profileMode === "sorteio-tampinhas") {
        setProfileMode("monthly");
        return;
      }
      if (profileMode === "monthly") {
        setProfileMode(null);
        return;
      }
      // No menu principal (profileMode === null): permite fechar o app normalmente
      // Não chamamos App.exitApp() — o Capacitor usa o comportamento padrão do SO.
    };

    // Capacitor App plugin (disponível no wrapper nativo)
    const cap = window.Capacitor;
    if (cap && cap.Plugins && cap.Plugins.App) {
      const listener = cap.Plugins.App.addListener("backButton", handleBack);
      return () => { listener.remove(); };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileMode, navSection]);

  // ── Auth listener + initial data load ──────────────────────────────────────
  useEffect(() => {
    const setup = () => {
      const fb = getFirebase();
      if (!fb) return;
      unsubAuthRef.current = fb.onAuthStateChanged(fb.auth, async (u) => {
        if (u) {
          setUser(u);
          setAuthState("loggedIn");
          logA('login', { method: 'google' });

          // Non-blocking: fetch the user's premium status. Defaults to false
          // until/unless a real purchase flow (Play Billing, after the
          // Capacitor wrap) sets users/{uid}.isPremium = true.
          getIsPremium(u.uid).then(setIsPremium).catch(()=>{});

          const local = loadDataLocal();
          const hasLocalData = local?.teams?.length > 0;

          // Helper: push local-only data to the cloud (first-time sync) and
          // run the v1→v4 schema migrations + bring back the authoritative
          // cloud copy. Used both in the foreground (no local data) and
          // background (local data present) paths below.
          const syncWithCloud = async ({ applyTeams } = {}) => {
            const apply = applyTeams || ((cloudTeams) => {
              setTeams(cloudTeams);
              saveDataLocal({ teams: cloudTeams });
            });
            const { teams: cloudTeams, migrated } = await initTeamsFromCloud(u.uid);

            // Carregar times colaborativos dos quais o usuário participa
            const collabRefs = await loadCollabRefs(u.uid);
            let collabTeams = [];
            if (collabRefs.length > 0) {
              const loaded = await Promise.all(collabRefs.map(r => loadCollabTeamFull(r.teamId)));
              collabTeams = loaded.filter(Boolean);
            }
            // Deduplicar por id: cloudTeams pode já incluir o time collab (marcado _collabMigrated)
            // do dono; collabTeams carrega de collab_teams/. Priorizar a versão collab (mais atual).
            const teamMap = new Map();
            (cloudTeams || []).forEach(t => teamMap.set(String(t.id), t));
            collabTeams.forEach(t => teamMap.set(String(t.id), t)); // sobrescreve se duplicado
            const allTeams = Array.from(teamMap.values());

            if (allTeams.length > 0) {
              apply(allTeams);
            } else if (local?.teams?.length > 0) {
              // Cloud empty but we have local data — push it up
              const teamsWithLineups = local.teams.map(t => {
                if (t.lineups && t.lineups.length > 0) return t;
                const defL = makeLineup({ id: genUUID(), name: "Titular", type: "titular", formation: t.formation || "4-4-2", entries: t.lineup || [], isActive: true });
                return { ...t, lineups: [defL], activeLineupId: defL.id };
              });
              await Promise.all(teamsWithLineups.filter(t=>!t.isCollab).map(t => saveTeamWithPlayersCloud(u.uid, t)));
              await setSchemaVersion(u.uid, SCHEMA_VERSION);
            }
            if (migrated) {
              setToast("✅ Dados migrados para a nova estrutura!");
            }
          };

          if (hasLocalData) {
            // Nunca exibir times collab do cache local — eles são sempre carregados
            // do Firestore via loadCollabRefs. Isso evita exibir um time collab
            // do qual o usuário já saiu (cache pode estar desatualizado).
            const localPersonalTeams = (local.teams || []).filter(t => !t.isCollab);
            setTeams(localPersonalTeams);
            setMigrating(false);
            setLoaded(true);
            const teamsAtLoad = localPersonalTeams;
            syncWithCloud({
              // Avoid clobbering edits the user makes during the background
              // sync window: only apply the cloud snapshot if `teams` hasn't
              // changed since we displayed the local copy.
              applyTeams: (cloudTeams) => {
                if (teamsRef.current === teamsAtLoad) {
                  setTeams(cloudTeams);
                  saveDataLocal({ teams: cloudTeams });
                  // Subscribe em tempo real nos times colaborativos
                  const collabTs = cloudTeams.filter(t => t.isCollab);
                  collabTs.forEach(ct => {
                    if (!collabUnsubsRef.current[ct.id]) {
                      collabUnsubsRef.current[ct.id] = subscribeCollabTeam(ct.id, ({ type, data }) => {
                        setTeams(prev => prev.map(t => {
                          if (String(t.id) !== String(ct.id)) return t;
                          if (type === "deleted") { setTeams(prev => prev.filter(tm => String(tm.id) !== String(ct.id))); setActiveTeamId(prev => String(prev) === String(ct.id) ? null : prev); return t; }
                          if (type === "meta") return { ...t, ...data };
                          if (type === "players") return { ...t, players: data };
                          if (type === "lineups") {
                            const activeLineup = getActiveLineup(t, data);
                            return { ...t, lineups: data, formation: activeLineup?.formation || t.formation, lineup: activeLineup?.entries || t.lineup };
                          }
                          return t;
                        }));
                      });
                    }
                  });
                } else {
                  console.log("Skipping background cloud sync overwrite — local edits detected.");
                }
              }
            }).catch(e => {
              console.warn("Background cloud sync failed, keeping local data:", e);
            });
          } else {
            // No local cache (first login on this device) — nothing to show
            // yet, so we must wait for the cloud load (which may include a
            // one-time schema migration).
            setMigrating(true);
            try {
              await syncWithCloud();
              // Subscribe em tempo real nos times colaborativos
              const collabTs = teamsRef.current.filter(t => t.isCollab);
              collabTs.forEach(ct => {
                if (!collabUnsubsRef.current[ct.id]) {
                  collabUnsubsRef.current[ct.id] = subscribeCollabTeam(ct.id, ({ type, data }) => {
                    setTeams(prev => prev.map(t => {
                      if (String(t.id) !== String(ct.id)) return t;
                      if (type === "meta") return { ...t, ...data };
                      if (type === "players") return { ...t, players: data };
                      if (type === "lineups") {
                        const activeLineup = getActiveLineup(t, data);
                        return { ...t, lineups: data, formation: activeLineup?.formation || t.formation, lineup: activeLineup?.entries || t.lineup };
                      }
                      return t;
                    }));
                  });
                }
              });
            } catch(e) {
              console.warn("initTeamsFromCloud failed, using localStorage:", e);
              const fallback = loadDataLocal();
              if (fallback?.teams) setTeams(fallback.teams);
            } finally {
              setMigrating(false);
              setLoaded(true);
            }
          }
        } else {
          setUser(null);
          setIsPremium(false);
          setAuthState("loggedOut");
          setLoaded(false);
          setMigrating(false);
          setTeams([]);
          setActiveTeamId(null);
          // Clear all pending save timers
          Object.values(saveTimersRef.current).forEach(clearTimeout);
          saveTimersRef.current = {};
          // Unsubscribe all collab listeners
          Object.values(collabUnsubsRef.current).forEach(unsub => { try { unsub(); } catch {} });
          collabUnsubsRef.current = {};
          // Wipe memory cache to prevent data leaking between accounts
          _memCache.invalidateAll(user?.uid || "");
        }
      });
    };
    setup();
    // Captura resultado do signInWithRedirect (usado no WebView/APK)
    const handleRedirectResult = async () => {
      const fb = getFirebase(); if (!fb || !fb.getRedirectResult) return;
      try { await fb.getRedirectResult(fb.auth); } catch(e) { console.warn("Redirect result:", e); }
    };
    handleRedirectResult();
    return () => { if (unsubAuthRef.current) unsubAuthRef.current(); };
  }, []);

  // ── Persist to localStorage whenever teams change ──────────────────────────
  // Times colaborativos são carregados sempre do Firestore; não persistir
  // localmente para evitar exibir um time collab vazio quando offline.
  useEffect(() => {
    if (!loaded) return;
    saveDataLocal({ teams: teams.filter(t => !t.isCollab) });
  }, [teams, loaded]);

  // ── Save a single team metadata to cloud (debounced 600ms) ──────────────────
  const scheduleSaveTeam = useCallback((team) => {
    if (!user) return;
    const key = `team_${team.id}`;
    clearTimeout(saveTimersRef.current[key]);
    beginSync();
    saveTimersRef.current[key] = setTimeout(async () => {
      startSyncing();
      // Skip if team was deleted from state while this timer was pending
      if (!teamsRef.current.find(t => String(t.id) === String(team.id))) {
        delete saveTimersRef.current[key];
        endSync(true);
        return;
      }
      const ok = team.isCollab
        ? await saveCollabTeamMeta(team)
        : await saveTeamCloud(user.uid, team);
      delete saveTimersRef.current[key];
      endSync(ok);
    }, 600);
  }, [user, beginSync, startSyncing, endSync]);

  // ── Save a single player to cloud (debounced 800ms) ───────────────────────
  const scheduleSavePlayer = useCallback((teamId, player) => {
    if (!user) return;
    const key = `player_${teamId}_${player.id}`;
    clearTimeout(saveTimersRef.current[key]);
    beginSync();
    saveTimersRef.current[key] = setTimeout(async () => {
      startSyncing();
      const team = teamsRef.current.find(t => String(t.id) === String(teamId));
      const ok = team?.isCollab
        ? await saveCollabPlayer(teamId, player)
        : await savePlayerCloud(user.uid, teamId, player);
      delete saveTimersRef.current[key];
      endSync(ok);
    }, 800);
  }, [user, beginSync, startSyncing, endSync]);

  // ── Save on tab close ──────────────────────────────────────────────────────
  useEffect(() => {
    const handleUnload = (e) => {
      if (!loaded || !user) return;
      // Nunca persistir times collab no cache local — eles são sempre carregados
      // do Firestore no próximo boot via loadCollabRefs. Persistir collab no
      // localStorage causaria o bug de "voltar após sair" porque o cache é
      // exibido antes do cloud sync completar no próximo reload.
      saveDataLocal({ teams: teams.filter(t => !t.isCollab) });
      teams.forEach(t => {
        if (t.isCollab) saveCollabTeamMeta(t);
        else saveTeamCloud(user.uid, t);
      });
      if (syncStatus === "pending" || syncStatus === "syncing" || syncStatus === "error") {
        e.preventDefault();
        e.returnValue = "";
        return "";
      }
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, [teams, loaded, user, syncStatus]);

  // ── Force-save (called from TeamView save button) ─────────────────────────
  const handleForceSave = useCallback(async () => {
    if (!user || !loaded) return false;
    saveDataLocal({ teams });
    startSyncing();
    // Separar times pessoais de colaborativos — cada um usa o path correto
    const personalTeams = teams.filter(t => !t.isCollab);
    const collabTeams   = teams.filter(t =>  t.isCollab);
    const [ok1, ok2] = await Promise.all([
      personalTeams.length > 0 ? saveAllTeamsCloud(user.uid, personalTeams) : Promise.resolve(true),
      collabTeams.length   > 0 ? Promise.all(collabTeams.map(t => saveCollabTeamMeta(t))).then(rs => rs.every(Boolean)) : Promise.resolve(true),
    ]);
    const ok = ok1 && ok2;
    if (ok) {
      // Force-save covers everything pending — clear the counter entirely
      pendingOpsRef.current = 0;
      setSyncStatus("synced");
      clearTimeout(syncedTimerRef.current);
      syncedTimerRef.current = setTimeout(() => {
        setSyncStatus(s => s === "synced" ? "idle" : s);
      }, 2000);
    } else {
      setSyncStatus("error");
    }
    return ok;
  }, [user, loaded, teams, startSyncing]);

  // ── Auth helpers ───────────────────────────────────────────────────────────
  const isWebView = () => {
    const ua = navigator.userAgent || "";
    return /wv|WebView/.test(ua) || (window.Capacitor && window.Capacitor.isNativePlatform());
  };

  const handleLogin = async () => {
    const fb = getFirebase(); if (!fb) return;
    setLoginLoading(true);
    try {
      if (isWebView()) {
        // Login nativo via plugin Capacitor (evita redirecionamento para localhost)
        const result = await fb.FirebaseAuthentication.signInWithGoogle();
        const idToken = result.credential?.idToken;
        const credential = _fb.GoogleAuthProvider.credential(idToken);
        await fb.signInWithCredential(fb.auth, credential);
      } else {
        await fb.signInWithPopup(fb.auth, fb.provider);
      }
    } catch(e) {
      console.error("Login error:", e);
setLoginLoading(false);
    }
  };

  const handleLogout = async () => {
    const fb = getFirebase(); if (!fb) return;
    logA('logout');
    await fb.signOut(fb.auth);
    setActiveTeamId(null);
  };

  const handleDeleteAccount = async () => {
    const fb = getFirebase(); if (!fb) return;
    const user = fb.auth.currentUser; if (!user) return;
    const uid = user.uid;
    try {
      // Apagar times próprios e suas subcoleções
      const teamsSnap = await fb.getDocs(fb.collection(fb.db, "users", uid, "teams"));
      for (const teamDoc of teamsSnap.docs) {
        const tid = teamDoc.id;
        const subcols = ["players","lineups","matches","stats"];
        for (const sub of subcols) {
          const subSnap = await fb.getDocs(fb.collection(fb.db, "users", uid, "teams", tid, sub));
          const batch = fb.writeBatch(fb.db);
          subSnap.docs.forEach(d => batch.delete(d.ref));
          if (subSnap.docs.length) await batch.commit();
        }
        await fb.deleteDoc(teamDoc.ref);
      }
      // Apagar mensalistas e mensalidades
      const menSnap = await fb.getDocs(fb.collection(fb.db, "users", uid, "mensalistas"));
      for (const menDoc of menSnap.docs) {
        const mensSnap = await fb.getDocs(fb.collection(fb.db, "users", uid, "mensalistas", menDoc.id, "mensalidades"));
        const batch = fb.writeBatch(fb.db);
        mensSnap.docs.forEach(d => batch.delete(d.ref));
        if (mensSnap.docs.length) await batch.commit();
        await fb.deleteDoc(menDoc.ref);
      }
      // Apagar collab_refs e collab_agenda_refs
      const collabRefsSnap = await fb.getDocs(fb.collection(fb.db, "users", uid, "collab_refs"));
      const agendaRefsSnap = await fb.getDocs(fb.collection(fb.db, "users", uid, "collab_agenda_refs"));
      const batch2 = fb.writeBatch(fb.db);
      collabRefsSnap.docs.forEach(d => batch2.delete(d.ref));
      agendaRefsSnap.docs.forEach(d => batch2.delete(d.ref));
      await batch2.commit();
      // Apagar documento raiz do usuário
      await fb.deleteDoc(fb.doc(fb.db, "users", uid));
      // Apagar conta de autenticação
      logA('delete_account');
      await user.delete();
      setActiveTeamId(null);
    } catch(e) {
      console.error("Erro ao excluir conta:", e);
      // Se o Firebase exigir reautenticação (token expirado), orientar o usuário
      if (e.code === "auth/requires-recent-login") {
        alert("Por segurança, faça logout e login novamente antes de excluir sua conta.");
      } else {
        alert("Erro ao excluir conta. Tente novamente.");
      }
    }
  };

  // ── CRUD helpers ───────────────────────────────────────────────────────────
  const createTeam = async (form) => {
    const t = makeTeam(form.name, form.colorIdx);
    t.shieldEmoji = form.shieldEmoji || "🛡️";
    t.shieldShapeId = form.shieldShapeId || null;
    t.kits = form.kits || makeDefaultKits(form.colorIdx);
    t.activeKitId = form.activeKitId || "titular";
    const fb = getFirebase();
    const uid = fb?.auth?.currentUser?.uid;
    // PhotoPicker already compressed the image (≤300x300, JPEG 75%) — use it as-is.
    t.photo = form.photo || "";
    const newTeams = [...teams, t];
    setTeams(newTeams);
    saveDataLocal({ teams: newTeams });
    setShowNewTeam(false);
    setActiveTeamId(t.id);
    setToast("Time criado!");
    logA('create_team', { formation: t.formation });
    if (uid) {
      beginSync();
      startSyncing();
      const ok = await saveTeamCloud(uid, t);
      // Save initial lineup
      const lineupResults = await Promise.all((t.lineups || []).map(l => saveLineupCloud(uid, t.id, l)));
      endSync(ok && lineupResults.every(Boolean));
    }
  };

  const updateTeam = useCallback((updatedOrFn) => {
    setTeams(prev => {
      // Support both direct object update and functional updater (fn receives current team object)
      let next;
      if (typeof updatedOrFn === 'function') {
        // Find active team, apply fn, then merge back
        next = prev.map(t => {
          if (t.id !== activeTeamId) return t;
          const result = updatedOrFn(t);
          return result;
        });
      } else {
        const updated = updatedOrFn;
        next = prev.map(t => t.id === updated.id ? { ...t, ...updated } : t);
      }
      const teamId = typeof updatedOrFn === 'function' ? activeTeamId : updatedOrFn.id;
      const fresh = next.find(t => t.id === teamId);
      if (fresh) scheduleSaveTeam(fresh);
      return next;
    });
  }, [scheduleSaveTeam, activeTeamId]);

  // ── Save a single lineup to cloud (debounced 600ms) ────────────────────────
  const scheduleSaveLineup = useCallback((teamId, lineup) => {
    if (!user) return;
    const key = `lineup_${teamId}_${lineup.id}`;
    clearTimeout(saveTimersRef.current[key]);
    beginSync();
    saveTimersRef.current[key] = setTimeout(async () => {
      startSyncing();
      const team = teamsRef.current.find(t => String(t.id) === String(teamId));
      const ok = team?.isCollab
        ? await saveCollabLineup(teamId, lineup)
        : await saveLineupCloud(user.uid, teamId, lineup);
      delete saveTimersRef.current[key];
      endSync(ok);
    }, 600);
  }, [user, beginSync, startSyncing, endSync]);

  const deleteTeam = async (id) => {
    const team = teams.find(t => t.id === id);
    const filteredTeams = teams.filter(t => t.id !== id);
    setTeams(filteredTeams);
    saveDataLocal({ teams: filteredTeams });
    if (activeTeamId === id) setActiveTeamId(null);

    if (team?.isCollab) {
      // Unsubscribe real-time listener antes de qualquer operação
      if (collabUnsubsRef.current[id]) {
        try { collabUnsubsRef.current[id](); } catch {}
        delete collabUnsubsRef.current[id];
      }
      const isOwner = team.ownerUid === uid;
      if (isOwner) {
        // Dono: encerrar colaboração = desativar (migra dados de volta, não apaga)
        setToast("Colaboração encerrada — time restaurado");
        const ok = await deactivateCollabTeam(id, uid);
        if (ok) {
          // Recarregar o time pessoal que voltou (sem o flag _collabMigrated)
          _memCache.invalidateTeam(uid, id);
          const restored = await loadTeamFull(uid, { id, ...team, isCollab: false, _collabMigrated: false });
          if (restored) {
            setTeams(prev => {
              const next = [...prev.filter(t => t.id !== id), { ...restored, isCollab: false }];
              saveDataLocal({ teams: next });
              return next;
            });
          }
        }
      } else {
        // Editor: sair do time colaborativo
        // Usar fb.auth.currentUser.uid diretamente para garantir que o uid
        // está disponível independente do estado React no momento da chamada.
        const fb = getFirebase();
        const currentUid = fb?.auth?.currentUser?.uid || uid;
        if (!currentUid) {
          setTeams(prev => {
            if (prev.find(t => t.id === id)) return prev;
            return [...prev, team];
          });
          setToast("Erro ao sair: usuário não identificado. Tente novamente.");
          return;
        }
        const ok = await removeCollabMember(String(id), currentUid);
        if (ok) {
          setToast("Você saiu do time colaborativo");
        } else {
          // Falhou — reverter remoção da UI e avisar o usuário
          setTeams(prev => {
            if (prev.find(t => t.id === id)) return prev;
            const reverted = [...prev, team];
            saveDataLocal({ teams: reverted });
            return reverted;
          });
          setToast("Erro ao sair do time. Verifique sua conexão.");
        }
      }
      return;
    }

    setToast("Time excluído");
    const fb = getFirebase();
    const uidLocal = fb?.auth?.currentUser?.uid;
    if (uidLocal) {
      // Cancel all pending saves for this team and its players
      Object.keys(saveTimersRef.current).forEach(key => {
        if (key === `team_${id}` || key.startsWith(`player_${id}_`) || key.startsWith(`lineup_${id}_`)) {
          clearTimeout(saveTimersRef.current[key]);
          delete saveTimersRef.current[key];
        }
      });
      await deleteTeamCloud(uidLocal, id); // deletes team doc + all player subcollection docs
    }
  };

  const editTeam = async (form) => {
    const fb = getFirebase();
    const uid = fb?.auth?.currentUser?.uid;
    // PhotoPicker already compressed the image (≤300x300, JPEG 75%) — use it as-is.
    const updated = { ...editingTeam, ...form };
    const updatedTeams = teams.map(t => t.id === editingTeam.id ? updated : t);
    setTeams(updatedTeams);
    saveDataLocal({ teams: updatedTeams });
    setEditingTeam(null);
    setToast("Time atualizado!");
    if (uid) {
      if (updated.isCollab) saveCollabTeamMeta(updated);
      else saveTeamCloud(uid, updated);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  if (authState === "loading") return (
    <div style={{minHeight:"100vh",background:"#050c0a",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16}}>
      <div style={{width:40,height:40,border:"3px solid rgba(52,211,153,0.3)",borderTopColor:"#34d399",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
      <span style={{color:"#34d399",fontFamily:"'Bebas Neue',sans-serif",fontSize:20,letterSpacing:2}}>CARREGANDO...</span>
      <style>{`@keyframes spin{to{transform:rotate(360deg);}}`}</style>
    </div>
  );

  if (authState === "loggedOut" && !isOnline) return (
    <div style={{minHeight:"100vh",background:"#050c0a",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:24,padding:"0 32px"}}>
      <style>{`@keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.5;}}`}</style>
      <img src="/assets/images/logo.png" alt="Escalação FC" style={{width:120,height:120,objectFit:"contain",marginBottom:8}}/>
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:12,textAlign:"center"}}>
        <div style={{width:56,height:56,borderRadius:"50%",background:"rgba(239,68,68,0.12)",border:"2px solid rgba(239,68,68,0.4)",display:"flex",alignItems:"center",justifyContent:"center"}}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.56 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>
          </svg>
        </div>
        <span style={{color:"#fff",fontFamily:"'Bebas Neue',sans-serif",fontSize:26,letterSpacing:2}}>SEM CONEXÃO</span>
        <span style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:14,lineHeight:1.6,maxWidth:280}}>
          O primeiro acesso ao <b style={{color:"#34d399"}}>Escalação FC</b> requer conexão com a internet para autenticar sua conta Google.
        </span>
        <span style={{color:"#6B7280",fontFamily:"'DM Sans',sans-serif",fontSize:12,lineHeight:1.6,maxWidth:280}}>
          Após o login, você poderá usar o app normalmente mesmo sem internet.
        </span>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:8,background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:12,padding:"10px 18px",animation:"pulse 2s ease-in-out infinite"}}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span style={{color:"#ef4444",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700}}>Conecte-se ao Wi-Fi ou dados móveis</span>
      </div>
    </div>
  );

  if (authState === "loggedOut") return (
    <>
      <LoginScreen onLogin={handleLogin} loading={loginLoading}/>
      <style>{`@keyframes spin{to{transform:rotate(360deg);}}`}</style>
    </>
  );

  if (!loaded) return (
    <div style={{minHeight:"100vh",background:"#050c0a",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16}}>
      <div style={{width:40,height:40,border:"3px solid rgba(52,211,153,0.3)",borderTopColor:"#34d399",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
      <span style={{color:"#34d399",fontFamily:"'Bebas Neue',sans-serif",fontSize:20,letterSpacing:2}}>
        {migrating ? "MIGRANDO DADOS..." : "SINCRONIZANDO..."}
      </span>
      {migrating && (
        <span style={{color:"#4B5563",fontFamily:"'DM Sans',sans-serif",fontSize:12,letterSpacing:1,maxWidth:260,textAlign:"center",lineHeight:1.6}}>
          Migrando jogadores para documentos independentes.<br/>Isso acontece apenas uma vez.
        </span>
      )}
      <style>{`@keyframes spin{to{transform:rotate(360deg);}}`}</style>
    </div>
  );

  const activeTeam = teams.find(t => t.id === activeTeamId);
  const uid = user?.uid;

  // Chamado quando o usuário faz downgrade de premium → free.
  // Desativa todos os times e agendas colaborativos de que ele é dono.
  const handlePremiumDowngrade = async (currentUid, currentTeams) => {
    if (!currentUid) return;
    // 1. Times: desativa todos os collab de que o usuário é dono
    const ownedCollabTeams = (currentTeams || []).filter(t => t.isCollab && t.ownerUid === currentUid);
    if (ownedCollabTeams.length > 0) {
      await Promise.all(ownedCollabTeams.map(t => deactivateCollabTeam(t.id, currentUid)));
      setTeams(prev => prev.map(t =>
        t.isCollab && t.ownerUid === currentUid ? { ...t, isCollab: false, _collabMigrated: false } : t
      ));
    }
    // 2. Agendas: desativa todas as collab do usuário via Firestore
    await deactivateAllOwnedCollabAgendas(currentUid);
  };

  // When a team is active, sections "tactic" and "office" are available.
  // If the user navigates to "home", keep activeTeamId so they can come back.
  const showNav = authState === "loggedIn" && loaded && !!activeTeam;

  return (
    <div style={{minHeight:"100vh",background:"#050c0a"}}>
      <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;700;900&family=Anton&family=Oswald:wght@400;700&family=Teko:wght@400;700&family=Russo+One&family=Archivo+Black&family=Squada+One&family=Black+Ops+One&family=Orbitron:wght@400;700&family=Staatliches&family=Bungee&display=swap" rel="stylesheet"/>
      <style>{`
        *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
        select option{background:#0d1f17;}
        ::-webkit-scrollbar{width:4px;}::-webkit-scrollbar-track{background:transparent;}::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.15);border-radius:4px;}
        @keyframes fadeUp{from{opacity:0;transform:translateY(18px);}to{opacity:1;transform:translateY(0);}}
        @keyframes toastIn{from{opacity:0;transform:translateX(-50%) translateY(-8px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}
        @keyframes spin{to{transform:rotate(360deg);}}
      `}</style>

      {toast && <Toast msg={toast} onDone={() => setToast(null)}/>}

      {/* ── Banner de offline (só quando logado) ── */}
      {!isOnline && authState === "loggedIn" && (
        <div style={{position:"fixed",bottom:"calc(env(safe-area-inset-bottom,0px) + 12px)",left:"50%",transform:"translateX(-50%)",zIndex:9999,background:"rgba(17,24,39,0.97)",border:"1px solid rgba(234,179,8,0.3)",borderRadius:12,padding:"9px 16px",display:"flex",alignItems:"center",gap:8,boxShadow:"0 4px 24px rgba(0,0,0,0.5)",maxWidth:"calc(100vw - 32px)",whiteSpace:"nowrap"}}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#eab308" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
            <line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.56 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>
          </svg>
          <span style={{color:"#eab308",fontFamily:"'DM Sans',sans-serif",fontSize:12,fontWeight:700}}>Offline</span>
          <span style={{color:"#9CA3AF",fontFamily:"'DM Sans',sans-serif",fontSize:12}}>— sincroniza ao reconectar</span>
        </div>
      )}

      {/* ── Onboarding (primeira vez) ── */}
      {authState === "loggedIn" && loaded && !onboardingDone && (
        <OnboardingScreen onDone={()=>setOnboardingDone(true)}/>
      )}

      {/* ── Main menu (mode selector) ── */}
      {authState === "loggedIn" && loaded && !profileMode && onboardingDone && (
        <MainMenuScreen
          user={user}
          isPremium={isPremium}
          onTogglePremium={()=>{
            if(!IS_DEV) return;
            const next=!isPremium;
            setIsPremium(next);
            if(!next) handlePremiumDowngrade(user?.uid, teams);
          }}
          onLogout={handleLogout}
          onDeleteAccount={handleDeleteAccount}
          onSelect={(mode)=>{ logA('select_mode', { mode }); setProfileMode(mode); }}
        />
      )}

      {/* ── Monthly mode ── */}
      {authState === "loggedIn" && loaded && profileMode === "monthly" && (
        <PeladaMensalScreen onBack={()=>setProfileMode(null)} uid={uid} onSelect={(key)=>{ if(key==="mensalistas") setProfileMode("mensalistas"); if(key==="sorteio-lista") setProfileMode("sorteio-lista"); if(key==="sorteio-tampinhas") setProfileMode("sorteio-tampinhas"); }}/>
      )}

      {/* ── Mensalistas mode ── */}
      {authState === "loggedIn" && loaded && profileMode === "mensalistas" && (
        <MensalistasScreen onBack={()=>setProfileMode("monthly")} uid={uid} user={user} isPremium={isPremium}/>
      )}

      {/* ── Sorteio Lista mode ── */}
      {authState === "loggedIn" && loaded && profileMode === "sorteio-lista" && (
        <SorteioListaScreen onBack={()=>setProfileMode("monthly")} uid={uid}/>
      )}

      {/* ── Sorteio Tampinhas mode ── */}
      {authState === "loggedIn" && loaded && profileMode === "sorteio-tampinhas" && (
        <SorteioTampinhasScreen onBack={()=>setProfileMode("monthly")}/>
      )}

      {/* ── Premium Benefits ── */}
      {authState === "loggedIn" && loaded && profileMode === "premium" && (
        <PremiumBenefitsScreen onBack={()=>setProfileMode(null)} isPremium={isPremium}/>
      )}

      {/* ── Field mode: full app ── */}
      {authState === "loggedIn" && loaded && profileMode === "field" && (<>

      {/* ── Section routing ── */}

      {/* Home: team list */}
      {(navSection === "home" || !activeTeam) && (
        <HomePage
          teams={teams}
          user={user}
          syncStatus={syncStatus}
          onRetrySync={handleForceSave}
          isPremium={isPremium}
          onTogglePremium={()=>{
            if(!IS_DEV) return; // botão só ativo em localhost
            const next=!isPremium;
            setIsPremium(next);
            // Em dev: só muda estado local — não grava no Firestore
            // (as rules bloqueiam escrita de isPremium pelo cliente)
            if(!next) handlePremiumDowngrade(user?.uid, teams);
          }}
          onBackToMenu={()=>{ setProfileMode(null); setActiveTeamId(null); setNavSection("home"); }}
          onSelectTeam={async (t) => {
            const fb = getFirebase();
            const u = fb?.auth?.currentUser?.uid;
            if (u && !t.isCollab) {
              const cacheKey = `${u}_${t.id}`;
              const needsLoad = !_memCache.has(_memCache.players, cacheKey) || !_memCache.has(_memCache.lineups, cacheKey);
              if (needsLoad) {
                const full = await loadTeamFull(u, t);
                setTeams(prev => prev.map(tm => tm.id === t.id ? { ...tm, ...full } : tm));
              }
            } else if (t.isCollab) {
              // Garantir subscribe ativo ao abrir time colaborativo
              if (!collabUnsubsRef.current[t.id]) {
                collabUnsubsRef.current[t.id] = subscribeCollabTeam(t.id, ({ type, data }) => {
                  setTeams(prev => prev.map(tm => {
                    if (String(tm.id) !== String(t.id)) return tm;
                    if (type === "meta") return { ...tm, ...data };
                    if (type === "players") return { ...tm, players: data };
                    if (type === "lineups") {
                      const activeLineup = getActiveLineup(tm, data);
                      return { ...tm, lineups: data, formation: activeLineup?.formation || tm.formation, lineup: activeLineup?.entries || tm.lineup };
                    }
                    return tm;
                  }));
                });
              }
              // Recarregar dados completos ao abrir
              const full = await loadCollabTeamFull(t.id);
              if (full) setTeams(prev => prev.map(tm => tm.id === t.id ? { ...tm, ...full } : tm));
            }
            setActiveTeamId(t.id);
            setNavSection("tactic");
          }}
          onNewTeam={() => {
            if (!isPremium && teams.length >= FREE_TEAM_LIMIT) { setShowTeamLimitUpsell(true); return; }
            setShowNewTeam(true);
          }}
          onDeleteTeam={deleteTeam}
          onEditTeam={(t) => setEditingTeam(t)}
          onLogout={handleLogout}
          onImportDone={async () => {
            if (uid) {
              const refreshed = await loadAllTeamsFull(uid);
              if (refreshed) setTeams(refreshed);
            }
          }}
          onEnableCollab={(team) => setEnableCollabTeam(team)}
          onManageCollab={(team) => setManageCollabTeam(team)}
          onJoinCollab={(code) => { setJoinCollabCode(code || ""); setShowJoinCollab(true); }}
        />
      )}

      {/* Tactic: TeamView (prancheta + elenco) */}
      {navSection === "tactic" && activeTeam && (
        <TeamView
          team={activeTeam}
          onUpdateTeam={updateTeam}
          onBack={() => { setNavSection("home"); }}
          onForceSave={handleForceSave}
          onSavePlayer={scheduleSavePlayer}
          onSaveLineup={scheduleSaveLineup}
          syncStatus={syncStatus}
          isPremium={isPremium}
          uid={uid}
          onDeletePlayerCloud={(teamId, playerId) => {
            const team = teams.find(t => String(t.id) === String(teamId));
            if (team?.isCollab) {
              const key = `player_${teamId}_${playerId}`;
              clearTimeout(saveTimersRef.current[key]);
              delete saveTimersRef.current[key];
              deleteCollabPlayer(teamId, playerId);
            } else if (uid) {
              const key = `player_${teamId}_${playerId}`;
              clearTimeout(saveTimersRef.current[key]);
              delete saveTimersRef.current[key];
              deletePlayerCloud(uid, teamId, playerId);
            }
          }}
          onDeleteLineup={(teamId, lineupId) => {
            const team = teams.find(t => String(t.id) === String(teamId));
            if (team?.isCollab) {
              const key = `lineup_${teamId}_${lineupId}`;
              clearTimeout(saveTimersRef.current[key]);
              delete saveTimersRef.current[key];
              deleteCollabLineup(teamId, lineupId);
            } else if (uid) {
              const key = `lineup_${teamId}_${lineupId}`;
              clearTimeout(saveTimersRef.current[key]);
              delete saveTimersRef.current[key];
              deleteLineupCloud(uid, teamId, lineupId);
            }
          }}
        />
      )}

      {/* Office: calendar + stats */}
      {navSection === "office" && activeTeam && (
        <OfficeView team={activeTeam} uid={uid} onUpdateTeam={updateTeam} onSavePlayer={scheduleSavePlayer} isPremium={isPremium}/>
      )}

      {/* Bottom navigation — only when logged in with a team selected */}
      {showNav && (
        <BottomNav active={navSection} onChange={section => {
          // Office and tactic require an active team
          if ((section === "office" || section === "tactic") && !activeTeam) return;
          setNavSection(section);
        }}/>
      )}

      {showNewTeam && <TeamFormModal isPremium={isPremium} onSave={createTeam} onClose={() => setShowNewTeam(false)}/>}
      {editingTeam && <TeamFormModal initial={editingTeam} isPremium={isPremium} onSave={editTeam} onClose={() => setEditingTeam(null)}/>}
      {showTeamLimitUpsell && <PremiumUpsellModal
        title="Limite de times"
        description={`No plano gratuito você pode cadastrar ${FREE_TEAM_LIMIT} time. Faça upgrade para o premium e gerencie times ilimitados.`}
        onClose={()=>setShowTeamLimitUpsell(false)}
      />}

      {/* ── Modais colaborativos ── */}
      {enableCollabTeam && (
        <EnableCollabModal
          team={enableCollabTeam}
          user={user}
          onClose={()=>setEnableCollabTeam(null)}
          onEnabled={async () => {
            // Recarregar o time agora como colaborativo
            const full = await loadCollabTeamFull(enableCollabTeam.id);
            if (full) {
              setTeams(prev => prev.map(t => t.id === enableCollabTeam.id ? { ...t, ...full } : t));
              // Ativar subscribe
              if (!collabUnsubsRef.current[enableCollabTeam.id]) {
                collabUnsubsRef.current[enableCollabTeam.id] = subscribeCollabTeam(enableCollabTeam.id, ({ type, data }) => {
                  setTeams(prev => prev.map(t => {
                    if (String(t.id) !== String(enableCollabTeam.id)) return t;
                    if (type === "meta") return { ...t, ...data };
                    if (type === "players") return { ...t, players: data };
                    if (type === "lineups") {
                      const activeLineup = getActiveLineup(t, data);
                      return { ...t, lineups: data, formation: activeLineup?.formation || t.formation, lineup: activeLineup?.entries || t.lineup };
                    }
                    return t;
                  }));
                });
              }
            }
            setEnableCollabTeam(null);
            setToast("🤝 Colaboração ativada!");
          }}
        />
      )}
      {manageCollabTeam && (
        <CollabInviteModal
          team={manageCollabTeam}
          user={user}
          onClose={()=>setManageCollabTeam(null)}
          onBeforeDeactivate={() => {
            // Para o listener ANTES de deletar o doc no Firestore,
            // evitando que o onSnapshot "deleted" remova o time da lista (tela preta).
            const teamId = manageCollabTeam.id;
            if (collabUnsubsRef.current[teamId]) {
              try { collabUnsubsRef.current[teamId](); } catch {}
              delete collabUnsubsRef.current[teamId];
            }
          }}
          onDeactivated={async () => {
            const teamId = manageCollabTeam.id;
            // Recarregar o time pessoal restaurado
            _memCache.invalidateTeam(uid, teamId);
            const restored = await loadTeamFull(uid, { id: teamId, isCollab: false, _collabMigrated: false, ...manageCollabTeam });
            if (restored) {
              setTeams(prev => prev.map(t => t.id === teamId ? { ...restored, isCollab: false } : t));
            } else {
              setTeams(prev => prev.map(t => t.id === teamId ? { ...t, isCollab: false } : t));
            }
            setManageCollabTeam(prev => prev ? { ...prev, isCollab: false } : null);
            setToast("🔒 Colaboração desativada — time restaurado");
          }}
          onEnabled={async () => {
            const teamId = manageCollabTeam.id;
            const full = await loadCollabTeamFull(teamId);
            if (full) {
              setTeams(prev => prev.map(t => t.id === teamId ? { ...t, ...full, isCollab: true } : t));
              if (!collabUnsubsRef.current[teamId]) {
                collabUnsubsRef.current[teamId] = subscribeCollabTeam(teamId, ({ type, data }) => {
                  setTeams(prev => prev.map(t => {
                    if (String(t.id) !== String(teamId)) return t;
                    if (type === "meta") return { ...t, ...data };
                    if (type === "players") return { ...t, players: data };
                    if (type === "lineups") {
                      const activeLineup = getActiveLineup(t, data);
                      return { ...t, lineups: data, formation: activeLineup?.formation || t.formation, lineup: activeLineup?.entries || t.lineup };
                    }
                    return t;
                  }));
                });
              }
            } else {
              setTeams(prev => prev.map(t => t.id === teamId ? { ...t, isCollab: true } : t));
            }
            setManageCollabTeam(prev => prev ? { ...prev, isCollab: true } : null);
            setToast("🤝 Colaboração ativada!");
          }}
        />
      )}
      {showJoinCollab && (
        <JoinCollabModal
          user={user}
          initialCode={joinCollabCode}
          isPremium={isPremium}
          collabMemberCount={teams.filter(t=>t.isCollab&&t.ownerUid!==uid).length}
          onClose={()=>{ setShowJoinCollab(false); setJoinCollabCode(""); }}
          onJoined={async (teamId) => {
            // Carregar o time colaborativo que acabou de entrar
            if (teamId) {
              const full = await loadCollabTeamFull(teamId);
              if (full) {
                setTeams(prev => {
                  if (prev.some(t => String(t.id) === String(teamId))) {
                    return prev.map(t => String(t.id) === String(teamId) ? { ...t, ...full } : t);
                  }
                  return [...prev, full];
                });
                // Ativar subscribe
                if (!collabUnsubsRef.current[teamId]) {
                  collabUnsubsRef.current[teamId] = subscribeCollabTeam(teamId, ({ type, data }) => {
                    setTeams(prev => prev.map(t => {
                      if (String(t.id) !== String(teamId)) return t;
                      if (type === "meta") return { ...t, ...data };
                      if (type === "players") return { ...t, players: data };
                      if (type === "lineups") {
                        const activeLineup = getActiveLineup(t, data);
                        return { ...t, lineups: data, formation: activeLineup?.formation || t.formation, lineup: activeLineup?.entries || t.lineup };
                      }
                      return t;
                    }));
                  });
                }
              }
            }
            setShowJoinCollab(false);
            setJoinCollabCode("");
          }}
        />
      )}
      </>)}
    </div>
  );
}

export default App;
