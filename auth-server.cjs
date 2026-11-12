const path = require("node:path");
const express = require("express");
const { initializeApp, cert } = require("firebase-admin/app");
const { getDatabaseWithUrl } = require("firebase-admin/database");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
let authConfigurationError;
try {
  if (!raw && !encoded) throw new Error("Firebase service account is required for login");
  let credentials;
  try {
    credentials = JSON.parse(raw || Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    throw new Error("Firebase service account must contain the complete valid JSON document");
  }
  if (credentials.project_id !== "jbmrsports-cricket-live") {
    throw new Error("Use the jbmrsports-cricket-live service account for the app login");
  }
  if (!process.env.TWOFACTOR_API_KEY) throw new Error("TWOFACTOR_API_KEY is required");
  try {
    initializeApp({ credential: cert(credentials) });
  } catch {
    throw new Error("Firebase service account could not be initialized");
  }
} catch (err) {
  authConfigurationError = err.message;
  console.error("Login configuration:", authConfigurationError);
}
const { handleSendOtp, handleVerifyOtp, handleVerifyPinLogin, createPinHash } = require("./lib/otp-2factor.cjs");
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8kb" }));
app.get("/health", (_req, res) => res.status(authConfigurationError ? 503 : 200).json({
  ok: !authConfigurationError, service: "jbmr-auth", provider: "2factor", template: "OTP1",
  error: authConfigurationError,
}));
app.use(["/sendOtp", "/verifyOtp", "/verifyPinLogin"], (_req, res, next) => {
  if (authConfigurationError) return res.status(503).json({ ok: false, error: "Login is temporarily unavailable. Please try again later." });
  next();
});
app.post("/sendOtp", handleSendOtp);
app.post("/verifyOtp", handleVerifyOtp);
app.post("/verifyPinLogin", handleVerifyPinLogin);
app.get("/api/public/live-feed", authenticated, async (_req, res) => {
  try {
    const db = getDatabaseWithUrl("https://jbmrsports-cricket-live-default-rtdb.asia-southeast1.firebasedatabase.app");
    const [feed, scorer80, scorer99, scorer6] = await Promise.all([
      db.ref("tournament_feed").get(),
      db.ref("scorers_public/80c7442eb2ca4aeabfb6779128d91b8a").get(),
      db.ref("scorers_public/994bd24b405943c790d9b8b32d3e13e2").get(),
      db.ref("scorers_public/6fca9fc7d4974919a43b149d32717119").get(),
    ]);
    const source = feed.val() || {};
    const scorerIDs = new Set(["80c7442eb2ca4aeabfb6779128d91b8a", "994bd24b405943c790d9b8b32d3e13e2", "6fca9fc7d4974919a43b149d32717119"]);
    const discover = (node) => {
      if (Array.isArray(node)) return node.forEach(discover);
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if ((key === "installation_id" || key === "scorer_installation") && typeof value === "string" && value.trim()) scorerIDs.add(value.trim());
        discover(value);
      }
    };
    discover(source);
    const dynamicScorers = await Promise.all([...scorerIDs].filter((id) => !["80c7442eb2ca4aeabfb6779128d91b8a", "994bd24b405943c790d9b8b32d3e13e2", "6fca9fc7d4974919a43b149d32717119"].includes(id)).map((id) => db.ref(`scorers_public/${id}`).get()));
    const scorerValues = [scorer80.val(), scorer99.val(), scorer6.val(), ...dynamicScorers.map((s) => s.val())];
    const scorerList = [...scorerIDs];
    const teamIndex = {};
    for (const [sourceIndex, snapshot] of scorerValues.entries()) {
      for (const [id, team] of Object.entries(snapshot?.tables?.teams || {})) {
        teamIndex[`${scorerList[sourceIndex]}:${String(team?.id ?? id)}`] = { id: String(team?.id ?? id), name: team?.name || "Team", shortName: team?.short_name || team?.shortName || null, logoUrl: team?.logo_url || null };
      }
    }
    const tournaments = {};
    for (const [installationKey, installation] of Object.entries(source)) {
      for (const [key, raw] of Object.entries(installation?.tournaments || {})) {
        const t = raw || {};
        const sourceID = String(t.installation_id || t.scorer_installation || installation?.installation_id || installation?.scorer_installation || installationKey);
        const tid = String(t.tournament_uid || t.tournament_id || key);
        const matches = {};
        for (const [matchKey, match] of Object.entries(t.matches || {})) {
          const m = match || {};
          matches[String(m.match_uid || m.match_id || matchKey)] = {
            matchId: String(m.match_uid || m.match_id || matchKey), status: m.status || "scheduled",
            title: m.title || "Match", scheduledAt: m.scheduled_at || null, venue: m.venue || t.venue || null,
            result: m.result || null, highlightUrl: m.highlight_url || null, liveUrl: m.youtube_url || null,
            team1: m.team1 || m.team_a || teamIndex[`${sourceID}:${String(m.team_a_id)}`] || { name: "TBD" },
            team2: m.team2 || m.team_b || teamIndex[`${sourceID}:${String(m.team_b_id)}`] || { name: "TBD" },
          };
        }
        tournaments[tid] = { tournamentId: String(t.tournament_id || tid), name: t.name || "Tournament",
          logoUrl: t.logo_url || null, venue: t.venue || null, matches };
      }
    }
    const safeScorer = (snapshot) => {
      const tables = snapshot?.tables || {};
      const matches = Object.values(tables.matches || {}).map((m) => ({
        id: m.id, status: m.status, title: m.title, scheduledAt: m.scheduled_at,
        teamAId: m.team_a_id, teamBId: m.team_b_id, tournamentId: m.tournament_id,
        innings: Object.values(tables.innings || {}).filter((i) => i.match_id === m.id).map((i) => ({ id: i.id, number: i.number, state: i.state, battingTeamId: i.batting_team_id })),
      }));
      return { matches };
    };
    res.set("Cache-Control", "no-store").json({ ok: true, tournaments, scorers: scorerValues.map(safeScorer) });
  } catch {
    res.status(502).json({ ok: false, error: "Live feed temporarily unavailable" });
  }
});
async function authenticated(req, res, next) {
  if (authConfigurationError) return res.status(503).json({ ok: false, error: "Login unavailable" });
  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
    req.user = await require("firebase-admin/auth").getAuth().verifyIdToken(token);
    next();
  } catch {
    res.status(401).json({ ok: false, error: "Please sign in again" });
  }
}
require("./lib/admin-visibility.cjs").install(app);
require("./lib/shorts.cjs").install(app, authenticated);
app.get("/api/scoring-archives", authenticated, async (_req, res) => {
  try {
    const payloads = await require("./lib/admin-visibility.cjs").archives();
    res.set("Cache-Control", "private, no-store").json({ ok: true, archives: payloads });
  } catch (error) {
    console.error("JBMR archive API failed", error.code ?? error.name, error.message);
    res.status(502).json({ ok: false, error: "Match archives could not load" });
  }
});
app.post("/savePin", authenticated, async (req, res) => {
  const phone = String(req.user.phone_number || req.user.phone || "").replace(/^\+91/, "");
  const pin = String(req.body.pin || "");
  const legacyHash = String(req.body.pinHash || "");
  if (!/^\d{10}$/.test(phone) || (!/^\d{4}$/.test(pin) && !/^[a-f0-9]{64}$/.test(legacyHash))) return res.status(400).json({ ok: false, error: "Invalid PIN setup" });
  try {
    const hash = /^\d{4}$/.test(pin) ? createPinHash(pin) : legacyHash;
    const db = require("firebase-admin/firestore").getFirestore("criccricket");
    const batch = db.batch();
    batch.set(db.collection("phonePins").doc(phone), { uid: req.user.uid, pinHash: hash, updatedAt: new Date() }, { merge: true });
    const userRef = db.collection("users").doc(req.user.uid);
    if ((await userRef.get()).exists) {
      const removeLegacyVerifier = require("firebase-admin/firestore").FieldValue.delete();
      batch.set(userRef, { pinHash: removeLegacyVerifier, pinUpdatedAt: removeLegacyVerifier }, { merge: true });
    }
    await batch.commit();
    res.json({ ok: true });
  } catch { res.status(502).json({ ok: false, error: "PIN could not be saved" }); }
});
app.use(express.static(path.join(__dirname, "dist")));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "dist", "index.html")));
app.use((_req, res) => res.status(404).json({ ok: false, error: "Endpoint not found" }));
app.listen(Number(process.env.PORT || 3000), "0.0.0.0");
