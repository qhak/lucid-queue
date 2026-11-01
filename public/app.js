const JOB_TYPES = {
  cutrank: ["physique.scan", "physique.audit", "physique.rescan"],
  listvint: ["photo.enhance", "photo.remove-background", "price.estimate", "listing.analysis"],
  modhorizon: ["project.generate", "shader.generate", "build.validate"],
};
const PROJECT_NAMES = { cutrank: "CutRank", listvint: "Listvint", modhorizon: "ModHorizon" };
const $ = (selector) => document.querySelector(selector);
let toastTimer;
let refreshing = false;
let lastActivityId = 0;
let configuredProjects = new Set();

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}

function relativeTime(iso) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function renderJobs(jobs, totals) {
  const body = $("#jobs-body");
  body.innerHTML = jobs.slice(0, 5).map((job) => {
    const status = String(job.status).toLowerCase();
    const name = escapeHtml(job.name);
    const project = PROJECT_NAMES[job.project] || job.project;
    const owner = escapeHtml(job.submitted_by || "Website");
    const initials = escapeHtml((job.submitted_by || project)[0]?.toUpperCase() || "L");
    const action = status === "failed"
      ? `<button class="row-action" data-action="retry" data-job="${escapeHtml(job.id)}">Retry</button>`
      : status === "queued"
        ? `<button class="row-action" data-action="cancel" data-job="${escapeHtml(job.id)}">Cancel</button>`
        : `<button class="row-menu" title="${escapeHtml(job.error || job.id)}">···</button>`;
    return `<tr>
      <td><div class="job-cell"><span class="job-type">${escapeHtml(project[0])}</span><span class="job-id"><b>${escapeHtml(job.id.slice(0, 14))}</b><small>${name}<em>${escapeHtml(job.type)}</em></small></span></div></td>
      <td><span class="user-cell"><span class="user-avatar">${initials}</span>${owner}</span></td>
      <td><span class="status-badge status-${status}">${escapeHtml(job.status)}</span></td>
      <td><span class="wait-cell">${relativeTime(job.created_at)}</span></td>
      <td>${action}</td>
    </tr>`;
  }).join("");
  if (!jobs.length) body.innerHTML = '<tr><td colspan="5" class="empty-row">No jobs yet. Product requests will appear here after their private processor adapters are connected.</td></tr>';

  $("#metric-queued").textContent = totals.queued || 0;
  $("#metric-active").textContent = totals.running || 0;
  $("#metric-done").textContent = totals.done || 0;
  $("#metric-failed").textContent = totals.failed || 0;
  $("#pipeline-total").textContent = jobs.length;
  $("#pipeline-queued").textContent = totals.queued || 0;
  $("#pipeline-active").textContent = totals.running || 0;
  $("#nav-jobs").textContent = (totals.queued || 0) + (totals.running || 0);
  $("#jobs-count").textContent = jobs.length;
  $("#total-count").textContent = jobs.length;
  $("#showing-count").textContent = Math.min(jobs.length, 5);
}

function renderActive(jobs) {
  const running = jobs.filter((job) => job.status === "running");
  $("#workers-title .heading-count").textContent = running.length;
  $("#pipeline-active-label").textContent = `${running.length} running`;
  $("#worker-empty").hidden = running.length > 0;
  $("#workers-list").innerHTML = running.slice(0, 4).map((job, index) => `<div class="worker-row">
    <span class="worker-avatar">⌘</span>
    <span class="worker-info"><b>Run ${String(index + 1).padStart(2, "0")} · ${escapeHtml(PROJECT_NAMES[job.project] || job.project)}</b><small>${escapeHtml(job.name)}</small></span>
    <span class="worker-status">Processing</span>
  </div>`).join("");
}

function renderActivity(items) {
  const list = $("#activity-list");
  list.innerHTML = items.slice(0, 6).map((item) => {
    const color = item.kind === "completed" ? "green" : item.kind === "failed" ? "amber" : "blue";
    const icon = item.kind === "completed" ? "✓" : item.kind === "failed" ? "!" : item.kind === "started" ? "⌘" : "＋";
    const project = PROJECT_NAMES[item.project] || item.project || "Queue";
    return `<div class="activity-item"><span class="activity-icon ${color}">${icon}</span><span class="activity-copy"><b>${escapeHtml(project)}</b> · ${escapeHtml(item.message)}<small>${relativeTime(item.created_at)} ago</small></span></div>`;
  }).join("");
  if (!items.length) list.innerHTML = '<div class="empty-activity">Queue events will show here as requests arrive.</div>';
  if (items[0]?.id > lastActivityId && lastActivityId) toast("Queue activity updated");
  lastActivityId = items[0]?.id || lastActivityId;
}

function renderProcessors(processors = []) {
  configuredProjects = new Set(processors.filter((item) => item.configured).map((item) => item.project));
  const missing = Object.keys(PROJECT_NAMES).filter((project) => !configuredProjects.has(project));
  const banner = $("#integration-status");
  banner.hidden = missing.length === 0;
  banner.classList.toggle("ready", missing.length === 0);
  banner.innerHTML = missing.length
    ? `<b>Processors to connect:</b> ${missing.map((project) => escapeHtml(PROJECT_NAMES[project])).join(", ")}. Live requests from those sites cannot run until their private adapter endpoints are configured.`
    : '<b>All processor endpoints are configured.</b> The queue will route each product job to its private handler.';
  $("#new-job").disabled = configuredProjects.size === 0;
  updateTypeOptions();
}

function updateQueueState(paused) {
  const button = $("#pause-queue");
  button.innerHTML = paused ? '▶ <span>Resume queue</span>' : 'Ⅱ <span>Pause queue</span>';
  $(".updated-label").innerHTML = paused
    ? '<i class="pulse-dot" style="background:#d6a34f;box-shadow:0 0 0 3px #fff5e5"></i> Queue paused'
    : '<i class="pulse-dot"></i> Updating live';
  $("#pipeline").classList.toggle("paused", paused);
}

async function refresh() {
  if (refreshing || $("#login-screen").hidden === false) return;
  refreshing = true;
  try {
    const data = await api("/api/admin/state");
    renderProcessors(data.processors || []);
    renderJobs(data.jobs || [], data.totals || {});
    renderActive(data.jobs || []);
    renderActivity(data.activity || []);
    updateQueueState(data.paused);
    $("#queue-clock").textContent = `LIVE QUEUE · ${new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date())} GMT`;
  } catch (error) {
    if (error.status === 401) showLogin();
    else toast(error.message);
  } finally { refreshing = false; }
}

function showLogin() {
  $("#login-screen").hidden = false;
  $("#admin-password").focus();
}

function hideLogin() {
  $("#login-screen").hidden = true;
  $("#login-error").textContent = "";
}

function updateTypeOptions() {
  const project = $("#job-project").value;
  $("#job-type").innerHTML = JOB_TYPES[project].map((type) => `<option value="${type}">${type}</option>`).join("");
  $("#job-type").disabled = !configuredProjects.has(project);
  $("#submit-job").disabled = !configuredProjects.has(project);
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password: $("#admin-password").value }) });
    $("#admin-password").value = "";
    hideLogin();
    await refresh();
  } catch (error) { $("#login-error").textContent = error.message; }
  finally { button.disabled = false; }
});

$("#logout-button").addEventListener("click", async () => {
  await api("/api/admin/logout", { method: "POST", body: "{}" }).catch(() => {});
  showLogin();
});

$("#new-job").addEventListener("click", () => $("#job-dialog").showModal());
$(".dialog-close").addEventListener("click", () => $("#job-dialog").close());
$("#job-project").addEventListener("change", updateTypeOptions);
$("#job-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { $("#job-dialog").close(); return; }
  const payloadText = $("#job-payload").value;
  let payload;
  try { payload = JSON.parse(payloadText); }
  catch { toast("Payload must be valid JSON"); return; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) { toast("Payload must be a JSON object"); return; }
  const button = $("#submit-job");
  button.disabled = true;
  try {
    await api("/api/admin/jobs", { method: "POST", body: JSON.stringify({
      project: $("#job-project").value,
      type: $("#job-type").value,
      name: $("#job-name").value.trim(),
      submittedBy: $("#job-user").value.trim() || "Admin",
      idempotencyKey: crypto.randomUUID(),
      payload,
    }) });
    $("#job-dialog").close();
    $("#job-name").value = "";
    $("#job-payload").value = "{}";
    toast("Request added to the queue");
    await refresh();
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

$("#pause-queue").addEventListener("click", async () => {
  const paused = $("#pipeline").classList.contains("paused");
  try {
    const state = await api(`/api/admin/queue/${paused ? "resume" : "pause"}`, { method: "POST", body: "{}" });
    updateQueueState(state.paused);
    toast(state.paused ? "Queue paused. New jobs will wait." : "Queue resumed");
  } catch (error) { toast(error.message); }
});

$("#jobs-body").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  button.disabled = true;
  try {
    const result = await api(`/api/admin/jobs/${button.dataset.job}/${button.dataset.action}`, { method: "POST", body: "{}" });
    toast(result.status === "queued" ? "Job queued for retry" : "Job cancelled");
    await refresh();
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

updateTypeOptions();
api("/api/admin/session").then((data) => {
  if (data.authenticated) { hideLogin(); refresh(); }
  else showLogin();
});
setInterval(refresh, 4000);
