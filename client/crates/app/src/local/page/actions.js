"use strict";
// Button wiring and pairing; runs after app.js, whose helpers it uses.

function serverAddress() {
  const raw = $("server").value.trim();
  if (!raw) throw new Error("Enter the address of your Print Better site.");
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

async function pair(body) {
  showPairError(null);
  const reply = await api("/api/pair", { ...body, name: $("name").value.trim() || undefined });
  const link = reply.paired ? null : safeUrl(reply.verificationUriComplete);
  if (link) window.open(link, "_blank", "noopener");
  await refresh();
}

function readHash() {
  if (!location.hash) return;
  const params = new URLSearchParams(location.hash.slice(1));
  if (location.hash === "#tray-hidden") {
    const show = el("button", { type: "button", className: "primary", textContent: "Show the icon again" });
    show.onclick = () => withBusy(show, async () => {
      await api("/api/settings", { tray: true });
      $("banner").hidden = true;
      await refresh();
    });
    showBanner("The Print Better icon is hidden. Printing keeps working in the background. You can bring the icon back here or under Settings.", "info", show);
  } else if (params.get("server")) {
    linkRequest = { server: params.get("server"), token: params.get("token") || undefined };
  }
  // Keeps a pairing token out of the address bar and history.
  history.replaceState(null, "", "/");
  if (current) render(current);
}

$("pair-browser").onclick = (e) => withBusy(e.currentTarget, () => pair({ server: serverAddress() }), showPairError);
$("pair-token").onclick = (e) => {
  const button = e.currentTarget;
  if ($("token-row").hidden) {
    $("token-row").hidden = false;
    button.textContent = "Connect with this code";
    $("token").focus();
    return;
  }
  withBusy(button, () => {
    const token = $("token").value.trim();
    if (!token) throw new Error("Enter the pairing code from your dashboard.");
    return pair({ server: serverAddress(), token });
  }, showPairError);
};
$("confirm-yes").onclick = (e) => {
  const request = linkRequest;
  linkRequest = null;
  withBusy(e.currentTarget, () => pair(request), showPairError);
};
$("confirm-no").onclick = () => {
  linkRequest = null;
  if (current) render(current);
};
$("pair-cancel").onclick = (e) => withBusy(e.currentTarget, async () => {
  await api("/api/pair/cancel", {});
  await refresh();
});
$("pause").onclick = (e) => withBusy(e.currentTarget, async () => {
  await api("/api/settings", { paused: !current.settings.paused });
  await refresh();
});
$("update-now").onclick = (e) => withBusy(e.currentTarget, async () => {
  await api("/api/update", { install: true });
  await refresh();
});
$("discover").onclick = (e) => {
  const button = e.currentTarget;
  button.textContent = "Searching…";
  withBusy(button, async () => {
    await api("/api/discover", {});
    await refresh();
  }).finally(() => { button.textContent = "Find printers"; });
};
$("run-checks").onclick = (e) => withBusy(e.currentTarget, async () => {
  const { checks } = await api("/api/doctor");
  $("checks").hidden = false;
  $("checks").replaceChildren(...checks.map((check) => el("li", {},
    el("div", { className: "item-head" },
      el("span", { className: "item-title", textContent: check.name }),
      pill(check.ok ? "OK" : "Problem", check.ok ? "ok" : "bad")),
    el("p", { className: "muted", textContent: check.detail }))));
});
$("show-logs").onclick = (e) => withBusy(e.currentTarget, async () => {
  const { lines } = await api("/api/logs?lines=200");
  $("logs").hidden = false;
  $("logs").textContent = lines.length ? lines.join("\n") : "The log is empty.";
});
$("unpair").onclick = (e) => {
  const question = `Disconnect this computer from ${current?.server}? Printing from your dashboard stops until you connect it again.`;
  if (!window.confirm(question)) return;
  withBusy(e.currentTarget, async () => {
    await api("/api/unpair", {});
    await refresh();
  });
};

window.addEventListener("hashchange", readHash);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) refresh(); }, 2000);
readHash();
refresh();
