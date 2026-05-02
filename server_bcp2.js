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

app.post("/suggest-prompts", async (req, res) => {
  try {
    const input = req.body.input;

    if (!input) {
      return res.json({ suggestions: [] });
    }

    const apiKey = process.env.OPENAI_API_KEY?.trim();

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content: "You generate creative image prompts."
          },
          {
            role: "user",
            content: `Give 5 short creative image prompts based on: "${input}". Return ONLY a JSON array of strings.`
          }
        ],
        temperature: 0.8
      })
    });

    const data = await response.json();

    const text = data.choices?.[0]?.message?.content || "[]";

    let suggestions;

    try {
      suggestions = JSON.parse(text);
    } catch {
      suggestions = [];
    }

    res.json({ suggestions });

  } catch (err) {
    console.error(err);
    res.json({ suggestions: [] });
  }
});

app.post("/enhance-prompt", async (req, res) => {
  try {
    const input = req.body.input;
    const style = req.body.style || "default";

    if (!input) {
      return res.json({ enhanced: "" });
    }

    const apiKey = process.env.OPENAI_API_KEY?.trim();

    const styleInstructions = {
      cinematic: "Make it cinematic, dramatic lighting, film-like composition",
      anime: "Make it anime style, vibrant colors, stylized characters",
      realistic: "Make it highly realistic, photographic detail, natural lighting",
      fantasy: "Make it fantasy-themed, magical elements, epic environment",
      cyberpunk: "Make it cyberpunk, neon lights, futuristic city, high contrast",
      default: "Make it detailed and visually rich"
    };

    const styleText = styleInstructions[style] || styleInstructions.default;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content: "You enhance image generation prompts."
          },
          {
            role: "user",
            content: `Enhance this prompt: "${input}". ${styleText}. Return ONLY the improved prompt.`
          }
        ],
        temperature: 0.9
      })
    });

    const data = await response.json();
    const enhanced = data.choices?.[0]?.message?.content?.trim() || input;

    res.json({ enhanced });

  } catch (err) {
    console.error(err);
    res.json({ enhanced: "" });
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