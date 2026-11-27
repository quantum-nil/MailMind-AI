require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');

const {
  verifyGmailCredentials,
  fetchGmailInbox,
  sendGmailReply,
  sendOwnerNotificationEmail,
  saveGmailDraft,
  markGmailAsRead,
  getDemoEmails,
} = require('./mailService');
const { analyzeAndDraftReply } = require('./aiAgent');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

app.get('/health', (req, res) => {
  res.json({ ok: true });
});
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store keyed by session ID so credentials stay server-side only
const userSessions = new Map();
const sessionTimers = new Map();

function stopBackgroundMonitor(sessionId) {
  const timer = sessionTimers.get(sessionId);
  if (timer) {
    clearInterval(timer);
    sessionTimers.delete(sessionId);
  }
}

async function runBackgroundSync(sessionId) {
  const state = userSessions.get(sessionId);
  if (!state || !state.settings.autoMonitor || state.isScanning) return;

  state.isScanning = true;
  try {
    if (state.mode === 'live') {
      const fresh = await fetchGmailInbox(state.email, state.password, 20);
      const prevById = new Map(state.emails.map((e) => [e.id, e]));
      state.emails = fresh.map((item) => {
        const prev = prevById.get(item.id);
        return prev
          ? {
              ...item,
              analysis: prev.analysis,
              replied: prev.replied,
              sentReply: prev.sentReply,
              gmailDraftSaved: prev.gmailDraftSaved,
            }
          : item;
      });
    }

    const targets = state.emails.filter((e) => !e.analysis && e.unread);
    for (const email of targets) {
      await processSingleEmail(state, email);
    }
    state.lastSyncAt = new Date().toISOString();
  } catch (err) {
    console.warn(`[Background Monitor] Session ${sessionId} sync warning:`, err.message);
  } finally {
    state.isScanning = false;
  }
}

function startBackgroundMonitor(sessionId) {
  stopBackgroundMonitor(sessionId);
  const state = userSessions.get(sessionId);
  if (!state || !state.settings.autoMonitor) return;

  const intervalMs = Math.max(15, Number(state.settings.pollIntervalSeconds) || 60) * 1000;
  const timer = setInterval(() => {
    runBackgroundSync(sessionId);
  }, intervalMs);
  sessionTimers.set(sessionId, timer);
}

function requireAuth(req, res, next) {
  const state = userSessions.get(req.sessionID);
  if (!req.session.authenticated || !state) {
    return res.status(401).json({ error: 'Not authenticated. Please connect your Gmail account first.' });
  }
  req.userState = state;
  next();
}

function addNotification(state, payload) {
  const notif = {
    id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    read: false,
    ...payload,
  };
  state.notifications.unshift(notif);
  return notif;
}

function serializeSettings(state) {
  return {
    autoReplyMode: state.settings.autoReplyMode,
    notifyOwnerByEmail: state.settings.notifyOwnerByEmail,
    autoMonitor: state.settings.autoMonitor,
    pollIntervalSeconds: state.settings.pollIntervalSeconds,
    tone: state.settings.tone,
    hasGeminiKey: Boolean(state.settings.geminiApiKey),
  };
}

// --- AUTH ROUTES ---

app.get('/api/auth/status', (req, res) => {
  const state = userSessions.get(req.sessionID);
  if (!req.session.authenticated || !state) {
    return res.json({ authenticated: false });
  }
  res.json({
    authenticated: true,
    mode: state.mode,
    email: state.email,
    ownerName: state.ownerName,
    lastSyncAt: state.lastSyncAt || null,
    isScanning: Boolean(state.isScanning),
    settings: serializeSettings(state),
  });
});

app.post('/api/auth/connect', async (req, res) => {
  try {
    const {
      email,
      password,
      ownerName,
      geminiApiKey,
      autoReplyMode = 'draft',
      notifyOwnerByEmail = true,
      autoMonitor = true,
      pollIntervalSeconds = 60,
      demo = false,
    } = req.body || {};

    if (demo) {
      const demoEmail = (email && email.trim()) || 'alex.morgan@gmail.com';
      const name = (ownerName && ownerName.trim()) || demoEmail.split('@')[0];
      const state = {
        mode: 'demo',
        email: demoEmail,
        password: '',
        ownerName: name,
        lastSyncAt: new Date().toISOString(),
        isScanning: false,
        settings: {
          autoReplyMode,
          notifyOwnerByEmail: false,
          autoMonitor: Boolean(autoMonitor),
          pollIntervalSeconds: Number(pollIntervalSeconds) || 60,
          tone: 'professional and helpful',
          geminiApiKey: geminiApiKey || process.env.GEMINI_API_KEY || '',
        },
        emails: getDemoEmails(demoEmail),
        notifications: [],
      };
      addNotification(state, {
        type: 'system',
        title: 'Demo Inbox Connected',
        message: `Connected ${demoEmail} in interactive Demo Mode. Auto-Monitor is ${state.settings.autoMonitor ? 'ON' : 'OFF'}.`,
        urgency: 'Low',
      });
      userSessions.set(req.sessionID, state);
      req.session.authenticated = true;
      startBackgroundMonitor(req.sessionID);
      return res.json({ ok: true, mode: 'demo', email: demoEmail, ownerName: name });
    }

    if (!email || !password) {
      return res.status(400).json({ error: 'Email address and App Password are required.' });
    }

    const cleanEmail = email.trim();
    const cleanPassword = password.replace(/\s+/g, '');

    await verifyGmailCredentials(cleanEmail, cleanPassword);

    const name = (ownerName && ownerName.trim()) || cleanEmail.split('@')[0];
    const emails = await fetchGmailInbox(cleanEmail, cleanPassword, 20);

    const state = {
      mode: 'live',
      email: cleanEmail,
      password: cleanPassword,
      ownerName: name,
      lastSyncAt: new Date().toISOString(),
      isScanning: false,
      settings: {
        autoReplyMode,
        notifyOwnerByEmail: Boolean(notifyOwnerByEmail),
        autoMonitor: Boolean(autoMonitor),
        pollIntervalSeconds: Number(pollIntervalSeconds) || 60,
        tone: 'professional and helpful',
        geminiApiKey: geminiApiKey || process.env.GEMINI_API_KEY || '',
      },
      emails,
      notifications: [],
    };

    addNotification(state, {
      type: 'system',
      title: 'Gmail Account Attached',
      message: `Authenticated ${cleanEmail} via IMAP & SMTP (${emails.length} recent emails). Background Auto-Monitor is ${state.settings.autoMonitor ? `ON (every ${state.settings.pollIntervalSeconds}s)` : 'OFF'}.`,
      urgency: 'Low',
    });

    userSessions.set(req.sessionID, state);
    req.session.authenticated = true;
    startBackgroundMonitor(req.sessionID);

    res.json({ ok: true, mode: 'live', email: cleanEmail, ownerName: name, count: emails.length });
  } catch (err) {
    res.status(401).json({ error: err.message || 'Failed to connect Gmail account.' });
  }
});

app.post('/api/auth/disconnect', (req, res) => {
  stopBackgroundMonitor(req.sessionID);
  userSessions.delete(req.sessionID);
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// --- EMAIL ROUTES ---

app.get('/api/emails', requireAuth, async (req, res) => {
  try {
    const state = req.userState;
    if (state.mode === 'live' && req.query.refresh === '1') {
      const fresh = await fetchGmailInbox(state.email, state.password, 20);
      // Preserve existing AI analysis/replied state by UID
      const prevById = new Map(state.emails.map((e) => [e.id, e]));
      state.emails = fresh.map((item) => {
        const prev = prevById.get(item.id);
        return prev
          ? {
              ...item,
              analysis: prev.analysis,
              replied: prev.replied,
              sentReply: prev.sentReply,
              gmailDraftSaved: prev.gmailDraftSaved,
            }
          : item;
      });
      state.lastSyncAt = new Date().toISOString();
    }
    res.json({ emails: state.emails, lastSyncAt: state.lastSyncAt });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch emails.' });
  }
});

// --- AI AGENT ROUTES ---

async function processSingleEmail(state, email) {
  const analysis = await analyzeAndDraftReply(email, {
    geminiApiKey: state.settings.geminiApiKey,
    ownerName: state.ownerName,
    tone: state.settings.tone,
  });
  email.analysis = analysis;

  const autoSend = state.settings.autoReplyMode === 'auto' && analysis.shouldAutoReply && !email.replied;

  if (autoSend) {
    if (state.mode === 'live') {
      await sendGmailReply(state.email, state.password, {
        to: email.fromEmail,
        subject: analysis.replySubject,
        body: analysis.replyBody,
        inReplyTo: email.messageId,
        ownerName: state.ownerName,
      });
      await markGmailAsRead(state.email, state.password, email.uid).catch((e) =>
        console.warn('[IMAP Mark Read Warning]', e.message)
      );
      if (state.settings.notifyOwnerByEmail) {
        await sendOwnerNotificationEmail(state.email, state.password, {
          originalEmail: email,
          analysis,
          replyBody: analysis.replyBody,
          actionTaken: 'Auto-Replied by AI',
        });
      }
    }
    email.replied = true;
    email.unread = false;
    email.sentReply = {
      subject: analysis.replySubject,
      body: analysis.replyBody,
      sentAt: new Date().toISOString(),
      autoSent: true,
    };

    addNotification(state, {
      type: 'auto-reply',
      emailId: email.id,
      title: `AI Auto-Replied to ${email.fromName}`,
      message: `${analysis.senderRequestSummary} Reply sent automatically${state.mode === 'live' && state.settings.notifyOwnerByEmail ? ' & owner notified via email' : ''}.`,
      category: analysis.category,
      urgency: analysis.urgency,
    });
  } else {
    let savedToGmailDrafts = false;
    if (state.mode === 'live' && analysis.shouldAutoReply && !email.gmailDraftSaved) {
      try {
        await saveGmailDraft(state.email, state.password, {
          to: email.fromEmail,
          subject: analysis.replySubject,
          body: analysis.replyBody,
          inReplyTo: email.messageId,
          ownerName: state.ownerName,
        });
        email.gmailDraftSaved = true;
        savedToGmailDrafts = true;
      } catch (e) {
        console.warn('[IMAP Save Draft Warning]', e.message);
      }
    }

    addNotification(state, {
      type: 'triaged',
      emailId: email.id,
      title: `AI Read & Drafted Reply for ${email.fromName}`,
      message: `${analysis.senderRequestSummary} (${analysis.category} · ${analysis.urgency} priority).${savedToGmailDrafts ? ' Saved to Gmail Drafts.' : ' Ready for your review.'}`,
      category: analysis.category,
      urgency: analysis.urgency,
    });
  }

  return email;
}

app.post('/api/agent/analyze/:id', requireAuth, async (req, res) => {
  try {
    const state = req.userState;
    const email = state.emails.find((e) => e.id === req.params.id);
    if (!email) return res.status(404).json({ error: 'Email not found.' });

    await processSingleEmail(state, email);
    res.json({ email, notifications: state.notifications });
  } catch (err) {
    res.status(500).json({ error: err.message || 'AI analysis failed.' });
  }
});

app.post('/api/agent/scan-all', requireAuth, async (req, res) => {
  try {
    const state = req.userState;
    const targets = state.emails.filter((e) => !e.analysis && (e.unread || req.body?.includeRead));
    let processed = 0;

    for (const email of targets) {
      await processSingleEmail(state, email);
      processed++;
    }

    res.json({
      processed,
      emails: state.emails,
      notifications: state.notifications,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Batch AI scan failed.' });
  }
});

app.post('/api/emails/:id/reply', requireAuth, async (req, res) => {
  try {
    const state = req.userState;
    const email = state.emails.find((e) => e.id === req.params.id);
    if (!email) return res.status(404).json({ error: 'Email not found.' });

    const { subject, body } = req.body || {};
    if (!body || !body.trim()) {
      return res.status(400).json({ error: 'Reply body cannot be empty.' });
    }

    const replySubject = subject || email.analysis?.replySubject || `Re: ${email.subject}`;

    if (state.mode === 'live') {
      await sendGmailReply(state.email, state.password, {
        to: email.fromEmail,
        subject: replySubject,
        body,
        inReplyTo: email.messageId,
        ownerName: state.ownerName,
      });

      await markGmailAsRead(state.email, state.password, email.uid).catch((e) =>
        console.warn('[IMAP Mark Read Warning]', e.message)
      );

      if (state.settings.notifyOwnerByEmail && email.analysis) {
        await sendOwnerNotificationEmail(state.email, state.password, {
          originalEmail: email,
          analysis: email.analysis,
          replyBody: body,
          actionTaken: 'Approved & Sent via AI Assistant',
        });
      }
    }

    email.replied = true;
    email.unread = false;
    email.sentReply = {
      subject: replySubject,
      body,
      sentAt: new Date().toISOString(),
      autoSent: false,
    };

    const notif = addNotification(state, {
      type: 'replied',
      emailId: email.id,
      title: `Reply Sent to ${email.fromName}`,
      message: `Sent reply to "${email.subject}"${state.mode === 'live' && state.settings.notifyOwnerByEmail ? ' and emailed you a confirmation summary' : ''}.`,
      category: email.analysis?.category || 'Reply',
      urgency: email.analysis?.urgency || 'Low',
    });

    res.json({ ok: true, email, notification: notif });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to send reply.' });
  }
});

// --- NOTIFICATIONS & SETTINGS ---

app.get('/api/notifications', requireAuth, (req, res) => {
  res.json({ notifications: req.userState.notifications });
});

app.post('/api/notifications/read', requireAuth, (req, res) => {
  req.userState.notifications.forEach((n) => {
    n.read = true;
  });
  res.json({ ok: true });
});

app.post('/api/settings', requireAuth, (req, res) => {
  const { autoReplyMode, notifyOwnerByEmail, autoMonitor, pollIntervalSeconds, tone, geminiApiKey } = req.body || {};
  const s = req.userState.settings;
  if (autoReplyMode === 'draft' || autoReplyMode === 'auto') s.autoReplyMode = autoReplyMode;
  if (typeof notifyOwnerByEmail === 'boolean') s.notifyOwnerByEmail = notifyOwnerByEmail;
  if (typeof autoMonitor === 'boolean') s.autoMonitor = autoMonitor;
  if (pollIntervalSeconds && Number(pollIntervalSeconds) >= 15) {
    s.pollIntervalSeconds = Number(pollIntervalSeconds);
  }
  if (typeof tone === 'string' && tone.trim()) s.tone = tone.trim();
  if (typeof geminiApiKey === 'string') s.geminiApiKey = geminiApiKey.trim();

  if (s.autoMonitor) {
    startBackgroundMonitor(req.sessionID);
  } else {
    stopBackgroundMonitor(req.sessionID);
  }

  res.json({
    ok: true,
    settings: serializeSettings(req.userState),
  });
});

app.listen(PORT, () => {
  console.log(`MailMind AI Gmail Assistant running at http://localhost:${PORT}`);
});
