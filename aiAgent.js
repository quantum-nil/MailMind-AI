const { GoogleGenAI } = require('@google/genai');

/**
 * Analyze an incoming email to understand the sender's request, urgency,
 * category, action items, and draft an appropriate reply.
 * Uses Gemini API when an API key is provided; falls back to built-in
 * heuristic NLP analysis otherwise.
 */
async function analyzeAndDraftReply(email, options = {}) {
  const { geminiApiKey, ownerName = 'Account Owner', tone = 'professional and helpful' } = options;

  if (geminiApiKey && geminiApiKey.trim()) {
    try {
      return await analyzeWithGemini(email, geminiApiKey.trim(), ownerName, tone);
    } catch (err) {
      console.warn('[AI Agent] Gemini API failed, falling back to built-in analyzer:', err.message);
    }
  }

  return analyzeLocally(email, ownerName, tone);
}

async function analyzeWithGemini(email, apiKey, ownerName, tone) {
  const ai = new GoogleGenAI({ apiKey });

  const prompt = `You are an intelligent personal Gmail assistant acting on behalf of ${ownerName}.
Read the following incoming email, understand what the sender is requesting, and draft a ${tone} reply.

From: ${email.fromName} <${email.fromEmail}>
Subject: ${email.subject}
Date: ${email.date}
Body:
"""
${(email.text || email.snippet || '').slice(0, 4000)}
"""

Respond ONLY with valid JSON matching this exact schema:
{
  "category": "Meeting Request" | "Support / Question" | "Billing / Invoice" | "Partnership / Sales" | "Urgent Action" | "Personal" | "Newsletter / Promotional",
  "urgency": "High" | "Medium" | "Low",
  "shouldAutoReply": boolean,
  "senderRequestSummary": "1-2 sentence clear summary of what the sender wants for the mail owner",
  "actionItemsForOwner": ["short action item 1", "short action item 2"],
  "replySubject": "Re: ...",
  "replyBody": "Full polite email reply addressed to the sender by name, signed as ${ownerName}'s AI Assistant (or ${ownerName})."
}`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.3,
    },
  });

  const parsed = JSON.parse(response.text);
  return {
    ...parsed,
    engine: 'Gemini AI (gemini-2.5-flash)',
    analyzedAt: new Date().toISOString(),
  };
}

function analyzeLocally(email, ownerName, tone) {
  const subject = (email.subject || '').toLowerCase();
  const body = (email.text || email.snippet || '').toLowerCase();
  const combined = `${subject}\n${body}`;
  const senderFirst = (email.fromName || email.fromEmail.split('@')[0] || 'there').split(' ')[0];

  let category = 'Support / Question';
  let urgency = 'Medium';
  let shouldAutoReply = true;
  let senderRequestSummary = `${email.fromName || email.fromEmail} sent a message regarding "${email.subject}".`;
  let actionItemsForOwner = ['Review the sender request and confirm if any follow-up is needed.'];
  let replyBody = '';

  const isNewsletter =
    /unsubscribe|newsletter|digest|no-reply|noreply|promotional|webinar/i.test(combined) ||
    /no-?reply@/i.test(email.fromEmail);

  if (isNewsletter) {
    category = 'Newsletter / Promotional';
    urgency = 'Low';
    shouldAutoReply = false;
    senderRequestSummary = `Automated or promotional email from ${email.fromName || email.fromEmail} ("${email.subject}"). No reply needed.`;
    actionItemsForOwner = ['No action required (automated/promotional message).'];
    replyBody = `Hi ${senderFirst},\n\nThank you for the update.\n\nBest regards,\n${ownerName}`;
  } else if (/meeting|schedule|calendar|call|zoom|google meet|availability|catch up|sync/i.test(combined)) {
    category = 'Meeting Request';
    urgency = /today|tomorrow|urgent|asap/i.test(combined) ? 'High' : 'Medium';
    senderRequestSummary = `${email.fromName || email.fromEmail} is requesting to schedule a meeting or call regarding "${email.subject}".`;
    actionItemsForOwner = [
      'Check your calendar availability for the proposed time.',
      'Confirm the meeting link or suggest an alternative slot if needed.',
    ];
    replyBody = `Hi ${senderFirst},\n\nThank you for reaching out! I have received your meeting request regarding "${email.subject}" and notified ${ownerName} so they can check their calendar.\n\nCould you please share 2–3 time slots that work best for you (along with your time zone) so we can lock it in promptly?\n\nBest regards,\nAI Email Assistant on behalf of ${ownerName}`;
  } else if (/invoice|payment|billing|receipt|refund|quote|pricing|contract/i.test(combined)) {
    category = 'Billing / Invoice';
    urgency = /overdue|urgent|failed|immediately/i.test(combined) ? 'High' : 'Medium';
    senderRequestSummary = `${email.fromName || email.fromEmail} sent a billing or invoice inquiry ("${email.subject}").`;
    actionItemsForOwner = [
      'Verify the invoice/payment details mentioned in the email.',
      'Approve or process the billing request.',
    ];
    replyBody = `Hi ${senderFirst},\n\nThank you for your message regarding "${email.subject}". I have logged your billing inquiry and alerted ${ownerName} for review.\n\nWe will verify the details and follow up with you shortly with a confirmation.\n\nBest regards,\nAI Email Assistant on behalf of ${ownerName}`;
  } else if (/urgent|asap|deadline|critical|broken|down|issue|error|help/i.test(combined)) {
    category = 'Urgent Action';
    urgency = 'High';
    senderRequestSummary = `Urgent request from ${email.fromName || email.fromEmail}: needs immediate attention on "${email.subject}".`;
    actionItemsForOwner = [
      'Prioritize this urgent request immediately.',
      'Follow up directly if additional context is required.',
    ];
    replyBody = `Hi ${senderFirst},\n\nThank you for flagging this. I understand this is time-sensitive and have immediately notified ${ownerName} with high priority.\n\nWe are looking into "${email.subject}" right away and will get back to you as soon as possible.\n\nBest regards,\nAI Email Assistant on behalf of ${ownerName}`;
  } else if (/partner|collaborat|proposal|opportunity|demo|interested in/i.test(combined)) {
    category = 'Partnership / Sales';
    urgency = 'Medium';
    senderRequestSummary = `${email.fromName || email.fromEmail} reached out with a partnership or business proposal ("${email.subject}").`;
    actionItemsForOwner = [
      'Review the proposal details and decide on next steps.',
    ];
    replyBody = `Hi ${senderFirst},\n\nThanks for getting in touch and sharing your proposal regarding "${email.subject}". I have summarized your message and shared it with ${ownerName}.\n\nWe will review the details and follow up with you soon.\n\nBest regards,\nAI Email Assistant on behalf of ${ownerName}`;
  } else {
    category = 'Support / Question';
    urgency = 'Low';
    senderRequestSummary = `${email.fromName || email.fromEmail} asked a question or shared an update about "${email.subject}".`;
    actionItemsForOwner = ['Review the AI-drafted response and confirm any specific details.'];
    replyBody = `Hi ${senderFirst},\n\nThank you for your email regarding "${email.subject}". I have received your message and notified ${ownerName}.\n\nWe will review your request and follow up with a detailed response shortly.\n\nBest regards,\nAI Email Assistant on behalf of ${ownerName}`;
  }

  return {
    category,
    urgency,
    shouldAutoReply,
    senderRequestSummary,
    actionItemsForOwner,
    replySubject: email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
    replyBody,
    engine: 'Built-in Smart AI',
    analyzedAt: new Date().toISOString(),
  };
}

module.exports = { analyzeAndDraftReply };
