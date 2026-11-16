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
const { handleSendOtp, handleVerifyOtp, handleVerifyPinLogin, createPinHash } = require("./lib/otp-2factor.cjs");
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "8kb" }));
app.use(require("./lib/simulator-access.cjs").middleware(() => require("firebase-admin/auth").getAuth()));
app.get("/health", async (_req, res) => {
  let authStorageReady = false;
  try {
    await require("./lib/mysql-pin.cjs").checkSchema();
    authStorageReady = true;
  } catch (error) {
    console.warn("MySQL auth health check failed", error.code || error.name);
  }
  const ok = !authConfigurationError && authStorageReady;
  res.status(ok ? 200 : 503).json({
    ok, service: "jbmr-auth", provider: "2factor", template: "OTP1",
    authStorage: "mysql", authStorageReady, error: authConfigurationError
  });
});
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
    req.user = req.verifiedUser || await require("firebase-admin/auth").getAuth().verifyIdToken(token);
    next();
  } catch {
    res.status(401).json({ ok: false, error: "Please sign in again" });
  }
}
require("./lib/admin-visibility.cjs").install(app);
require("./lib/shorts.cjs").install(app, authenticated);
require("./lib/public-archives.cjs").install(app, authenticated);
require("./lib/ott-feed-api.cjs").install(app, authenticated);
require("./lib/simulator-preview.cjs").install(app, authenticated);
function accountPhone(user) {
  return String(user.phone_number || user.phone || "").replace(/^\+91/, "");
}

app.get("/pinStatus", authenticated, async (req, res) => {
  const phone = accountPhone(req.user);
  if (!/^\d{10}$/.test(phone)) return res.json({ configured: false });
  try {
    const row = await require("./lib/mysql-pin.cjs").findPin(phone);
    res.json({ configured: row?.uid === req.user.uid });
  } catch {
    res.status(503).json({ error: "PIN status unavailable" });
  }
});
app.post("/deletePin", authenticated, async (req, res) => {
  const phone = accountPhone(req.user);
  try {
    if (/^\d{10}$/.test(phone)) await require("./lib/mysql-pin.cjs").deletePin(phone, req.user.uid);
    res.json({ ok: true });
  } catch {
    res.status(503).json({ error: "PIN could not be removed" });
  }
});
app.post("/savePin", authenticated, async (req, res) => {
  const phone = accountPhone(req.user);
  const pin = String(req.body.pin || "");
  const legacyHash = String(req.body.pinHash || "");
  if (!/^\d{10}$/.test(phone) || (!/^\d{4}$/.test(pin) && !/^[a-f0-9]{64}$/.test(legacyHash))) return res.status(400).json({ ok: false, error: "Invalid PIN setup" });
  try {
    const hash = /^\d{4}$/.test(pin) ? createPinHash(pin) : legacyHash;
    await require("./lib/mysql-pin.cjs").savePin(phone, req.user.uid, hash);
    res.json({ ok: true });
  } catch { res.status(502).json({ ok: false, error: "PIN could not be saved" }); }
});
app.use(express.static(path.join(__dirname, "dist")));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "dist", "index.html")));
app.use((_req, res) => res.status(404).json({ ok: false, error: "Endpoint not found" }));
const server = app.listen(Number(process.env.PORT || 3000), "0.0.0.0");
require('./lib/live-socket.cjs').install(server, {
  verifyToken: token => require('firebase-admin/auth').getAuth().verifyIdToken(token),
  verifyAdmin: token => require('./lib/admin-visibility.cjs').isAuthorizedDevice(token),
  revision: () => require('./lib/mysql-scoring.cjs').liveRevision(),
  invalidate: () => { require('./lib/mysql-scoring.cjs').invalidate(); require('./lib/simulator-preview.cjs').invalidateLiveData(); }
});
