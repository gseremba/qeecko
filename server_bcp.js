// =========================
// BACKEND (Node.js + Express)
// =========================

// 1. Install dependencies:
// npm init -y
// npm install express cors dotenv node-fetch

// 2. Create server.js

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

/**
 * Health check
 */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/**
 * Image generation endpoint
 */
app.post("/generate-image", async (req, res) => {
  try {
    const prompt = req.body.prompt;

    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const apiKey = process.env.OPENAI_API_KEY?.trim();

    if (!apiKey) {
      return res.status(500).json({ error: "Missing API key" });
    }

    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: prompt,
        size: "1024x1024"
      })
    });

    const data = await response.json();

    // 🔥 If OpenAI returns an error, pass it clearly
    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error?.message || "Image generation failed",
        details: data
      });
    }

    res.json(data);

  } catch (error) {
    console.error("SERVER ERROR:", error);
    res.status(500).json({
      error: "Internal server error",
      message: error.message
    });
  }
});

/**
 * Serve frontend
 */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});