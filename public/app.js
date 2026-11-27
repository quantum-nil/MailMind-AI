const state = {
  auth: null,
  emails: [],
  notifications: [],
  filter: 'all',
  selectedId: null,
};

const $ = (id) => document.getElementById(id);

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.hidden = true;
  }, 3500);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// --- AUTH & INIT ---

async function checkAuth() {
  const status = await api('/api/auth/status');
  if (status.authenticated) {
    state.auth = status;
    showDashboard();
    await loadDashboardData();
  } else {
    $('auth-view').hidden = false;
    $('app-view').hidden = true;
  }
}

function showDashboard() {
  $('auth-view').hidden = true;
  $('app-view').hidden = false;
  const { email, mode, settings } = state.auth;
  $('account-badge').textContent = `${email} (${mode === 'demo' ? 'Demo' : 'Live Gmail'})`;
  $('ai-engine-badge').textContent = settings.hasGeminiKey ? 'Gemini AI' : 'Built-in Smart AI';
  const mon = $('monitor-badge');
  if (settings.autoMonitor) {
    mon.textContent = `Auto-Monitor: ON (${settings.pollIntervalSeconds || 60}s)`;
    mon.className = 'pill pill-low';
  } else {
    mon.textContent = 'Auto-Monitor: Paused';
    mon.className = 'pill pill-neutral';
  }
  updateSidebarModeText();
  startUiAutoRefresh();
}

let uiRefreshTimer = null;
function startUiAutoRefresh() {
  if (uiRefreshTimer) clearInterval(uiRefreshTimer);
  uiRefreshTimer = setInterval(async () => {
    if (!state.auth) return;
    try {
      await loadDashboardData(false);
    } catch (_) {
      // ignore transient poll errors
    }
  }, 15000);
}

function updateSidebarModeText() {
  const s = state.auth.settings;
  $('sidebar-mode-text').textContent =
    s.autoReplyMode === 'auto'
      ? 'Auto-Reply is ON: AI reads, replies immediately, and notifies you.'
      : 'Draft & Approve is ON: AI reads, drafts replies, and notifies you for approval.';
}

async function loadDashboardData(refreshLive = false) {
  const [mailRes, notifRes] = await Promise.all([
    api(`/api/emails${refreshLive ? '?refresh=1' : ''}`),
    api('/api/notifications'),
  ]);
  state.emails = mailRes.emails || [];
  state.notifications = notifRes.notifications || [];
  renderAll();
}

// --- RENDERING ---

function getFilteredEmails() {
  switch (state.filter) {
    case 'unread':
      return state.emails.filter((e) => e.unread);
    case 'triaged':
      return state.emails.filter((e) => e.analysis && !e.replied);
    case 'replied':
      return state.emails.filter((e) => e.replied);
    default:
      return state.emails;
  }
}

function renderAll() {
  renderCounts();
  renderEmailList();
  renderDetail();
  renderNotifications();
}

function renderCounts() {
  $('count-all').textContent = state.emails.length;
  $('count-unread').textContent = state.emails.filter((e) => e.unread).length;
  $('count-triaged').textContent = state.emails.filter((e) => e.analysis && !e.replied).length;
  $('count-replied').textContent = state.emails.filter((e) => e.replied).length;
  $('count-notifs').textContent = state.notifications.length;

  const unreadNotifs = state.notifications.filter((n) => !n.read).length;
  const badge = $('notif-badge');
  badge.textContent = unreadNotifs;
  badge.hidden = unreadNotifs === 0;
}

function renderEmailList() {
  const isNotifs = state.filter === 'notifications';
  $('mail-workspace').hidden = isNotifs;
  $('notifications-workspace').hidden = !isNotifs;

  if (isNotifs) return;

  const titles = {
    all: 'All Inbox',
    unread: 'Unread Messages',
    triaged: 'AI Drafted (Pending Approval)',
    replied: 'AI Replied',
  };
  $('list-title').textContent = titles[state.filter] || 'Inbox';

  const list = getFilteredEmails();
  $('list-subtitle').textContent = `${list.length} email${list.length === 1 ? '' : 's'}`;

  const container = $('email-list');
  if (list.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding:32px;"><p class="muted">No emails in this view.</p></div>`;
    return;
  }

  container.innerHTML = list
    .map((email) => {
      const selected = email.id === state.selectedId ? 'selected' : '';
      const unread = email.unread ? 'unread' : '';
      const tags = [];
      if (email.replied) {
        tags.push(`<span class="pill pill-low">${email.sentReply?.autoSent ? 'Auto-Replied' : 'Replied'}</span>`);
      } else if (email.analysis) {
        tags.push(`<span class="pill pill-accent">${email.gmailDraftSaved ? 'Saved in Gmail Drafts' : 'Draft Ready'}</span>`);
      }
      if (email.analysis?.urgency) {
        const u = email.analysis.urgency.toLowerCase();
        tags.push(`<span class="pill pill-${u}">${escapeHtml(email.analysis.urgency)}</span>`);
      }

      return `
        <div class="email-row ${selected} ${unread}" data-id="${escapeHtml(email.id)}" role="listitem" tabindex="0">
          <div class="email-row-top">
            <span class="email-sender">${escapeHtml(email.fromName)}</span>
            <span class="email-time">${formatTime(email.date)}</span>
          </div>
          <div class="email-subject">${escapeHtml(email.subject)}</div>
          <div class="email-snippet">${escapeHtml(email.snippet)}</div>
          ${tags.length ? `<div class="email-tags">${tags.join('')}</div>` : ''}
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('.email-row').forEach((row) => {
    const select = () => {
      state.selectedId = row.dataset.id;
      renderEmailList();
      renderDetail();
    };
    row.addEventListener('click', select);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select();
      }
    });
  });
}

function renderDetail() {
  const email = state.emails.find((e) => e.id === state.selectedId);
  if (!email) {
    $('empty-detail').hidden = false;
    $('detail-content').hidden = true;
    return;
  }

  $('empty-detail').hidden = true;
  $('detail-content').hidden = false;
  $('detail-subject').textContent = email.subject;
  $('detail-meta').textContent = `From: ${email.fromName} <${email.fromEmail}> · ${formatTime(email.date)}`;
  $('detail-body').textContent = email.text;

  const aiPanel = $('ai-panel');
  if (!email.analysis) {
    aiPanel.hidden = true;
    $('analyze-one-btn').textContent = 'Analyze & Draft Reply with AI';
    return;
  }

  $('analyze-one-btn').textContent = 'Re-analyze with AI';
  aiPanel.hidden = false;

  const a = email.analysis;
  $('ai-category').textContent = a.category;
  const urg = $('ai-urgency');
  urg.textContent = `${a.urgency} Priority`;
  urg.className = `pill pill-${a.urgency.toLowerCase()}`;
  $('ai-engine-used').textContent = `Engine: ${a.engine}`;
  $('ai-summary').textContent = a.senderRequestSummary;
  $('ai-actions').innerHTML = (a.actionItemsForOwner || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('');

  $('reply-subject').value = email.sentReply?.subject || a.replySubject;
  $('reply-body').value = email.sentReply?.body || a.replyBody;

  const sentBanner = $('sent-banner');
  if (email.replied && email.sentReply) {
    sentBanner.hidden = false;
    sentBanner.textContent = `${email.sentReply.autoSent ? 'Auto-replied' : 'Reply sent'} on ${formatTime(email.sentReply.sentAt)} — Owner notified.`;
  } else {
    sentBanner.hidden = true;
  }
}

function renderNotifications() {
  const list = $('notifications-list');
  if (state.notifications.length === 0) {
    list.innerHTML = `<div class="empty-state"><p class="muted">No notifications yet. Run the AI assistant to see activity here.</p></div>`;
    return;
  }

  list.innerHTML = state.notifications
    .map(
      (n) => `
      <div class="notif-card ${n.read ? '' : 'unread'}">
        <div>
          <h4>${escapeHtml(n.title)}</h4>
          <p>${escapeHtml(n.message)}</p>
        </div>
        <div style="text-align:right; flex-shrink:0;">
          ${n.urgency ? `<span class="pill pill-${n.urgency.toLowerCase()}">${escapeHtml(n.urgency)}</span>` : ''}
          <div class="muted small-text" style="margin-top:6px;">${formatTime(n.timestamp)}</div>
        </div>
      </div>
    `
    )
    .join('');
}

// --- EVENT HANDLERS ---

$('connect-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('connect-btn');
  const errBox = $('auth-error');
  errBox.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Verifying Gmail Credentials...';

  try {
    const fd = new FormData(e.target);
    await api('/api/auth/connect', {
      method: 'POST',
      body: JSON.stringify({
        email: fd.get('email'),
        password: fd.get('password'),
        ownerName: fd.get('ownerName'),
        autoReplyMode: fd.get('autoReplyMode'),
        geminiApiKey: fd.get('geminiApiKey'),
        notifyOwnerByEmail: $('notify-email-checkbox').checked,
        autoMonitor: $('auto-monitor-checkbox').checked,
      }),
    });
    await checkAuth();
    showToast('Gmail account attached successfully!');
  } catch (err) {
    errBox.textContent = err.message;
    errBox.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Authenticate & Attach Gmail';
  }
});

$('demo-btn').addEventListener('click', async () => {
  const btn = $('demo-btn');
  btn.disabled = true;
  try {
    await api('/api/auth/connect', {
      method: 'POST',
      body: JSON.stringify({
        demo: true,
        email: $('email-input').value.trim() || 'alex.morgan@gmail.com',
        ownerName: $('owner-name-input').value.trim() || 'Alex Morgan',
        autoReplyMode: $('mode-select').value,
        geminiApiKey: $('gemini-key-input').value.trim(),
      }),
    });
    await checkAuth();
    showToast('Demo Inbox loaded!');
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
  }
});

$('disconnect-btn').addEventListener('click', async () => {
  if (uiRefreshTimer) {
    clearInterval(uiRefreshTimer);
    uiRefreshTimer = null;
  }
  await api('/api/auth/disconnect', { method: 'POST' });
  state.auth = null;
  state.emails = [];
  state.notifications = [];
  state.selectedId = null;
  $('app-view').hidden = true;
  $('auth-view').hidden = false;
  showToast('Disconnected Gmail account.');
});

$('refresh-btn').addEventListener('click', async () => {
  const btn = $('refresh-btn');
  btn.disabled = true;
  try {
    await loadDashboardData(true);
    showToast('Inbox refreshed.');
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
  }
});

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    renderEmailList();
  });
});

$('notif-toggle-btn').addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.filter === 'notifications');
  });
  state.filter = 'notifications';
  renderEmailList();
});

$('mark-notifs-read-btn').addEventListener('click', async () => {
  await api('/api/notifications/read', { method: 'POST' });
  state.notifications.forEach((n) => (n.read = true));
  renderCounts();
  renderNotifications();
});

async function analyzeSelected() {
  if (!state.selectedId) return;
  const btn = $('analyze-one-btn');
  btn.disabled = true;
  btn.textContent = 'AI Reading Email...';
  try {
    const res = await api(`/api/agent/analyze/${encodeURIComponent(state.selectedId)}`, { method: 'POST' });
    const idx = state.emails.findIndex((e) => e.id === res.email.id);
    if (idx !== -1) state.emails[idx] = res.email;
    state.notifications = res.notifications;
    renderAll();
    showToast('AI analyzed email & updated owner notifications.');
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
  }
}

$('analyze-one-btn').addEventListener('click', analyzeSelected);
$('regenerate-btn').addEventListener('click', analyzeSelected);

$('scan-all-btn').addEventListener('click', async () => {
  const btn = $('scan-all-btn');
  btn.disabled = true;
  btn.textContent = 'AI Scanning Unread...';
  try {
    const res = await api('/api/agent/scan-all', { method: 'POST', body: JSON.stringify({ includeRead: false }) });
    state.emails = res.emails;
    state.notifications = res.notifications;
    if (!state.selectedId && state.emails.length > 0) {
      state.selectedId = state.emails[0].id;
    }
    renderAll();
    showToast(`AI processed ${res.processed} unread email(s) and notified owner.`);
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run AI Assistant on Unread';
  }
});

$('reply-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.selectedId) return;
  const btn = $('send-reply-btn');
  btn.disabled = true;
  btn.textContent = 'Sending Reply...';
  try {
    const res = await api(`/api/emails/${encodeURIComponent(state.selectedId)}/reply`, {
      method: 'POST',
      body: JSON.stringify({
        subject: $('reply-subject').value,
        body: $('reply-body').value,
      }),
    });
    const idx = state.emails.findIndex((e) => e.id === res.email.id);
    if (idx !== -1) state.emails[idx] = res.email;
    if (res.notification) state.notifications.unshift(res.notification);
    renderAll();
    showToast('Reply sent and owner notified!');
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Reply & Notify Owner';
  }
});

$('open-settings-btn').addEventListener('click', () => {
  if (!state.auth) return;
  const s = state.auth.settings;
  $('settings-mode').value = s.autoReplyMode;
  $('settings-tone').value = s.tone;
  $('settings-notify-email').checked = s.notifyOwnerByEmail;
  $('settings-auto-monitor').checked = Boolean(s.autoMonitor);
  $('settings-interval').value = String(s.pollIntervalSeconds || 60);
  $('settings-gemini').value = '';
});

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    autoReplyMode: $('settings-mode').value,
    tone: $('settings-tone').value,
    notifyOwnerByEmail: $('settings-notify-email').checked,
    autoMonitor: $('settings-auto-monitor').checked,
    pollIntervalSeconds: Number($('settings-interval').value),
  };
  const newKey = $('settings-gemini').value.trim();
  if (newKey) payload.geminiApiKey = newKey;

  const res = await api('/api/settings', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  state.auth.settings = res.settings;
  showDashboard();
  $('settings-dialog').close();
  showToast('Settings saved.');
});

checkAuth();
