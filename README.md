# NEXUS — personal finance & shifts

NEXUS is a multi-user finance and work-shift tracker with a dark responsive UI, goals, reminders and an AI assistant. Currency is UAH by default.

## Stack
- React + Vite + TypeScript + Tailwind
- Capacitor Android wrapper
- Node.js + Express + PostgreSQL
- JWT + bcrypt authentication
- OpenAI Chat Completions tool calling

## Run locally
1. Install Node.js 20+ and PostgreSQL.
2. Copy `server/.env.example` to `server/.env` and set `DATABASE_URL` and `JWT_SECRET`.
3. From the repository root:
   ```bash
   npm install
   npm run dev
   ```
4. Open the Vite URL shown in the terminal. API runs on port 4000.

The server creates its tables on startup. Never commit `.env` or API keys.

## Deploy on Render
1. Upload this project to a GitHub repository.
2. In Render choose **New → Blueprint**, connect the repository and deploy `render.yaml`.
3. In the Render service environment, add `OPENAI_API_KEY` (optional; the rest of the app works without it).
4. Wait for deployment. The service serves the built web app and API from one URL.

The Render free database/service may sleep and free database retention/availability can change. For important financial records, use a paid persistent database and make regular backups.

## Android APK (build from phone)
The included GitHub Actions workflow builds a debug APK when you push to `main`.
1. After first deployment, copy your Render URL (for example `https://nexus-app.onrender.com`).
2. In GitHub → Settings → Secrets and variables → Actions, create repository variable `VITE_API_URL` with that URL. (The app uses the same URL for its API.)
3. Push to `main` or run the workflow manually.
4. Open the Actions run → Artifacts → download `nexus-debug-apk`. Install the APK on Android (allow installs from your browser/files app).

For a release APK suitable for public distribution, configure Android signing credentials; the included workflow intentionally produces a debug APK.

## Capacitor
The project includes `capacitor.config.ts`. GitHub Actions generates the Android project and builds the APK. If developing locally:
```bash
npm run build -w client
npx cap add android
npx cap sync android
```

## AI assistant
Set `OPENAI_API_KEY` on Render. The key stays on the server. The assistant can read the signed-in user's financial summary and, after tool calls, add transactions or mark shifts. It cannot access another user's data.

## Current MVP scope
- Multi-user email/password registration and login
- Income and expense records
- Shift calendar and per-shift / hourly / monthly / mixed pay entries
- Goals and reminders
- Summary analytics
- AI assistant with guarded user-scoped actions
- Export user data as JSON backup

Before using this for important records, test the workflows and set up a reliable database backup policy.
