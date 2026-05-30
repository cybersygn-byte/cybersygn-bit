/**
 * CyberSygn dashboard, prototype.
 *
 * Fetches the sender's list of documents from the Worker and renders
 * one row per doc. Each row expands to reveal per-signer status, the
 * magic links (when the sender has the per-doc senderToken cached
 * locally), reminder actions, and download links once the doc is
 * complete.
 *
 * No build-time route guard: an empty senderId list is a legitimate
 * empty state, so the page always renders.
 */

import {
  fetchSenderDocs,
  fetchProgress,
  remindSigner,
  createWorkspace,
  fetchWorkspaceDocs,
  fetchWorkspaceMembers,
  createInvite,
} from '../preview/api.js';
import {
  getSenderId,
  setSenderId,
  getDocToken,
  listWorkspaces,
  saveWorkspace,
  removeWorkspace,
  getActiveWorkspaceId,
  setActiveWorkspaceId,
  getActiveWorkspace,
} from '../preview/identity.js';

const $ = id => document.getElementById(id);

// ---- DOM refs ---------------------------------------------------------------

const stateLoading = $('state-loading');
const stateError = $('state-error');
const stateErrorMsg = $('state-error-message');
const stateErrorRetry = $('state-error-retry');
const stateEmpty = $('state-empty');
const stateList = $('state-list');
const docsList = $('docs-list');

const identityToggle = $('identity-toggle');
const identityPanel = $('identity-panel');
const identityClose = $('identity-close');
const identityInput = $('identity-input');
const identityCopy = $('identity-copy');
const identityPaste = $('identity-paste');
const identitySave = $('identity-save');

const filterButtons = document.querySelectorAll('.filter-chip');
const countAll = $('count-all');
const countActive = $('count-active');
const countComplete = $('count-complete');

const workspaceSelect = $('workspace-select');
const wsManageBtn = $('ws-manage');
const wsModal = $('ws-modal');
const wsModalKicker = $('ws-modal-kicker');
const wsModalTitle = $('ws-modal-title');
const wsModalBody = $('ws-modal-body');
const wsModalFooterLeft = $('ws-modal-footer-left');
const wsModalFooterRight = $('ws-modal-footer-right');
const wsModalClose = $('ws-modal-close');

let docs = []; // last fetched list
let currentFilter = 'all';

// ---- Boot -------------------------------------------------------------------

stateErrorRetry.addEventListener('click', () => load());

identityToggle.addEventListener('click', () => {
  identityPanel.hidden = false;
  identityInput.value = getSenderId();
  identitySave.hidden = true;
  identityInput.removeAttribute('readonly');
  identityInput.select();
  identityInput.setAttribute('readonly', 'true');
});
identityClose.addEventListener('click', () => {
  identityPanel.hidden = true;
});
identityCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(identityInput.value);
    identityCopy.textContent = 'Copied';
    setTimeout(() => { identityCopy.textContent = 'Copy'; }, 1400);
  } catch {
    identityInput.removeAttribute('readonly');
    identityInput.select();
    document.execCommand && document.execCommand('copy');
    identityInput.setAttribute('readonly', 'true');
  }
});
identityPaste.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    identityInput.removeAttribute('readonly');
    identityInput.value = text.trim();
    identityInput.setAttribute('readonly', 'true');
    identitySave.hidden = false;
  } catch {
    identityInput.removeAttribute('readonly');
    identityInput.focus();
    identitySave.hidden = false;
  }
});
identitySave.addEventListener('click', () => {
  const id = setSenderId(identityInput.value);
  if (!id) return;
  identityPanel.hidden = true;
  identitySave.hidden = true;
  load();
});

filterButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    filterButtons.forEach(b => b.classList.remove('filter-chip--active'));
    btn.classList.add('filter-chip--active');
    currentFilter = btn.dataset.filter;
    renderList();
  });
});

workspaceSelect.addEventListener('change', () => {
  const id = workspaceSelect.value || null;
  setActiveWorkspaceId(id);
  load();
});

wsManageBtn.addEventListener('click', () => openWorkspaceModal());
wsModalClose.addEventListener('click', closeWorkspaceModal);
wsModal.addEventListener('click', e => { if (e.target === wsModal) closeWorkspaceModal(); });
window.addEventListener('keydown', e => { if (e.key === 'Escape' && !wsModal.hidden) closeWorkspaceModal(); });

populateWorkspaceSwitcher();
maybeShowJoinFlash();

load();

// ---- Data load --------------------------------------------------------------

async function load() {
  showState('loading');
  const activeWs = getActiveWorkspace();

  // Update header to reflect what we're viewing.
  const titleEl = document.getElementById('dashboard-title');
  const ledeEl = document.getElementById('dashboard-lede');
  if (activeWs) {
    if (titleEl) titleEl.textContent = `Every contract sent through ${activeWs.name}.`;
    if (ledeEl) ledeEl.textContent =
      'Documents from every member of this workspace, newest first. Switch to "Personal" to see only documents you sent.';
  } else {
    if (titleEl) titleEl.textContent = 'Every contract you have routed through CyberSygn.';
    if (ledeEl) ledeEl.textContent =
      'Active documents are waiting on at least one signer. Completed documents include the audit certificate and the signed PDF, ready to download.';
  }

  const res = activeWs
    ? await fetchWorkspaceDocs(activeWs.id, activeWs.token)
    : await fetchSenderDocs(getSenderId());

  if (!res.ok) {
    stateErrorMsg.textContent = res.error || 'Unknown error.';
    showState('error');
    return;
  }
  docs = (res.data && res.data.docs) || [];
  // Workspace responses also carry member data; cache it for the modal.
  if (activeWs && res.data) {
    workspaceCache = {
      ...activeWs,
      name: res.data.name || activeWs.name,
      members: res.data.members || [],
    };
  } else {
    workspaceCache = null;
  }

  if (docs.length === 0) {
    showState('empty');
    return;
  }
  showState('list');
  renderList();
}

function showState(state) {
  stateLoading.hidden = state !== 'loading';
  stateError.hidden = state !== 'error';
  stateEmpty.hidden = state !== 'empty';
  stateList.hidden = state !== 'list';
}

// ---- Rendering --------------------------------------------------------------

function renderList() {
  // Counts
  countAll.textContent = docs.length;
  countActive.textContent = docs.filter(d => !d.completedAt).length;
  countComplete.textContent = docs.filter(d => d.completedAt).length;

  const filtered = docs.filter(d => {
    if (currentFilter === 'active')   return !d.completedAt;
    if (currentFilter === 'complete') return  d.completedAt;
    return true;
  });

  docsList.innerHTML = '';

  if (filtered.length === 0) {
    const li = document.createElement('li');
    li.className = 'docs-list__empty';
    li.textContent = currentFilter === 'active'
      ? 'No active documents. Every document you sent has been signed.'
      : currentFilter === 'complete'
      ? 'No signed documents yet. Pending documents are listed under "Active."'
      : 'No documents.';
    docsList.appendChild(li);
    return;
  }

  for (const doc of filtered) {
    docsList.appendChild(renderDocRow(doc));
  }
}

function renderDocRow(doc) {
  const li = document.createElement('li');
  li.className = 'doc-row';
  li.dataset.docId = doc.docId;
  if (doc.completedAt) li.classList.add('doc-row--complete');

  // Summary line: title, status, progress count, date
  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'doc-row__summary';
  summary.setAttribute('aria-expanded', 'false');

  const summaryLeft = document.createElement('div');
  summaryLeft.className = 'doc-row__left';

  const title = document.createElement('h3');
  title.className = 'doc-row__title';
  title.textContent = doc.title || 'Untitled document';

  const meta = document.createElement('p');
  meta.className = 'doc-row__meta';
  meta.innerHTML =
    `<span class="doc-row__meta-item">${formatDate(doc.lastEventAt || doc.createdAt)}</span>` +
    `<span class="doc-row__meta-sep">·</span>` +
    `<span class="doc-row__meta-item">${doc.signers} ${doc.signers === 1 ? 'signer' : 'signers'}</span>` +
    `<span class="doc-row__meta-sep">·</span>` +
    `<span class="doc-row__meta-item">${doc.totalOwned} ${doc.totalOwned === 1 ? 'field' : 'fields'}</span>`;

  summaryLeft.appendChild(title);
  summaryLeft.appendChild(meta);

  const summaryRight = document.createElement('div');
  summaryRight.className = 'doc-row__right';
  const status = document.createElement('span');
  status.className = 'doc-row__status';
  if (doc.completedAt) {
    status.classList.add('doc-row__status--complete');
    status.innerHTML = `<span class="doc-row__status-dot"></span>Signed`;
  } else {
    status.classList.add('doc-row__status--active');
    status.innerHTML = `<span class="doc-row__status-dot"></span>${doc.signersComplete} of ${doc.signers}`;
  }
  summaryRight.appendChild(status);

  const caret = document.createElement('span');
  caret.className = 'doc-row__caret';
  caret.textContent = '▾';
  summaryRight.appendChild(caret);

  summary.appendChild(summaryLeft);
  summary.appendChild(summaryRight);

  const detail = document.createElement('div');
  detail.className = 'doc-row__detail';
  detail.hidden = true;

  summary.addEventListener('click', () => {
    const open = !detail.hidden;
    if (open) {
      detail.hidden = true;
      summary.setAttribute('aria-expanded', 'false');
      li.classList.remove('doc-row--open');
      return;
    }
    detail.hidden = false;
    summary.setAttribute('aria-expanded', 'true');
    li.classList.add('doc-row--open');
    loadDetail(doc, detail);
  });

  li.appendChild(summary);
  li.appendChild(detail);
  return li;
}

async function loadDetail(doc, container) {
  // First render: a skeleton; then fetch progress (which includes signer
  // magic links if we have the senderToken).
  container.innerHTML = '<p class="doc-row__loading">Loading signer details.</p>';

  const senderToken = doc.senderToken || getDocToken(doc.docId);
  const res = await fetchProgress(doc.docId, senderToken);
  if (!res.ok) {
    container.innerHTML = `<p class="doc-row__loading">Could not load signer details: ${res.error}</p>`;
    return;
  }
  const detail = res.data;

  container.innerHTML = '';

  // Top-line actions: download signed PDF + audit when complete.
  if (detail.completedAt && detail.signedPdfUrl) {
    const actions = document.createElement('div');
    actions.className = 'doc-row__top-actions';
    const dl = document.createElement('a');
    dl.className = 'btn btn--primary btn--sm';
    dl.href = detail.signedPdfUrl;
    dl.target = '_blank';
    dl.rel = 'noopener';
    dl.textContent = 'Download signed PDF';
    actions.appendChild(dl);
    if (detail.auditUrl) {
      const audit = document.createElement('a');
      audit.className = 'btn btn--ghost btn--sm';
      audit.href = detail.auditUrl;
      audit.target = '_blank';
      audit.rel = 'noopener';
      audit.textContent = 'Download audit certificate';
      actions.appendChild(audit);
    }
    container.appendChild(actions);
  }

  // Per-signer rows
  const signers = document.createElement('ol');
  signers.className = 'signer-list';
  for (const s of detail.progress) {
    signers.appendChild(renderSignerRow(doc, s));
  }
  container.appendChild(signers);

  // Audit log preview note. We don't fetch full events here (the audit
  // certificate is the proper deliverable), but a single line of "n
  // events" gives the sender confidence the trail exists.
  if (detail.completedAt) {
    const note = document.createElement('p');
    note.className = 'doc-row__audit-note';
    note.textContent =
      'The audit certificate above lists every signer, every event, and ' +
      'the SHA-256 of the original PDF. Keep it with the signed document ' +
      'as evidence of who signed what and when.';
    container.appendChild(note);
  }
}

function renderSignerRow(doc, s) {
  const li = document.createElement('li');
  li.className = 'signer-status';
  if (s.complete) li.classList.add('signer-status--complete');

  // Initials swatch. Same coloring rule as the preview page so it
  // reads as "the same Alice" across views.
  const initials = (s.name || '?').trim().split(/\s+/)
    .map(p => p[0]).slice(0, 2).join('').toUpperCase();

  const swatch = document.createElement('span');
  swatch.className = 'signer-status__swatch';
  swatch.textContent = initials;

  const meta = document.createElement('div');
  meta.className = 'signer-status__meta';
  const name = document.createElement('p');
  name.className = 'signer-status__name';
  name.textContent = s.name;
  const email = document.createElement('p');
  email.className = 'signer-status__email';
  email.textContent = s.email || '(no email)';
  meta.appendChild(name);
  meta.appendChild(email);

  const status = document.createElement('span');
  status.className = 'signer-status__pill';
  if (s.complete) {
    status.textContent = `Signed · ${s.filled} of ${s.owned}`;
    status.classList.add('signer-status__pill--complete');
  } else if (s.filled > 0) {
    status.textContent = `In progress · ${s.filled} of ${s.owned}`;
    status.classList.add('signer-status__pill--partial');
  } else {
    status.textContent = `Pending · 0 of ${s.owned}`;
    status.classList.add('signer-status__pill--pending');
  }

  // Reminder summary
  const reminders = document.createElement('span');
  reminders.className = 'signer-status__reminders';
  if (s.reminderCount > 0) {
    reminders.textContent = `${s.reminderCount} reminder${s.reminderCount === 1 ? '' : 's'} sent`;
  } else if (!s.complete) {
    reminders.textContent = 'No reminders sent';
  } else {
    reminders.textContent = '';
  }

  const actions = document.createElement('div');
  actions.className = 'signer-status__actions';

  // Copy magic link, only available when we have it (sender token validated).
  if (s.magicLink) {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn--ghost btn--sm';
    copyBtn.textContent = 'Copy link';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(s.magicLink);
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 1400);
      } catch {}
    });
    actions.appendChild(copyBtn);
  }

  // Remind, only if signer is pending and has an email.
  if (!s.complete && s.email) {
    const remindBtn = document.createElement('button');
    remindBtn.type = 'button';
    remindBtn.className = 'btn btn--ink btn--sm';
    remindBtn.textContent = 'Remind';
    remindBtn.addEventListener('click', async () => {
      remindBtn.disabled = true;
      remindBtn.textContent = 'Sending.';
      const r = await remindSigner(doc.docId, s.signerId);
      if (!r.ok) {
        remindBtn.textContent = 'Try again';
        remindBtn.disabled = false;
        showInlineNote(li, r.error || 'Could not send reminder.');
        return;
      }
      const tone = r.data && r.data.tone;
      remindBtn.textContent = tone === 'final' ? 'Final sent'
                            : tone === 'second' ? 'Second sent'
                            : 'Sent';
      setTimeout(() => {
        remindBtn.textContent = 'Remind again';
        remindBtn.disabled = false;
      }, 4000);
      // refresh count in the row
      if (r.data && r.data.reminderCount) {
        reminders.textContent = `${r.data.reminderCount} reminder${r.data.reminderCount === 1 ? '' : 's'} sent`;
      }
    });
    actions.appendChild(remindBtn);
  }

  li.appendChild(swatch);
  li.appendChild(meta);
  li.appendChild(status);
  li.appendChild(reminders);
  li.appendChild(actions);
  return li;
}

function showInlineNote(row, text) {
  // Drop a brief inline error under the signer row.
  let note = row.querySelector('.signer-status__note');
  if (!note) {
    note = document.createElement('p');
    note.className = 'signer-status__note';
    row.appendChild(note);
  }
  note.textContent = text;
  setTimeout(() => { if (note) note.remove(); }, 5000);
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now.getTime() - 86400000);
  const sameYesterday = d.toDateString() === yest.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `Today, ${hh}:${mi}`;
  if (sameYesterday) return `Yesterday, ${hh}:${mi}`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${hh}:${mi}`;
}

// ---- Workspaces -----------------------------------------------------------

let workspaceCache = null; // cached members for the active workspace

function populateWorkspaceSwitcher() {
  const list = listWorkspaces();
  const active = getActiveWorkspaceId();

  // Reset options: always start with Personal.
  workspaceSelect.innerHTML = '';
  const personalOpt = document.createElement('option');
  personalOpt.value = '';
  personalOpt.textContent = 'Personal';
  workspaceSelect.appendChild(personalOpt);

  for (const ws of list) {
    const opt = document.createElement('option');
    opt.value = ws.id;
    opt.textContent = ws.name || 'Workspace';
    workspaceSelect.appendChild(opt);
  }

  // Add a "Create a workspace" option that opens the modal.
  const createOpt = document.createElement('option');
  createOpt.value = '__create__';
  createOpt.textContent = list.length === 0 ? 'Create a workspace…' : 'New workspace…';
  workspaceSelect.appendChild(createOpt);

  workspaceSelect.value = active && list.some(w => w.id === active) ? active : '';

  // Intercept "__create__" via a dedicated handler so the change event
  // does not try to navigate.
  workspaceSelect.addEventListener('change', e => {
    if (e.target.value === '__create__') {
      // Restore previous selection visually.
      workspaceSelect.value = active && list.some(w => w.id === active) ? active : '';
      openCreateWorkspaceModal();
      e.stopImmediatePropagation();
    }
  }, { once: false });
}

function openWorkspaceModal() {
  const activeWs = getActiveWorkspace();
  if (!activeWs) {
    openCreateWorkspaceModal();
    return;
  }
  wsModal.hidden = false;
  document.body.style.overflow = 'hidden';
  wsModalKicker.textContent = 'Workspace.';
  wsModalTitle.textContent = workspaceCache && workspaceCache.name ? workspaceCache.name : activeWs.name;
  renderWorkspaceModalBody(activeWs);
}

function closeWorkspaceModal() {
  wsModal.hidden = true;
  document.body.style.overflow = '';
}

function renderWorkspaceModalBody(activeWs) {
  wsModalBody.innerHTML = '';
  wsModalFooterLeft.innerHTML = '';
  wsModalFooterRight.innerHTML = '';

  // Member list section.
  const membersHead = document.createElement('p');
  membersHead.className = 'modal-card__lede';
  const memberCount = workspaceCache && workspaceCache.members ? workspaceCache.members.length : '...';
  membersHead.innerHTML = `<strong>${memberCount} member${memberCount === 1 ? '' : 's'}.</strong> Every member can send and see every document in this workspace.`;
  wsModalBody.appendChild(membersHead);

  const memberList = document.createElement('ol');
  memberList.className = 'ws-member-list';
  if (workspaceCache && workspaceCache.members) {
    for (const m of workspaceCache.members) {
      const li = document.createElement('li');
      li.className = 'ws-member';
      const initials = (m.name || '?').trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
      const swatch = document.createElement('span');
      swatch.className = 'ws-member__swatch';
      swatch.textContent = initials;
      const meta = document.createElement('div');
      meta.className = 'ws-member__meta';
      const name = document.createElement('p');
      name.className = 'ws-member__name';
      name.textContent = m.name;
      const email = document.createElement('p');
      email.className = 'ws-member__email';
      email.textContent = m.email || '(no email)';
      meta.appendChild(name);
      meta.appendChild(email);
      const role = document.createElement('span');
      role.className = 'ws-member__role';
      role.textContent = m.role === 'admin' ? 'Owner' : 'Member';
      li.appendChild(swatch);
      li.appendChild(meta);
      li.appendChild(role);
      memberList.appendChild(li);
    }
  }
  wsModalBody.appendChild(memberList);

  // Invite form.
  const inviteHead = document.createElement('h3');
  inviteHead.className = 'ws-invite-head';
  inviteHead.textContent = 'Invite a teammate.';
  wsModalBody.appendChild(inviteHead);

  const form = document.createElement('div');
  form.className = 'ws-invite-form';

  const nameField = document.createElement('div');
  nameField.className = 'field';
  const nameInput = document.createElement('input');
  nameInput.id = 'invite-name';
  nameInput.className = 'field__input';
  nameInput.placeholder = ' ';
  nameInput.type = 'text';
  const nameLabel = document.createElement('label');
  nameLabel.className = 'field__label';
  nameLabel.htmlFor = 'invite-name';
  nameLabel.textContent = 'Name (optional)';
  nameField.appendChild(nameInput);
  nameField.appendChild(nameLabel);

  const emailField = document.createElement('div');
  emailField.className = 'field';
  const emailInput = document.createElement('input');
  emailInput.id = 'invite-email';
  emailInput.className = 'field__input';
  emailInput.placeholder = ' ';
  emailInput.type = 'email';
  const emailLabel = document.createElement('label');
  emailLabel.className = 'field__label';
  emailLabel.htmlFor = 'invite-email';
  emailLabel.textContent = 'Email (optional, lets us send the invite)';
  emailField.appendChild(emailInput);
  emailField.appendChild(emailLabel);

  form.appendChild(nameField);
  form.appendChild(emailField);

  const sendInvite = document.createElement('button');
  sendInvite.type = 'button';
  sendInvite.className = 'btn btn--ink';
  sendInvite.textContent = 'Create invite link';

  const inviteResult = document.createElement('div');
  inviteResult.className = 'ws-invite-result';
  inviteResult.hidden = true;

  sendInvite.addEventListener('click', async () => {
    sendInvite.disabled = true;
    sendInvite.textContent = 'Creating.';
    const res = await createInvite(activeWs.id, activeWs.token, {
      name: nameInput.value.trim(),
      email: emailInput.value.trim(),
    });
    if (!res.ok) {
      sendInvite.disabled = false;
      sendInvite.textContent = 'Try again';
      inviteResult.hidden = false;
      inviteResult.dataset.kind = 'error';
      inviteResult.textContent = res.error || 'Could not create invite.';
      return;
    }
    sendInvite.textContent = 'Create another';
    sendInvite.disabled = false;
    inviteResult.hidden = false;
    inviteResult.dataset.kind = 'success';
    inviteResult.innerHTML = '';
    const intro = document.createElement('p');
    intro.className = 'ws-invite-result__intro';
    intro.textContent = res.data.delivered
      ? 'Invite sent. Copy the link too in case they need it again.'
      : 'Invite link ready. Send it to your teammate however you prefer.';
    inviteResult.appendChild(intro);

    const linkRow = document.createElement('div');
    linkRow.className = 'link-row';
    const meta = document.createElement('div');
    meta.className = 'send-list__meta';
    const m1 = document.createElement('p');
    m1.className = 'send-list__name';
    m1.textContent = nameInput.value.trim() || 'New teammate';
    const m2 = document.createElement('p');
    m2.className = 'send-list__email';
    m2.textContent = emailInput.value.trim() || 'No email on file';
    meta.appendChild(m1);
    meta.appendChild(m2);

    const urlInput = document.createElement('input');
    urlInput.className = 'link-row__url';
    urlInput.readOnly = true;
    urlInput.value = res.data.inviteUrl;
    urlInput.addEventListener('focus', () => urlInput.select());

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn--ghost btn--sm';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(res.data.inviteUrl);
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
      } catch {}
    });

    linkRow.appendChild(meta);
    linkRow.appendChild(urlInput);
    linkRow.appendChild(copyBtn);
    inviteResult.appendChild(linkRow);

    nameInput.value = '';
    emailInput.value = '';
  });

  form.appendChild(sendInvite);
  form.appendChild(inviteResult);
  wsModalBody.appendChild(form);

  // Footer: leave workspace (if not the only member, or always for non-admin)
  const leaveBtn = document.createElement('button');
  leaveBtn.type = 'button';
  leaveBtn.className = 'btn btn--ghost';
  leaveBtn.textContent = 'Forget this workspace';
  leaveBtn.title = 'Remove this workspace from this browser. Other members keep access.';
  leaveBtn.addEventListener('click', () => {
    if (!confirm('Forget this workspace on this device? You can rejoin with a new invite or by pasting the workspace token.')) return;
    removeWorkspace(activeWs.id);
    closeWorkspaceModal();
    populateWorkspaceSwitcher();
    setActiveWorkspaceId(null);
    load();
  });
  wsModalFooterLeft.appendChild(leaveBtn);

  const doneBtn = document.createElement('button');
  doneBtn.type = 'button';
  doneBtn.className = 'btn btn--primary';
  doneBtn.textContent = 'Done';
  doneBtn.addEventListener('click', closeWorkspaceModal);
  wsModalFooterRight.appendChild(doneBtn);
}

function openCreateWorkspaceModal() {
  wsModal.hidden = false;
  document.body.style.overflow = 'hidden';
  wsModalKicker.textContent = 'New workspace.';
  wsModalTitle.textContent = 'Set up a shared workspace.';
  wsModalBody.innerHTML = '';
  wsModalFooterLeft.innerHTML = '';
  wsModalFooterRight.innerHTML = '';

  const lede = document.createElement('p');
  lede.className = 'modal-card__lede';
  lede.textContent =
    'A workspace lets several CyberSygn senders share a single document index. ' +
    'Every member can send documents and see every other member\'s documents. ' +
    'You\'ll be the owner.';
  wsModalBody.appendChild(lede);

  const form = document.createElement('div');
  form.className = 'ws-invite-form';
  form.innerHTML =
    '<div class="field"><input id="ws-name" class="field__input" placeholder=" " type="text" /><label class="field__label" for="ws-name">Workspace name (e.g. "Patterson Studio")</label></div>' +
    '<div class="field"><input id="ws-owner-name" class="field__input" placeholder=" " type="text" /><label class="field__label" for="ws-owner-name">Your name</label></div>' +
    '<div class="field"><input id="ws-owner-email" class="field__input" placeholder=" " type="email" /><label class="field__label" for="ws-owner-email">Your email (optional)</label></div>';
  wsModalBody.appendChild(form);

  const result = document.createElement('div');
  result.className = 'ws-invite-result';
  result.hidden = true;
  wsModalBody.appendChild(result);

  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.className = 'btn btn--primary';
  createBtn.textContent = 'Create workspace';
  createBtn.addEventListener('click', async () => {
    const name = (document.getElementById('ws-name').value || '').trim();
    const ownerName = (document.getElementById('ws-owner-name').value || '').trim();
    const ownerEmail = (document.getElementById('ws-owner-email').value || '').trim();
    if (!name) {
      result.hidden = false;
      result.dataset.kind = 'error';
      result.textContent = 'A workspace name is required.';
      return;
    }
    createBtn.disabled = true;
    createBtn.textContent = 'Creating.';
    const res = await createWorkspace({
      name,
      adminSenderId: getSenderId(),
      adminName: ownerName,
      adminEmail: ownerEmail,
    });
    if (!res.ok) {
      createBtn.disabled = false;
      createBtn.textContent = 'Try again';
      result.hidden = false;
      result.dataset.kind = 'error';
      result.textContent = res.error || 'Could not create workspace.';
      return;
    }
    saveWorkspace({
      id: res.data.workspaceId,
      token: res.data.workspaceToken,
      name: res.data.name,
      memberId: res.data.adminMemberId,
    });
    setActiveWorkspaceId(res.data.workspaceId);
    closeWorkspaceModal();
    populateWorkspaceSwitcher();
    load();
    // Reopen on the manage view so the owner can immediately invite.
    setTimeout(() => openWorkspaceModal(), 400);
  });
  wsModalFooterRight.appendChild(createBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn--ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeWorkspaceModal);
  wsModalFooterLeft.appendChild(cancelBtn);
}

/**
 * If the URL carries ?joined=<workspaceId>, surface a brief flash and
 * clean the URL. This is how the invite-acceptance page hands off.
 */
function maybeShowJoinFlash() {
  const params = new URLSearchParams(window.location.search);
  const joined = params.get('joined');
  if (!joined) return;
  const ws = listWorkspaces().find(w => w.id === joined);
  if (ws) {
    setActiveWorkspaceId(joined);
    // Clean the URL so a reload doesn't refire the flash.
    const u = new URL(window.location.href);
    u.searchParams.delete('joined');
    history.replaceState({}, '', u.toString());
    // Render a simple sticky banner near the top via state-card pattern.
    const banner = document.createElement('section');
    banner.className = 'state-card';
    banner.style.borderLeft = '3px solid var(--green)';
    banner.style.marginBottom = '20px';
    banner.innerHTML =
      `<p class="state-card__kicker" style="color: var(--green)">Joined.</p>` +
      `<p class="state-card__body">You're now a member of <strong>${ws.name}</strong>. Documents from every member of this workspace appear below.</p>`;
    const container = document.querySelector('.dashboard .container');
    if (container) container.insertBefore(banner, container.querySelector('section'));
    setTimeout(() => banner.remove(), 8000);
  }
}

// Boot owner mode on the dashboard too.
import('../preview/owner.js').then(mod => {
  mod.bootOwner('').then(() => mod.wirePillControls());
  mod.watchActivation('');
}).catch(err => console.error('[cybersygn:owner]', err));
