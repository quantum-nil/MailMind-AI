const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { simpleParser } = require('mailparser');

function createImapClient(email, password) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: email,
      pass: password,
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    logger: false,
  });

  // Prevent unhandled 'error' events from crashing the server on socket timeout/reset
  client.on('error', (err) => {
    console.warn('[IMAP Error]', err.message || err.code || err);
  });

  return client;
}

function createSmtpTransport(email, password) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    auth: {
      user: email,
      pass: password,
    },
  });
}

/**
 * Verify Gmail IMAP + SMTP credentials for the connecting owner.
 */
async function verifyGmailCredentials(email, password) {
  const imap = createImapClient(email, password);
  try {
    await imap.connect();
    await imap.logout();
  } catch (err) {
    const msg = err.responseText || err.message || 'Authentication failed';
    if (/invalid credentials|application-specific password|username and password not accepted/i.test(msg)) {
      throw new Error(
        'Gmail rejected the credentials. Please make sure you are using a 16-character Google App Password (with 2-Step Verification enabled on your Google Account) rather than your regular Google login password.'
      );
    }
    throw new Error(`Could not connect to Gmail IMAP: ${msg}`);
  }

  const transporter = createSmtpTransport(email, password);
  await transporter.verify();
}

/**
 * Fetch the latest emails from the owner's Gmail INBOX.
 */
async function fetchGmailInbox(email, password, limit = 20) {
  const client = createImapClient(email, password);
  await client.connect();

  const emails = [];
  const lock = await client.getMailboxLock('INBOX');
  try {
    const total = client.mailbox.exists;
    if (total === 0) return [];

    const startSeq = Math.max(1, total - limit + 1);
    const range = `${startSeq}:${total}`;

    for await (const msg of client.fetch(range, {
      uid: true,
      flags: true,
      envelope: true,
      source: true,
    })) {
      const parsed = await simpleParser(msg.source);
      const fromObj = parsed.from?.value?.[0] || msg.envelope?.from?.[0] || {};
      const fromEmail = fromObj.address || 'unknown@sender.com';
      const fromName = fromObj.name || fromEmail.split('@')[0];
      const text = (parsed.text || '').trim();
      const snippet = text.replace(/\s+/g, ' ').slice(0, 140);

      emails.push({
        id: String(msg.uid),
        uid: msg.uid,
        messageId: parsed.messageId || msg.envelope?.messageId || '',
        subject: parsed.subject || '(No Subject)',
        fromName,
        fromEmail,
        to: email,
        date: (parsed.date || new Date()).toISOString(),
        unread: !msg.flags?.has('\\Seen'),
        snippet,
        text: text || '(No plain-text body)',
        html: parsed.html || null,
        replied: false,
        analysis: null,
      });
    }
  } finally {
    lock.release();
    await client.logout();
  }

  return emails.reverse();
}

/**
 * Send a reply to the sender via Gmail SMTP and optionally mark the original as seen.
 */
async function sendGmailReply(email, password, { to, subject, body, inReplyTo, ownerName }) {
  const transporter = createSmtpTransport(email, password);
  const mailOptions = {
    from: ownerName ? `"${ownerName}" <${email}>` : email,
    to,
    subject,
    text: body,
  };

  if (inReplyTo) {
    mailOptions.inReplyTo = inReplyTo;
    mailOptions.references = inReplyTo;
  }

  const info = await transporter.sendMail(mailOptions);
  return info.messageId;
}

/**
 * Notify the mail owner via email that their AI Assistant handled a message.
 */
async function sendOwnerNotificationEmail(email, password, { originalEmail, analysis, replyBody, actionTaken }) {
  const transporter = createSmtpTransport(email, password);
  const subject = `[MailMind AI Notification] ${actionTaken}: "${originalEmail.subject}"`;
  const text = [
    `Hello,`,
    ``,
    `Your Gmail AI Assistant just processed an incoming email on your behalf.`,
    ``,
    `--- SENDER DETAILS ---`,
    `From: ${originalEmail.fromName} <${originalEmail.fromEmail}>`,
    `Subject: ${originalEmail.subject}`,
    `Category: ${analysis.category} | Urgency: ${analysis.urgency}`,
    ``,
    `--- AI UNDERSTANDING OF SENDER'S REQUEST ---`,
    `${analysis.senderRequestSummary}`,
    ``,
    `--- ACTION ITEMS FOR YOU ---`,
    ...(analysis.actionItemsForOwner || []).map((item, i) => `${i + 1}. ${item}`),
    ``,
    `--- REPLY SENT / DRAFTED (${actionTaken}) ---`,
    replyBody,
    ``,
    `— MailMind AI Assistant`,
  ].join('\n');

  await transporter.sendMail({
    from: `"MailMind AI Assistant" <${email}>`,
    to: email,
    subject,
    text,
  });
}

function getDemoEmails(ownerEmail) {
  const now = Date.now();
  return [
    {
      id: 'demo-1',
      messageId: '<demo-1@example.com>',
      subject: 'Q4 Product Partnership & Integration Call',
      fromName: 'Elena Vance',
      fromEmail: 'elena.vance@horizonlabs.io',
      to: ownerEmail,
      date: new Date(now - 18 * 60 * 1000).toISOString(),
      unread: true,
      snippet: 'Hi! We loved your recent launch and would love to schedule a 20-minute call this Thursday to discuss...',
      text: `Hi there,\n\nWe loved your recent product launch and think there is a strong synergy with Horizon Labs.\n\nCould we schedule a 20-minute call this Thursday or Friday afternoon (EST) to explore an API partnership and co-marketing?\n\nBest,\nElena Vance\nHead of Partnerships, Horizon Labs`,
      replied: false,
      analysis: null,
    },
    {
      id: 'demo-2',
      messageId: '<demo-2@example.com>',
      subject: 'URGENT: Production API Webhook Timeout on Invoice #4821',
      fromName: 'Marcus Chen',
      fromEmail: 'm.chen@acmeretail.com',
      to: ownerEmail,
      date: new Date(now - 52 * 60 * 1000).toISOString(),
      unread: true,
      snippet: 'Our checkout webhook started timing out 30 minutes ago and Invoice #4821 has not been marked paid...',
      text: `Hello,\n\nOur checkout webhook started timing out about 30 minutes ago and Invoice #4821 ($2,450) has not been marked as paid in our dashboard.\n\nThis is blocking our end-of-day reconciliation. Can someone check this ASAP?\n\nThanks,\nMarcus Chen`,
      replied: false,
      analysis: null,
    },
    {
      id: 'demo-3',
      messageId: '<demo-3@example.com>',
      subject: 'Question about annual plan pricing for 15 seats',
      fromName: 'Priya Nair',
      fromEmail: 'priya@brightstudio.design',
      to: ownerEmail,
      date: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
      unread: true,
      snippet: 'Hi! Our design team of 15 people is evaluating your platform. Do you offer an annual discount...',
      text: `Hi,\n\nOur design team of 15 people is evaluating your platform for next quarter.\n\nDo you offer an annual discount for teams of 15+ seats, and can we pay via bank transfer / invoice?\n\nWarmly,\nPriya Nair`,
      replied: false,
      analysis: null,
    },
    {
      id: 'demo-4',
      messageId: '<demo-4@example.com>',
      subject: 'Weekly Cloud Infrastructure Digest',
      fromName: 'CloudWeekly',
      fromEmail: 'noreply@cloudweekly.dev',
      to: ownerEmail,
      date: new Date(now - 7 * 60 * 60 * 1000).toISOString(),
      unread: false,
      snippet: 'Top 10 serverless patterns in 2026. Click here to unsubscribe from this newsletter...',
      text: `Welcome to this week's Cloud Infrastructure Digest!\n\n1. Serverless edge routing\n2. Postgres connection pooling\n\nTo unsubscribe, click here.`,
      replied: false,
      analysis: null,
    },
  ];
}

/**
 * Save an AI-prepared draft directly into Gmail's [Gmail]/Drafts folder via IMAP APPEND.
 */
async function saveGmailDraft(email, password, { to, subject, body, inReplyTo, ownerName }) {
  const mailOptions = {
    from: ownerName ? `"${ownerName}" <${email}>` : email,
    to,
    subject,
    text: body,
  };
  if (inReplyTo) {
    mailOptions.inReplyTo = inReplyTo;
    mailOptions.references = inReplyTo;
  }

  const rawBuffer = await new MailComposer(mailOptions).compile().build();
  const client = createImapClient(email, password);
  await client.connect();
  try {
    // Find the Drafts special-use mailbox or fall back to '[Gmail]/Drafts'
    let draftsPath = '[Gmail]/Drafts';
    try {
      const mailboxes = await client.list();
      const found = mailboxes.find((m) => m.specialUse === '\\Drafts');
      if (found && found.path) draftsPath = found.path;
    } catch (_) {
      // ignore list errors and use default
    }
    await client.append(draftsPath, rawBuffer, ['\\Draft']);
    return true;
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Mark an email as Read (\Seen) in Gmail INBOX.
 */
async function markGmailAsRead(email, password, uid) {
  if (!uid) return;
  const client = createImapClient(email, password);
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    await client.messageFlagsAdd({ uid: Number(uid) }, ['\\Seen'], { uid: true });
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

module.exports = {
  verifyGmailCredentials,
  fetchGmailInbox,
  sendGmailReply,
  sendOwnerNotificationEmail,
  saveGmailDraft,
  markGmailAsRead,
  getDemoEmails,
};
