require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const nodemailer = require("nodemailer");
const rateLimit = require("express-rate-limit");

const app = express();

const IMGBB_API_KEY = process.env.IMGBB_API_KEY || "";
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const MAIL_FROM = process.env.MAIL_FROM || "";
const PORT = Number(process.env.PORT || 3000);

const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (!FRONTEND_ORIGINS.length) return callback(null, true);
    if (FRONTEND_ORIGINS.includes(origin)) return callback(null, true);

    console.error("Blocked CORS origin:", origin);
    return callback(new Error("CORS origin not allowed"));
  }
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "10mb" }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "too_many_requests",
    message: "Too many requests. Please try again shortly."
  }
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "too_many_uploads",
    message: "Too many uploads. Please slow down."
  }
});

app.use("/api/", apiLimiter);

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT || 587),
  secure: false,
  requireTLS: true,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS
  },
  tls: {
    minVersion: "TLSv1.2",
    rejectUnauthorized: false
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000,
  logger: true,
  debug: true
});

async function verifyMailer() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !MAIL_FROM) {
    console.warn("Mailer not configured: missing SMTP credentials");
    return false;
  }

  try {
    console.log("Verifying mailer...");
    await transporter.verify();
    console.log("Mailer verified successfully");
    return true;
  } catch (err) {
    console.error("Mailer verification failed:", err.message);
    return false;
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 6
  },
  fileFilter(req, file, cb) {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only JPG, PNG, and WEBP images are allowed"));
    }
    cb(null, true);
  }
});

let cache = { at: 0, data: null };
const CACHE_MS = 60 * 1000;

function requireEnv() {
  const missing = [];
  if (!IMGBB_API_KEY) missing.push("IMGBB_API_KEY");
  if (!SMTP_HOST) missing.push("SMTP_HOST");
  if (!SMTP_PORT) missing.push("SMTP_PORT");
  if (!SMTP_USER) missing.push("SMTP_USER");
  if (!SMTP_PASS) missing.push("SMTP_PASS");
  if (!MAIL_FROM) missing.push("MAIL_FROM");

  if (missing.length) {
    console.warn("Missing env vars:", missing.join(", "));
  }
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[m]));
}

function normalizeText(value, max = 5000) {
  return String(value || "").trim().slice(0, max);
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message || "Operation timed out")), ms)
    )
  ]);
}

async function ensureMailerReady() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !MAIL_FROM) {
    throw new Error("SMTP credentials are missing in environment variables");
  }

  await withTimeout(transporter.verify(), 10000, "SMTP verify timed out");
}

function fetchFxUsd() {
  return fetch("https://open.er-api.com/v6/latest/USD")
    .then((res) => res.json())
    .then((data) => {
      if (data?.result !== "success") throw new Error("FX provider failed");
      return data.rates || {};
    });
}

function fetchBtcUsd() {
  return fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd")
    .then((res) => res.json())
    .then((data) => {
      const amount = Number(data?.bitcoin?.usd);
      if (!Number.isFinite(amount)) throw new Error("CoinGecko provider failed");
      return amount;
    });
}

async function uploadToImgBB(fileBuffer, fileName = "proof.jpg", mimeType = "image/jpeg") {
  const form = new FormData();
  const blob = new Blob([fileBuffer], { type: mimeType });

  form.append("key", IMGBB_API_KEY);
  form.append("image", blob, fileName);
  form.append("name", fileName);

  const res = await fetch("https://api.imgbb.com/1/upload", {
    method: "POST",
    body: form
  });

  const data = await res.json();

  if (!res.ok || !data?.success) {
    throw new Error(data?.error?.message || "ImgBB upload failed");
  }

  return {
    url: data.data.url,
    displayUrl: data.data.display_url,
    deleteUrl: data.data.delete_url,
    thumbUrl: data.data.thumb?.url || "",
    mediumUrl: data.data.medium?.url || "",
    fileName
  };
}

function validateOrder(order) {
  const required = ["userName", "userEmail", "serviceName", "currency", "usdAmount", "paymentMethod"];
  for (const key of required) {
    if (!normalizeText(order[key])) {
      throw new Error(`Missing required field: ${key}`);
    }
  }

  const paymentMethod = normalizeText(order.paymentMethod).toLowerCase();
  if (!["btc", "giftcard"].includes(paymentMethod)) {
    throw new Error("Invalid payment method");
  }

  const isTest = order.isTest === true;

  if (!isTest && paymentMethod === "btc" && !normalizeText(order.txid, 500)) {
    throw new Error("TXID is required for BTC payments");
  }

  if (!isTest && paymentMethod === "giftcard") {
    if (!normalizeText(order.giftType, 200)) throw new Error("Gift card type is required");
    if (!normalizeText(order.giftValue, 200)) throw new Error("Gift card value is required");
  }
}

function buildOrderEmailHtml(order) {
  const safeOrder = {
    userName: escapeHtml(normalizeText(order.userName, 200)),
    userEmail: escapeHtml(normalizeText(order.userEmail, 200)),
    celebName: escapeHtml(normalizeText(order.celebName, 200)),
    serviceName: escapeHtml(normalizeText(order.serviceName, 200)),
    serviceId: escapeHtml(normalizeText(order.serviceId, 200)),
    currency: escapeHtml(normalizeText(order.currency, 50)),
    usdAmount: escapeHtml(normalizeText(order.usdAmount, 50)),
    btcAmount: escapeHtml(normalizeText(order.btcAmount, 50)),
    paymentMethod: escapeHtml(normalizeText(order.paymentMethod, 50)),
    txid: escapeHtml(normalizeText(order.txid, 300)),
    giftType: escapeHtml(normalizeText(order.giftType, 200)),
    giftValue: escapeHtml(normalizeText(order.giftValue, 200)),
    giftCode: escapeHtml(normalizeText(order.giftCode, 500)),
    notes: escapeHtml(normalizeText(order.notes, 3000)),
    cardHolderName: escapeHtml(normalizeText(order.cardHolderName, 200)),
    memberId: escapeHtml(normalizeText(order.memberId, 200)),
    billingPlan: escapeHtml(normalizeText(order.billingPlan, 100)),
    fanCardTier: escapeHtml(normalizeText(order.fanCardTier, 100)),
    issueDate: escapeHtml(normalizeText(order.issueDate, 100)),
    expiryDate: escapeHtml(normalizeText(order.expiryDate, 100)),
    isTest: order.isTest === true ? "Yes" : "No",
    paymentStatus: escapeHtml(normalizeText(order.paymentStatus, 100)),
    status: escapeHtml(normalizeText(order.status, 100))
  };

  const proofs = normalizeArray(order.proofs).slice(0, 6);
  const customFields = normalizeArray(order.customFields).slice(0, 20);

  const proofLinks = proofs
    .map((p, i) => {
      const url = escapeHtml(normalizeText(p?.url, 1000));
      const fileName = escapeHtml(normalizeText(p?.fileName || p?.url, 300));
      return `<li><a href="${url}" target="_blank" rel="noopener noreferrer">Proof ${i + 1}: ${fileName}</a></li>`;
    })
    .join("");

  const customFieldsHtml = customFields
    .map((field) => {
      const label = escapeHtml(normalizeText(field?.label, 200));
      const value = escapeHtml(normalizeText(field?.value, 1000));
      return `<p><b>${label}:</b> ${value || "-"}</p>`;
    })
    .join("");

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
      <h2>New Star Connect Order</h2>
      <p><b>User:</b> ${safeOrder.userName || "-"}</p>
      <p><b>Email:</b> ${safeOrder.userEmail || "-"}</p>
      <p><b>Celebrity:</b> ${safeOrder.celebName || "-"}</p>
      <p><b>Service:</b> ${safeOrder.serviceName || "-"}</p>
      <p><b>Service ID:</b> ${safeOrder.serviceId || "-"}</p>
      <p><b>Currency:</b> ${safeOrder.currency || "-"}</p>
      <p><b>USD Amount:</b> ${safeOrder.usdAmount || "-"}</p>
      <p><b>BTC Amount:</b> ${safeOrder.btcAmount || "-"}</p>
      <p><b>Payment Method:</b> ${safeOrder.paymentMethod || "-"}</p>
      <p><b>TXID:</b> ${safeOrder.txid || "-"}</p>
      <p><b>Gift Card Type:</b> ${safeOrder.giftType || "-"}</p>
      <p><b>Gift Card Value:</b> ${safeOrder.giftValue || "-"}</p>
      <p><b>Gift Card Code:</b> ${safeOrder.giftCode || "-"}</p>
      <p><b>Card Holder Name:</b> ${safeOrder.cardHolderName || "-"}</p>
      <p><b>Member ID:</b> ${safeOrder.memberId || "-"}</p>
      <p><b>Fan Card Tier:</b> ${safeOrder.fanCardTier || "-"}</p>
      <p><b>Billing Plan:</b> ${safeOrder.billingPlan || "-"}</p>
      <p><b>Issue Date:</b> ${safeOrder.issueDate || "-"}</p>
      <p><b>Expiry Date:</b> ${safeOrder.expiryDate || "-"}</p>
      <p><b>Test Mode:</b> ${safeOrder.isTest}</p>
      <p><b>Payment Status:</b> ${safeOrder.paymentStatus || "-"}</p>
      <p><b>Status:</b> ${safeOrder.status || "-"}</p>
      <p><b>Notes:</b> ${safeOrder.notes || "-"}</p>

      ${customFieldsHtml ? `<h3>Extra Details</h3>${customFieldsHtml}` : ""}

      <h3>Proof Links</h3>
      <ul>${proofLinks || "<li>No proof uploaded</li>"}</ul>
    </div>
  `;
}

async function sendOrderEmail(order) {
  validateOrder(order);

  console.log("Preparing to send order email for:", order.serviceName || "unknown service");
  console.log("SMTP config check:", {
    host: SMTP_HOST,
    port: SMTP_PORT,
    user: SMTP_USER,
    hasPass: !!SMTP_PASS,
    from: MAIL_FROM
  });

  await ensureMailerReady();

  const html = buildOrderEmailHtml(order);

  console.log("Sending email now...");

  const info = await withTimeout(
    transporter.sendMail({
      from: `"Star Connect" <${MAIL_FROM}>`,
      to: MAIL_FROM,
      subject: `New Star Connect Order - ${normalizeText(order.serviceName, 200) || "Booking"}`,
      html
    }),
    15000,
    "Email sending timed out"
  );

  console.log("Email sent:", info.messageId);
  return info;
}

app.get("/", (req, res) => {
  res.send("Star Connect API is running");
});

app.get("/health", async (req, res) => {
  let mailerReady = false;

  if (SMTP_HOST && SMTP_USER && SMTP_PASS && MAIL_FROM) {
    try {
      await withTimeout(transporter.verify(), 5000, "SMTP verify timed out");
      mailerReady = true;
    } catch (err) {
      mailerReady = false;
    }
  }

  res.json({
    ok: true,
    uptime: process.uptime(),
    imgbbConfigured: Boolean(IMGBB_API_KEY),
    emailConfigured: Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS && MAIL_FROM),
    mailerReady
  });
});

app.get("/api/rates", async (req, res) => {
  const now = Date.now();

  try {
    if (cache.data && now - cache.at < CACHE_MS) {
      return res.json({ ...cache.data, cachedAt: cache.at, cached: true });
    }

    const [fxUsd, btcUsd] = await Promise.all([fetchFxUsd(), fetchBtcUsd()]);
    const payload = { btcUsd, fxUsd };

    cache = { at: now, data: payload };
    return res.json({ ...payload, cachedAt: now, cached: false });
  } catch (err) {
    return res.status(500).json({
      error: "rates_failed",
      message: err.message || "Failed to fetch rates"
    });
  }
});

app.post("/api/upload-proof", uploadLimiter, upload.array("proofs", 6), async (req, res) => {
  try {
    if (!IMGBB_API_KEY) {
      return res.status(500).json({
        error: "imgbb_not_configured",
        message: "ImgBB API key is missing"
      });
    }

    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({
        error: "no_files",
        message: "No proof images uploaded"
      });
    }

    const uploaded = [];
    for (const file of files) {
      const item = await uploadToImgBB(
        file.buffer,
        file.originalname || "proof.jpg",
        file.mimetype || "image/jpeg"
      );
      uploaded.push(item);
    }

    return res.json({
      success: true,
      count: uploaded.length,
      files: uploaded
    });
  } catch (err) {
    return res.status(500).json({
      error: "upload_failed",
      message: err.message || "Failed to upload proof images"
    });
  }
});

app.post("/api/send-order-email", async (req, res) => {
  try {
    const order = req.body || {};

    console.log("Incoming order email request");
    const info = await sendOrderEmail(order);

    return res.json({
      success: true,
      message: "Order email sent",
      messageId: info.messageId || null
    });
  } catch (err) {
    console.error("EMAIL ERROR:", err);
    return res.status(400).json({
      error: "email_failed",
      message: err.message || "Failed to send order email"
    });
  }
});

app.get("/api/test-email", async (req, res) => {
  try {
    await ensureMailerReady();

    const info = await withTimeout(
      transporter.sendMail({
        from: `"Star Connect" <${MAIL_FROM}>`,
        to: MAIL_FROM,
        subject: "Star Connect test email",
        html: "<p>If you got this, Brevo SMTP is working.</p>"
      }),
      15000,
      "Test email sending timed out"
    );

    return res.json({
      success: true,
      message: "Test email sent successfully",
      messageId: info.messageId || null
    });
  } catch (err) {
    console.error("TEST EMAIL ERROR:", err);
    return res.status(500).json({
      error: "test_email_failed",
      message: err.message || "Test email failed"
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: "not_found",
    message: "Endpoint not found"
  });
});

app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);

  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      error: "upload_invalid",
      message: err.message
    });
  }

  if (err.message === "Only JPG, PNG, and WEBP images are allowed") {
    return res.status(400).json({
      error: "invalid_file_type",
      message: err.message
    });
  }

  if (err.message === "CORS origin not allowed") {
    return res.status(403).json({
      error: "cors_blocked",
      message: err.message
    });
  }

  return res.status(500).json({
    error: "server_error",
    message: "Internal server error"
  });
});

app.listen(PORT, async () => {
  requireEnv();
  await verifyMailer();
  console.log("Star Connect API running on port", PORT);
});
