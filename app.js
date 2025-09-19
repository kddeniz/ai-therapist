// app.js
const fs = require('fs');
const path = require("path");

// .env'yi dosyanın yanından, kesin yoldan yükle
const envPath = path.resolve(__dirname, ".env");
const result = require("dotenv").config({ path: envPath, override: true });
// İsterseniz geçici debug:
if (result.error) console.error("dotenv load error:", result.error);
else console.log("dotenv loaded from:", envPath);

const express = require("express");
const { Pool } = require("pg");  
const PORT = process.env.PORT || 3000;
const { v4: uuidv4 } = require("uuid"); // uuid kütüphanesini ekleyin (npm install uuid)
const app = express();
const swaggerUi = require('swagger-ui-express')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL ? { rejectUnauthorized: false } : false
});

const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

// ElevenLabs & OpenAI endpoint'leri (güncel dokümanınıza göre URL'leri teyit edin)
const ELEVEN_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const ELEVEN_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // bir voice id/ismi
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions"; // Responses API kullanıyorsanız onu koyun
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

app.use(express.json()); // JSON body okumak için

app.use((req, res, next) => {
  // Origin'i aynen yansıt (veya '*' de olur; cookie kullanmıyorsan fark etmez)
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');

  // İzin verilen metodlar
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');

  // İzin verilen header'lar (Swagger/fetch'in gönderdiği tüm header'ları kapsa)
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] || 'Content-Type,Authorization,xi-api-key'
  );

  // Credential kullanmıyorsan kapalı kalsın; gerekiyorsa 'true' yap ve Origin'i '*' değil spesifik yaz
  // res.setHeader('Access-Control-Allow-Credentials', 'true');

  // Preflight kısa devre
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

//swagger için lazım
app.set('trust proxy', 1); // Render behind proxy -> doğru proto (https) için

//routes

// JSON'u dinamik üret: host/proto'yu gelen isteğe göre doldur
app.get('/openapi.json', (req, res) => {
  try {
    const spec = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'swagger_output.json'), 'utf8')
    );

    // İstekten gerçek host/proto’yu al
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
    const host = req.get('host'); // ör: myapp.onrender.com

    if (spec.swagger === '2.0') {
      // Swagger 2.0 (OAS2)
      spec.host = host;            // DYNAMIC_BY_RUNTIME yerini alır
      spec.basePath = spec.basePath || '/';
      spec.schemes = [proto];      // http veya https
    } else if (spec.openapi) {
      // OpenAPI 3
      spec.servers = [{ url: `${proto}://${host}` }];
    }

    res.json(spec);
  } catch (e) {
    console.error('openapi serve error:', e);
    res.status(500).json({ error: 'openapi_load_failed' });
  }
});

app.get('/', (req, res) => {
  res.send('Hello World?!')
})

app.post("/clients", async (req, res) => {
  try {
    const { username, gender, language } = req.body;

    // basit validasyon
    if (!username || !language || gender === undefined) {
      return res.status(400).json({ error: "username, gender ve language gerekli" });
    }

    // yeni id üret (tablonuzda DEFAULT olsa bile explicit gönderebiliriz)
    const id = uuidv4();

    const query = `
      INSERT INTO client (id, username, gender, language)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `;

    const values = [id, username, gender, language];
    const { rows } = await pool.query(query, values);

    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error("createClient error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

app.post("/sessions", async (req, res) => {
  try {
    const { clientId, therapistId, price } = req.body;

    if (!clientId || !therapistId) {
      return res.status(400).json({ error: "clientId ve therapistId zorunlu" });
    }

    const query = `
      INSERT INTO session (client_id, therapist_id, price)
      VALUES ($1, $2, $3)
      RETURNING id, created
    `;

    const values = [clientId, therapistId, price || null];
    const { rows } = await pool.query(query, values);

    res.status(201).json({
      id: rows[0].id,
      created: rows[0].created,
    });
  } catch (err) {
    console.error("createSession error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

app.post("/sessions/:sessionId/messages", async (req, res) => {
  const { sessionId } = req.params;
  const { text, language = "tr" } = req.body || {};

  if (!text || !text.trim()) {
    return res.status(400).json({ error: "text is required" });
  }

  try {
    // 0) Session var mı?
    const s = await pool.query("SELECT 1 FROM session WHERE id = $1", [sessionId]);
    if (s.rowCount === 0) {
      return res.status(404).json({ error: "session_not_found" });
    }

    // 1) Kullanıcı mesajını kaydet
    const insertUser = `
      INSERT INTO message (session_id, created, language, is_client, content)
      VALUES ($1, NOW(), $2, TRUE, $3)
      RETURNING id, created
    `;
    const { rows: userRows } = await pool.query(insertUser, [sessionId, language, text.trim()]);
    const userMessageId = userRows[0].id;

    // (Opsiyonel) Son konuşma geçmişini modele göndermek isteyebilirsiniz:
    // const history = await pool.query(
    //   `SELECT is_client, content FROM message WHERE session_id=$1 ORDER BY created ASC LIMIT 30`, [sessionId]
    // );
    // const chat = history.rows.map(r => ({ role: r.is_client ? "user" : "assistant", content: r.content }));

    // 2) OpenAI’dan yanıt al
    const aiResp = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are an empathetic therapy assistant. Be concise, supportive, and practical. Avoid diagnosis; offer gentle coping strategies and next steps."
          },
          // ...chat, // geçmişi kullanacaksanız burayı açın
          { role: "user", content: text.trim() }
        ]
      })
    });

    if (!aiResp.ok) {
      const body = await aiResp.text().catch(() => "");
      // Kullanıcı mesajı DB’de duruyor; 502 ile döndürüp id’yi veriyoruz.
      return res.status(502).json({ error: "openai_failed", userMessageId, detail: body });
    }

    const aiJson = await aiResp.json();
    const aiText = aiJson.choices?.[0]?.message?.content?.trim() || "";
    if (!aiText) {
      return res.status(502).json({ error: "empty_ai_response", userMessageId });
    }

    // 3) AI mesajını kaydet
    const insertAi = `
      INSERT INTO message (session_id, created, language, is_client, content)
      VALUES ($1, NOW(), $2, FALSE, $3)
      RETURNING id, created
    `;
    const { rows: aiRows } = await pool.query(insertAi, [sessionId, language, aiText]);
    const aiMessageId = aiRows[0].id;

    // 4) Yanıt
    return res.status(201).json({
      sessionId,
      userMessageId,
      aiMessageId,
      userText: text.trim(),
      aiText
    });
  } catch (err) {
    console.error("text message flow error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

app.post("/sessions/:sessionId/messages/audio", upload.single("audio"), 
  /* 
    #swagger.tags = ['Messages']
    #swagger.summary = 'Audio → STT → AI → TTS'
    #swagger.consumes = ['multipart/form-data']

    #swagger.parameters['sessionId'] = {
      in: 'path', required: true, type: 'string', format: 'uuid'
    }
    #swagger.parameters['stream'] = {
      in: 'query', required: false, type: 'integer', enum: [0,1], default: 0
    }
    #swagger.parameters['audio'] = {
      in: 'formData', type: 'file', required: true, name: 'audio',
      description: 'Ses dosyası (field name: audio)'
    }
    #swagger.parameters['language'] = {
      in: 'formData', type: 'string', required: false, default: 'tr'
    }
  */
  async (req, res) => {
  const client = await pool.connect();
  try {
    const { sessionId } = req.params;
    const { language = "tr" } = req.body;
    const streamAudio = String(req.query.stream || "0") === "1"; // ?stream=1 ise ses stream

    if (!req.file) {
      return res.status(400).json({ error: "audio file missing (field name: audio)" });
    }

    const sttResp = await fetch(ELEVEN_STT_URL, {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVEN_API_KEY },
      body: (() => {
        const fd = new FormData();
        // Dosya (ogg/wav/mp3) — mimetype'ı da verin
        fd.append(
          "file",
          new Blob([req.file.buffer], { type: req.file.mimetype || "audio/ogg" }),
          req.file.originalname || "audio.ogg"
        );

        // ZORUNLU: model_id (STT için Scribe v1)
        fd.append("model_id", "scribe_v1");

        // Opsiyonel ama doğru anahtar adı: language_code
        if (language) fd.append("language_code", language);

        // İsterseniz diğer opsiyonlar:
        // fd.append("diarize", "false"); // konuşmacı ayrımı
        return fd;
      })(),
    });

    if (!sttResp.ok) {
      const txt = await sttResp.text().catch(() => "");
      throw new Error(`ElevenLabs STT failed: ${sttResp.status} ${txt}`);
    }
    const sttJson = await sttResp.json();
    const userText = sttJson.text || sttJson.transcript || ""; // alan adı dokümana göre değişebilir
    if (!userText) throw new Error("Empty transcript from STT");

    // 2) DB: kullanıcının mesajını kaydet (transaction)
    await client.query("BEGIN");
    const insertUser = `
      INSERT INTO message (session_id, created, language, is_client, content)
      VALUES ($1, NOW(), $2, TRUE, $3)
      RETURNING id, created
    `;
    const { rows: userRows } = await client.query(insertUser, [sessionId, language, userText]);
    const userMessageId = userRows[0].id;

    // 3) OpenAI: yanıt al
    const aiResp = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: "You are a helpful therapy assistant. Be empathetic, brief, and actionable. Avoid medical claims; suggest coping strategies." },
          { role: "user", content: userText }
        ]
      })
    });
    if (!aiResp.ok) {
      const txt = await aiResp.text().catch(() => "");
      throw new Error(`OpenAI failed: ${aiResp.status} ${txt}`);
    }
    const aiJson = await aiResp.json();
    const aiText = aiJson.choices?.[0]?.message?.content?.trim() || "";
    if (!aiText) throw new Error("Empty AI response");

    // 4) DB: AI mesajını kaydet
    const insertAi = `
      INSERT INTO message (session_id, created, language, is_client, content)
      VALUES ($1, NOW(), $2, FALSE, $3)
      RETURNING id, created
    `;
    const { rows: aiRows } = await client.query(insertAi, [sessionId, language, aiText]);
    const aiMessageId = aiRows[0].id;
    await client.query("COMMIT");

    // 5) TTS: ElevenLabs -> ses
    const ttsResp = await fetch(`${ELEVEN_TTS_URL}/${encodeURIComponent(ELEVEN_VOICE_ID)}`, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVEN_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text: aiText,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }, // isteğe göre
        model_id: "eleven_multilingual_v2" // dokümanınıza göre
      })
    });
    if (!ttsResp.ok) {
      const txt = await ttsResp.text().catch(() => "");
      throw new Error(`ElevenLabs TTS failed: ${ttsResp.status} ${txt}`);
    }
    const audioBuffer = Buffer.from(await ttsResp.arrayBuffer());

    // 6) Yanıt: İsteğe göre stream ya da base64
    if (streamAudio) {
      res.setHeader("Content-Type", "audio/mpeg"); // ElevenLabs genelde mp3 verir
      res.setHeader("Content-Disposition", `inline; filename="reply.mp3"`);
      return res.send(audioBuffer);
    } else {
      const b64 = audioBuffer.toString("base64");
      return res.status(201).json({
        sessionId,
        userMessageId,
        aiMessageId,
        transcript: userText,
        aiText,
        audioBase64: b64,
        audioMime: "audio/mpeg"
      });
    }
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("audio message flow error:", err);
    res.status(500).json({ error: "internal_error", detail: String(err.message || err) });
  } finally {
    client.release();
  }
});

app.get("/clients", async (req, res) => { //to be deleted
  try {
    const { rows } = await pool.query(
      `SELECT id, username, language, gender, created
       FROM client
       ORDER BY created DESC
       LIMIT 50`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal_error" });
  }
});

// GET /therapists  — liste + filtre + sayfalama
app.get("/therapists", async (req, res) => {
  /* 
    #swagger.tags = ['Therapists']
    #swagger.summary = 'Terapist listesini getir'
    #swagger.parameters['q'] = { in: 'query', type: 'string', description: 'İsim/açıklama arama (ILIKE)' }
    #swagger.parameters['therapyTypeId'] = { in: 'query', type: 'string', format: 'uuid', description: 'Terapi tipi filtresi' }
    #swagger.parameters['gender'] = { in: 'query', type: 'integer', enum: [0,1,2], description: '0:unknown, 1:male, 2:female' }
    #swagger.parameters['limit'] = { in: 'query', type: 'integer', default: 50, description: 'Max 100' }
    #swagger.parameters['offset'] = { in: 'query', type: 'integer', default: 0 }
    #swagger.responses[200] = { description: 'OK' }
  */
  try {
    let { q, therapyTypeId, gender, limit = 50, offset = 0 } = req.query;

    // basit validasyon
    limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
    offset = Math.max(parseInt(offset, 10) || 0, 0);

    const where = [];
    const params = [];
    const add = (clause, val) => { params.push(val); where.push(`${clause} $${params.length}`); };

    if (q && q.trim()) {
      add("(t.name ILIKE '%' || $${i} || '%' OR t.description ILIKE '%' || $${i} || '%')".replaceAll("$${i}", `$${params.length+1}`), q.trim());
      // yukarıdaki küçük numara: param indexini doğru artırmak için replace
      // ama istersen şöyle de yazabiliriz (daha okunur):
      params.push(q.trim());
      where.push(`(t.name ILIKE '%' || $${params.length} || '%' OR t.description ILIKE '%' || $${params.length} || '%')`);
    }
    if (therapyTypeId) {
      params.push(therapyTypeId);
      where.push(`t.therapy_type_id = $${params.length}`);
    }
    if (gender !== undefined) {
      const g = parseInt(gender, 10);
      if ([0,1,2].includes(g)) {
        params.push(g);
        where.push(`t.gender = $${params.length}`);
      }
    }

    const sql = `
      SELECT
        t.id,
        t.name,
        t.description,
        t.gender,
        t.therapy_type_id AS "therapyTypeId",
        tt.name           AS "therapyTypeName"
      FROM therapist t
      LEFT JOIN therapy_type tt ON tt.id = t.therapy_type_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.name ASC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    params.push(limit, offset);
    const { rows } = await pool.query(sql, params);

    res.json({ items: rows, paging: { limit, offset, count: rows.length } });
  } catch (e) {
    console.error("list therapists error:", e);
    res.status(500).json({ error: "internal_error" });
  }
});

// GET /clients/:clientId/sessions  — seans listesi (terapist + terapi tipi adı ile)
app.get("/clients/:clientId/sessions", async (req, res) => {
  /* 
    #swagger.tags = ['Sessions']
    #swagger.summary = 'Bir müşterinin tüm terapi seanslarını listele'
    #swagger.parameters['clientId'] = { in: 'path', required: true, type: 'string', format: 'uuid' }
    #swagger.parameters['status'] = { in: 'query', type: 'string', enum: ['active','ended'], description: 'active = ended IS NULL' }
    #swagger.parameters['limit'] = { in: 'query', type: 'integer', default: 50 }
    #swagger.parameters['offset'] = { in: 'query', type: 'integer', default: 0 }
    #swagger.parameters['sort'] = { in: 'query', type: 'string', enum: ['created_desc','created_asc'], default: 'created_desc' }
    #swagger.responses[200] = { description: 'OK' }
  */
  try {
    const { clientId } = req.params;
    let { status, limit = 50, offset = 0, sort = 'created_desc' } = req.query;

    limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
    offset = Math.max(parseInt(offset, 10) || 0, 0);
    const order = sort === 'created_asc' ? 'ASC' : 'DESC';

    const where = ['s.client_id = $1'];
    const params = [clientId];

    if (status === 'active') where.push('s.ended IS NULL');
    if (status === 'ended')  where.push('s.ended IS NOT NULL');

    const sql = `
      SELECT
        s.id,
        s.created,
        s.ended,
        s.price,
        s.therapist_id           AS "therapistId",
        t.name                    AS "therapistName",
        t.gender                  AS "therapistGender",
        t.therapy_type_id         AS "therapyTypeId",
        tt.name                   AS "therapyTypeName",
        COUNT(*) OVER()           AS "total"
      FROM session s
      LEFT JOIN therapist t   ON t.id  = s.therapist_id
      LEFT JOIN therapy_type tt ON tt.id = t.therapy_type_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.created ${order}
      LIMIT $2 OFFSET $3
    `;

    params.push(limit, offset);
    const { rows } = await pool.query(sql, params);

    const total = rows[0]?.total ? Number(rows[0].total) : 0;
    // total yoksa (hiç kayıt yoksa) 0 döner
    res.json({
      items: rows.map(r => ({
        id: r.id,
        created: r.created,
        ended: r.ended,
        price: r.price,
        therapistId: r.therapistId,
        therapistName: r.therapistName,
        therapistGender: r.therapistGender,
        therapyTypeId: r.therapyTypeId,
        therapyTypeName: r.therapyTypeName
      })),
      paging: { limit, offset, total }
    });
  } catch (e) {
    console.error("list client sessions error:", e);
    res.status(500).json({ error: "internal_error" });
  }
});

// Swagger setup
app.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup(null, {
    explorer: true,
    customSiteTitle: 'API Documentation',
    swaggerOptions: { url: '/openapi.json' }
  })
);

app.listen(PORT, () => {
  console.log(`Example app listening on port ${PORT}`)
})
