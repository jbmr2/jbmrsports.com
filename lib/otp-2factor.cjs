const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { createHash } = require("node:crypto");

const DEMO_PHONE = "9000000001";
const DEMO_OTP = "123456";
const DEMO_SESSION = "demo-apple-review";

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
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

async function rateLimit(phone, kind) {
  const db = getFirestore();
  const ref = db.collection("otpAttempts").doc(`${kind}_${phone}`);
  const snap = await ref.get();
  const row = snap.data() || {};
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const count = row.at && now - row.at < windowMs ? row.count || 0 : 0;
  const max = kind === "send" ? 6 : 10;
  if (count >= max) {
    const err = new Error("Too many attempts — try again later");
    err.status = 429;
    throw err;
  }
  await db.runTransaction(async (tx) => {
    const latest = (await tx.get(ref)).data() || {};
    const recent = latest.at && now - latest.at < windowMs;
    const attempts = recent ? latest.count || 0 : 0;
    if (attempts >= max) {
      const err = new Error("Too many attempts — try again later");
      err.status = 429;
      throw err;
    }
    tx.set(ref, { count: attempts + 1, at: recent ? latest.at : now });
  });
}

function sessionRef(sessionId) {
  return getFirestore().collection("otpSessions").doc(createHash("sha256").update(sessionId).digest("hex"));
}

function assertSession(row, phone) {
  if (!row || row.phone !== phone || row.used || row.expiresAt <= Date.now()) {
    const err = new Error("OTP expired or invalid — request a new OTP");
    err.status = 401;
    throw err;
  }
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
  try {
    await rateLimit(phone, "send");
    if (phone === DEMO_PHONE) {
      res.json({ ok: true, sessionId: DEMO_SESSION, demo: true });
      return;
    }
    const { ok, data } = await twoFactorGet(`/SMS/91${phone}/AUTOGEN/OTP1`);
    const status = String(data?.Status || "").toLowerCase();
    const sessionId = String(data?.Details || "");
    const detail = sessionId.toLowerCase();
    if (detail.includes("voice") || detail.includes("call")) {
      res.status(502).json({
        ok: false,
        error: "2Factor sent a voice call. Enable SMS credits / DLT template in the 2Factor dashboard.",
      });
      return;
    }
    if (!ok || status !== "success" || !sessionId) {
      res.status(502).json({
        ok: false,
        error: sessionId || "Couldn’t send SMS OTP — check 2Factor SMS balance",
      });
      return;
    }
    await sessionRef(sessionId).set({ phone, expiresAt: Date.now() + 5 * 60 * 1000, used: false });
    res.json({ ok: true, sessionId });
  } catch (err) {
    const code = err.status || 500;
    console.error("sendOtp", err);
    res.status(code).json({ ok: false, error: err.message || String(err) });
  }
}

async function handleVerifyOtp(req, res) {
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
    await rateLimit(phone, "verify");
    if (phone === DEMO_PHONE) {
      if (otp !== DEMO_OTP || sessionId !== DEMO_SESSION) {
        res.status(401).json({ ok: false, error: "Incorrect OTP — try again" });
        return;
      }
      const session = await firebaseSessionForPhone(phone);
      res.json({ ok: true, ...session });
      return;
    }
    const ref = sessionRef(sessionId);
    assertSession((await ref.get()).data(), phone);
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
    await getFirestore().runTransaction(async (tx) => {
      assertSession((await tx.get(ref)).data(), phone);
      tx.update(ref, { used: true });
    });
    const session = await firebaseSessionForPhone(phone);
    res.json({ ok: true, ...session });
  } catch (err) {
    const code = err.status || 500;
    console.error("verifyOtp", err);
    res.status(code).json({ ok: false, error: err.message || String(err) });
  }
}

async function handleVerifyPinLogin(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST required" });
  const phone = nationalPhone(req.body?.phone);
  const pin = String(req.body?.pin || "");
  if (!/^\d{10}$/.test(phone) || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ ok: false, error: "Enter a 10-digit number and 4-digit PIN" });
  }
  try {
    await rateLimit(phone, "pin");
    const row = (await getFirestore().collection("phonePins").doc(phone).get()).data();
    const hash = row?.uid ? createHash("sha256").update(`jbmr-pin-v1|${row.uid}|${pin}`).digest("hex") : "";
    if (!row?.uid || hash !== row.pinHash) {
      return res.status(401).json({ ok: false, error: "Incorrect PIN, or no PIN saved. Use OTP to create one." });
    }
    const user = await getAuth().getUser(row.uid);
    if (user.disabled || user.phoneNumber !== `+91${phone}`) {
      return res.status(401).json({ ok: false, error: "Account unavailable. Please use OTP." });
    }
    const token = await getAuth().createCustomToken(row.uid);
    res.json({ ok: true, uid: row.uid, phone, token });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: "Login unavailable — please try again later" });
  }
}

module.exports = { handleSendOtp, handleVerifyOtp, handleVerifyPinLogin };
