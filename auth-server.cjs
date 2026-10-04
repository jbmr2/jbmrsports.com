const path = require("node:path");
const express = require("express");
const { initializeApp, cert } = require("firebase-admin/app");
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
const { handleSendOtp, handleVerifyOtp, handleVerifyPinLogin } = require("./lib/otp-2factor.cjs");
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
app.get("/api/scoring-archives", authenticated, async (_req, res) => {
  try {
    const db = require("firebase-admin/firestore").getFirestore("criccricket");
    const docs = await db.collection("scoring_archives").doc("80c7442eb2ca4aeabfb6779128d91b8a").collection("matches").get();
    const payloads = [];
    for (const doc of docs.docs) {
      const row = doc.data();
      if (row.status !== "completed" || !row.revision) continue;
      const chunks = await doc.ref.collection("revisions").doc(row.revision).collection("chunks").get();
      const parts = chunks.docs.sort((a, b) => a.id.localeCompare(b.id)).map(x => x.get("json"));
      if (parts.length !== Number(row.chunk_count) || parts.some(x => typeof x !== "string")) throw Error("Invalid archive");
      payloads.push(JSON.parse(parts.join("")));
    }
    res.set("Cache-Control", "private, no-store").json({ ok: true, archives: payloads });
  } catch {
    res.status(502).json({ ok: false, error: "Match archives could not load" });
  }
});
app.post("/savePin", authenticated, async (req, res) => {
  const phone = String(req.user.phone_number || "").replace(/^\+91/, "");
  const hash = String(req.body.pinHash || "");
  if (!/^\d{10}$/.test(phone) || !/^[a-f0-9]{64}$/.test(hash)) return res.status(400).json({ ok: false, error: "Invalid PIN setup" });
  try {
    const db = require("firebase-admin/firestore").getFirestore("criccricket");
    const batch = db.batch();
    batch.set(db.collection("phonePins").doc(phone), { uid: req.user.uid, pinHash: hash, updatedAt: new Date() }, { merge: true });
    batch.set(db.collection("users").doc(req.user.uid), { phoneNational: phone, phoneE164: req.user.phone_number, pinHash: hash, pinUpdatedAt: new Date() }, { merge: true });
    await batch.commit();
    res.json({ ok: true });
  } catch { res.status(502).json({ ok: false, error: "PIN could not be saved" }); }
});
app.use(express.static(path.join(__dirname, "dist")));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "dist", "index.html")));
app.use((_req, res) => res.status(404).json({ ok: false, error: "Endpoint not found" }));
app.listen(Number(process.env.PORT || 3000), "0.0.0.0");
