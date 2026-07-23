# Jarvis Pro — Web Voice Assistant

A full-featured browser voice assistant built for laptop use. Talk to Claude
using your mic, get smart spoken replies, manage multiple conversations, and
customize everything.

## Features
- Real-time audio waveform visualizer while listening
- Conversation sessions — save, rename, switch, delete
- Persistent memory across page reloads (saved in browser)
- Export any conversation as a .txt file
- Offline quick commands — time, date, maths (no API needed)
- Suggestion chips on empty screen to get started fast
- Settings panel: voice speed, pitch, language, accent, which voice
- Dark/light mode toggle (persists)
- Space bar shortcut to start/stop listening
- Copy any message or replay any Jarvis reply with one click
- Paste your own Anthropic API key in Settings (overrides the server key)

## Deploy to Vercel

### Option A: Via GitHub (recommended)
1. Create a new GitHub repo, upload all files
2. On vercel.com → Add New Project → Import that repo
3. Add Environment Variable: `ANTHROPIC_API_KEY` = your key from console.anthropic.com
4. Deploy → done, get a live URL

### Option B: Via Vercel CLI (no GitHub needed)
```
npm install -g vercel
cd jarvis-pro
vercel
# follow the prompts, paste your API key when asked for env vars
```

## Run locally
```
npm install
cp .env.local.example .env.local
# edit .env.local — paste your real Anthropic API key
npm run dev
# open http://localhost:3000
```

## Browser support
Works in **Chrome and Edge** (desktop). Voice input uses the Web Speech API
which Firefox and Safari do not support. The page shows a clear error if you
open it in an unsupported browser instead of silently breaking.

## Project structure
```
app/
  page.tsx          — full UI: sessions, waveform, mic, log, settings panel
  page.module.css   — all styles including animations
  layout.tsx        — root layout with fonts
  globals.css       — design tokens (dark/light), base resets
  api/chat/
    route.ts        — server-side Claude API call (keeps key secret)
```

## Customizing
- **Personality**: edit `SYSTEM_PROMPT` in `app/api/chat/route.ts`
- **Offline commands**: add cases to `tryOffline()` in `app/page.tsx`
- **Accent/language**: change default in `DEFAULT_SETTINGS.lang`
- **More voices**: the Settings panel lists voices available in your browser —
  the list varies by OS (Windows has many built-in, macOS has Siri voices)
