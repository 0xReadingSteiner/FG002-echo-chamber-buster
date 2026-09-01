(() => {
  "use strict";

  /*
    Behavior:

    AUTO_SCAN = true
      Automatically scans usernames found on the page.

    SCAN_EVEN_IF_CACHED = false
      Cached results (7-day TTL) are reused instead of re-scanning.

    MAX_AUTO_SCANS_PER_PAGE
      Safety cap per page.

    Auto-scans run in "lite" mode (smaller accusation-reply budget,
    faster). The manual "Run full-history scan" button always runs the
    full analysis.
  */
  const AUTO_SCAN = true;
  const SCAN_EVEN_IF_CACHED = false;
  const MAX_AUTO_SCANS_PER_PAGE = 20;
  const SCAN_DELAY_MS = 1200;
  const LOOKUP_DELAY_MS = 400;

  const BADGE_ATTR = "data-dcs-badge";
  const ANNOTATED_ATTR = "data-dcs-annotated";
  const PANEL_ID = "dcs-panel";
  const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;

  const lookupQueue = new Set();
  const badgeEls = new Map();

  const scanQueue = [];
  const scanQueued = new Set();
  const scanDone = new Set();

  let scanActive = false;
  let lookupTimer = null;
  let scanTimer = null;
  let mutationTimer = null;

  function cleanName(raw) {
    const name = String(raw || "").trim().replace(/^@/, "");
    return USERNAME_RE.test(name) ? name : null;
  }

  function nameFromHref(href) {
    try {
      const u = new URL(href, location.href);
      const m = u.pathname.match(/\/user\/([A-Za-z0-9_-]{3,20})/i);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  function currentProfileKey() {
    const m = location.pathname.match(/\/user\/([A-Za-z0-9_-]{3,20})/i);
    return m ? m[1].toLowerCase() : null;
  }

  function isProfileKey(key) {
    return String(key || "").toLowerCase() === currentProfileKey();
  }

  function trackBadge(key, el) {
    if (!badgeEls.has(key)) {
      badgeEls.set(key, new Set());
    }

    badgeEls.get(key).add(el);
  }

  function getDisplayName(key) {
    const els = badgeEls.get(key);

    if (!els) return key;

    for (const el of els) {
      if (el.dataset && el.dataset.displayName) {
        return el.dataset.displayName;
      }
    }

    return key;
  }

  function setBadges(key, text, className, title, state) {
    const els = badgeEls.get(key);
    if (!els) return;

    for (const el of els) {
      el.textContent = text;
      el.className = className;
      el.title = title;
      el.dataset.state = state;
    }
  }

  function updateBadgeFromInfo(key, info) {
    if (info && info.state === "listed") {
      setBadges(
        key,
        "LISTED",
        "dcs-badge dcs-listed",
        `Listed in local cluster list: ${info.label || info.cluster || "unknown"}`,
        "listed"
      );
      return;
    }

    if (info && info.state === "cached") {
      const band = String(info.band || "low").trim().toLowerCase();

      if (band === "unknown") {
        setBadges(
          key,
          "?",
          "dcs-badge dcs-unknown",
          "Cached result: insufficient data",
          "unknown"
        );
        return;
      }

      setBadges(
        key,
        band.toUpperCase(),
        `dcs-badge dcs-${band}`,
        `Cached score ${info.index ?? "?"}/100`,
        band
      );
      return;
    }

    setBadges(
      key,
      "DCS",
      "dcs-badge dcs-pending",
      "Waiting for lookup",
      "pending"
    );
  }

  function updateBadgeFromScan(key, scan) {
    if (!scan || scan.error) {
      setBadges(
        key,
        "ERR",
        "dcs-badge dcs-error",
        scan && scan.error ? String(scan.error) : "Scan failed",
        "error"
      );
      return;
    }

    const band = String(scan.band || "unknown").trim().toLowerCase();

    if (band === "unknown") {
      setBadges(
        key,
        "?",
        "dcs-badge dcs-unknown",
        "Insufficient archive data",
        "unknown"
      );
      return;
    }

    setBadges(
      key,
      band.toUpperCase(),
      `dcs-badge dcs-${band}`,
      `Score ${scan.index ?? "?"}/100`,
      band
    );
  }

  function addBadge(target, displayName) {
    if (!target || target.nodeType !== 1 || target.hasAttribute(ANNOTATED_ATTR)) {
      return;
    }

    const name = cleanName(displayName);
    if (!name) return;

    const key = name.toLowerCase();

    target.setAttribute(ANNOTATED_ATTR, key);

    const badge = document.createElement("span");

    badge.className = "dcs-badge dcs-pending";
    badge.setAttribute(BADGE_ATTR, key);
    badge.dataset.displayName = name;
    badge.dataset.state = "pending";
    badge.textContent = "DCS";
    badge.title = "Echo Chamber Buster";

    badge.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      openPanel(name);
    });

    target.insertAdjacentElement("afterend", badge);

    trackBadge(key, badge);

    lookupQueue.add(key);
    scheduleLookup();
  }

  function scheduleLookup() {
    clearTimeout(lookupTimer);

    lookupTimer = setTimeout(() => {
      lookupTimer = null;
      processLookup();
    }, LOOKUP_DELAY_MS);
  }

  function canQueueScan(info) {
    if (!AUTO_SCAN) return false;

    if (scanDone.size >= MAX_AUTO_SCANS_PER_PAGE) {
      return false;
    }

    if (SCAN_EVEN_IF_CACHED) {
      return true;
    }

    return !info || !(info.state === "listed" || info.state === "cached");
  }

  function queueScan(key, priority) {
    if (!AUTO_SCAN) return;

    if (scanDone.has(key) || scanQueued.has(key)) return;

    if (scanDone.size >= MAX_AUTO_SCANS_PER_PAGE) return;

    scanQueued.add(key);

    if (priority) {
      scanQueue.unshift(key);
    } else {
      scanQueue.push(key);
    }

    scheduleScan();
  }

  function scheduleScan() {
    if (scanActive) return;

    clearTimeout(scanTimer);

    scanTimer = setTimeout(() => {
      scanTimer = null;
      processScanQueue();
    }, 250);
  }

  async function processLookup() {
    if (!lookupQueue.size) return;

    const keys = Array.from(lookupQueue).slice(0, 200);

    keys.forEach((k) => lookupQueue.delete(k));

    let response = {};

    try {
      response =
        (await chrome.runtime.sendMessage({
          type: "lookup",
          names: keys
        })) || {};
    } catch {
      response = {};
    }

    for (const key of keys) {
      const info = response[key];

      updateBadgeFromInfo(key, info);

      if (canQueueScan(info)) {
        queueScan(key, isProfileKey(key));
      }
    }

    if (lookupQueue.size) {
      scheduleLookup();
    }
  }

  async function processScanQueue() {
    if (scanActive) return;

    const key = scanQueue.shift();

    if (!key) return;

    scanQueued.delete(key);
    scanActive = true;

    setBadges(
      key,
      "SCAN",
      "dcs-badge dcs-scanning",
      "Full-history scan running",
      "scanning"
    );

    try {
      const name = getDisplayName(key);

      const res = await chrome.runtime.sendMessage({
        type: "deepScan",
        name,
        domHints: collectDomHints(),
        lite: true
      });

      scanDone.add(key);

      updateBadgeFromScan(key, res);
    } catch (err) {
      scanDone.add(key);

      setBadges(
        key,
        "ERR",
        "dcs-badge dcs-error",
        String(err),
        "error"
      );
    }

    scanActive = false;

    if (scanQueue.length) {
      clearTimeout(scanTimer);

      scanTimer = setTimeout(() => {
        scanTimer = null;
        processScanQueue();
      }, SCAN_DELAY_MS);
    }
  }

  function scan() {
    if (!document.body) return;

    const anchors = document.querySelectorAll('a[href*="/user/"]');

    for (const a of anchors) {
      const name = cleanName(nameFromHref(a.href) || a.textContent);
      if (name) addBadge(a, name);
    }

    const profileKey = currentProfileKey();

    if (profileKey) {
      const name = cleanName(profileKey);
      const h1 = document.querySelector("h1");

      if (name && h1 && !h1.hasAttribute(ANNOTATED_ATTR)) {
        addBadge(h1, name);
      }
    }
  }

  function parseNumber(text) {
    const m = String(text || "").replace(/,/g, "").match(/([0-9]+)/);
    return m ? Number(m[1]) : null;
  }

  function collectDomHints() {
    const hints = {
      totalKarma: null,
      accountAgeDays: null
    };

    const text = document.body ? document.body.innerText : "";

    const karmaPatterns = [
      /([0-9][0-9,]*)\s*total karma/i,
      /total karma\s*([0-9][0-9,]*)/i,
      /([0-9][0-9,]*)\s*karma/i
    ];

    for (const re of karmaPatterns) {
      const m = text.match(re);

      if (m) {
        hints.totalKarma = parseNumber(m[1]);

        if (hints.totalKarma != null) break;
      }
    }

    const cake = text.match(/cake day\s*([^\n]+)/i);

    if (cake) {
      const dt = new Date(cake[1]);

      if (!Number.isNaN(dt.getTime())) {
        hints.accountAgeDays = Math.max(
          0,
          Math.floor((Date.now() - dt.getTime()) / 86400000)
        );
      }
    }

    return hints;
  }

  function openPanel(displayName) {
    const name = cleanName(displayName);
    if (!name) return;

    const old = document.getElementById(PANEL_ID);
    if (old) old.remove();

    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    const close = document.createElement("button");
    close.className = "dcs-panel-close";
    close.textContent = "×";
    close.addEventListener("click", () => panel.remove());

    const title = document.createElement("h2");
    title.textContent = name;

    const status = document.createElement("div");
    status.className = "dcs-status";
    status.textContent = "Loading…";

    const deep = document.createElement("button");
    deep.className = "dcs-button";
    deep.textContent = "Run full-history scan";
    deep.disabled = true;

    const evidence = document.createElement("pre");
    evidence.className = "dcs-evidence";

    const disclaimer = document.createElement("div");
    disclaimer.className = "dcs-disclaimer";
    disclaimer.textContent =
      "Heuristic likelihood — verify before acting.";

    panel.append(close, title, status, deep, evidence, disclaimer);
    document.body.appendChild(panel);

    deep.addEventListener("click", async () => {
      deep.disabled = true;
      status.textContent = "Scanning…";
      status.className = "dcs-status";
      evidence.textContent = "";

      try {
        const res = await chrome.runtime.sendMessage({
          type: "deepScan",
          name,
          domHints: collectDomHints(),
          lite: false
        });

        renderScan(status, evidence, res);
      } catch (err) {
        status.textContent = "Scan failed.";
        evidence.textContent = String(err);
      } finally {
        deep.disabled = false;
      }
    });

    loadDetail(name, status, evidence, deep);
  }

  async function loadDetail(name, status, evidence, deepButton) {
    try {
      const detail = await chrome.runtime.sendMessage({
        type: "detail",
        name
      });

      deepButton.disabled = false;

      if (!detail) {
        status.textContent = "No data.";
        return;
      }

      const lines = [];

      if (detail.listed) {
        lines.push(
          `Listed in cluster: ${detail.listed.label || detail.listed.cluster}`
        );
      }

      if (detail.scan) {
        renderScan(status, evidence, detail.scan);
        return;
      }

      if (detail.stale) {
        lines.push(
          `Stale cached score: ${detail.stale.index} (${String(
            detail.stale.band
          ).toUpperCase()})`
        );
      }

      if (!lines.length) {
        lines.push("No cached scan yet.");
      }

      status.textContent = lines.join("\n");
    } catch (err) {
      deepButton.disabled = false;
      status.textContent = "Could not load details.";
      evidence.textContent = String(err);
    }
  }

  function renderScan(status, evidence, scan) {
    if (!scan || scan.error) {
      status.textContent =
        scan && scan.error ? String(scan.error) : "Scan failed.";
      status.className = "dcs-status";
      evidence.textContent = "";
      return;
    }

    const band = String(scan.band || "unknown").trim().toLowerCase();

    if (band === "unknown") {
      status.textContent = "UNKNOWN — insufficient archive data";
      status.className = "dcs-status dcs-text-unknown";
    } else {
      status.textContent = `Score ${scan.index ?? "?"}/100 — ${band.toUpperCase()}`;
      status.className = `dcs-status dcs-text-${band}`;
    }

    const lines = [
      "Heuristic likelihood — verify before acting.",
      ""
    ];

    if (scan.listed) {
      lines.push(
        `Listed cluster: ${scan.listed.label || scan.listed.cluster}`
      );
    }

    if (scan.sources && scan.sources.length) {
      lines.push(`Sources: ${scan.sources.join(", ")}`);
    }

    if (scan.dataQuality) {
      lines.push(
        `Data: ${scan.dataQuality.comments} comments, ${scan.dataQuality.posts} posts`
      );

      if (scan.dataQuality.truncated) {
        lines.push("Note: history truncated at scan cap.");
      }
    }

    lines.push("Signals:");

    for (const [k, v] of Object.entries(scan.signals || {})) {
      lines.push(`  ${k}: ${Number(v || 0).toFixed(2)}`);
    }

    lines.push("Evidence:");

    if (scan.evidence && scan.evidence.length) {
      scan.evidence.forEach((item) => lines.push(`  - ${item}`));
    } else {
      lines.push("  - none available");
    }

    evidence.textContent = lines.join("\n");
  }

  const observer = new MutationObserver(() => {
    clearTimeout(mutationTimer);

    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      scan();
    }, 500);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  scan();
})();