import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY ?? "").trim();
const OPENROUTER_MODEL = (process.env.OPENROUTER_MODEL ?? "google/gemini-2.5-flash:free").trim();
const OPENROUTER_API_BASE = (process.env.OPENROUTER_API_BASE ?? "https://openrouter.ai/api/v1").trim();

const APP_URL = (process.env.APP_URL ?? "").trim();
const APP_NAME = (process.env.APP_NAME ?? "StudyMate AI").trim();

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const STUDY_DIR = path.join(DATA_DIR, "study");

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]", "utf8");
  if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, "[]", "utf8");
  if (!fs.existsSync(STUDY_DIR)) fs.mkdirSync(STUDY_DIR, { recursive: true });
}

function studyFilePath(userId) {
  const safe = String(userId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(STUDY_DIR, `${safe || "unknown"}.json`);
}

function authenticateUser(req, res, next) {
  const token = parseBearerToken(req);
  const user = token ? getUserByToken(token) : null;
  if (!user) return res.status(401).json({ error: { message: "Не авторизован" } });
  req.authUser = user;
  next();
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function hashPassword(password, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  return crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("hex");
}

function issueSession(userId) {
  const sessions = readJson(SESSIONS_FILE, []);
  const token = crypto.randomBytes(32).toString("hex");
  sessions.push({ token, userId, createdAt: new Date().toISOString() });
  writeJson(SESSIONS_FILE, sessions);
  return token;
}

function getUserByToken(token) {
  const sessions = readJson(SESSIONS_FILE, []);
  const users = readJson(USERS_FILE, []);
  const session = sessions.find((s) => s.token === token);
  if (!session) return null;
  const user = users.find((u) => u.id === session.userId);
  if (!user) return null;
  return { id: user.id, firstName: user.firstName || "", lastName: user.lastName || "", name: user.name || "", email: user.email };
}

function parseBearerToken(req) {
  const auth = req.headers.authorization;
  if (!auth || typeof auth !== "string") return "";
  const [kind, token] = auth.split(" ");
  return kind === "Bearer" && token ? token.trim() : "";
}

async function aiChatCompletion({ messages, temperature = 0.6 }) {
  const r = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": APP_URL || "https://studymate-server-9shn.onrender.com",
      "X-Title": APP_NAME || "StudyMate AI",
    },
    body: JSON.stringify({ model: OPENROUTER_MODEL, messages, temperature, max_tokens: 4000 }),
  });

  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!r.ok) {
    throw new Error(data?.error?.message ?? `OpenRouter error ${r.status}`);
  }
  return data?.choices?.[0]?.message?.content?.trim() ?? "";
}

function tryParseJsonObjectFromText(text) {
  try { return JSON.parse(text); } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }
}

ensureDataFiles();

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/auth/register", (req, res) => {
  const { firstName, lastName, email, password } = req.body ?? {};
  const safeEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const users = readJson(USERS_FILE, []);
  if (users.some((u) => u.email === safeEmail)) return res.status(409).json({ error: { message: "Email занят" } });

  const salt = crypto.randomBytes(16).toString("hex");
  const user = { id: crypto.randomUUID(), firstName, lastName, name: `${firstName} ${lastName}`.trim(), email: safeEmail, passwordHash: hashPassword(password, salt), salt, createdAt: new Date().toISOString() };
  users.push(user);
  writeJson(USERS_FILE, users);
  return res.status(201).json({ token: issueSession(user.id), user: { id: user.id, name: user.name, email: user.email } });
});

app.post("/auth/login", (req, res) => {
  const { email, password } = req.body ?? {};
  const user = readJson(USERS_FILE, []).find((u) => u.email === String(email).toLowerCase().trim());
  if (!user || hashPassword(password, user.salt) !== user.passwordHash) return res.status(401).json({ error: { message: "Неверный логин или пароль" } });
  return res.json({ token: issueSession(user.id), user: { id: user.id, name: user.name, email: user.email } });
});

app.get("/user/study-data", authenticateUser, (req, res) => {
  res.json(readJson(studyFilePath(req.authUser.id), { exams: [], plans: [], recentMaterials: [] }));
});

app.put("/user/study-data", authenticateUser, (req, res) => {
  writeJson(studyFilePath(req.authUser.id), req.body ?? {});
  res.json({ ok: true });
});

app.post("/plan/generate", async (req, res) => {
  const { subject, examDate, topics } = req.body ?? {};
  if (!subject || !topics || !Array.isArray(topics)) return res.status(400).json({ error: { message: "Нет данных" } });

  try {
    const prompt = `Составь план подготовки к экзамену по предмету "${subject}" до даты "${examDate}".\n` +
      `Темы: ${topics.join(", ")}.\n` +
      `Верни ответ СТРОГО в формате JSON без каких-либо markdown-тегов (\`\`\`json), только чистый текст объекта.\n` +
      `Структура:\n` +
      `{"subject":"${subject}","examDate":"${examDate}","days":[{"day":1,"topic":"Название темы","minutes":90,"difficulty":"Средний уровень","whatIsTitle":"Что такое...","whatIs":"объяснение","basicRules":["правило 1","правило 2"],"applicationExamples":"пример","explanation":"объяснение","practiceTasks":[{"prompt":"задача","solution":"решение"}]}]}`;

    const content = await aiChatCompletion({ messages: [{ role: "user", content: prompt }], temperature: 0.3 });
    const parsed = tryParseJsonObjectFromText(content);
    if (!parsed) return res.status(502).json({ error: { message: "ИИ вернул невалидный формат. Попробуй еще раз." } });
    return res.json({ plan: parsed });
  } catch (e) {
    return res.status(500).json({ error: { message: e.message } });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body ?? {};
    const reply = await aiChatCompletion({ messages: [{ role: "system", content: "Ты помощник StudyMate AI." }, { role: "user", content: message }] });
    return res.json({ reply });
  } catch (e) { return res.status(500).json({ error: { message: e.message } }); }
});

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));ы