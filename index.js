import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

// Вычисляем пути и принудительно подтягиваем .env из текущей папки сервера
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const AI_PROVIDER = (process.env.AI_PROVIDER ?? "openrouter").trim().toLowerCase();
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY ?? "").trim();
// ИСПРАВЛЕНО: Заменили дефолтную модель OpenRouter на Gemini 2.5 Flash Free
const OPENROUTER_MODEL = (process.env.OPENROUTER_MODEL ?? "google/gemini-2.5-flash:free").trim();
const OPENROUTER_API_BASE = (process.env.OPENROUTER_API_BASE ?? "https://openrouter.ai/api/v1").trim();
const APP_URL = (process.env.APP_URL ?? "").trim();
const APP_NAME = (process.env.APP_NAME ?? "StudyMate AI").trim();
const NVIDIA_API_KEY = (process.env.NVIDIA_API_KEY ?? "").trim();
// ИСПРАВЛЕНО: На всякий случай заменили дефолтную модель NVIDIA на Gemini
const NVIDIA_MODEL = (process.env.NVIDIA_MODEL ?? "google/gemini-2.5-flash:free").trim();
const NVIDIA_API_BASE = (process.env.NVIDIA_API_BASE ?? "https://integrate.api.nvidia.com/v1").trim();

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
  sessions.push({
    token,
    userId,
    createdAt: new Date().toISOString(),
  });
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
  const lastName =
    user.lastName || String(user.name || "").split(" ").slice(1).join(" ").trim() || "";
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
  if (AI_PROVIDER === "nvidia") {
    return NVIDIA_API_KEY.length > 0;
  }
  return OPENROUTER_API_KEY.length > 0;
}

function aiProviderKeyHint() {
  if (AI_PROVIDER === "nvidia") return "NVIDIA_API_KEY";
  return "OPENROUTER_API_KEY";
}

async function openrouterChatCompletion({ messages, temperature = 0.6, responseFormat }) {
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
  if (responseFormat) {
    body.response_format = responseFormat;
  }

  const r = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (!r.ok) {
    const msg =
      data?.error?.message ??
      data?.message ??
      `OpenRouter error ${r.status}: ${text?.slice(0, 200) ?? ""}`;
    throw new Error(msg);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenRouter вернул пустой ответ");
  }
  return content.trim();
}

async function nvidiaChatCompletion({ messages, temperature = 0.6 }) {
  const r = await fetch(`${NVIDIA_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${NVIDIA_API_KEY}`,
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages,
      temperature,
    }),
  });

  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (!r.ok) {
    const msg =
      data?.error?.message ??
      data?.message ??
      `NVIDIA AI API error ${r.status}: ${text?.slice(0, 200) ?? ""}`;
    throw new Error(msg);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("NVIDIA AI API вернул пустой ответ");
  }
  return content.trim();
}

async function aiChatCompletion({ messages, temperature = 0.6, responseFormat }) {
  if (AI_PROVIDER === "nvidia") {
    return nvidiaChatCompletion({ messages, temperature });
  }
  return openrouterChatCompletion({ messages, temperature, responseFormat });
}

function tryParseJsonObjectFromText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

ensureDataFiles();

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/auth/register", (req, res) => {
  const { firstName, lastName, email, password } = req.body ?? {};
  const safeFirstName = typeof firstName === "string" ? firstName.trim() : "";
  const safeLastName = typeof lastName === "string" ? lastName.trim() : "";
  const safeEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const safePassword = typeof password === "string" ? password : "";

  if (safeFirstName.length < 2) {
    return res.status(400).json({ error: { message: "Имя должно быть не короче 2 символов" } });
  }
  if (safeLastName.length < 2) {
    return res.status(400).json({ error: { message: "Фамилия должна быть не короче 2 символов" } });
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
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      name: user.name,
      email: user.email,
    },
  });
});

app.post("/auth/login", (req, res) => {
  const { email, password } = req.body ?? {};
  const safeEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const safePassword = typeof password === "string" ? password : "";

  const users = readJson(USERS_FILE, []);
  const user = users.find((u) => u.email === safeEmail);
  if (!user) {
    return res.status(401).json({ error: { message: "Неверный email или пароль" } });
  }

  const incomingHash = hashPassword(safePassword, user.salt);
  if (incomingHash !== user.passwordHash) {
    return res.status(401).json({ error: { message: "Неверный email или пароль" } });
  }

  const token = issueSession(user.id);
  return res.json({
    token,
    user: getUserByToken(token),
  });
});

app.get("/auth/me", (req, res) => {
  const token = parseBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: { message: "Не авторизован" } });
  }
  const user = getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: { message: "Сессия недействительна" } });
  }
  return res.json({ user });
});

app.get("/user/study-data", authenticateUser, (req, res) => {
  const p = studyFilePath(req.authUser.id);
  if (!fs.existsSync(p)) {
    return res.json({ exams: [], plans: [], recentMaterials: [] });
  }
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

function buildPracticeTasks(topic, safeSubject) {
  const mathy = /матем|алгебр|геометр|физик|хим|логарифм|производн|интеграл|уравнен/i.test(
    `${safeSubject} ${topic}`,
  );
  const tasks = [];
  for (let i = 1; i <= 10; i++) {
    if (mathy) {
      tasks.push({
        prompt: `Задача ${i} (типовая по теме «${topic}»): сформулируй условие по образцу из задачника (найди аналог в учебнике) и реши самостоятельно.`,
        solution: `Решение: краткий ход — что дано, какая формула/метод, преобразования, ответ. Проверь ОДЗ и размерность. Задача ${i}: сверься с разбором в конце учебника.`,
      });
    } else {
      tasks.push({
        prompt: `Блок ${i} по «${topic}»: ключевой тезис или вопрос, который часто встречается на экзамене.`,
        solution: `Развёрнуто: определение, 2–3 аргумента, мини-пример или ситуация из практики. Свяжи с курсом «${safeSubject}».`,
      });
    }
  }
  return tasks;
}

function buildFallbackDay(topic, i, safeSubject) {
  const minutes = 60 + (i % 4) * 30;
  return {
    day: i + 1,
    topic,
    minutes,
    difficulty: i % 3 === 0 ? "Лёгкий уровень" : i % 3 === 1 ? "Средний уровень" : "Повышенный уровень",
    whatIsTitle: `Что такое «${topic}»?`,
    whatIs:
      `Тема «${topic}» важна в курсе «${safeSubject}». Сначала пойми идею: какую задачу решает это понятие и зачем оно нужно на экзамене. ` +
      `Добавь простую аналогию из жизни (скорость, рост, оптимизация времени) — так проще держать смысл в голове, а не только формулы. ` +
      `Затем сформулируй определение своими словами в 2–4 предложениях и сверь с учебником.`,
    basicRules: [
      `Сформулируй определение «${topic}» и условия, когда оно применимо.`,
      `Запиши 2–4 ключевых факта или формулы и отметь типичные ошибки.`,
      `Разбей изучение на шаги: понятия → пример → контрольный вопрос себе.`,
      `Реши минимум 2 задачи разного типа и сравни ход с эталоном.`,
    ],
    applicationExamples:
      `Подумай, где «${topic}» встречается в задачах по «${safeSubject}» и в смежных темах: рост и изменение величин, сравнение сценариев, анализ графиков. ` +
      `На экзамене обычно проверяют умение выбрать метод, а не только зазубрить формулировку.`,
    explanation: "",
    practiceTasks: buildPracticeTasks(topic, safeSubject),
  };
}

function normalizePlanDay(d, i, safeSubject, safeTopics) {
  const topic =
    typeof d?.topic === "string" && d.topic.trim()
      ? d.topic.trim()
      : safeTopics[i] || `Тема ${i + 1}`;
  const minutes = Number(d?.minutes) > 0 ? Number(d.minutes) : 45;
  const difficulty =
    typeof d?.difficulty === "string" && d.difficulty.trim()
      ? d.difficulty.trim()
      : "Средний уровень";
  let whatIsTitle = typeof d?.whatIsTitle === "string" ? d.whatIsTitle.trim() : "";
  if (!whatIsTitle) whatIsTitle = `Что такое «${topic}»?`;
  const whatIsRaw = typeof d?.whatIs === "string" ? d.whatIs.trim() : "";
  const explanationRaw = typeof d?.explanation === "string" ? d.explanation.trim() : "";
  const whatIs =
    whatIsRaw ||
    explanationRaw ||
    `Разверни тему «${topic}» простым языком: зачем она нужна, основная идея, одна жизненная аналогия.`;
  let basicRules = [];
  if (Array.isArray(d?.basicRules)) {
    basicRules = d.basicRules
      .filter((x) => typeof x === "string" && x.trim())
      .map((x) => x.trim());
  }
  if (basicRules.length === 0) {
    basicRules = [
      `Сформулируй определение «${topic}» своими словами.`,
      `Запиши ключевые формулы или факты и условия их применения.`,
      `Реши 2–3 типовых задания и разбери ошибки.`,
    ];
  }
  let applicationExamples =
    typeof d?.applicationExamples === "string" ? d.applicationExamples.trim() : "";
  if (!applicationExamples) {
    applicationExamples =
      `Где «${topic}» применяется в задачах по предмету «${safeSubject}»: свяжи абстрактное определение с 1–2 конкретными ситуациями из курса.`;
  }
  let practiceTasks = [];
  if (Array.isArray(d?.practiceTasks)) {
    for (const x of d.practiceTasks) {
      const prompt =
        typeof x?.prompt === "string"
          ? x.prompt.trim()
          : typeof x?.question === "string"
            ? x.question.trim()
            : "";
      const solution =
        typeof x?.solution === "string"
          ? x.solution.trim()
          : typeof x?.answer === "string"
            ? x.answer.trim()
            : "";
      if (prompt) {
        practiceTasks.push({
          prompt,
          solution: solution || "Сверься с учебником и разбором по теме.",
        });
      }
    }
  }
  if (practiceTasks.length === 0) {
    practiceTasks = buildPracticeTasks(topic, safeSubject);
  } else if (practiceTasks.length < 8) {
    const pad = buildPracticeTasks(topic, safeSubject);
    let j = 0;
    while (practiceTasks.length < 10 && j < pad.length) {
      practiceTasks.push(pad[j++]);
    }
  }
  return {
    day: Number(d?.day) > 0 ? Number(d.day) : i + 1,
    topic,
    minutes,
    difficulty,
    whatIsTitle,
    whatIs,
    basicRules,
    applicationExamples,
    explanation: explanationRaw || whatIs,
    practiceTasks,
  };
}

app.post("/plan/generate", async (req, res) => {
  const { subject, examDate, topics } = req.body ?? {};
  const safeSubject = typeof subject === "string" ? subject.trim() : "";
  const safeExamDate = typeof examDate === "string" ? examDate.trim() : "";
  const safeTopics = Array.isArray(topics)
    ? topics.map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean)
    : [];

  if (!safeSubject || !safeExamDate || safeTopics.length === 0) {
    return res.status(400).json({
      error: { message: "Нужно передать предмет, дату экзамена и список тем" },
    });
  }

  if (!hasAiProviderKey()) {
    const fallbackDays = safeTopics.map((topic, i) => buildFallbackDay(topic, i, safeSubject));
    return res.json({
      plan: {
        subject: safeSubject,
        examDate: safeExamDate,
        days: fallbackDays,
      },
    });
  }

  try {
    const jsonExample =
      `{"subject":"...","examDate":"...","days":[{"day":1,"topic":"...","minutes":120,"difficulty":"Средний уровень",` +
      `"whatIsTitle":"Что такое «...»?","whatIs":"текст","basicRules":["1","2","3","4"],"applicationExamples":"абзац",` +
      `"practiceTasks":[{"prompt":"условие задачи 1","solution":"полное решение 1"}, ... ещё 8-9 объектов]}]}`;

    const prompt =
      `Ты методист и репетитор. Составь план подготовки к экзамену на русском языке.\n\n` +
      `Предмет: ${safeSubject}\n` +
      `Дата экзамена: ${safeExamDate}\n` +
      `Темы (по порядку дней): ${safeTopics.join(", ")}\n\n` +
      `Для КАЖДОЙ темы дай развёрнутый учебный мини-урок:\n` +
      `- minutes: 60–240\n` +
      `- difficulty: «Лёгкий уровень», «Средний уровень» или «Повышенный уровень»\n` +
      `- whatIsTitle, whatIs (3–6 предложений + аналогия), basicRules (4 пункта), applicationExamples (абзац)\n` +
      `- practiceTasks: ровно 10 элементов. Если предмет математика/физика/химия или тема явно числовая — для каждого элемента поля prompt (условие) и solution (подробное решение). ` +
      `Иначе (гуманитарные дисциплины) prompt = короткий вопрос/тезис, solution = развёрнутый полезный ответ (как мини-конспект).\n\n` +
      `Верни ТОЛЬКО валидный JSON без markdown:\n` +
      jsonExample;

    const content = await aiChatCompletion({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      responseFormat: { type: "json_object" },
    });

    const parsedPlan = tryParseJsonObjectFromText(content);
    if (!parsedPlan || typeof parsedPlan !== "object") {
      return res.status(502).json({ error: { message: "Не удалось разобрать JSON плана" } });
    }

    const daysRaw = Array.isArray(parsedPlan?.days) ? parsedPlan.days : [];
    let days = daysRaw
      .map((d, i) => normalizePlanDay(d, i, safeSubject, safeTopics))
      .filter((d) => d.topic);
    if (days.length < safeTopics.length) {
      for (let i = days.length; i < safeTopics.length; i++) {
        days.push(buildFallbackDay(safeTopics[i], i, safeSubject));
      }
    }

    if (days.length === 0) {
      return res.status(502).json({ error: { message: "План получился пустым" } });
    }

    return res.json({
      plan: {
        subject: typeof parsedPlan.subject === "string" && parsedPlan.subject.trim()
          ? parsedPlan.subject.trim()
          : safeSubject,
        examDate:
          typeof parsedPlan.examDate === "string" && parsedPlan.examDate.trim()
            ? parsedPlan.examDate.trim()
            : safeExamDate,
        days,
      },
    });
  } catch (e) {
    return res.status(500).json({
      error: { message: e?.message ? String(e.message) : "Ошибка генерации плана" },
    });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const { message, history } = req.body ?? {};
    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        error: { message: "Missing 'message' string" },
      });
    }

    const safeHistory = Array.isArray(history) ? history : [];

    if (!hasAiProviderKey()) {
      return res.status(400).json({
        error: { message: `Missing ${aiProviderKeyHint()} in server environment` },
      });
    }

    const system =
      "Ты StudyMate AI — дружелюбный помощник студенту. Отвечай по-русски, коротко, ясно и по делу. " +
      "Если вопрос про математику — дай простое объяснение и мини-пример.";

    const messages = [
      { role: "system", content: system },
      ...safeHistory
        .filter(
          (m) =>
            m &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string"
        )
        .map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: message.trim() },
    ];

    const reply = await aiChatCompletion({ messages, temperature: 0.6 });
    return res.json({ reply });
  } catch (e) {
    return res.status(500).json({
      error: { message: e?.message ? String(e.message) : "Server error" },
    });
  }
});

app.listen(PORT, () => {
  console.log(`[studymate-ai-proxy] listening on http://localhost:${PORT}`);
});