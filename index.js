import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Безопасное подключение встроенного модуля crypto для старых Node.js
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const crypto = require("crypto");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY ?? "").trim();
const OPENROUTER_MODEL = "google/gemini-2.5-flash:free";
const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

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
  return {
    id: user.id,
    firstName: user.firstName || "",
    lastName: user.lastName || "",
    name: user.name || `${user.firstName} ${user.lastName}`.trim(),
    email: user.email,
  };
}

function parseBearerToken(req) {
  const auth = req.headers.authorization;
  if (!auth || typeof auth !== "string") return "";
  const [kind, token] = auth.split(" ");
  if (kind !== "Bearer" || !token) return "";
  return token.trim();
}

async function aiChatCompletion({ messages, temperature = 0.6 }) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
  };

  const r = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      temperature,
      max_tokens: 4000
    }),
  });

  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!r.ok) {
    throw new Error(data?.error?.message ?? `API error ${r.status}`);
  }
  return data?.choices?.[0]?.message?.content?.trim() || "";
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

// --- Регистрация ---
const registerHandler = (req, res) => {
  const { firstName, lastName, email, password } = req.body ?? {};
  const safeFirstName = typeof firstName === "string" ? firstName.trim() : "";
  const safeLastName = typeof lastName === "string" ? lastName.trim() : "";
  const safeEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const safePassword = typeof password === "string" ? password : "";

  if (safeFirstName.length < 2 || safeLastName.length < 2) {
    return res.status(400).json({ error: { message: "Имя и фамилия должны быть не короче 2 символов" } });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeEmail)) {
    return res.status(400).json({ error: { message: "Некорректный email" } });
  }
  if (safePassword.length < 6) {
    return res.status(400).json({ error: { message: "Пароль должен быть не короче 6 символов" } });
  }

  const users = readJson(USERS_FILE, []);
  if (users.some((u) => u.email === safeEmail)) {
    return res.status(409).json({ error: { message: "Пользователь с таким email уже существует" } });
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(safePassword, salt);
  const user = {
    id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"),
    firstName: safeFirstName,
    lastName: safeLastName,
    name: `${safeFirstName} ${safeLastName}`.trim(),
    email: safeEmail,
    passwordHash,
    salt,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeJson(USERS_FILE, users);

  const token = issueSession(user.id);
  return res.status(201).json({
    token,
    user: { id: user.id, firstName: user.firstName, lastName: user.lastName, name: user.name, email: user.email },
  });
};
app.post("/auth/register", registerHandler);
app.post("/api/auth/register", registerHandler);

// --- Вход ---
const loginHandler = (req, res) => {
  const { email, password } = req.body ?? {};
  const safeEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const safePassword = typeof password === "string" ? password : "";

  const users = readJson(USERS_FILE, []);
  const user = users.find((u) => u.email === safeEmail);
  if (!user) return res.status(401).json({ error: { message: "Неверный email или пароль" } });

  const incomingHash = hashPassword(safePassword, user.salt);
  if (incomingHash !== user.passwordHash) return res.status(401).json({ error: { message: "Неверный email или пароль" } });

  const token = issueSession(user.id);
  return res.json({ token, user: getUserByToken(token) });
};
app.post("/auth/login", loginHandler);
app.post("/api/auth/login", loginHandler);

// --- Генерация плана ---
const generatePlanHandler = async (req, res) => {
  const { subject, examDate, topics } = req.body ?? {};
  const safeSubject = typeof subject === "string" ? subject.trim() : "";
  const safeExamDate = typeof examDate === "string" ? examDate.trim() : "";
  const safeTopics = Array.isArray(topics) ? topics.filter(Boolean) : [];

  if (!safeSubject || !safeExamDate || safeTopics.length === 0) {
    return res.status(400).json({ error: { message: "Передайте все поля" } });
  }

  try {
    const prompt = `Ты репетитор. Составь JSON-план подготовки по предмету "${safeSubject}" до ${safeExamDate}. Темы: ${safeTopics.join(", ")}. 
    Верни JSON объект с полями subject, examDate и массивом days (в каждом дне: day, topic, minutes, difficulty, whatIsTitle, whatIs, basicRules[], applicationExamples, practiceTasks[{prompt, solution}] из 10 штук). Не используй markdown разметку.`;

    let content = await aiChatCompletion({ messages: [{ role: "user", content: prompt }], temperature: 0.3 });
    content = content.replace(/```json/g, "").replace(/```/g, "").trim();

    const parsedPlan = tryParseJsonObjectFromText(content);
    if (!parsedPlan) return res.status(502).json({ error: { message: "Ошибка разбора JSON" } });

    return res.json({ plan: parsedPlan });
  } catch (e) {
    return res.status(500).json({ error: { message: e.message } });
  }
};
app.post("/plan/generate", generatePlanHandler);
app.post("/api/plan/generate", generatePlanHandler);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));