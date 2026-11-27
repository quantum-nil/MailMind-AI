# MailMind AI — Personal Gmail Assistant

**MailMind AI** is a multi-user web application that connects to any Gmail account, automatically reads incoming emails with AI, understands what each sender is requesting, prepares or sends threaded replies, syncs drafts and read status back to Gmail, and notifies the mail owner in real time.

---

## Key Features

- **Multi-User Gmail Authentication:** Any user can connect their own Gmail account using their email address and a 16-character Google App Password (encrypted IMAP `imap.gmail.com:993` & SMTP `smtp.gmail.com:465`). Credentials stay in server-side session memory only and are never written to disk.
- **Interactive Demo Mode:** Test the entire AI triage, drafting, replying, and owner notification workflow immediately without entering real Gmail credentials.
- **AI Email Reading & Request Understanding:**
  - Classifies emails (`Meeting Request`, `Billing / Invoice`, `Urgent Action`, `Partnership / Sales`, `Support / Question`, `Personal`, `Newsletter / Promotional`).
  - Assigns priority (`High`, `Medium`, `Low`), summarizes what the sender is asking for, and extracts action items for the owner.
  - Supports **Gemini AI (`gemini-2.5-flash`)** when a Gemini API key is provided, and automatically falls back to a **Built-in Smart AI** analyzer when no key is supplied.
- **Automatic Background Monitoring:** While you are busy, the assistant automatically checks your `INBOX` on a configurable schedule (`30s`, `60s`, `2m`, or `5m`), analyzes new unread emails, and notifies you as soon as something arrives.
- **Two Operating Modes:**
  - **Draft & Notify Owner (Safe Mode, Default):** AI prepares a reply, saves it directly into your Gmail **Drafts** folder (`[Gmail]/Drafts`), and notifies you in the **Owner Notification Center** for 1-click approval or editing.
  - **Auto-Reply & Notify Owner:** AI automatically sends threaded replies (`In-Reply-To` / `References`) to non-promotional emails, marks them as **Read** in Gmail, and notifies you.
- **Owner Notifications (In-App + Email):** Every action is logged in the **Owner Notification Center** and optionally emailed as a summary directly to your Gmail address.

---

## Prerequisites

- **Node.js** `v18+` (tested on `v24.19.0`) and **npm**
- For **Live Gmail mode**:
  1. Enable **2-Step Verification** on your [Google Account Security](https://myaccount.google.com/security) page.
  2. Generate a **16-character App Password** at [Google App Passwords](https://myaccount.google.com/apppasswords).
- *(Optional)* A **Gemini API Key** from Google AI Studio if you want LLM-powered analysis instead of the built-in analyzer.

---

## Quick Start

1. **Clone or open the project folder:**
   ```bash
   cd gmail-ai-assistant
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **(Optional) Configure environment variables:**
   Create a `.env` file in the project root if you want to set defaults:
   ```env
   PORT=3000
   SESSION_SECRET=replace-with-a-random-secret
   GEMINI_API_KEY=optional-default-gemini-api-key
   ```

4. **Start the server:**
   ```bash
   npm start
   ```

5. **Open in your browser:**
   Navigate to `http://localhost:3000`.

---

## Deploy Live on Render (Free Tier)

This repository includes a [`render.yaml`](render.yaml) Blueprint and `/health` check endpoint for one-click deployment on [Render](https://render.com):

1. Push this folder to a GitHub repository (`node_modules` and `.env` are ignored via `.gitignore`).
2. Log in to [Render](https://dashboard.render.com) and click **New → Blueprint** (or **New → Web Service**).
3. Connect your GitHub repository — Render will automatically detect `render.yaml` (`buildCommand: npm install`, `startCommand: npm start`, `healthCheckPath: /health`).
4. *(Optional)* Add `GEMINI_API_KEY` in Render's Environment Variables if you want a default Gemini key for all users (`SESSION_SECRET` is auto-generated).
5. Click **Apply / Deploy** — within a couple of minutes Render will give you a live `https://mailmind-ai-xxxx.onrender.com` URL that anyone can use.

> **Note on Render Free Tier:** Free web services spin down after 15 minutes of inactivity. For 24/7 uninterrupted background inbox monitoring while you're away, upgrade to a paid Render instance (or keep a tab open).

---

## How to Use

1. **Connect Your Gmail (or Try Demo):**
   - Enter your **Gmail Address** and **16-character Google App Password**, choose your preferred **AI Reply Mode** (`Draft & Notify Owner` or `Auto-Reply & Notify Owner`), and click **Authenticate & Attach Gmail**.
   - Or click **Try Interactive Demo** to explore with sample emails.
2. **Leave It Running or Scan Manually:**
   - With **Auto-Monitor** enabled (on by default, every `60s`), MailMind AI automatically checks for new unread emails in the background.
   - You can also click **Run AI Assistant on Unread** at any time to triage immediately.
3. **Review Drafts & Notifications:**
   - Click any email to inspect the **What the Sender is Requesting** summary, **Action Items for Owner**, and the AI-drafted reply.
   - Edit the draft if needed and click **Send Reply & Notify Owner** (or open **Gmail Drafts** on your phone/browser—drafts are synced automatically in Live mode).
   - Open **Notifications** in the top bar or sidebar to view the full activity log.
4. **Customize Settings:**
   - Click **Settings** in the top bar to switch between Draft and Auto-Reply modes, adjust the background check interval (`30s` – `5m`), set your reply tone, toggle owner email notifications, or add/update your Gemini API key.

---

## Project Structure

```text
gmail-ai-assistant/
├── aiAgent.js          # Gemini AI (gemini-2.5-flash) & Built-in Smart AI email analyzer
├── mailService.js      # Gmail IMAP (read, mark read, save drafts) & SMTP (send replies, owner alerts)
├── server.js           # Express server, session isolation, background monitor & REST API
├── package.json
└── public/
    ├── index.html      # Auth view, mailbox workspace, notification center & settings dialog
    ├── styles.css      # Responsive UI styling
    └── app.js          # Frontend state, auto-refresh & API integration
```

---

## REST API Overview

| Method & Endpoint | Auth | Description |
| :--- | :---: | :--- |
| `GET /api/auth/status` | No | Returns session auth status, mode (`live`/`demo`), and settings |
| `POST /api/auth/connect` | No | Authenticates Live Gmail (IMAP/SMTP) or starts Demo Mode |
| `POST /api/auth/disconnect` | No | Clears server-side session & stops background monitor |
| `GET /api/emails` | Yes | Lists cached emails (`?refresh=1` fetches latest 20 from `INBOX`) |
| `POST /api/agent/analyze/:id` | Yes | Analyzes & drafts/auto-replies for a single email |
| `POST /api/agent/scan-all` | Yes | Batch-processes all unanalyzed unread emails |
| `POST /api/emails/:id/reply` | Yes | Sends threaded reply via SMTP, marks read in Gmail & notifies owner |
| `GET /api/notifications` | Yes | Returns owner notification feed |
| `POST /api/notifications/read` | Yes | Marks all notifications as read |
| `POST /api/settings` | Yes | Updates mode, auto-monitor interval, tone, email alerts & Gemini key |

---

## Security & Limitations

- **Session-Only Credentials:** Passwords and API keys are held strictly in server memory (`express-session`) for the active session and cleared on disconnect or server restart.
- **Google App Password Required:** Google blocks regular account passwords for IMAP/SMTP; 2-Step Verification + an App Password is required for Live Gmail mode.
- **In-Memory State:** Email caches, AI analyses, and notification history reset when the Node.js server restarts.
- **Inbox Window:** Fetches the 20 most recent messages in `INBOX`.
