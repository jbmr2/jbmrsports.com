const mysqlPin = require("./mysql-pin.cjs");
const { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } = require("node:crypto");
const { getAuth } = require("firebase-admin/auth");
const otpAuditKey = randomBytes(32);

const DEMO_PHONE = String(process.env.DEMO_PHONE || "");
const DEMO_OTP = String(process.env.DEMO_OTP || "");
const DEMO_SESSION = String(process.env.DEMO_SESSION || "");
function isDemoPhone(phone) {
  return process.env.DEMO_LOGIN_ENABLED === "true" && phone === DEMO_PHONE &&
    /^\d{6}$/.test(DEMO_OTP) && DEMO_SESSION.length > 0;
}

function nationalPhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function apiKey() {
  return String(process.env.TWOFACTOR_API_KEY || "").trim();
}

async function twoFactorGet(path) {
  const key = apiKey();
  if (!key) throw new Error("2Factor API key missing");
  const url = `https://2factor.in/API/V1/${encodeURIComponent(key)}${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

function requestAddress(req) {
  return String(req.ip || req.socket?.remoteAddress || "").trim();
}

function rateLimit(phone, kind, req) {
  return mysqlPin.limitAttempts(kind, phone, requestAddress(req));
}

async function firebaseSessionForPhone(phone) {
  const e164 = `+91${phone}`;
  const auth = getAuth();
  let user;
  try {
    user = await auth.getUserByPhoneNumber(e164);
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
    user = await auth.createUser({ phoneNumber: e164, disabled: false });
  }
  const token = await auth.createCustomToken(user.uid, { phone: e164 });
  return { uid: user.uid, token, phone };
}

async function handleSendOtp(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "POST required" });
    return;
  }
  const phone = nationalPhone(req.body?.phone);
  if (phone.length !== 10) {
    res.status(400).json({ ok: false, error: "Enter a 10-digit mobile number" });
    return;
  }
  const address = requestAddress(req);
  const agent = String(req.headers?.["user-agent"] || "");
  const audit = {
    id: randomUUID(),
    route: req.path === "/api/auth/sendOtp" ? "/api/auth/sendOtp" : "/sendOtp",
    network: address ? createHmac("sha256", otpAuditKey).update(address).digest("hex").slice(0, 16) : null,
    clientHint: /Dalvik|okhttp/i.test(agent) ? "android" :
      /CFNetwork/i.test(agent) ? "apple" : /Mozilla\//i.test(agent) ? "browser" : "unknown",
  };
  let stage = "rate_limit";
  try {
    await rateLimit(phone, "send", req);
    if (isDemoPhone(phone)) {
      res.json({ ok: true, sessionId: DEMO_SESSION, demo: true });
      return;
    }
    stage = "provider";
    const { ok, data } = await twoFactorGet(`/SMS/91${phone}/AUTOGEN/OTP1`);
    const status = String(data?.Status || "").toLowerCase();
    const sessionId = String(data?.Details || "");
    const detail = sessionId.toLowerCase();
    if (detail.includes("voice") || detail.includes("call")) {
      console.warn("otp_send", { ...audit, outcome: "provider_voice" });
      res.status(502).json({
        ok: false,
        error: "2Factor sent a voice call. Enable SMS credits / DLT template in the 2Factor dashboard.",
      });
      return;
    }
    if (!ok || status !== "success" || !sessionId) {
      console.warn("otp_send", { ...audit, outcome: "provider_rejected" });
      res.status(502).json({
        ok: false,
        error: sessionId || "Couldn’t send SMS OTP — check 2Factor SMS balance",
      });
      return;
    }
    audit.sessionHash = createHash("sha256").update(sessionId).digest("hex");
    stage = "store_session";
    await mysqlPin.createOtpSession(sessionId, phone);
    console.info("otp_send", { ...audit, outcome: "sent" });
    res.json({ ok: true, sessionId });
  } catch (err) {
    const code = err.status || 500;
    if (code === 429 && Number.isSafeInteger(err.retryAfter)) {
      res.set("Retry-After", String(err.retryAfter));
    }
    console.warn("otp_send", { ...audit, stage, status: code, outcome: code === 429 ? "limited" : "failed" });
    res.status(code).json({ ok: false, error: code === 429 ? err.message : err.name === "TimeoutError" ? "OTP provider timed out. Please try again." : "OTP is temporarily unavailable" });
  }
}

async function verifyOtp(req, res, issueSession) {
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "POST required" });
    return;
  }
  const phone = nationalPhone(req.body?.phone);
  const otp = String(req.body?.otp || "").replace(/\D/g, "");
  const sessionId = String(req.body?.sessionId || "").trim();
  if (phone.length !== 10 || otp.length !== 6 || !sessionId) {
    res.status(400).json({ ok: false, error: "Enter the 6-digit OTP" });
    return;
  }
  try {
    await rateLimit(phone, "verify", req);
    if (isDemoPhone(phone)) {
      if (otp !== DEMO_OTP || sessionId !== DEMO_SESSION) {
        res.status(401).json({ ok: false, error: "Incorrect OTP — try again" });
        return;
      }
      const session = await issueSession(phone);
      res.json({ ok: true, ...session });
      return;
    }
    if (!await mysqlPin.checkOtpSession(sessionId, phone)) {
      return res.status(401).json({ ok: false, error: "OTP expired or invalid. Request a new OTP." });
    }
    const { ok, data } = await twoFactorGet(
      `/SMS/VERIFY/${encodeURIComponent(sessionId)}/${otp}`
    );
    const status = String(data?.Status || "").toLowerCase();
    if (!ok || status !== "success") {
      res.status(401).json({
        ok: false,
        error: String(data?.Details || "Incorrect OTP — try again"),
      });
      return;
    }
    if (!await mysqlPin.consumeOtpSession(sessionId, phone)) {
      return res.status(401).json({ ok: false, error: "OTP expired or invalid. Request a new OTP." });
    }
    const session = await issueSession(phone);
    res.json({ ok: true, ...session });
  } catch (err) {
    const code = err.status || 500;
    console.error("verifyOtp", err.code || err.name);
    res.status(code).json({ ok: false, error: code === 429 ? err.message : err.name === "TimeoutError" ? "OTP provider timed out. Please try again." : "OTP is temporarily unavailable" });
  }
}

function createPinHash(pin) {
  const salt = randomBytes(16).toString("hex");
  const digest = scryptSync(pin, salt, 32).toString("hex");
  return `scrypt-v1$${salt}$${digest}`;
}

function verifyPinHash(uid, pin, stored) {
  if (typeof stored !== "string") return false;
  let candidate;
  const parts = stored.split("$");
  if (parts.length === 3 && parts[0] === "scrypt-v1" && /^[a-f0-9]{32}$/.test(parts[1]) && /^[a-f0-9]{64}$/.test(parts[2])) {
    candidate = scryptSync(pin, parts[1], 32).toString("hex");
    return timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(parts[2], "hex"));
  }
  if (/^[a-f0-9]{64}$/.test(stored)) {
    candidate = createHash("sha256").update(`jbmr-pin-v1|${uid}|${pin}`).digest("hex");
    return timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(stored, "hex"));
  }
  return false;
}

async function firebaseSessionForPin(phone, uid) {
  const auth = getAuth();
  const user = await auth.getUser(uid);
  if (user.disabled || user.phoneNumber !== `+91${phone}`) {
    throw Object.assign(new Error("Account unavailable"), { status: 401 });
  }
  return { uid, phone, token: await auth.createCustomToken(uid) };
}

async function verifyPinLogin(req, res, issueSession) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST required" });
  const phone = nationalPhone(req.body?.phone);
  const pin = String(req.body?.pin || "");
  if (!/^\d{10}$/.test(phone) || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ ok: false, error: "Enter a 10-digit number and 4-digit PIN" });
  }
  try {
    await rateLimit(phone, "pin", req);
    const row = await mysqlPin.findPin(phone);
    if (!row?.uid || !verifyPinHash(row.uid, pin, row.pinHash)) {
      return res.status(401).json({ ok: false, error: "Incorrect PIN, or no PIN saved. Use OTP to create one." });
    }
    if (!row.pinHash.startsWith("scrypt-v1$")) {
      await mysqlPin.upgradePin(phone, row.uid, row.pinHash, createPinHash(pin));
    }
    res.json({ ok: true, ...await issueSession(phone, row.uid) });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.status === 429 ? err.message : "Login unavailable — please try again later" });
  }
}

module.exports = {
  handleSendOtp,
  handleVerifyOtp: (req, res) => verifyOtp(req, res, firebaseSessionForPhone),
  handleVerifyPinLogin: (req, res) => verifyPinLogin(req, res, firebaseSessionForPin),
  verifyOtp,
  verifyPinLogin,
  createPinHash
};
