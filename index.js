import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

// Настройки путей
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const AI_PROVIDER = (process.env.AI_PROVIDER ?? "openrouter").trim().toLowerCase();
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY ?? "").trim();

const OPENROUTER_MODEL = "google/gemini-2.5-flash:free";
const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

const APP_URL = (process.env.APP_URL ?? "").trim();
const APP_NAME = (process.env.APP_NAME ?? "StudyMate AI").trim();

const NVIDIA_API_KEY = (process.env.NVIDIA_API_KEY ?? "").trim();
const NVIDIA_MODEL = "google/gemini-2.5-flash:free";
const NVIDIA_API_BASE = "https://integrate.api.nvidia.com/v1";

// Локальная БД на сервере (в Render папка /tmp или текущая директория)
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
  if (!user) {
    return res.status(401).json({ error: { message: "Не авторизован" } });
  }
  req.authUser = user;
  next();
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
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
  const firstName = user.firstName || String(user.name || "").split(" ")[0] || "";
  const lastName = user.lastName || String(user.name || "").split(" ").slice(1).join(" ").trim() || "";
  return {
    id: user.id,
    firstName,
    lastName,
    name: `${firstName}${lastName ? ` ${lastName}` : ""}`.trim() || user.name || "",
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

function hasAiProviderKey() {
  if (AI_PROVIDER === "nvidia") return NVIDIA_API_KEY.length > 0;
  return OPENROUTER_API_KEY.length > 0;
}

function aiProviderKeyHint() {
  if (AI_PROVIDER === "nvidia") return "NVIDIA_API_KEY";
  return "OPENROUTER_API_KEY";
}

async function aiChatCompletion({ messages, temperature = 0.6, responseFormat }) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    "HTTP-Referer": APP_URL || "http://localhost:8787",
    "X-Title": APP_NAME || "StudyMate AI",
  };

  const body = {
    model: OPENROUTER_MODEL,
    messages,
    temperature,
    max_tokens: 4000
  };
  if (responseFormat) body.response_format = responseFormat;

  const r = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!r.ok) {
    const msg = data?.error?.message ?? data?.message ?? `API error ${r.status}`;
    throw new Error(msg);
  }

  return data?.choices?.[0]?.message?.content?.trim() || "";
}

function tryParseJsonObjectFromText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }
}

ensureDataFiles();

app.get("/health", (_req, res) => res.json({ ok: true }));

// --- Роуты Авторизации ---
app.post("/auth/register", (req, res) => {
  const { firstName, lastName, email, password } = req.body ?? {};
  const safeFirstName = typeof firstName === "string" ? firstName.trim() : "";
  const safeLastName = typeof lastName === "string" ? lastName.trim() : "";
  const safeEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const safePassword = typeof password === "string" ? password : "";

  if (safeFirstName.length < 2) return res.status(400).json({ error: { message: "Имя должно быть не короче 2 символов" } });
  if (safeLastName.length < 2) return res.status(400).json({ error: { message: "Фамилия должна быть не короче 2 символов" } });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeEmail)) return res.status(400).json({ error: { message: "Некорректный email" } });
  if (safePassword.length < 6) return res.status(400).json({ error: { message: "Пароль должен быть не короче 6 символов" } });

  const users = readJson(USERS_FILE, []);
  if (users.some((u) => u.email === safeEmail)) {
    return res.status(409).json({ error: { message: "Пользователь с таким email уже существует" } });
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(safePassword, salt);
  const user = {
    id: crypto.randomUUID(),
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
});

app.post("/auth/login", (req, res) => {
  const { email, password } = req.body ?? {};
  const safeEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const safePassword = typeof password === "string" ? password : "";

  const users = readJson(USERS_FILE, []);
  const user = users.find((u) => u.email === safeEmail);
  if (!user) return res.status(401).json({ error: { message: "Неверный email или пароль" } });

  const incomingHash = hashPassword(safePassword, user.salt);
  if (incomingHash !== user.passwordHash) {
    return res.status(401).json({ error: { message: "Неверный email или пароль" } });
  }

  const token = issueSession(user.id);
  return res.json({ token, user: getUserByToken(token) });
});

app.get("/auth/me", (req, res) => {
  const token = parseBearerToken(req);
  if (!token) return res.status(401).json({ error: { message: "Не авторизован" } });
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ error: { message: "Сессия недействительна" } });
  return res.json({ user });
});

// --- Работа с учебными данными ---
app.get("/user/study-data", authenticateUser, (req, res) => {
  const p = studyFilePath(req.authUser.id);
  if (!fs.existsSync(p)) return res.json({ exams: [], plans: [], recentMaterials: [] });
  const data = readJson(p, { exams: [], plans: [], recentMaterials: [] });
  return res.json({
    exams: Array.isArray(data.exams) ? data.exams : [],
    plans: Array.isArray(data.plans) ? data.plans : [],
    recentMaterials: Array.isArray(data.recentMaterials) ? data.recentMaterials : [],
  });
});

app.put("/user/study-data", authenticateUser, (req, res) => {
  const body = req.body ?? {};
  const payload = {
    exams: Array.isArray(body.exams) ? body.exams : [],
    plans: Array.isArray(body.plans) ? body.plans : [],
    recentMaterials: Array.isArray(body.recentMaterials) ? body.recentMaterials : [],
  };
  writeJson(studyFilePath(req.authUser.id), payload);
  return res.json({ ok: true });
});

// Вспомогательные функции генерации планов
function buildPracticeTasks(topic, safeSubject) {
  const tasks = [];
  for (let i = 1; i <= 10; i++) {
    tasks.push({
      prompt: `Блок ${i} по «${topic}»: ключевой тезис или вопрос по предмету ${safeSubject}.`,
      solution: `Развёрнутый ответ и решение для закрепления темы. Сверься с учебными материалами.`,
    });
  }
  return tasks;
}

function buildFallbackDay(topic, i, safeSubject) {
  return {
    day: i + 1,
    topic,
    minutes: 90,
    difficulty: "Средний уровень",
    whatIsTitle: `Что такое «${topic}»?`,
    whatIs: `Тема «${topic}» важна в курсе «${safeSubject}». Разбери базовые понятия, сформулируй определение своими словами и разбери примеры.`,
    basicRules: [`Изучи теорию по теме ${topic}`, `Выпиши формулы или тезисы`, `Реши практические упражнения`],
    applicationExamples: `Эта тема напрямую используется при решении экзаменационных заданий по курсу ${safeSubject}.`,
    explanation: "",
    practiceTasks: buildPracticeTasks(topic, safeSubject),
  };
}

function normalizePlanDay(d, i, safeSubject, safeTopics) {
  const topic = typeof d?.topic === "string" && d.topic.trim() ? d.topic.trim() : safeTopics[i] || `Тема ${i + 1}`;
  const minutes = Number(d?.minutes) > 0 ? Number(d.minutes) : 60;
  const difficulty = typeof d?.difficulty === "string" ? d.difficulty.trim() : "Средний уровень";
  const whatIs = typeof d?.whatIs === "string" ? d.whatIs.trim() : (typeof d?.explanation === "string" ? d.explanation.trim() : "Изучите материал темы.");
  
  let practiceTasks = [];
  if (Array.isArray(d?.practiceTasks)) {
    for (const x of d.practiceTasks) {
      const prompt = x?.prompt || x?.question || "";
      const solution = x?.solution || x?.answer || "";
      if (prompt) practiceTasks.push({ prompt, solution });
    }
  }
  if (practiceTasks.length < 10) {
    const pad = buildPracticeTasks(topic, safeSubject);
    while (practiceTasks.length < 10) practiceTasks.push(pad[practiceTasks.length % pad.length]);
  }

  return {
    day: Number(d?.day) > 0 ? Number(d.day) : i + 1,
    topic,
    minutes,
    difficulty,
    whatIsTitle: d?.whatIsTitle || `Что такое «${topic}»?`,
    whatIs,
    basicRules: Array.isArray(d?.basicRules) ? d.basicRules : [`Изучить основы темы ${topic}`],
    applicationExamples: d?.applicationExamples || `Применение темы ${topic} на практике.`,
    explanation: whatIs,
    practiceTasks,
  };
}

// --- Исправленный безопасный роут генерации планов ---
app.post("/plan/generate", async (req, res) => {
  const { subject, examDate, topics } = req.body ?? {};
  const safeSubject = typeof subject === "string" ? subject.trim() : "";
  const safeExamDate = typeof examDate === "string" ? examDate.trim() : "";
  const safeTopics = Array.isArray(topics) ? topics.filter(Boolean) : [];

  if (!safeSubject || !safeExamDate || safeTopics.length === 0) {
    return res.status(400).json({ error: { message: "Передайте предмет, дату и список тем" } });
  }

  try {
    const jsonExample = `{"subject":"...","examDate":"...","days":[{"day":1,"topic":"...","minutes":120,"difficulty":"Средний уровень","whatIsTitle":"Что такое...","whatIs":"...","basicRules":["1","2"],"applicationExamples":"...","practiceTasks":[{"prompt":"...","solution":"..."}]}]}`;
    const prompt = `Ты репетитор. Составь JSON-план подготовки по предмету "${safeSubject}" до ${safeExamDate}. Темы: ${safeTopics.join(", ")}. Для каждой темы создай день подготовки. В каждом дне practiceTasks должен содержать строго 10 элементов с подробными prompt и solution. Ответь ТОЛЬКО валидным JSON по шаблону: ${jsonExample}`;

    const content = await aiChatCompletion({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      responseFormat: { type: "json_object" },
    });

    const parsedPlan = tryParseJsonObjectFromText(content);
    if (!parsedPlan) return res.status(502).json({ error: { message: "Ошибка парсинга ответа ИИ" } });

    const daysRaw = Array.isArray(parsedPlan?.days) ? parsedPlan.days : [];
    const days = daysRaw.map((d, i) => normalizePlanDay(d, i, safeSubject, safeTopics));

    return res.json({
      plan: { subject: safeSubject, examDate: safeExamDate, days }
    });
  } catch (e) {
    return res.status(500).json({ error: { message: e.message || "Ошибка генерации плана" } });
  }
});

app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));