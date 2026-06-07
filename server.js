require("./instrument");
require("dotenv").config();

let Sentry = null;
try {
  Sentry = require("@sentry/node");

  if (process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || "development",
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1)
    });
  }
} catch (err) {
  console.warn("Sentry is not installed or could not be initialized:", err.message);
}

function captureServerError(err, context = {}) {
  if (!err) return;

  if (Sentry?.withScope && Sentry?.captureException) {
    Sentry.withScope(scope => {
      Object.entries(context || {}).forEach(([key, value]) => {
        scope.setExtra(key, value);
      });
      Sentry.captureException(err);
    });
  }
}

process.on("unhandledRejection", err => {
  console.error("UNHANDLED REJECTION:", err);
  captureServerError(err, { source: "unhandledRejection" });
});

process.on("uncaughtException", err => {
  console.error("UNCAUGHT EXCEPTION:", err);
  captureServerError(err, { source: "uncaughtException" });
});

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");
const fs = require("fs");
const bodyParser = require("body-parser");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production";

// =========================
// ENVIRONMENT VALIDATION
// =========================
const requiredEnv = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "OPENAI_API_KEY",
  "APP_URL",
  "STRIPE_PRICE_25",
  "STRIPE_PRICE_100",
  "STRIPE_PRICE_500"
];

const missingEnv = requiredEnv.filter(name => !process.env[name]);

if (missingEnv.length) {
  console.error(`Missing required environment variables: ${missingEnv.join(", ")}`);
  if (isProduction) {
    process.exit(1);
  }
}

function parseAllowedOrigins() {
  const configured = (process.env.ALLOWED_ORIGINS || process.env.APP_URL || "")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);

  if (!isProduction) {
    configured.push("http://localhost:3000", "http://127.0.0.1:3000");
  }

  return [...new Set(configured)];
}

const allowedOrigins = parseAllowedOrigins();

app.set("trust proxy", 1);

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false
}));

app.use(cors({
  origin(origin, callback) {
    // Allow same-origin browser requests, curl, Stripe webhook calls, and server-to-server calls with no Origin.
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.warn("Blocked CORS origin:", origin);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true
}));

app.use(express.static(path.join(__dirname, "public")));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // service role key; never expose this to frontend
);

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Stripe webhooks need the raw body. All other routes use JSON.
app.use((req, res, next) => {
  if (req.originalUrl === "/stripe-webhook") {
    next();
  } else {
    express.json({ limit: "50mb" })(req, res, next);
  }
});

app.use(express.static(path.join(__dirname)));

// =========================
// HEALTH CHECK
// =========================
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// =========================
// SIMPLE RATE LIMIT
// =========================
const requests = {};

setInterval(() => {
  for (const key of Object.keys(requests)) {
    delete requests[key];
  }
}, 60_000);

app.use((req, res, next) => {
  const ip = req.ip;

  requests[ip] = requests[ip] || 0;
  requests[ip]++;

  if (requests[ip] > 100) {
    return res.status(429).json({ error: "Too many requests" });
  }

  next();
});

// =========================
// AUTH HELPERS
// =========================
async function getUser(req) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) return null;

  return data.user;
}

async function getCredits(userId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("credits")
    .eq("id", userId)
    .single();

  if (error) {
    console.error("CREDITS ERROR:", error);
    return 0;
  }

  return data?.credits || 0;
}

async function requireCredits(userId, amount = 1) {
  const credits = await getCredits(userId);

  if (credits < amount) {
    return {
      ok: false,
      credits
    };
  }

  return {
    ok: true,
    credits
  };
}

async function deductCredits(userId, currentCredits, amount = 1) {
  const { error } = await supabase
    .from("profiles")
    .update({
      credits: Math.max(0, currentCredits - amount)
    })
    .eq("id", userId);

  if (error) {
    console.error("DEDUCT CREDITS ERROR:", error);
    throw new Error("Could not deduct credits");
  }
}

// Production-ready credit preparation:
// Create these Supabase RPC functions when ready:
// - deduct_credits_atomic(p_user_id uuid, p_amount int) returns table(ok boolean, credits int)
// - add_credits_atomic(p_user_id uuid, p_amount int) returns void
// The server safely falls back to the old update path until the RPCs exist.
async function chargeCredits(userId, amount = 1, options = {}) {
  const { data, error } = await supabase.rpc("deduct_credits_atomic", {
    p_user_id: userId,
    p_amount: amount
  });

  if (!error) {
    const result = Array.isArray(data) ? data[0] : data;
    const ok = Boolean(result?.ok);

    if (ok) {
      await logCreditTransaction({
        userId,
        amount: -Math.abs(Number(amount)),
        transactionType: options.transactionType || "usage",
        description: options.description || "Credit used",
        metadata: {
          ...(options.metadata || {}),
          atomic: true,
          balance_after: Number(result?.credits || 0)
        }
      });
    }

    return {
      ok,
      credits: Number(result?.credits || 0),
      atomic: true
    };
  }

  if (error.code && !["42883", "PGRST202"].includes(error.code)) {
    console.error("ATOMIC CREDIT RPC ERROR:", error);
    throw new Error("Could not deduct credits");
  }

  console.warn("deduct_credits_atomic RPC missing; using non-atomic fallback");
  const creditCheck = await requireCredits(userId, amount);
  if (!creditCheck.ok) return { ...creditCheck, atomic: false };
  await deductCredits(userId, creditCheck.credits, amount);
  const balanceAfter = creditCheck.credits - amount;

  await logCreditTransaction({
    userId,
    amount: -Math.abs(Number(amount)),
    transactionType: options.transactionType || "usage",
    description: options.description || "Credit used",
    metadata: {
      ...(options.metadata || {}),
      atomic: false,
      balance_after: balanceAfter
    }
  });

  return { ok: true, credits: balanceAfter, atomic: false };
}

async function refundCredits(userId, amount = 1, options = {}) {
  const { error } = await supabase.rpc("add_credits_atomic", {
    p_user_id: userId,
    p_amount: amount
  });

  if (!error) {
    await logCreditTransaction({
      userId,
      amount: Math.abs(Number(amount)),
      transactionType: options.transactionType || "refund",
      description: options.description || "Credit refunded after failed generation",
      metadata: { ...(options.metadata || {}), atomic: true }
    });
    return;
  }

  if (error.code && !["42883", "PGRST202"].includes(error.code)) {
    console.error("ATOMIC REFUND RPC ERROR:", error);
    return;
  }

  console.warn("add_credits_atomic RPC missing; using fallback refund");
  const currentCredits = await getCredits(userId);
  const { error: updateError } = await supabase
    .from("profiles")
    .update({ credits: currentCredits + amount })
    .eq("id", userId);

  if (updateError) {
    console.error("REFUND CREDITS ERROR:", updateError);
    return;
  }

  await logCreditTransaction({
    userId,
    amount: Math.abs(Number(amount)),
    transactionType: options.transactionType || "refund",
    description: options.description || "Credit refunded after failed generation",
    metadata: { ...(options.metadata || {}), atomic: false }
  });
}

async function addCredits(userId, amount, options = {}) {
  const creditsToAdd = Number(amount);
  if (!Number.isFinite(creditsToAdd) || creditsToAdd <= 0) {
    throw new Error("Invalid credit amount");
  }

  const { error } = await supabase.rpc("add_credits_atomic", {
    p_user_id: userId,
    p_amount: creditsToAdd
  });

  if (!error) {
    await logCreditTransaction({
      userId,
      amount: creditsToAdd,
      transactionType: options.transactionType || "purchase",
      description: options.description || `Purchased ${creditsToAdd} credits`,
      stripeSessionId: options.stripeSessionId || null,
      stripeEventId: options.stripeEventId || null,
      revenueUsd: options.revenueUsd ?? null,
      metadata: { ...(options.metadata || {}), atomic: true }
    });
    return;
  }

  if (error.code && !["42883", "PGRST202"].includes(error.code)) {
    console.error("ATOMIC ADD CREDITS RPC ERROR:", error);
    throw new Error("Could not add credits");
  }

  console.warn("add_credits_atomic RPC missing; using non-atomic fallback");
  const currentCredits = await getCredits(userId);
  const { error: updateError } = await supabase
    .from("profiles")
    .update({ credits: currentCredits + creditsToAdd })
    .eq("id", userId);

  if (updateError) {
    console.error("CREDIT UPDATE ERROR:", updateError);
    throw new Error("Could not add credits");
  }

  await logCreditTransaction({
    userId,
    amount: creditsToAdd,
    transactionType: options.transactionType || "purchase",
    description: options.description || `Purchased ${creditsToAdd} credits`,
    stripeSessionId: options.stripeSessionId || null,
    stripeEventId: options.stripeEventId || null,
    revenueUsd: options.revenueUsd ?? null,
    metadata: { ...(options.metadata || {}), atomic: false }
  });
}

function optimizePrompt(prompt) {
  return `
${prompt},

highly detailed,
cinematic lighting,
professional composition,
high quality
`;
}

async function generateImages({ prompt, n = 4, size = "1024x1024" }) {
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt,
      n,
      size
    })
  });

  const data = await response.json();

  if (!response.ok) {
    const message =
      data.error?.message ||
      data.error ||
      "Image generation failed";

    const err = new Error(message);
    err.status = response.status;
    throw err;
  }

  return data;
}


async function editImageFromUrl({ imageUrl, prompt, n = 4, size = "1024x1024" }) {
  const imageResponse = await fetch(imageUrl);

  if (!imageResponse.ok) {
    throw new Error("Could not fetch uploaded image");
  }

  const contentType = imageResponse.headers.get("content-type") || "image/png";

  if (!contentType.startsWith("image/")) {
    throw new Error("Uploaded file is not an image");
  }

  const imageArrayBuffer = await imageResponse.arrayBuffer();
  const imageBlob = new Blob([imageArrayBuffer], { type: contentType });

  const form = new FormData();
  form.append("model", "gpt-image-1");
  form.append("image", imageBlob, "reference.png");
  form.append("prompt", prompt);
  form.append("n", String(n));
  form.append("size", size);

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: form
  });

  const data = await response.json();

  if (!response.ok) {
    const message =
      data.error?.message ||
      data.error ||
      "Image edit failed";

    const err = new Error(message);
    err.status = response.status;
    throw err;
  }

  return data;
}

function extractStoragePathFromPublicUrl(url) {
  if (!url || typeof url !== "string") return null;

  const marker = "/storage/v1/object/public/images/";

  if (url.includes(marker)) {
    return decodeURIComponent(url.split(marker)[1]);
  }

  if (url.includes("/images/")) {
    return decodeURIComponent(url.split("/images/")[1]);
  }

  return null;
}

function normalizeImageIds(imageIds, max = 100) {
  if (!Array.isArray(imageIds)) return [];

  return [...new Set(imageIds
    .map(id => Number(id))
    .filter(id => Number.isSafeInteger(id) && id > 0)
  )].slice(0, max);
}

async function deleteOwnedImages(userId, imageIds) {
  const safeIds = normalizeImageIds(imageIds);

  if (!safeIds.length) {
    return { error: "No valid image IDs", status: 400 };
  }

  const { data: rows, error: selectError } = await supabase
    .from("images")
    .select("id, image_url")
    .eq("user_id", userId)
    .in("id", safeIds);

  if (selectError) {
    console.error("DELETE SELECT ERROR:", selectError);
    return { error: "Delete failed", status: 500 };
  }

  if (!rows?.length) {
    return { deleted: 0, requested: safeIds.length };
  }

  const ownedIds = rows.map(row => row.id);

  // Clean child rows first so deletes do not fail when FK cascade is not configured.
  await supabase.from("image_likes").delete().in("image_id", ownedIds);
  await supabase.from("image_comments").delete().in("image_id", ownedIds);

  const storagePaths = rows
    .map(row => extractStoragePathFromPublicUrl(row.image_url))
    .filter(Boolean);

  if (storagePaths.length) {
    const { error: storageError } = await supabase.storage
      .from("images")
      .remove(storagePaths);

    if (storageError) {
      console.warn("STORAGE DELETE WARNING:", storageError);
    }
  }

  const { error: deleteError } = await supabase
    .from("images")
    .delete()
    .eq("user_id", userId)
    .in("id", ownedIds);

  if (deleteError) {
    console.error("IMAGE DELETE ERROR:", deleteError);
    return { error: "Delete failed", status: 500 };
  }

  return { deleted: ownedIds.length, requested: safeIds.length };
}

// =========================
// STRIPE WEBHOOK
// =========================
app.post(
  "/stripe-webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("WEBHOOK ERROR:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const userId =
        session.metadata?.user_id ||
        session.metadata?.userId;

      const creditsToAdd =
        Number(session.metadata?.credits || 100);

      if (!userId) {
        console.error("Webhook missing user ID");
        return res.json({ received: true });
      }

      const eventId = event.id;
      const sessionId = session.id;

      // Idempotency guard. Create table stripe_webhook_events for full protection.
      // If the table is missing in local/dev, the webhook continues but logs a warning.
      // const { error: eventInsertError } = await supabase
      const { data: webhookStatus, error: eventInsertError } = await supabase.rpc(
        "create_stripe_webhook_event",
        {
          p_event_id: eventId,
          p_stripe_session_id: sessionId,
          p_user_id: userId,
          p_event_type: event.type,
          p_credits: creditsToAdd
        }
      );

      if (eventInsertError) {
        console.error("WEBHOOK IDEMPOTENCY ERROR:", eventInsertError);
        return res.status(500).json({ error: "Webhook idempotency check failed" });
      }

      if (webhookStatus === "duplicate") {
        console.log("Duplicate Stripe webhook ignored:", eventId);
        return res.json({ received: true, duplicate: true });
      }

      let idempotencyActive = true;

      if (eventInsertError) {
        if (eventInsertError.code === "23505") {
          const { data: existingEvent, error: existingEventError } = await supabase
            .from("stripe_webhook_events")
            .select("delivered")
            .eq("event_id", eventId)
            .single();

          if (existingEventError) {
            console.error("WEBHOOK IDEMPOTENCY LOOKUP ERROR:", existingEventError);
            return res.status(500).json({ error: "Webhook idempotency lookup failed" });
          }

          if (existingEvent?.delivered) {
            console.log("Duplicate Stripe webhook ignored:", eventId);
            return res.json({ received: true, duplicate: true });
          }

          console.warn("Retrying undelivered Stripe webhook:", eventId);
        } else if (!["42P01", "PGRST205"].includes(eventInsertError.code)) {
          console.error("WEBHOOK IDEMPOTENCY ERROR:", eventInsertError);
          return res.status(500).json({ error: "Webhook idempotency check failed" });
        } else {
          idempotencyActive = false;
          console.warn("stripe_webhook_events table missing; webhook idempotency is not active");
        }
      }

      console.log("PAYMENT SUCCESS FOR:", userId);

      try {
        await addCredits(userId, creditsToAdd, {
          transactionType: "purchase",
          description: `Stripe purchase: ${creditsToAdd} credits`,
          stripeSessionId: sessionId,
          stripeEventId: eventId,
          revenueUsd: session.amount_total ? session.amount_total / 100 : null,
          metadata: {
            package: session.metadata?.package || String(creditsToAdd),
            stripe_customer: session.customer || null,
            payment_intent: session.payment_intent || null,
            amount_total: session.amount_total || null,
            currency: session.currency || null
          }
        });
        if (idempotencyActive) {
          //const { error: deliveryMarkError } = await supabase
          const { error: deliveryMarkError } = await supabase.rpc(
            "mark_stripe_webhook_delivered",
            {
              p_event_id: eventId
            }
          );
          //.eq("event_id", eventId);

          if (deliveryMarkError) {
            console.error("WEBHOOK DELIVERY MARK ERROR:", deliveryMarkError);
            return res.status(500).json({ error: "Could not mark webhook delivered" });
          }
        }

        console.log(`+${creditsToAdd} credits added`);
      } catch (creditError) {
        console.error("CREDIT DELIVERY ERROR:", creditError);
        return res.status(500).json({ error: "Credit delivery failed" });
      }
    }

    res.json({ received: true });
  }
);

// =========================
// STRIPE CHECKOUT
// =========================
const CREDIT_PACKAGES = {
  25: {
    credits: 25,
    priceId: process.env.STRIPE_PRICE_25,
    label: "25 Credits"
  },
  100: {
    credits: 100,
    priceId: process.env.STRIPE_PRICE_100,
    label: "100 Credits"
  },
  500: {
    credits: 500,
    priceId: process.env.STRIPE_PRICE_500,
    label: "500 Credits"
  }
};

app.post("/create-checkout-session", async (req, res) => {
  try {
    const user = await getUser(req);

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { credits } = req.body;

    const creditPackage = Number(credits);
    const selectedPackage = CREDIT_PACKAGES[creditPackage];

    if (!selectedPackage) {
      return res.status(400).json({
        error: "Invalid package"
      });
    }

    if (!selectedPackage.priceId) {
      console.error("Missing Stripe price ID for package:", creditPackage);

      return res.status(500).json({
        error: "Stripe price is not configured"
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",

      line_items: [
        {
          price: selectedPackage.priceId,
          quantity: 1
        }
      ],

      metadata: {
        user_id: user.id,
        credits: String(selectedPackage.credits),
        package: String(creditPackage)
      },

      success_url: `${process.env.APP_URL || "http://localhost:3000"}?success=true`,
      cancel_url: `${process.env.APP_URL || "http://localhost:3000"}?canceled=true`
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error("STRIPE CHECKOUT ERROR:", err);
    res.status(500).json({ error: "Stripe error" });
  }
});

// =========================
// CREDITS
// =========================
app.get("/credits", async (req, res) => {
  const user = await getUser(req);

  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const credits = await getCredits(user.id);

  res.json({ credits });
});

app.get("/api/credit-transactions", async (req, res) => {
  try {
    const user = await getUser(req);

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);

    const { data, error } = await supabase
      .from("credit_transactions")
      .select("id, amount, transaction_type, description, metadata, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("CREDIT TRANSACTIONS ERROR:", error);
      return res.status(500).json({ error: "Could not load credit transactions" });
    }

    res.json({ transactions: data || [] });

  } catch (err) {
    console.error("CREDIT TRANSACTIONS SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// =========================
// IMAGE GENERATION
// =========================
app.post("/generate-image", async (req, res) => {
  try {
    const user = await getUser(req);

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Prompt required" });
    }

    const creditCharge = await chargeCredits(user.id, 3, {
      transactionType: "generation",
      description: "Image generation",
      metadata: { route: "/generate-image", count: 4 }
    });

    console.log("USER ID:", user.id);
    console.log("USER CREDITS AFTER CHARGE:", creditCharge.credits);

    if (!creditCharge.ok) {
      return res.status(403).json({ error: "No credits left" });
    }

    const optimizedPrompt = optimizePrompt(prompt);

    console.log("OPTIMIZED PROMPT:");
    console.log(optimizedPrompt);

    try {
      const data = await generateImages({
        prompt: optimizedPrompt,
        n: 4,
        size: "1024x1024"
      });

      await logEvent(user.id, "image_generated", { count: 4 });
      console.log("1 credit deducted");

      res.json(data);
    } catch (generationError) {
      await refundCredits(user.id, 3, {
        description: "Refund after failed image generation",
        metadata: { route: "/generate-image" }
      });
      throw generationError;
    }

  } catch (err) {
    console.error("IMAGE ERROR:", err);
    res.status(err.status || 500).json({
      error: err.message || "Server error"
    });
  }
});

// =========================
// IMAGE VARIATION
// =========================
// Frontend can pass { prompt, image_url }. This creates fresh premium variants
// based on the existing image prompt/context.
app.post("/image-variation", async (req, res) => {
  try {
    const user = await getUser(req);

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { prompt, image_url } = req.body;

    const sourcePrompt =
      prompt ||
      "Create a visually similar but fresh variation of this AI image.";

    const creditCharge = await chargeCredits(user.id, 3, {
      transactionType: "variation",
      description: "Image variation",
      metadata: { route: "/image-variation", count: 4 }
    });

    if (!creditCharge.ok) {
      return res.status(403).json({ error: "No credits left" });
    }

    const variationPrompt = `
Create 4 high-quality variations of this image concept.

Original prompt/context:
${sourcePrompt}

${image_url ? `Reference image URL: ${image_url}` : ""}

Keep the core idea, but vary composition, lighting, color palette, and details.
Do not create duplicates.
Premium AI art quality.
`;

    try {
      const data = await generateImages({
        prompt: variationPrompt,
        n: 4,
        size: "1024x1024"
      });

      await logEvent(user.id, "image_variation", { count: 4 });
      res.json(data);
    } catch (generationError) {
      await refundCredits(user.id, 3, {
        description: "Refund after failed image variation",
        metadata: { route: "/image-variation" }
      });
      throw generationError;
    }

  } catch (err) {
    console.error("VARIATION ERROR:", err);
    res.status(err.status || 500).json({
      error: err.message || "Image variation failed"
    });
  }
});



// =========================
// GENERATE FROM UPLOADED IMAGE — STAGE 2
// =========================
// Stage 2 sends the actual uploaded image pixels to OpenAI's image edit API.
// This creates closer variations than Stage 1, which only used the image URL as text context.
app.post("/generate-from-image", async (req, res) => {
  try {
    const user = await getUser(req);

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { prompt, image_url } = req.body;

    if (!image_url) {
      return res.status(400).json({ error: "Uploaded image URL required" });
    }

    const creditCharge = await chargeCredits(user.id, 3, {
      transactionType: "true_variation",
      description: "Uploaded image variation",
      metadata: { route: "/generate-from-image", count: 4 }
    });

    if (!creditCharge.ok) {
      return res.status(403).json({ error: "No credits left" });
    }

    const variationPrompt = `
Create 4 close variations of the provided image.
Preserve the same main subject, composition, camera angle, layout, color identity, and overall visual structure.
Make only subtle creative changes such as lighting, texture, background details, material polish, and small style refinements.
Do not create a different scene.
Do not replace the main subject.

User direction:
${prompt || "Create subtle variations of this image."}
`;

    try {
      const data = await editImageFromUrl({
        imageUrl: image_url,
        prompt: variationPrompt,
        n: 4,
        size: "1024x1024"
      });

      await logEvent(user.id, "true_image_variation", { count: 4 });
      res.json(data);
    } catch (generationError) {
      await refundCredits(user.id, 3, {
        description: "Refund after failed uploaded-image variation",
        metadata: { route: "/generate-from-image" }
      });
      throw generationError;
    }

  } catch (err) {
    console.error("TRUE IMAGE VARIATION ERROR:", err);
    res.status(err.status || 500).json({
      error: err.message || "True image variation failed"
    });
  }
});

// =========================
// IMAGE UPSCALE
// =========================
// Practical implementation: creates one sharper, more detailed premium re-render.
// True pixel-level upscaling would require a dedicated upscaler model/service.
app.post("/upscale-image", async (req, res) => {
  try {
    const user = await getUser(req);

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { prompt, image_url } = req.body;

    const sourcePrompt =
      prompt ||
      "Upscale and improve this image with sharper details.";

    const creditCharge = await chargeCredits(user.id, 3, {
      transactionType: "upscale",
      description: "Image upscale",
      metadata: { route: "/upscale-image", count: 1 }
    });

    if (!creditCharge.ok) {
      return res.status(403).json({ error: "No credits left" });
    }

    const upscalePrompt = `
Create an upgraded, sharper, cleaner, more detailed version of this image concept.

Original prompt/context:
${sourcePrompt}

${image_url ? `Reference image URL: ${image_url}` : ""}

Improve clarity, textures, lighting, composition, and premium detail.
Keep the same subject and overall concept.
`;

    try {
      const data = await generateImages({
        prompt: upscalePrompt,
        n: 1,
        size: "1024x1024"
      });

      await logEvent(user.id, "image_upscaled", { count: 1 });
      res.json(data);
    } catch (generationError) {
      await refundCredits(user.id, 3, {
        description: "Refund after failed image upscale",
        metadata: { route: "/upscale-image" }
      });
      throw generationError;
    }

  } catch (err) {
    console.error("UPSCALE ERROR:", err);
    res.status(err.status || 500).json({
      error: err.message || "Upscale failed"
    });
  }
});

// =========================
// MULTI-SELECT BULK ACTIONS
// =========================
app.post("/bulk-update-images", async (req, res) => {
  try {
    const user = await getUser(req);

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { imageIds, updates } = req.body;

    if (!Array.isArray(imageIds) || imageIds.length === 0) {
      return res.status(400).json({ error: "No images selected" });
    }

    const allowedUpdates = {};

    if (Object.prototype.hasOwnProperty.call(updates || {}, "collection_id")) {
      allowedUpdates.collection_id = updates.collection_id || null;
    }

    if (Object.prototype.hasOwnProperty.call(updates || {}, "is_favorite")) {
      allowedUpdates.is_favorite = Boolean(updates.is_favorite);
    }

    if (Object.prototype.hasOwnProperty.call(updates || {}, "tags")) {
      allowedUpdates.tags = Array.isArray(updates.tags)
        ? updates.tags.slice(0, 20)
        : [];
    }

    if (!Object.keys(allowedUpdates).length) {
      return res.status(400).json({ error: "No valid update fields" });
    }

    const { error } = await supabase
      .from("images")
      .update(allowedUpdates)
      .eq("user_id", user.id)
      .in("id", imageIds);

    if (error) {
      console.error("BULK UPDATE ERROR:", error);
      return res.status(500).json({ error: "Bulk update failed" });
    }

    res.json({ success: true });

  } catch (err) {
    console.error("BULK UPDATE SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/bulk-delete-images", async (req, res) => {
  try {
    const user = await getUser(req);

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const result = await deleteOwnedImages(user.id, req.body.imageIds);

    if (result.error) {
      return res.status(result.status || 500).json({ error: result.error });
    }

    await logEvent(user.id, "images_bulk_deleted", {
      deleted: result.deleted,
      requested: result.requested
    });

    res.json({ success: true, deleted: result.deleted });

  } catch (err) {
    console.error("BULK DELETE SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/images/:imageId", async (req, res) => {
  try {
    const user = await getUser(req);

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const result = await deleteOwnedImages(user.id, [req.params.imageId]);

    if (result.error) {
      return res.status(result.status || 500).json({ error: result.error });
    }

    await logEvent(user.id, "image_deleted", {
      image_id: Number(req.params.imageId),
      deleted: result.deleted
    });

    res.json({ success: true, deleted: result.deleted });

  } catch (err) {
    console.error("DELETE IMAGE SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// =========================
// ALBUM REORDERING
// =========================
app.post("/reorder-collections", async (req, res) => {
  try {
    const user = await getUser(req);

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { orderedIds } = req.body;

    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({ error: "No album order provided" });
    }

    for (let i = 0; i < orderedIds.length; i++) {
      const { error } = await supabase
        .from("collections")
        .update({ sort_order: i })
        .eq("user_id", user.id)
        .eq("id", orderedIds[i]);

      if (error) {
        console.error("REORDER ERROR:", error);
        return res.status(500).json({ error: "Album reorder failed" });
      }
    }

    res.json({ success: true });

  } catch (err) {
    console.error("REORDER SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});



// =========================
// ANALYTICS + PROFILES + ADMIN MODERATION
// =========================
async function logEvent(userId, eventType, metadata = {}) {
  if (!userId || !eventType) return;
  const { error } = await supabase
    .from("analytics_events")
    .insert({ user_id: userId, event_type: eventType, metadata });
  if (error) console.warn("ANALYTICS EVENT WARNING:", error.message);
}

async function logCreditTransaction({
  userId,
  amount,
  transactionType,
  description = null,
  stripeSessionId = null,
  stripeEventId = null,
  revenueUsd = null,
  metadata = {}
}) {
  if (!userId || !Number.isFinite(Number(amount)) || !transactionType) return;

    const { error } = await supabase.rpc("log_credit_transaction", {
      p_user_id: userId,
      p_amount: Number(amount),
      p_transaction_type: transactionType,
      p_description: description,
      p_stripe_session_id: stripeSessionId,
      p_stripe_event_id: stripeEventId,
      p_metadata: metadata || {},
      p_revenue_usd: revenueUsd
    });

  if (error) {
    if (["42P01", "PGRST205"].includes(error.code)) {
      console.warn("credit_transactions table missing; credit ledger is not active");
      return;
    }

    console.warn("CREDIT LEDGER WARNING:", error.message || error);
  }
}

async function getProfile(userId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, credits, username, display_name, bio, avatar_url, is_admin, public_profile, is_suspended, suspended_at, suspended_reason, is_banned, banned_at, banned_reason")
    .eq("id", userId)
    .single();

  if (error) return null;
  return data;
}


function getEmailUsername(email) {
  const value = String(email || "").trim();
  if (!value || !value.includes("@")) return null;
  return value.split("@")[0].replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40) || null;
}

async function getActorIdentity(user) {
  if (!user?.id) {
    return {
      actorName: "Someone",
      actorUsername: null
    };
  }

  const actorProfile = await getProfile(user.id);
  const actorUsername = actorProfile?.username || getEmailUsername(user.email);
  const actorName =
    actorProfile?.display_name ||
    actorProfile?.username ||
    getEmailUsername(user.email) ||
    "Someone";

  return {
    actorName,
    actorUsername
  };
}


async function requireAdmin(req, res) {
  const user = await getUser(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }

  const profile = await getProfile(user.id);
  if (!profile?.is_admin) {
    res.status(403).json({ error: "Admin only" });
    return null;
  }

  return { user, profile };
}

async function writeAdminAuditLog(admin, action, targetType = null, targetId = null, metadata = {}) {
  try {
    const adminUserId = admin?.user?.id || admin?.id || null;
    if (!adminUserId || !action) return;

    const { error } = await supabase
      .from("admin_audit_logs")
      .insert({
        admin_user_id: adminUserId,
        action,
        target_type: targetType,
        target_id: targetId ? String(targetId) : null,
        metadata: metadata || {}
      });

    if (error) {
      console.warn("ADMIN AUDIT LOG WARNING:", error.message || error);
    }
  } catch (err) {
    console.warn("ADMIN AUDIT LOG SERVER WARNING:", err.message || err);
  }
}

// Block suspended users from making state-changing requests.
// Admin routes, Stripe webhooks, and checkout creation are excluded.
app.use(async (req, res, next) => {
  try {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
    if (
      req.path.startsWith("/api/admin") ||
      req.path === "/stripe-webhook" ||
      req.path === "/create-checkout-session"
    ) {
      return next();
    }

    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return next();

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user?.id) return next();

    const profile = await getProfile(data.user.id);
    if (profile?.is_suspended) {
      return res.status(403).json({
        error: profile.suspended_reason || "This account is suspended. Contact support if you believe this is a mistake."
      });
    }

    return next();
  } catch (err) {
    console.error("SUSPENSION CHECK ERROR:", err);
    return res.status(500).json({ error: "Security check failed" });
  }
});


async function getImageEngagement(imageIds = []) {
  const ids = [...new Set((imageIds || []).map(id => Number(id)).filter(Number.isFinite))];
  const likesByImage = new Map();
  const commentsByImage = new Map();
  const likedByMe = new Set();

  if (!ids.length) {
    return { likesByImage, commentsByImage, likedByMe };
  }

  const [{ data: likes }, { data: comments }] = await Promise.all([
    supabase.from("image_likes").select("image_id, user_id").in("image_id", ids),
    supabase.from("image_comments").select("image_id").eq("is_hidden", false).in("image_id", ids)
  ]);

  (likes || []).forEach(row => {
    likesByImage.set(row.image_id, (likesByImage.get(row.image_id) || 0) + 1);
  });

  (comments || []).forEach(row => {
    commentsByImage.set(row.image_id, (commentsByImage.get(row.image_id) || 0) + 1);
  });

  return { likesByImage, commentsByImage, likedByMe };
}

async function decorateImagesWithEngagement(images = []) {
  const ids = images.map(row => row.id);
  const { likesByImage, commentsByImage } = await getImageEngagement(ids);

  return images.map(row => ({
    ...row,
    like_count: likesByImage.get(row.id) || 0,
    comment_count: commentsByImage.get(row.id) || 0,
    view_count: Number(row.view_count || 0)
  }));
}

app.get("/api/me", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const profile = await getProfile(user.id);
  res.json({ profile: profile || { id: user.id } });
});

app.post("/api/profile", async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    let { username, display_name, bio, public_profile, avatar_url } = req.body;
    username = String(username || "").toLowerCase().trim().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
    display_name = String(display_name || "").trim().slice(0, 80);
    bio = String(bio || "").trim().slice(0, 300);
    avatar_url = avatar_url ? String(avatar_url).trim().slice(0, 1000) : null;

    if (!username) return res.status(400).json({ error: "Username required" });

    const updatePayload = { username, display_name, bio, public_profile: Boolean(public_profile) };
    if (avatar_url) updatePayload.avatar_url = avatar_url;

    const { data, error } = await supabase
      .from("profiles")
      .update(updatePayload)
      .eq("id", user.id)
      .select("id, username, display_name, bio, avatar_url, is_admin, public_profile")
      .single();

    if (error) {
      console.error("PROFILE UPDATE ERROR:", error);
      return res.status(400).json({ error: error.message || "Could not save profile" });
    }

    await logEvent(user.id, "profile_updated", { username, public_profile: Boolean(public_profile) });
    res.json({ profile: data });
  } catch (err) {
    console.error("PROFILE SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/analytics", async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const profile = await getProfile(user.id);

    const [images, favorites, publicImages, publicAlbums, recentViews, events] = await Promise.all([
      supabase.from("images").select("id", { count: "exact", head: true }).eq("user_id", user.id),
      supabase.from("images").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("is_favorite", true),
      supabase.from("images").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("is_public", true),
      supabase.from("collections").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("is_public", true),
      supabase.from("images").select("id", { count: "exact", head: true }).eq("user_id", user.id).not("last_viewed_at", "is", null),
      supabase.from("analytics_events").select("event_type, metadata, created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(20)
    ]);

    res.json({
      summary: {
        total_images: images.count || 0,
        favorite_images: favorites.count || 0,
        public_images: publicImages.count || 0,
        public_albums: publicAlbums.count || 0,
        recent_views: recentViews.count || 0,
        credits: profile?.credits || 0
      },
      recent_events: events.data || []
    });
  } catch (err) {
    console.error("ANALYTICS ERROR:", err);
    res.status(500).json({ error: "Analytics failed" });
  }
});


app.get("/api/admin/stats", async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const [usersResult, imagesResult, transactionsResult] = await Promise.all([
      supabase.from("profiles").select("id", { count: "exact", head: true }),
      supabase.from("images").select("id", { count: "exact", head: true }),
      supabase
        .from("credit_transactions")
        .select("amount, transaction_type, revenue_usd")
    ]);

    if (usersResult.error) {
      console.error("ADMIN STATS USERS ERROR:", usersResult.error);
      return res.status(500).json({ error: "Could not load user stats" });
    }

    if (imagesResult.error) {
      console.error("ADMIN STATS IMAGES ERROR:", imagesResult.error);
      return res.status(500).json({ error: "Could not load image stats" });
    }

    if (transactionsResult.error) {
      console.error("ADMIN STATS CREDIT TRANSACTIONS ERROR:", transactionsResult.error);
      return res.status(500).json({ error: "Could not load credit stats" });
    }

    const transactions = transactionsResult.data || [];

    const creditsSold = transactions
      .filter(row => row.transaction_type === "purchase" && Number(row.amount) > 0)
      .reduce((sum, row) => sum + Number(row.amount || 0), 0);

    const creditsUsed = Math.abs(transactions
      .filter(row => Number(row.amount) < 0)
      .reduce((sum, row) => sum + Number(row.amount || 0), 0));

    const totalRevenue = transactions
      .filter(row => row.transaction_type === "purchase")
      .reduce((sum, row) => sum + Number(row.revenue_usd || 0), 0);

    res.json({
      totalUsers: usersResult.count || 0,
      totalImagesGenerated: imagesResult.count || 0,
      totalRevenue,
      creditsSold,
      creditsUsed
    });

  } catch (err) {
    console.error("ADMIN STATS SERVER ERROR:", err);
    res.status(500).json({ error: "Admin stats failed" });
  }
});

app.get("/api/admin/moderation", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const status = String(req.query.status || "pending");
  let query = supabase
    .from("images")
    .select("id, user_id, image_url, prompt, is_public, moderation_status, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (status !== "all") query = query.eq("moderation_status", status);

  const { data, error } = await query;

  if (error) {
    console.error("ADMIN MODERATION ERROR:", error);
    return res.status(500).json({ error: "Could not load moderation queue" });
  }

  res.json({ images: data || [] });
});

app.post("/api/admin/moderate", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { imageId, moderation_status, is_public } = req.body;
  const status = ["approved", "pending", "hidden"].includes(moderation_status)
    ? moderation_status
    : "pending";

  const { error } = await supabase
    .from("images")
    .update({ moderation_status: status, is_public: Boolean(is_public) })
    .eq("id", imageId);

  if (error) {
    console.error("ADMIN MODERATE ERROR:", error);
    return res.status(500).json({ error: "Moderation failed" });
  }

  await logEvent(admin.user.id, "admin_moderated_image", { imageId, status, is_public: Boolean(is_public) });
  await writeAdminAuditLog(admin, "image_moderated", "image", imageId, { status, is_public: Boolean(is_public) });
  res.json({ success: true });
});

app.post("/api/admin/credits/adjust", async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const userId = String(req.body.user_id || "").trim();
    const amount = Number(req.body.amount);
    const reason = String(req.body.reason || "Admin credit adjustment").trim().slice(0, 300);

    if (!userId || !Number.isInteger(amount) || amount === 0) {
      return res.status(400).json({ error: "Valid user_id and non-zero integer amount required" });
    }

    if (amount > 0) {
      await addCredits(userId, amount, {
        transactionType: "admin_adjustment",
        description: reason,
        metadata: { adjusted_by: admin.user.id }
      });
    } else {
      const debit = Math.abs(amount);
      const charge = await chargeCredits(userId, debit, {
        transactionType: "admin_adjustment",
        description: reason,
        metadata: { adjusted_by: admin.user.id }
      });

      if (!charge.ok) {
        return res.status(400).json({ error: "User does not have enough credits for this adjustment" });
      }
    }

    await logEvent(admin.user.id, "admin_adjusted_credits", { user_id: userId, amount, reason });
    await writeAdminAuditLog(admin, "credits_adjusted", "user", userId, { amount, reason });

    res.json({ success: true });
  } catch (err) {
    console.error("ADMIN CREDIT ADJUST ERROR:", err);
    res.status(500).json({ error: err.message || "Credit adjustment failed" });
  }
});

// =========================
// ADMIN TOOLS: REPORTS, USERS, AUDIT LOGS
// =========================
app.post("/api/images/:imageId/report", async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Login required to report images" });

    const imageId = Number(req.params.imageId);
    if (!Number.isSafeInteger(imageId) || imageId <= 0) {
      return res.status(400).json({ error: "Invalid image" });
    }

    const reason = String(req.body.reason || "other").trim().slice(0, 80);
    const details = String(req.body.details || "").trim().slice(0, 1000);

    const { data: image, error: imageError } = await supabase
      .from("images")
      .select("id, user_id, is_public, moderation_status")
      .eq("id", imageId)
      .single();

    if (imageError || !image) {
      return res.status(404).json({ error: "Image not found" });
    }

    if (!image.is_public || image.moderation_status === "hidden") {
      return res.status(403).json({ error: "Image is not public" });
    }

    const { error } = await supabase
      .from("image_reports")
      .upsert({
        image_id: imageId,
        reporter_id: user.id,
        reason,
        details,
        status: "open"
      }, { onConflict: "image_id,reporter_id" });

    if (error) {
      console.error("IMAGE REPORT ERROR:", error);
      return res.status(500).json({ error: "Could not submit report" });
    }

    await logEvent(user.id, "image_reported", { image_id: imageId, reason });
    res.json({ success: true });
  } catch (err) {
    console.error("IMAGE REPORT SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});



app.post("/api/creators/:creatorId/report", async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Login required to report creators" });

    const creatorId = String(req.params.creatorId || "").trim();
    if (!creatorId || creatorId === user.id) {
      return res.status(400).json({ error: "Invalid creator" });
    }

    const reason = String(req.body.reason || "other").trim().slice(0, 80);
    const details = String(req.body.details || "").trim().slice(0, 1000);

    const { data: creator, error: creatorError } = await supabase
      .from("profiles")
      .select("id, username, public_profile, is_banned")
      .eq("id", creatorId)
      .eq("public_profile", true)
      .eq("is_banned", false)
      .single();

    if (creatorError || !creator) {
      return res.status(404).json({ error: "Creator not found" });
    }

    const { error } = await supabase
      .from("creator_reports")
      .upsert({
        reported_user_id: creatorId,
        reporter_id: user.id,
        reason,
        details,
        status: "open"
      }, { onConflict: "reported_user_id,reporter_id" });

    if (error) {
      console.error("CREATOR REPORT ERROR:", error);
      return res.status(500).json({ error: "Could not submit creator report" });
    }

    await logEvent(user.id, "creator_reported", { reported_user_id: creatorId, reason });
    res.json({ success: true });
  } catch (err) {
    console.error("CREATOR REPORT SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/admin/reports", async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const status = String(req.query.status || "open");
    let query = supabase
      .from("image_reports")
      .select("id, image_id, reporter_id, reason, details, status, created_at, resolved_at")
      .order("created_at", { ascending: false })
      .limit(100);

    if (status !== "all") query = query.eq("status", status);

    const { data: reports, error } = await query;
    if (error) {
      console.error("ADMIN REPORTS ERROR:", error);
      return res.status(500).json({ error: "Could not load reports" });
    }

    const imageIds = [...new Set((reports || []).map(r => Number(r.image_id)).filter(Number.isFinite))];
    let imageMap = new Map();

    if (imageIds.length) {
      const { data: images, error: imageError } = await supabase
        .from("images")
        .select("id, user_id, image_url, prompt, is_public, moderation_status, created_at")
        .in("id", imageIds);

      if (imageError) {
        console.warn("ADMIN REPORT IMAGES WARNING:", imageError.message || imageError);
      } else {
        imageMap = new Map((images || []).map(img => [Number(img.id), img]));
      }
    }

    res.json({
      reports: (reports || []).map(report => ({
        ...report,
        image: imageMap.get(Number(report.image_id)) || null
      }))
    });
  } catch (err) {
    console.error("ADMIN REPORTS SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/admin/reports/:reportId/resolve", async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const reportId = Number(req.params.reportId);
    const status = ["open", "reviewed", "dismissed", "action_taken"].includes(req.body.status)
      ? req.body.status
      : "reviewed";

    const { data, error } = await supabase
      .from("image_reports")
      .update({
        status,
        resolved_by: admin.user.id,
        resolved_at: new Date().toISOString()
      })
      .eq("id", reportId)
      .select("id, image_id, status")
      .single();

    if (error) {
      console.error("ADMIN REPORT RESOLVE ERROR:", error);
      return res.status(500).json({ error: "Could not update report" });
    }

    await writeAdminAuditLog(admin, "report_resolved", "image_report", reportId, { status, image_id: data?.image_id });
    res.json({ success: true, report: data });
  } catch (err) {
    console.error("ADMIN REPORT RESOLVE SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});



app.get("/api/admin/creator-reports", async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const status = String(req.query.status || "open");
    let query = supabase
      .from("creator_reports")
      .select("id, reported_user_id, reporter_id, reason, details, status, created_at, resolved_at")
      .order("created_at", { ascending: false })
      .limit(100);

    if (status !== "all") query = query.eq("status", status);

    const { data: reports, error } = await query;
    if (error) {
      console.error("ADMIN CREATOR REPORTS ERROR:", error);
      return res.status(500).json({ error: "Could not load creator reports" });
    }

    const creatorIds = [...new Set((reports || []).map(r => r.reported_user_id).filter(Boolean))];
    let creatorMap = new Map();

    if (creatorIds.length) {
      const { data: creators, error: creatorError } = await supabase
        .from("profiles")
        .select("id, username, display_name, bio, avatar_url, public_profile, is_suspended, suspended_at, is_banned, banned_at, banned_reason")
        .in("id", creatorIds);

      if (creatorError) {
        console.warn("ADMIN CREATOR REPORT PROFILES WARNING:", creatorError.message || creatorError);
      } else {
        creatorMap = new Map((creators || []).map(profile => [profile.id, profile]));
      }
    }

    res.json({
      reports: (reports || []).map(report => ({
        ...report,
        creator: creatorMap.get(report.reported_user_id) || null
      }))
    });
  } catch (err) {
    console.error("ADMIN CREATOR REPORTS SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/admin/creator-reports/:reportId/resolve", async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const reportId = Number(req.params.reportId);
    const status = ["open", "reviewed", "dismissed", "action_taken"].includes(req.body.status)
      ? req.body.status
      : "reviewed";

    const { data, error } = await supabase
      .from("creator_reports")
      .update({
        status,
        resolved_by: admin.user.id,
        resolved_at: new Date().toISOString()
      })
      .eq("id", reportId)
      .select("id, reported_user_id, status")
      .single();

    if (error) {
      console.error("ADMIN CREATOR REPORT RESOLVE ERROR:", error);
      return res.status(500).json({ error: "Could not update creator report" });
    }

    await writeAdminAuditLog(admin, "creator_report_resolved", "creator_report", reportId, {
      status,
      reported_user_id: data?.reported_user_id
    });

    res.json({ success: true, report: data });
  } catch (err) {
    console.error("ADMIN CREATOR REPORT RESOLVE SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function sanitizeAdminSearchTerm(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[%,()]/g, "")
    .slice(0, 80);
}

app.get("/api/admin/users", async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const q = sanitizeAdminSearchTerm(req.query.q);
    if (q.length < 2) {
      return res.json({ users: [] });
    }

    const filters = [
      `username.ilike.%${q}%`,
      `display_name.ilike.%${q}%`
    ];

    if (isValidUuid(q)) {
      filters.push(`id.eq.${q}`);
    }

    const { data, error } = await supabase
      .from("profiles")
      .select("id, username, display_name, credits, is_admin, public_profile, is_suspended, suspended_at, suspended_reason, is_banned, banned_at, banned_reason")
      .or(filters.join(","))
      .limit(25);

    if (error) {
      console.error("ADMIN USERS SEARCH ERROR:", error);
      return res.status(500).json({ error: "Could not search users" });
    }

    res.json({ users: data || [] });
  } catch (err) {
    console.error("ADMIN USERS SEARCH SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/admin/users/:userId/suspend", async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const userId = String(req.params.userId || "").trim();
    const reason = String(req.body.reason || "Account suspended by admin").trim().slice(0, 300);

    if (!userId) return res.status(400).json({ error: "Invalid user" });
    if (userId === admin.user.id) return res.status(400).json({ error: "Admins cannot suspend themselves" });

    const { error } = await supabase
      .from("profiles")
      .update({
        is_suspended: true,
        suspended_at: new Date().toISOString(),
        suspended_reason: reason,
        suspended_by: admin.user.id
      })
      .eq("id", userId);

    if (error) {
      console.error("ADMIN SUSPEND USER ERROR:", error);
      return res.status(500).json({ error: "Could not suspend user" });
    }

    await writeAdminAuditLog(admin, "user_suspended", "user", userId, { reason });
    res.json({ success: true });
  } catch (err) {
    console.error("ADMIN SUSPEND USER SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/admin/users/:userId/unsuspend", async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const userId = String(req.params.userId || "").trim();
    if (!userId) return res.status(400).json({ error: "Invalid user" });

    const { error } = await supabase
      .from("profiles")
      .update({
        is_suspended: false,
        suspended_at: null,
        suspended_reason: null,
        suspended_by: null
      })
      .eq("id", userId);

    if (error) {
      console.error("ADMIN UNSUSPEND USER ERROR:", error);
      return res.status(500).json({ error: "Could not unsuspend user" });
    }

    await writeAdminAuditLog(admin, "user_unsuspended", "user", userId, {});
    res.json({ success: true });
  } catch (err) {
    console.error("ADMIN UNSUSPEND USER SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/admin/creators/:creatorId/ban", async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const creatorId = String(req.params.creatorId || "").trim();
    const reason = String(req.body.reason || "Creator banned by admin").trim().slice(0, 300);

    if (!creatorId) return res.status(400).json({ error: "Invalid creator" });
    if (creatorId === admin.user.id) return res.status(400).json({ error: "Admins cannot ban themselves" });

    const { error: profileError } = await supabase
      .from("profiles")
      .update({
        is_banned: true,
        banned_at: new Date().toISOString(),
        banned_reason: reason,
        banned_by: admin.user.id,
        public_profile: false
      })
      .eq("id", creatorId);

    if (profileError) {
      console.error("ADMIN BAN CREATOR ERROR:", profileError);
      return res.status(500).json({ error: "Could not ban creator" });
    }

    const { error: imagesError } = await supabase
      .from("images")
      .update({ moderation_status: "hidden", is_public: false })
      .eq("user_id", creatorId);

    if (imagesError) {
      console.warn("ADMIN BAN CREATOR IMAGE HIDE WARNING:", imagesError.message || imagesError);
    }

    const { error: collectionsError } = await supabase
      .from("collections")
      .update({ is_public: false })
      .eq("user_id", creatorId);

    if (collectionsError) {
      console.warn("ADMIN BAN CREATOR COLLECTION HIDE WARNING:", collectionsError.message || collectionsError);
    }

    await writeAdminAuditLog(admin, "creator_banned", "user", creatorId, { reason });
    res.json({ success: true });
  } catch (err) {
    console.error("ADMIN BAN CREATOR SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/admin/creators/:creatorId/unban", async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const creatorId = String(req.params.creatorId || "").trim();
    if (!creatorId) return res.status(400).json({ error: "Invalid creator" });

    const { error } = await supabase
      .from("profiles")
      .update({
        is_banned: false,
        banned_at: null,
        banned_reason: null,
        banned_by: null,
        public_profile: true
      })
      .eq("id", creatorId);

    if (error) {
      console.error("ADMIN UNBAN CREATOR ERROR:", error);
      return res.status(500).json({ error: "Could not unban creator" });
    }

    await writeAdminAuditLog(admin, "creator_unbanned", "user", creatorId, {});
    res.json({ success: true });
  } catch (err) {
    console.error("ADMIN UNBAN CREATOR SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/admin/audit-logs", async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const { data, error } = await supabase
      .from("admin_audit_logs")
      .select("id, admin_user_id, action, target_type, target_id, metadata, created_at")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      console.error("ADMIN AUDIT LOGS ERROR:", error);
      return res.status(500).json({ error: "Could not load audit logs" });
    }

    res.json({ logs: data || [] });
  } catch (err) {
    console.error("ADMIN AUDIT LOGS SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});





// =========================
// NOTIFICATIONS
// =========================
async function createNotification({ userId, actorId = null, type, imageId = null, creatorId = null, data = {} }) {
  try {
    if (!userId || !type) return;
    if (actorId && String(actorId) === String(userId)) return;

    const { error } = await supabase
      .from("notifications")
      .insert({
        user_id: userId,
        actor_id: actorId,
        type,
        image_id: imageId,
        creator_id: creatorId,
        data: data || {},
        read: false
      });

    if (error) {
      console.warn("NOTIFICATION WARNING:", error.message || error);
    }
  } catch (err) {
    console.warn("NOTIFICATION SERVER WARNING:", err.message || err);
  }
}

app.get("/api/notifications", async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const limit = Math.min(Math.max(Number(req.query.limit || 30), 1), 100);

    const [{ data, error }, { count, error: countError }] = await Promise.all([
      supabase
        .from("notifications")
        .select("id, type, actor_id, image_id, creator_id, data, read, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(limit),
      supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("read", false)
    ]);

    if (error || countError) {
      console.error("NOTIFICATIONS LOAD ERROR:", error || countError);
      return res.status(500).json({ error: "Could not load notifications" });
    }

    res.json({ notifications: data || [], unread: count || 0 });
  } catch (err) {
    console.error("NOTIFICATIONS SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/notifications/:notificationId/read", async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const notificationId = Number(req.params.notificationId);
    if (!Number.isSafeInteger(notificationId)) {
      return res.status(400).json({ error: "Invalid notification" });
    }

    const { error } = await supabase
      .from("notifications")
      .update({ read: true })
      .eq("id", notificationId)
      .eq("user_id", user.id);

    if (error) {
      console.error("NOTIFICATION READ ERROR:", error);
      return res.status(500).json({ error: "Could not mark notification read" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("NOTIFICATION READ SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/notifications/read-all", async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const { error } = await supabase
      .from("notifications")
      .update({ read: true })
      .eq("user_id", user.id)
      .eq("read", false);

    if (error) {
      console.error("NOTIFICATIONS READ ALL ERROR:", error);
      return res.status(500).json({ error: "Could not mark notifications read" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("NOTIFICATIONS READ ALL SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// =========================
// SOCIAL GROWTH: FOLLOWS, FEEDS, TRENDING
// =========================
app.post("/api/creators/:creatorId/follow", async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Login required to follow creators" });

    const creatorId = String(req.params.creatorId || "");
    if (!creatorId || creatorId === user.id) {
      return res.status(400).json({ error: "Invalid creator" });
    }

    const { data: creator, error: creatorError } = await supabase
      .from("profiles")
      .select("id, public_profile")
      .eq("id", creatorId)
      .eq("public_profile", true)
      .single();

    if (creatorError || !creator) {
      return res.status(404).json({ error: "Creator not found" });
    }

    const { error } = await supabase
      .from("creator_follows")
      .upsert({ follower_id: user.id, creator_id: creatorId }, { onConflict: "follower_id,creator_id" });

    if (error) {
      console.error("FOLLOW ERROR:", error);
      return res.status(500).json({ error: "Could not follow creator" });
    }

    await logEvent(user.id, "creator_followed", { creator_id: creatorId });

    const { actorName, actorUsername } = await getActorIdentity(user);

    await createNotification({
      userId: creatorId,
      actorId: user.id,
      type: "creator_followed",
      creatorId,
      data: {
        actor_name: actorName,
        actor_username: actorUsername
      }
    });
    res.json({ following: true });
  } catch (err) {
    console.error("FOLLOW SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/creators/:creatorId/follow", async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Login required" });

    const creatorId = String(req.params.creatorId || "");
    const { error } = await supabase
      .from("creator_follows")
      .delete()
      .eq("follower_id", user.id)
      .eq("creator_id", creatorId);

    if (error) {
      console.error("UNFOLLOW ERROR:", error);
      return res.status(500).json({ error: "Could not unfollow creator" });
    }

    await logEvent(user.id, "creator_unfollowed", { creator_id: creatorId });
    res.json({ following: false });
  } catch (err) {
    console.error("UNFOLLOW SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/feed/following", async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const { data: follows, error: followError } = await supabase
      .from("creator_follows")
      .select("creator_id")
      .eq("follower_id", user.id)
      .limit(500);

    if (followError) {
      console.error("FOLLOWING FEED FOLLOWS ERROR:", followError);
      return res.status(500).json({ error: "Could not load following feed" });
    }

    const creatorIds = (follows || []).map(row => row.creator_id);
    if (!creatorIds.length) return res.json({ images: [] });

    const { data: images, error: imagesError } = await supabase
      .from("images")
      .select("id, user_id, image_url, prompt, tags, created_at, collection_id, view_count")
      .in("user_id", creatorIds)
      .eq("is_public", true)
      .eq("moderation_status", "approved")
      .order("created_at", { ascending: false })
      .limit(80);

    if (imagesError) {
      console.error("FOLLOWING FEED IMAGES ERROR:", imagesError);
      return res.status(500).json({ error: "Could not load following feed" });
    }

    const decorated = await decorateImagesWithEngagement(images || []);
    res.json({ images: decorated });
  } catch (err) {
    console.error("FOLLOWING FEED SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});


app.get("/api/trending-creators", async (req, res) => {
  try {
    const viewer = await getOptionalUser(req);

    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select("id, username, display_name, bio, avatar_url, public_profile, is_banned")
      .eq("public_profile", true)
      .eq("is_banned", false)
      .not("username", "is", null)
      .limit(200);

    if (profilesError) {
      console.error("TRENDING CREATORS PROFILE ERROR:", profilesError);
      return res.status(500).json({ error: "Could not load trending creators" });
    }

    const publicProfiles = profiles || [];
    const creatorIds = publicProfiles.map(profile => profile.id);

    if (!creatorIds.length) {
      return res.json({ creators: [] });
    }

    const [followersResult, imagesResult, viewerFollowsResult] = await Promise.all([
      supabase
        .from("creator_follows")
        .select("follower_id, creator_id")
        .in("creator_id", creatorIds)
        .limit(10000),
      supabase
        .from("images")
        .select("id, user_id")
        .in("user_id", creatorIds)
        .eq("is_public", true)
        .eq("moderation_status", "approved")
        .limit(10000),
      viewer?.id
        ? supabase
            .from("creator_follows")
            .select("creator_id")
            .eq("follower_id", viewer.id)
            .in("creator_id", creatorIds)
            .limit(10000)
        : Promise.resolve({ data: [], error: null })
    ]);

    if (followersResult.error) {
      console.error("TRENDING CREATORS FOLLOWERS ERROR:", followersResult.error);
      return res.status(500).json({ error: "Could not load trending creators" });
    }

    if (imagesResult.error) {
      console.error("TRENDING CREATORS IMAGES ERROR:", imagesResult.error);
      return res.status(500).json({ error: "Could not load trending creators" });
    }

    if (viewerFollowsResult.error) {
      console.error("TRENDING CREATORS VIEWER FOLLOW ERROR:", viewerFollowsResult.error);
    }

    const followerCounts = new Map();
    for (const row of followersResult.data || []) {
      followerCounts.set(row.creator_id, (followerCounts.get(row.creator_id) || 0) + 1);
    }

    const publicImageCounts = new Map();
    const imageOwner = new Map();
    for (const image of imagesResult.data || []) {
      publicImageCounts.set(image.user_id, (publicImageCounts.get(image.user_id) || 0) + 1);
      imageOwner.set(Number(image.id), image.user_id);
    }

    const imageIds = [...imageOwner.keys()];
    let likeCounts = new Map();

    if (imageIds.length) {
      const { data: likes, error: likesError } = await supabase
        .from("image_likes")
        .select("image_id")
        .in("image_id", imageIds)
        .limit(10000);

      if (likesError) {
        console.warn("TRENDING CREATORS LIKES WARNING:", likesError.message || likesError);
      } else {
        for (const like of likes || []) {
          const ownerId = imageOwner.get(Number(like.image_id));
          if (ownerId) {
            likeCounts.set(ownerId, (likeCounts.get(ownerId) || 0) + 1);
          }
        }
      }
    }

    const viewerFollowing = new Set((viewerFollowsResult.data || []).map(row => row.creator_id));

    const creators = publicProfiles
      .map(profile => {
        const followers = Number(followerCounts.get(profile.id) || 0);
        const publicImages = Number(publicImageCounts.get(profile.id) || 0);
        const likesReceived = Number(likeCounts.get(profile.id) || 0);
        const score = followers * 5 + likesReceived * 2 + publicImages;

        return {
          id: profile.id,
          username: profile.username,
          display_name: profile.display_name,
          bio: profile.bio,
          avatar_url: profile.avatar_url,
          stats: {
            followers,
            public_images: publicImages,
            likes_received: likesReceived,
            trending_score: score
          },
          viewer: {
            is_owner: viewer?.id === profile.id,
            following: viewerFollowing.has(profile.id)
          }
        };
      })
      .filter(creator => creator.username)
      .sort((a, b) =>
        b.stats.trending_score - a.stats.trending_score ||
        b.stats.followers - a.stats.followers ||
        b.stats.likes_received - a.stats.likes_received ||
        b.stats.public_images - a.stats.public_images
      )
      .slice(0, 50);

    res.json({ creators });
  } catch (err) {
    console.error("TRENDING CREATORS SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/trending-images", async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days || 7), 1), 30);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { data: images, error } = await supabase
      .from("images")
      .select("id, user_id, image_url, prompt, tags, created_at, collection_id, view_count")
      .eq("is_public", true)
      .eq("moderation_status", "approved")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      console.error("TRENDING IMAGES ERROR:", error);
      return res.status(500).json({ error: "Could not load trending images" });
    }

    const decorated = await decorateImagesWithEngagement(images || []);
    const ranked = decorated
      .map(img => ({
        ...img,
        trending_score:
          Number(img.like_count || 0) * 3 +
          Number(img.comment_count || 0) * 5 +
          Number(img.view_count || 0)
      }))
      .sort((a, b) => b.trending_score - a.trending_score || new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 80);

    res.json({ images: ranked });
  } catch (err) {
    console.error("TRENDING SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/images/:imageId/view", async (req, res) => {
  try {
    const imageId = Number(req.params.imageId);
    if (!Number.isSafeInteger(imageId) || imageId <= 0) {
      return res.status(400).json({ error: "Invalid image" });
    }

    const { error } = await supabase.rpc("increment_image_view", {
      p_image_id: imageId
    });

    if (error) {
      console.warn("IMAGE VIEW RPC WARNING:", error.message || error);
      return res.json({ success: false });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("IMAGE VIEW SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/public-profile/:username", async (req, res) => {
  const username = String(req.params.username || "").toLowerCase();
  const viewer = await getOptionalUser(req);

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, username, display_name, bio, avatar_url, public_profile, is_banned")
    .eq("username", username)
    .eq("public_profile", true)
    .eq("is_banned", false)
    .single();

  if (profileError || !profile) {
    return res.status(404).json({ error: "Profile not found" });
  }

  const [albumsResult, imagesResult, followersResult, followingResult] = await Promise.all([
    supabase.from("collections")
      .select("id, name, public_slug, cover_image_url, created_at")
      .eq("user_id", profile.id)
      .eq("is_public", true)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false }),
    supabase.from("images")
      .select("id, image_url, prompt, tags, created_at, collection_id, view_count")
      .eq("user_id", profile.id)
      .eq("is_public", true)
      .eq("moderation_status", "approved")
      .order("created_at", { ascending: false })
      .limit(80),
    supabase.from("creator_follows").select("creator_id", { count: "exact", head: true }).eq("creator_id", profile.id),
    supabase.from("creator_follows").select("follower_id", { count: "exact", head: true }).eq("follower_id", profile.id)
  ]);

  const images = await decorateImagesWithEngagement(imagesResult.data || []);
  const totalLikesReceived = images.reduce((sum, img) => sum + Number(img.like_count || 0), 0);
  let following = false;

  if (viewer?.id && viewer.id !== profile.id) {
    const { data: followRow } = await supabase
      .from("creator_follows")
      .select("creator_id")
      .eq("follower_id", viewer.id)
      .eq("creator_id", profile.id)
      .maybeSingle();
    following = Boolean(followRow);
  }

  res.json({
    profile,
    albums: albumsResult.data || [],
    images,
    stats: {
      followers: followersResult.count || 0,
      following: followingResult.count || 0,
      total_images: images.length,
      total_likes: totalLikesReceived
    },
    viewer: {
      is_owner: viewer?.id === profile.id,
      following
    }
  });
});

app.get("/api/public-gallery/:slug", async (req, res) => {
  const slug = String(req.params.slug || "");

  const { data: collection, error: collectionError } = await supabase
    .from("collections")
    .select("id, user_id, name, public_slug, cover_image_url, is_public")
    .eq("public_slug", slug)
    .eq("is_public", true)
    .single();

  if (collectionError || !collection) {
    return res.status(404).json({ error: "Gallery not found" });
  }

  const { data: images } = await supabase
    .from("images")
    .select("id, image_url, prompt, tags, created_at, collection_id")
    .eq("collection_id", collection.id)
    .eq("is_public", true)
    .eq("moderation_status", "approved")
    .order("created_at", { ascending: false });

  const decoratedImages = await decorateImagesWithEngagement(images || []);
  res.json({ collection, images: decoratedImages });
});

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getAppBaseUrl() {
  return String(process.env.APP_URL || "https://qeecko.com").replace(/\/$/, "");
}

function sendIndexWithMeta(res, meta = {}) {
  const indexPath = path.join(__dirname, "index.html");
  let html = fs.readFileSync(indexPath, "utf8");
  const baseUrl = getAppBaseUrl();
  const title = escapeHtml(meta.title || "Qeecko AI Image Generator");
  const description = escapeHtml(meta.description || "Create, share, and discover AI-generated images on Qeecko.");
  const image = meta.image ? escapeHtml(meta.image) : "";
  const canonical = escapeHtml(meta.canonical || baseUrl);
  const type = escapeHtml(meta.type || "website");

  const tags = `
  <title>${title}</title>
  <meta name="description" content="${description}">
  <link rel="canonical" href="${canonical}">
  <meta property="og:type" content="${type}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:url" content="${canonical}">
  ${image ? `<meta property="og:image" content="${image}">` : ""}
  <meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
  ${image ? `<meta name="twitter:image" content="${image}">` : ""}`;

  html = html.replace(/<title>.*?<\/title>/, tags);
  res.send(html);
}

app.get("/robots.txt", (req, res) => {
  const baseUrl = getAppBaseUrl();
  res.type("text/plain").send(`User-agent: *\nAllow: /\n\nSitemap: ${baseUrl}/sitemap.xml\n`);
});

app.get("/sitemap.xml", async (req, res) => {
  try {
    const baseUrl = getAppBaseUrl();
    const urls = [
      { loc: `${baseUrl}/`, priority: "1.0", changefreq: "daily" },
      { loc: `${baseUrl}/creators`, priority: "0.8", changefreq: "daily" },
      { loc: `${baseUrl}/trending`, priority: "0.8", changefreq: "hourly" },
      { loc: `${baseUrl}/trending-images`, priority: "0.8", changefreq: "hourly" }
    ];

    const [{ data: profiles }, { data: collections }] = await Promise.all([
      supabase
        .from("profiles")
        .select("username, updated_at, created_at")
        .eq("public_profile", true)
        .eq("is_banned", false)
        .not("username", "is", null)
        .limit(1000),
      supabase
        .from("collections")
        .select("public_slug, updated_at, created_at")
        .eq("is_public", true)
        .not("public_slug", "is", null)
        .limit(1000)
    ]);

    (profiles || []).forEach(profile => {
      urls.push({
        loc: `${baseUrl}/u/${encodeURIComponent(profile.username)}`,
        lastmod: profile.updated_at || profile.created_at || null,
        priority: "0.7",
        changefreq: "weekly"
      });
    });

    (collections || []).forEach(collection => {
      urls.push({
        loc: `${baseUrl}/gallery/${encodeURIComponent(collection.public_slug)}`,
        lastmod: collection.updated_at || collection.created_at || null,
        priority: "0.6",
        changefreq: "weekly"
      });
    });

    const body = urls.map(item => `
  <url>
    <loc>${escapeXml(item.loc)}</loc>
    ${item.lastmod ? `<lastmod>${escapeXml(new Date(item.lastmod).toISOString())}</lastmod>` : ""}
    <changefreq>${item.changefreq}</changefreq>
    <priority>${item.priority}</priority>
  </url>`).join("");

    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}
</urlset>`);
  } catch (err) {
    console.error("SITEMAP ERROR:", err);
    captureServerError(err, { route: "/sitemap.xml" });
    res.status(500).type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`);
  }
});

app.get("/u/:username", async (req, res) => {
  const username = String(req.params.username || "").toLowerCase();
  const { data: profile } = await supabase
    .from("profiles")
    .select("username, display_name, bio, avatar_url, public_profile, is_banned")
    .eq("username", username)
    .eq("public_profile", true)
    .eq("is_banned", false)
    .single();

  const baseUrl = getAppBaseUrl();
  sendIndexWithMeta(res, {
    title: profile ? `${profile.display_name || profile.username} | Qeecko AI Creator` : "Qeecko AI Creator",
    description: profile?.bio || "Explore this Qeecko creator profile and discover AI-generated images.",
    image: profile?.avatar_url || "",
    canonical: `${baseUrl}/u/${encodeURIComponent(username)}`,
    type: "profile"
  });
});

app.get("/gallery/:slug", async (req, res) => {
  const slug = String(req.params.slug || "");
  const { data: collection } = await supabase
    .from("collections")
    .select("name, cover_image_url, is_public")
    .eq("public_slug", slug)
    .eq("is_public", true)
    .single();

  const baseUrl = getAppBaseUrl();
  sendIndexWithMeta(res, {
    title: collection ? `${collection.name} | Qeecko AI Gallery` : "Qeecko AI Gallery",
    description: collection ? `Public AI gallery: ${collection.name}` : "Public Qeecko AI gallery.",
    image: collection?.cover_image_url || "",
    canonical: `${baseUrl}/gallery/${encodeURIComponent(slug)}`,
    type: "website"
  });
});

app.get(["/creators", "/trending-creators"], (req, res) => {
  const baseUrl = getAppBaseUrl();
  sendIndexWithMeta(res, {
    title: "Trending AI Creators | Qeecko",
    description: "Discover trending AI creators on Qeecko, follow profiles, and explore public AI image galleries.",
    canonical: `${baseUrl}/creators`,
    type: "website"
  });
});

app.get(["/trending", "/trending-images"], (req, res) => {
  const baseUrl = getAppBaseUrl();
  sendIndexWithMeta(res, {
    title: "Trending AI Images | Qeecko",
    description: "Explore trending AI-generated images shared by the Qeecko creator community.",
    canonical: `${baseUrl}/trending-images`,
    type: "website"
  });
});

// =========================
// PROMPT SUGGESTIONS
// =========================
app.post("/suggest-prompts", async (req, res) => {
  try {
    const { input } = req.body;

    if (!input) return res.json({ suggestions: [] });

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content: "Generate short creative image prompts."
          },
          {
            role: "user",
            content: `Give 5 prompts based on: ${input}. Return ONLY a JSON array.`
          }
        ],
        temperature: 0.8
      })
    });

    const data = await response.json();

    let suggestions = [];

    try {
      suggestions = JSON.parse(data.choices?.[0]?.message?.content || "[]");
    } catch {
      suggestions = [];
    }

    res.json({ suggestions });

  } catch (err) {
    console.error("SUGGEST ERROR:", err);
    res.json({ suggestions: [] });
  }
});

// =========================
// PROMPT ENHANCER
// =========================
app.post("/enhance-prompt", async (req, res) => {
  try {
    const { input, style } = req.body;

    const styles = {
      cinematic: "cinematic, dramatic lighting",
      anime: "anime style, vibrant",
      realistic: "photorealistic, detailed",
      fantasy: "fantasy, magical",
      cyberpunk: "cyberpunk, neon"
    };

    const styleText = styles[style] || "high detail";

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content: "Enhance prompts."
          },
          {
            role: "user",
            content: `Improve: "${input}" with ${styleText}`
          }
        ]
      })
    });

    const data = await response.json();

    res.json({
      enhanced: data.choices?.[0]?.message?.content || input
    });

  } catch (err) {
    console.error("ENHANCE ERROR:", err);
    res.json({ enhanced: req.body?.input || "" });
  }
});

// =========================
// SERVE FRONTEND
// =========================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Public creator profile route
app.get("/u/:username", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Public collection/gallery route
app.get("/public/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Stripe return routes
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});


// =========================
// PUBLIC IMAGE LIKES + COMMENTS
// =========================
async function getOptionalUser(req) {
  try {
    return await getUser(req);
  } catch {
    return null;
  }
}

app.get("/api/images/:imageId/social", async (req, res) => {
  try {
    const { imageId } = req.params;
    const user = await getOptionalUser(req);

    const { data: image, error: imageError } = await supabase
      .from("images")
      .select("id, user_id, is_public, moderation_status")
      .eq("id", imageId)
      .single();

    if (imageError || !image) {
      return res.status(404).json({ error: "Image not found" });
    }

    if (!image.is_public || image.moderation_status === "hidden") {
      return res.status(403).json({ error: "Image is not public" });
    }

    const { count: likeCount, error: likeCountError } = await supabase
      .from("image_likes")
      .select("*", { count: "exact", head: true })
      .eq("image_id", imageId);

    if (likeCountError) {
      console.error("LIKE COUNT ERROR:", likeCountError);
      return res.status(500).json({ error: "Could not load likes" });
    }

    let likedByMe = false;
    let savedByMe = false;

    if (user) {
      const [{ data: myLike }, { data: mySaved }] = await Promise.all([
        supabase
          .from("image_likes")
          .select("id")
          .eq("image_id", imageId)
          .eq("user_id", user.id)
          .maybeSingle(),
        supabase
          .from("saved_images")
          .select("id")
          .eq("image_id", imageId)
          .eq("user_id", user.id)
          .maybeSingle()
      ]);

      likedByMe = Boolean(myLike);
      savedByMe = Boolean(mySaved);
    }

    const { data: comments, error: commentError } = await supabase
      .from("image_comments")
      .select("id, comment, display_name, created_at")
      .eq("image_id", imageId)
      .eq("is_hidden", false)
      .order("created_at", { ascending: false })
      .limit(20);

    if (commentError) {
      console.error("COMMENTS ERROR:", commentError);
      return res.status(500).json({ error: "Could not load comments" });
    }

    res.json({
      likes: likeCount || 0,
      likedByMe,
      savedByMe,
      comments: comments || []
    });

  } catch (err) {
    console.error("SOCIAL LOAD ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/images/:imageId/save", async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Login required to save" });

    const { imageId } = req.params;

    const { data: image, error: imageError } = await supabase
      .from("images")
      .select("id, user_id, is_public, moderation_status")
      .eq("id", imageId)
      .single();

    if (imageError || !image) {
      return res.status(404).json({ error: "Image not found" });
    }

    if (!image.is_public || image.moderation_status === "hidden") {
      return res.status(403).json({ error: "Image is not public" });
    }

    const { error } = await supabase
      .from("saved_images")
      .upsert({ user_id: user.id, image_id: Number(imageId) }, { onConflict: "user_id,image_id" });

    if (error) {
      console.error("SAVE IMAGE ERROR:", error);
      return res.status(500).json({ error: "Could not save image" });
    }

    await logEvent(user.id, "image_saved", { image_id: Number(imageId) });
    res.json({ saved: true });
  } catch (err) {
    console.error("SAVE IMAGE SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/images/:imageId/save", async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Login required to unsave" });

    const { imageId } = req.params;

    const { error } = await supabase
      .from("saved_images")
      .delete()
      .eq("user_id", user.id)
      .eq("image_id", imageId);

    if (error) {
      console.error("UNSAVE IMAGE ERROR:", error);
      return res.status(500).json({ error: "Could not remove saved image" });
    }

    res.json({ saved: false });
  } catch (err) {
    console.error("UNSAVE IMAGE SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/saved-images", async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const limit = Math.min(Math.max(Number(req.query.limit || 60), 1), 100);

    const { data: savedRows, error: savedError } = await supabase
      .from("saved_images")
      .select("image_id, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (savedError) {
      console.error("SAVED IMAGES LOAD ERROR:", savedError);
      return res.status(500).json({ error: "Could not load saved images" });
    }

    const ids = (savedRows || []).map(row => Number(row.image_id)).filter(Number.isFinite);

    if (!ids.length) {
      return res.json({ images: [] });
    }

    const savedAtByImage = new Map((savedRows || []).map(row => [Number(row.image_id), row.created_at]));

    const { data: images, error: imageError } = await supabase
      .from("images")
      .select("id, image_url, prompt, tags, created_at, collection_id, user_id, is_public, moderation_status, view_count")
      .in("id", ids)
      .eq("is_public", true)
      .neq("moderation_status", "hidden");

    if (imageError) {
      console.error("SAVED IMAGES IMAGE ERROR:", imageError);
      return res.status(500).json({ error: "Could not load saved image details" });
    }

    const ordered = (images || [])
      .map(image => ({ ...image, saved_at: savedAtByImage.get(Number(image.id)), saved_by_me: true }))
      .sort((a, b) => new Date(b.saved_at || 0) - new Date(a.saved_at || 0));

    const decorated = await decorateImagesWithEngagement(ordered);
    res.json({ images: decorated });
  } catch (err) {
    console.error("SAVED IMAGES SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/images/:imageId/like", async (req, res) => {
  try {
    const user = await getUser(req);

    if (!user) {
      return res.status(401).json({ error: "Login required to like" });
    }

    const { imageId } = req.params;

    const { data: image, error: imageError } = await supabase
      .from("images")
      .select("id, user_id, is_public, moderation_status")
      .eq("id", imageId)
      .single();

    if (imageError || !image) {
      return res.status(404).json({ error: "Image not found" });
    }

    if (!image.is_public || image.moderation_status === "hidden") {
      return res.status(403).json({ error: "Image is not public" });
    }

    const { data: existing } = await supabase
      .from("image_likes")
      .select("id")
      .eq("image_id", imageId)
      .eq("user_id", user.id)
      .maybeSingle();

    let liked = false;

    if (existing) {
      const { error } = await supabase
        .from("image_likes")
        .delete()
        .eq("id", existing.id);

      if (error) {
        console.error("UNLIKE ERROR:", error);
        return res.status(500).json({ error: "Could not unlike image" });
      }
    } else {
      const { error } = await supabase
        .from("image_likes")
        .insert({
          image_id: imageId,
          user_id: user.id
        });

      if (error) {
        console.error("LIKE ERROR:", error);
        return res.status(500).json({ error: "Could not like image" });
      }

      liked = true;
      await logEvent(user.id, "image_liked", { image_id: imageId });

      const { actorName, actorUsername } = await getActorIdentity(user);

      await createNotification({
        userId: image.user_id,
        actorId: user.id,
        type: "image_liked",
        imageId: Number(imageId),
        data: {
          image_id: Number(imageId),
          actor_name: actorName,
          actor_username: actorUsername
        }
      });
    }

    const { count } = await supabase
      .from("image_likes")
      .select("*", { count: "exact", head: true })
      .eq("image_id", imageId);

    res.json({
      liked,
      likes: count || 0
    });

  } catch (err) {
    console.error("LIKE SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/images/:imageId/comments", async (req, res) => {
  try {
    const user = await getUser(req);

    if (!user) {
      return res.status(401).json({ error: "Login required to comment" });
    }

    const { imageId } = req.params;
    const comment = String(req.body.comment || "").trim().slice(0, 500);

    if (!comment) {
      return res.status(400).json({ error: "Comment required" });
    }

    const { data: image, error: imageError } = await supabase
      .from("images")
      .select("id, user_id, is_public, moderation_status")
      .eq("id", imageId)
      .single();

    if (imageError || !image) {
      return res.status(404).json({ error: "Image not found" });
    }

    if (!image.is_public || image.moderation_status === "hidden") {
      return res.status(403).json({ error: "Image is not public" });
    }

    const profile = await getProfile(user.id);
    const displayName =
      profile?.display_name ||
      profile?.username ||
      getEmailUsername(user.email) ||
      "Creator";

    const { data, error } = await supabase
      .from("image_comments")
      .insert({
        image_id: imageId,
        user_id: user.id,
        display_name: displayName,
        comment
      })
      .select("id, comment, display_name, created_at")
      .single();

    if (error) {
      console.error("COMMENT INSERT ERROR:", error);
      return res.status(500).json({ error: "Could not save comment" });
    }

    await logEvent(user.id, "image_commented", { image_id: imageId });

    const { actorName, actorUsername } = await getActorIdentity(user);

    if (image.user_id !== user.id) {
      const actorProfile = await getProfile(user.id);

      const actorName =
        actorProfile?.display_name ||
        actorProfile?.username ||
        "Someone";

      await createNotification({
        userId: image.user_id,
        type: "image_commented",
        data: {
          actor_id: user.id,
          actor_name: actorName,
          actor_username: actorProfile?.username || null,
          image_id: imageId,
          comment_id: data.id
        }
      });
    }

    res.json({ comment: data });

  } catch (err) {
    console.error("COMMENT SERVER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// Sentry test route. Enable only when explicitly requested in environment.
if (process.env.ENABLE_SENTRY_TEST_ROUTE === "true") {
  app.get("/debug-sentry", (req, res) => {
    throw new Error("Sentry test error");
  });
}

// Sentry Express error handler must be after routes and before the final fallback/error handler.
if (Sentry?.setupExpressErrorHandler) {
  Sentry.setupExpressErrorHandler(app);
}

// Fallback for public gallery URLs or refreshes.
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Final Express error handler.
app.use((err, req, res, next) => {
  captureServerError(err, {
    method: req.method,
    path: req.path,
    ip: req.ip
  });

  if (res.headersSent) {
    return next(err);
  }

  res.status(err.status || 500).json({ error: "Server error" });
});

// =========================
// START SERVER
// =========================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
