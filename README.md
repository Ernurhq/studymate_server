# StudyMate AI proxy (OpenRouter / NVIDIA)

This folder runs a local proxy to avoid browser CORS and to keep API keys out of the Flutter web app.

## Run

```bat
cd "c:\Users\Сабит\Desktop\Ernur Project\studymate_ai\server"
set AI_PROVIDER=openrouter
set OPENROUTER_API_KEY=YOUR_KEY_HERE
set OPENROUTER_MODEL=nvidia/llama-3.1-nemotron-70b-instruct
npm start
```

## Run with .env (recommended)

1) Copy `.env.example` to `.env`
2) Fill API key for your provider (`OPENROUTER_API_KEY` by default)
3) Start server:

```bat
cd "c:\Users\Сабит\Desktop\Ernur Project\studymate_ai\server"
npm install
npm start
```

Then the proxy is available at `http://localhost:8787/chat`.

## Optional provider settings

```bat
set AI_PROVIDER=openrouter
set OPENROUTER_API_BASE=https://openrouter.ai/api/v1

:: or direct NVIDIA
set AI_PROVIDER=nvidia
set NVIDIA_API_BASE=https://integrate.api.nvidia.com/v1
```

