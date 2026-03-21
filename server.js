require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const IMGBB_API_KEY = process.env.IMGBB_API_KEY || "";
const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "";
const PORT = process.env.PORT || 3000;

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 6
  }
});

let cache = { at: 0, data: null };
const CACHE_MS = 60 * 1000;

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

async function sendOrderEmail(order) {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    throw new Error("Email credentials are missing in .env");
  }

  const proofLinks = (order.proofs || [])
    .map((p, i) => `<li><a href="${p.url}" target="_blank">Proof ${i + 1}: ${p.fileName || p.url}</a></li>`)
    .join("");

  const customFieldsHtml = (order.customFields || [])
    .map((field) => `<p><b>${field.label}:</b> ${field.value || "-"}</p>`)
    .join("");

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
      <h2>New Star Connect Order</h2>
      <p><b>User:</b> ${order.userName || "-"}</p>
      <p><b>Email:</b> ${order.userEmail || "-"}</p>
      <p><b>Celebrity:</b> ${order.celebName || "-"}</p>
      <p><b>Service:</b> ${order.serviceName || "-"}</p>
      <p><b>Service ID:</b> ${order.serviceId || "-"}</p>
      <p><b>Currency:</b> ${order.currency || "-"}</p>
      <p><b>USD Amount:</b> ${order.usdAmount || "-"}</p>
      <p><b>BTC Amount:</b> ${order.btcAmount || "-"}</p>
      <p><b>Payment Method:</b> ${order.paymentMethod || "-"}</p>
      <p><b>TXID:</b> ${order.txid || "-"}</p>
      <p><b>Gift Card Type:</b> ${order.giftType || "-"}</p>
      <p><b>Gift Card Value:</b> ${order.giftValue || "-"}</p>
      <p><b>Gift Card Code:</b> ${order.giftCode || "-"}</p>
      <p><b>Notes:</b> ${order.notes || "-"}</p>

      ${customFieldsHtml ? `<h3>Extra Details</h3>${customFieldsHtml}` : ""}

      <h3>Proof Links</h3>
      <ul>${proofLinks || "<li>No proof uploaded</li>"}</ul>
    </div>
  `;

  return transporter.sendMail({
    from: `"Star Connect" <${GMAIL_USER}>`,
    to: GMAIL_USER,
    subject: `New Star Connect Order - ${order.serviceName || "Booking"}`,
    html
  });
}

app.get("/", (req, res) => {
  res.send("Star Connect API is running");
});

app.get("/api/rates", (req, res) => {
  const now = Date.now();

  if (cache.data && now - cache.at < CACHE_MS) {
    return res.json({ ...cache.data, cachedAt: cache.at, cached: true });
  }

  Promise.all([fetchFxUsd(), fetchBtcUsd()])
    .then(([fxUsd, btcUsd]) => {
      const payload = { btcUsd, fxUsd };
      cache = { at: now, data: payload };
      res.json({ ...payload, cachedAt: now, cached: false });
    })
    .catch((err) => {
      res.status(500).json({
        error: "rates_failed",
        message: err.message || "Failed to fetch rates"
      });
    });
});

app.post("/api/upload-proof", upload.array("proofs", 6), async (req, res) => {
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
    await sendOrderEmail(order);

    return res.json({
      success: true,
      message: "Order email sent"
    });
  } catch (err) {
    return res.status(500).json({
      error: "email_failed",
      message: err.message || "Failed to send order email"
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: "not_found",
    message: "Endpoint not found"
  });
});

app.listen(PORT, () => {
  console.log("Star Connect API running on port", PORT);
});

