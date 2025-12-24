#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

// env yükle
require("dotenv").config({ path: path.resolve(__dirname, ".env"), override: true });

const ELEVEN_TTS_URL = process.env.ELEVEN_TTS_URL || "https://api.elevenlabs.io/v1/text-to-speech";
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const OPENAI_API_URL = process.env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const VOICES_TXT = path.join(__dirname, "voices.txt");
const PUBLIC_VOICES_DIR = path.join(__dirname, "public", "voices");

const LANGUAGE_DISPLAY_NAMES = {
  tr: "Turkish",
  en: "English",
  de: "German",
  fr: "French",
  es: "Spanish",
  ar: "Arabic",
  pt: "Portuguese",
  it: "Italian",
  nl: "Dutch",
  sv: "Swedish",
};

const INTENTS = ["kaygi", "zihin", "deneme", "sohbet"];

if (!ELEVEN_API_KEY) {
  console.error("ELEVEN_API_KEY missing. Set it in .env before running this script.");
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY missing. Set it in .env before running this script.");
  process.exit(1);
}

function loadVoiceTexts() {
  if (!fs.existsSync(VOICES_TXT)) {
    throw new Error(`Missing ${VOICES_TXT}`);
  }
  const raw = fs.readFileSync(VOICES_TXT, "utf8");
  const lines = raw.split(/\r?\n/);
  const data = {};
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();
    if (!key || value === "") continue;

    if (key === "languages") {
      value = value.split("#")[0].trim();
      data.languages = value
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
    } else {
      data[key] = value.split("#")[0].trim();
    }
  }
  if (!data.languages || data.languages.length === 0) {
    throw new Error("voices.txt must include a languages line with comma-separated codes.");
  }
  return data;
}

const translationCache = new Map();

async function translateText(intention, language, sourceText) {
  if (language === "tr") return sourceText;
  const cacheKey = `${intention}:${language}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }
  const displayName = LANGUAGE_DISPLAY_NAMES[language] || language;
  const prompt = `Translate the following Turkish text to ${displayName}. Preserve the placeholder [KOÇ_ADI] exactly as written (do not translate or replace it). Respond with the translated text only.\n\n${sourceText}`;

  const resp = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: "You are a professional translator. Do not add extra explanation." },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "unknown");
    throw new Error(`OpenAI translation failed (${language}): ${resp.status} ${detail}`);
  }
  const payload = await resp.json();
  const translated = payload?.choices?.[0]?.message?.content?.trim();
  if (!translated) {
    throw new Error(`OpenAI returned empty translation for ${language}`);
  }
  translationCache.set(cacheKey, translated);
  return translated;
}

async function synthesizeAudio(voiceId, text) {
  const formPayload = {
    text,
    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    model_id: "eleven_flash_v2_5",
    output_format: "mp3_22050_32",
  };

  const resp = await fetch(`${ELEVEN_TTS_URL}/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(formPayload),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "unknown");
    throw new Error(`ElevenLabs TTS failed (${resp.status}): ${detail}`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  return buffer;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

async function generateFile(targetPath, generator) {
  if (fs.existsSync(targetPath)) {
    console.log("skip (exists)", targetPath);
    return;
  }
  ensureDir(path.dirname(targetPath));
  const buffer = await generator();
  fs.writeFileSync(targetPath, buffer);
  console.log("created", targetPath);
}

async function main() {
  const voiceTexts = loadVoiceTexts();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
  });

  let therapists = [];
  try {
    const { rows } = await pool.query("SELECT id, name, voice_id AS \"voiceId\" FROM public.therapist WHERE voice_id IS NOT NULL");
    therapists = rows;
  } finally {
    await pool.end();
  }

  if (therapists.length === 0) {
    throw new Error("No therapists with voice_id found.");
  }

  for (const therapist of therapists) {
    const coachName = therapist.name || "Therapist";
    console.log(`\n--- Processing ${coachName} (${therapist.id}) ---`);
    for (const language of voiceTexts.languages) {
      const cleanLang = language || "tr";
      for (const intent of INTENTS) {
        const baseText = voiceTexts[intent];
        if (!baseText) {
          console.warn(`Missing text for intent ${intent} in voices.txt`);
          continue;
        }
        const translated = await translateText(intent, cleanLang, baseText);
        const finalText = translated.replace(/\[KOÇ_ADI\]/g, coachName);
        const targetPath = path.join(
          PUBLIC_VOICES_DIR,
          "intro",
          cleanLang,
          intent,
          `${therapist.id}.mp3`
        );
        await generateFile(targetPath, () => synthesizeAudio(therapist.voiceId, finalText));
      }
      const previewText = voiceTexts.preview;
      if (!previewText) {
        console.warn("Missing preview text in voices.txt");
        continue;
      }
      const translatedPreview = await translateText("preview", cleanLang, previewText);
      const finalPreview = translatedPreview.replace(/\[KOÇ_ADI\]/g, coachName);
      const previewPath = path.join(
        PUBLIC_VOICES_DIR,
        "preview",
        cleanLang,
        `${therapist.id}.mp3`
      );
      await generateFile(previewPath, () => synthesizeAudio(therapist.voiceId, finalPreview));
    }
  }
}

main().catch((err) => {
  console.error("voices.js failed:", err);
  process.exit(1);
});

