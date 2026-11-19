"use strict";

const $ = (id) => document.getElementById(id);

const CONNECTION = {
  online: ["Connected", "ok"],
  connecting: ["Connecting…", "busy"],
  offline: ["Offline, retrying", "warn"],
  unpaired: ["Not connected yet", "muted"],
  revoked: ["Removed from Print Better", "bad"],
  replaced: ["Stopped: connected elsewhere", "bad"],
};
const PRINTER = {
  idle: ["Ready", "ok"],
  printing: ["Printing", "busy"],
  stopped: ["Needs attention", "warn"],
  offline: ["Offline", "bad"],
  unknown: ["Status unknown", "muted"],
};
const JOB = {
  dispatched: ["Waiting", "muted"],
  printing: ["Printing", "busy"],
  completed: ["Printed", "ok"],
  failed: ["Problem", "bad"],
  canceled: ["Canceled", "muted"],
};
const TOGGLES = [
  ["Show the Print Better icon in the menu bar or taskbar", (s) => s.tray, (on) => ({ tray: on })],
  ["Let other devices on this network print to added printers", (s) => s.lanSharing, (on) => ({ lanSharing: on })],
  ["Find network printers automatically", (s) => s.discovery.mdns, (on) => ({ discovery: { mdns: on } })],
  ["Also look for older network printers", (s) => s.discovery.snmp, (on) => ({ discovery: { snmp: on } })],
  ["Find printers plugged in with USB", (s) => s.discovery.usb, (on) => ({ discovery: { usb: on } })],
  ["Use printers already set up on this computer", (s) => s.discovery.os, (on) => ({ discovery: { os: on } })],
  ["Keep detailed logs for troubleshooting", (s) => s.logLevel === "debug", (on) => ({ logLevel: on ? "debug" : "info" })],
  ["Install updates automatically", (s) => s.autoUpdate, (on) => ({ autoUpdate: on })],
];

let current = null;
let linkRequest = null;
let latest = 0;
const rendered = {};

async function api(path, body) {
  const init = body === undefined
    ? {}
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Something went wrong (${response.status}).`);
  return data;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false && child !== ""));
  return node;
}

function pill(text, tone, node = el("span", { className: "pill" })) {
  node.textContent = text;
  node.dataset.tone = tone;
  return node;
}

const chip = (text) => el("span", { className: "chip", textContent: text });

function safeUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function when(ms) {
  if (!ms) return null;
  const date = new Date(ms);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function changed(key, value) {
  const json = JSON.stringify(value);
  if (rendered[key] === json) return false;
  rendered[key] = json;
  return true;
}

function showBanner(text, tone = "info", action = null) {
  const banner = $("banner");
  const dismiss = el("button", { type: "button", textContent: "Dismiss", onclick: () => { banner.hidden = true; } });
  banner.dataset.tone = tone;
  banner.replaceChildren(el("span", { textContent: text }), el("div", { className: "actions" }, action, dismiss));
  banner.hidden = false;
}

function showPairError(message) {
  $("pair-error").hidden = !message;
  $("pair-error").textContent = message || "";
}

async function withBusy(button, task, onError = (message) => showBanner(message, "bad")) {
  button.disabled = true;
  try {
    await task();
  } catch (error) {
    onError(error.message);
  } finally {
    button.disabled = false;
  }
}

async function refresh() {
  const ticket = ++latest;
  try {
    const status = await api("/api/status");
    if (ticket === latest) render(status);
  } catch {
    if (ticket === latest) pill("Print Better is not running", "bad", $("conn"));
  }
}

function render(st) {
  current = st;
  pill(...(CONNECTION[st.connection] || CONNECTION.offline), $("conn"));
  $("version").textContent = `Print Better ${st.version}`;
  $("log-file").textContent = st.logFile ? `Log file: ${st.logFile}` : "";
  $("unpair").hidden = !st.paired;
  renderPairing(st);
  renderOverview(st);
  renderUpdate(st.update);
  if (changed("printers", [st.paired, st.printers])) renderPrinters(st);
  if (changed("jobs", st.jobs)) renderJobs(st.jobs);
  if (changed("settings", st.settings)) renderSettings(st.settings);
  const shareError = st.settings.lanSharing ? st.lanSharing?.error : null;
  $("share-error").hidden = !shareError;
  $("share-error").textContent = shareError ? `Sharing isn't working: ${shareError}` : "";
  const remoteError = st.settings.remotePrinters ? st.remotePrinters?.error : null;
  $("remote-error").hidden = !remoteError;
  $("remote-error").textContent = remoteError ? `Printers from other devices: ${remoteError}` : "";
}

function renderPairing(st) {
  $("pair").hidden = st.paired;
  if (st.paired) {
    if (linkRequest) showBanner(`This computer is already connected to ${st.server}. Disconnect it under Help and troubleshooting first.`);
    linkRequest = null;
    return;
  }
  const pairing = st.pairing;
  const waiting = pairing?.state === "waiting";
  const confirming = !waiting && linkRequest !== null;
  $("pair-wait").hidden = !waiting;
  $("pair-confirm").hidden = !confirming;
  $("pair-form").hidden = waiting || confirming;
  if (confirming) $("confirm-server").textContent = linkRequest.server;
  if (waiting) {
    $("pair-code").textContent = pairing.userCode || "";
    $("pair-link").href = safeUrl(pairing.verificationUriComplete) || safeUrl(pairing.verificationUri) || "#";
  } else if (pairing?.state === "failed") {
    showPairError(pairing.message || "Connecting didn't finish. Please try again.");
  }
}

function renderOverview(st) {
  $("overview").hidden = !st.paired;
  if (!st.paired) return;
  $("device-name").textContent = st.name || "This computer";
  $("device-server").textContent = st.server;
  const dashboard = safeUrl(st.dashboardUrl);
  $("dashboard").hidden = !dashboard;
  if (dashboard) $("dashboard").href = dashboard;
  const detail = st.connection === "online" ? null : st.connectionDetail;
  $("device-detail").hidden = !detail;
  $("device-detail").textContent = detail || "";
  const paused = st.settings.paused;
  $("pause-title").textContent = paused ? "Printing is paused" : "Printing is on";
  $("pause-text").textContent = paused ? "New jobs wait here until you resume." : "Jobs sent to this computer print right away.";
  $("pause").textContent = paused ? "Resume printing" : "Pause printing";
  $("pause").classList.toggle("primary", paused);
}

function renderUpdate(update) {
  const busy = update?.phase;
  const show = Boolean(update && (busy || update.available || update.error));
  $("update-row").hidden = !show;
  if (!show) return;
  $("update-title").textContent = busy
    ? `Updating to ${update.latest}…`
    : update.available ? `Print Better ${update.latest} is available` : "Automatic updates";
  $("update-text").textContent = busy
    ? "Print Better restarts on its own when the update is installed."
    : update.error || (update.autoUpdate ? "It installs automatically, or install it now." : `This computer has ${update.current}.`);
  $("update-now").hidden = Boolean(busy) || !update.available;
}

function renderPrinters(st) {
  const items = st.printers.map((p) => {
    const [label, tone] = PRINTER[p.state] || PRINTER.unknown;
    const low = (p.supplies || []).filter((s) => s.level >= 0 && s.level <= 15);
    return el("li", {},
      el("div", { className: "item-head" }, el("span", { className: "item-title", textContent: p.name }), pill(label, tone)),
      p.message && el("p", { className: "muted", textContent: p.message }),
      el("div", { className: "chips" },
        chip(p.added ? "Added" : "Not added"),
        p.lanShare && chip("Shared on this network"),
        p.makeModel && p.makeModel !== p.name && chip(p.makeModel),
        p.location && chip(p.location),
        ...low.map((s) => chip(`${s.name} is low (${s.level}%)`))));
  });
  if (!items.length) {
    items.push(el("li", { className: "empty", textContent: "No printers found yet. Make sure the printer is turned on, then choose Find printers." }));
  } else if (st.paired && st.printers.some((p) => !p.added)) {
    items.push(el("li", { className: "empty", textContent: "Choose which printers to use from your dashboard." }));
  }
  $("printers").replaceChildren(...items);
}

function renderJobs(jobs) {
  const items = jobs.map((job) => {
    const [label, tone] = JOB[job.status] || JOB.dispatched;
    const done = ["completed", "failed", "canceled"].includes(job.status);
    const pages = job.pages ? `${job.pages} page${job.pages === 1 ? "" : "s"}` : null;
    const facts = [job.printerName, pages, when(job.createdAt)].filter(Boolean).join(" · ");
    const cancel = el("button", { type: "button", textContent: "Cancel" });
    cancel.onclick = () => withBusy(cancel, async () => {
      await api(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, {});
      await refresh();
    });
    return el("li", {},
      el("div", { className: "item-head" }, el("span", { className: "item-title", textContent: job.title || "Document" }), pill(label, tone)),
      facts && el("p", { className: "muted small", textContent: facts }),
      job.message && el("p", { textContent: job.message }),
      !done && el("div", { className: "actions" }, cancel));
  });
  if (!items.length) items.push(el("li", { className: "empty", textContent: "Nothing printed yet." }));
  $("jobs").replaceChildren(...items);
}

function renderSettings(settings) {
  $("settings").replaceChildren(...TOGGLES.map(([label, read, patch]) => {
    const input = el("input", { type: "checkbox", checked: read(settings) });
    input.setAttribute("role", "switch");
    input.onchange = async () => {
      input.disabled = true;
      try {
        await api("/api/settings", patch(input.checked));
      } catch (error) {
        input.checked = !input.checked;
        showBanner(error.message, "bad");
      } finally {
        input.disabled = false;
      }
      refresh();
    };
    return el("label", { className: "toggle" }, el("span", { textContent: label }), input);
  }));
}
