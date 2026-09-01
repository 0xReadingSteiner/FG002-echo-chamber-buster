"use strict";

importScripts("signals.js");

const AS_BASE = "https://arctic-shift.photon-reddit.com/api";
const PP_BASE = "https://api.pullpush.io/reddit/search";

const PAGE_SIZE = 100;

/*
  Full-history scan limits.

  MAX_PAGES = 30 means up to about 3000 comments and 3000 posts per account.
  Raise this if you want deeper scans, but scans will become slower.
*/
const MAX_PAGES = 30;
const MAX_ITEMS_PER_TYPE = 3000;

const THROTTLE_MS = 1200;
const FETCH_TIMEOUT_MS = 15000;
const SCAN_TTL_MS = 7 * 24 * 3600 * 1000;

/* ---------- IndexedDB cache ---------- */

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("echo-chamber-buster", 1);

    req.onupgradeneeded = () => {
      req.result.createObjectStore("scans");
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheGet(name) {
  try {
    const db = await idb();

    return await new Promise((resolve) => {
      const r = db
        .transaction("scans")
        .objectStore("scans")
        .get(String(name).toLowerCase());

      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function cachePut(name, rec) {
  try {
    const db = await idb();

    await new Promise((resolve) => {
      const tx = db.transaction("scans", "readwrite");
      tx.objectStore("scans").put(rec, String(name).toLowerCase());
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
  } catch {
    // Cache is best-effort.
  }
}

/* ---------- Fetch plumbing ---------- */

async function fetchJSON(url, attempts = 3) {
  let lastErr = null;

  for (let a = 0; a < attempts; a++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        signal: ctl.signal
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      return await res.json();
    } catch (err) {
      lastErr = err;

      if (a < attempts - 1) {
        await new Promise((r) => setTimeout(r, 800 * (a + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr;
}

let lastReq = 0;
let chain = Promise.resolve();

function throttled(fn) {
  const run = chain.then(async () => {
    const wait = lastReq + THROTTLE_MS - Date.now();

    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }

    lastReq = Date.now();
    return fn();
  });

  chain = run.catch(() => {});
  return run;
}

function extractItems(res) {
  if (!res) return [];

  if (Array.isArray(res)) {
    return res;
  }

  if (Array.isArray(res.data)) {
    return res.data;
  }

  if (Array.isArray(res.items)) {
    return res.items;
  }

  return [];
}

/* ---------- Archive normalization ---------- */

function makeId(it) {
  return String(
    it.id ||
      `${it.created_utc || 0}:${it.subreddit || ""}:${String(
        it.body || it.selftext || it.title || ""
      ).slice(0, 80)}`
  );
}

function normAS(it, kind) {
  return {
    id: makeId(it),
    ts: Number(it.created_utc) || 0,
    subreddit: it.subreddit || "",
    body:
      kind === "comment"
        ? String(it.body || "")
        : String(it.selftext || it.title || ""),
    kind,
    authorFullname: it.author_fullname || null
  };
}

function normPP(it, kind) {
  return {
    id: makeId(it),
    ts: Number(it.created_utc) || 0,
    subreddit: it.subreddit || "",
    body: String(it.body || it.selftext || it.title || ""),
    kind,
    authorFullname: it.author_fullname || null
  };
}

function mergeItems(a, b) {
  const map = new Map();

  for (const item of a.concat(b)) {
    if (!item || !item.id) continue;
    if (!map.has(item.id)) map.set(item.id, item);
  }

  return Array.from(map.values()).sort((x, y) => x.ts - y.ts);
}

/* ---------- Pagination ---------- */

async function paginate(makeUrl, normalize, kind) {
  let items = [];
  let after = null;
  let pages = 0;
  let truncated = false;
  let lastError = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = makeUrl(after);

    let res;

    try {
      res = await throttled(() => fetchJSON(url));
    } catch (err) {
      lastError = err;
      break;
    }

    const arr = extractItems(res);

    if (!arr.length) break;

    const norm = arr
      .map((x) => normalize(x, kind))
      .filter((x) => x.ts > 0)
      .sort((a, b) => a.ts - b.ts);

    if (!norm.length) break;

    const lastTs = norm[norm.length - 1].ts;

    if (after != null && lastTs < after) {
      break;
    }

    items = items.concat(norm);
    pages++;

    after = lastTs + 1;

    if (items.length >= MAX_ITEMS_PER_TYPE) {
      items = items.slice(0, MAX_ITEMS_PER_TYPE);
      truncated = true;
      break;
    }

    if (arr.length < PAGE_SIZE) {
      break;
    }

    if (page === MAX_PAGES - 1) {
      truncated = true;
    }
  }

  return {
    items,
    pages,
    truncated,
    error: lastError ? String(lastError.message || lastError) : null
  };
}

/* ---------- Archive fetchers ---------- */

async function fetchAllComments(name) {
  const as = await paginate(
    (after) => {
      const p = new URLSearchParams({
        author: name,
        limit: String(PAGE_SIZE),
        sort: "asc"
      });

      if (after != null) {
        p.set("after", String(after));
      }

      return `${AS_BASE}/comments/search?${p.toString()}`;
    },
    normAS,
    "comment"
  );

  let items = as.items;
  let source = as.items.length ? "arctic-shift" : null;
  let truncated = as.truncated;
  let pages = as.pages;

  if (!as.items.length || as.truncated) {
    const pp = await paginate(
      (after) => {
        const p = new URLSearchParams({
          author: name,
          size: String(PAGE_SIZE),
          sort: "asc",
          sort_type: "created_utc"
        });

        if (after != null) {
          p.set("after", String(after));
        }

        return `${PP_BASE}/comment/?${p.toString()}`;
      },
      normPP,
      "comment"
    );

    if (pp.items.length) {
      items = mergeItems(items, pp.items);
      source = source ? `${source}+pullpush` : "pullpush";
      truncated = truncated || pp.truncated;
      pages += pp.pages;
    }
  }

  return {
    items: items.slice(0, MAX_ITEMS_PER_TYPE),
    source,
    truncated,
    pages
  };
}

async function fetchAllPosts(name) {
  const as = await paginate(
    (after) => {
      const p = new URLSearchParams({
        author: name,
        limit: String(PAGE_SIZE),
        sort: "asc"
      });

      if (after != null) {
        p.set("after", String(after));
      }

      return `${AS_BASE}/posts/search?${p.toString()}`;
    },
    normAS,
    "post"
  );

  let items = as.items;
  let source = as.items.length ? "arctic-shift" : null;
  let truncated = as.truncated;
  let pages = as.pages;

  if (!as.items.length || as.truncated) {
    const pp = await paginate(
      (after) => {
        const p = new URLSearchParams({
          author: name,
          size: String(PAGE_SIZE),
          sort: "asc",
          sort_type: "created_utc"
        });

        if (after != null) {
          p.set("after", String(after));
        }

        return `${PP_BASE}/submission/?${p.toString()}`;
      },
      normPP,
      "post"
    );

    if (pp.items.length) {
      items = mergeItems(items, pp.items);
      source = source ? `${source}+pullpush` : "pullpush";
      truncated = truncated || pp.truncated;
      pages += pp.pages;
    }
  }

  return {
    items: items.slice(0, MAX_ITEMS_PER_TYPE),
    source,
    truncated,
    pages
  };
}

/* ---------- Cluster list ---------- */

let LIST = {
  version: 0,
  asOf: null,
  source: "none",
  clusters: [],
  index: new Map(),
  count: 0
};

function adoptList(raw, source) {
  if (!raw || !Array.isArray(raw.clusters)) {
    throw new Error("bad list shape");
  }

  const index = new Map();

  for (const cl of raw.clusters) {
    if (!cl || !Array.isArray(cl.accounts)) continue;

    for (const acc of cl.accounts) {
      if (!acc || !acc.name) continue;

      index.set(String(acc.name).toLowerCase(), {
        name: acc.name,
        cluster: cl.id || cl.label || "?",
        label: cl.label || cl.id || "cluster",
        brands: cl.brands || [],
        note: acc.note || ""
      });
    }
  }

  LIST = {
    version: raw.version ?? 0,
    asOf: raw.asOf || null,
    source,
    clusters: raw.clusters,
    index,
    count: index.size
  };

  return meta();
}

async function loadList() {
  try {
    const raw = await fetchJSON(chrome.runtime.getURL("data/list.json"));
    adoptList(raw, "bundled");
  } catch {
    LIST = {
      version: 0,
      asOf: null,
      source: "failed",
      clusters: [],
      index: new Map(),
      count: 0
    };
  }

  return meta();
}

function meta() {
  return {
    version: LIST.version,
    asOf: LIST.asOf,
    source: LIST.source,
    count: LIST.count || 0,
    name: chrome.runtime.getManifest().name,
    extVersion: chrome.runtime.getManifest().version
  };
}

/* ---------- Lookup / detail ---------- */

async function lookup(names) {
  const out = {};
  const now = Date.now();

  for (const n of names || []) {
    const key = String(n || "").toLowerCase();
    if (!key) continue;

    const hit = LIST.index.get(key);

    if (hit) {
      out[n] = {
        state: "listed",
        cluster: hit.cluster,
        label: hit.label
      };
      continue;
    }

    const cached = await cacheGet(key);

    if (cached && now - cached.ts < SCAN_TTL_MS) {
      out[n] = {
        state: "cached",
        index: cached.index,
        band: cached.band
      };
    }
  }

  return out;
}

async function detail(name) {
  const key = String(name || "").toLowerCase();

  const hit = LIST.index.get(key) || null;
  const cached = await cacheGet(key);

  const fresh =
    cached && Date.now() - cached.ts < SCAN_TTL_MS ? cached : null;

  return {
    listed: hit,
    scan: fresh,
    stale: cached && !fresh ? cached : null
  };
}

/* ---------- Account meta (Reddit about.json, runs in the user's browser) ---------- */

/*
  t2-id → creation-date estimation.

  Reddit assigns each account a fullname "t2_<base36>". Decode the base36
  number and interpolate a creation date from anchors: real accounts whose
  t2 id and (approximate) creation date are known. Calibrated 2026-09 from
  arctic-shift /api/users/search ids + first-archived-activity dates.

  Accuracy is a few months — good enough for the gestation (sleeper)
  signal, not for day-level claims.
*/
const T2_ANCHORS = [
  { utc: Date.UTC(2020, 1, 12) / 1000, id: 388042961977 }, // anchor: early-2020 account (first archived activity)
  { utc: 1653945823, id: 1861661513050 }, // anchor: mid-2022 account (exact creation date)
  { utc: Date.UTC(2025, 8, 9) / 1000, id: 167661436981889 }, // anchor: mid-2025 account (first archived activity)
  { utc: Date.UTC(2026, 4, 22) / 1000, id: 186205101743874 } // anchor: mid-2026 account (first archived activity)
];

function b36decode(s) {
  let n = 0;
  for (const ch of String(s)) {
    n = n * 36 + parseInt(ch, 36);
    if (Number.isNaN(n)) return null;
  }
  return n;
}

function estimateCreatedUtc(t2id) {
  const id = b36decode(t2id);
  if (id == null || id < T2_ANCHORS[0].id) return null;

  let lo = T2_ANCHORS[0];
  let hi = T2_ANCHORS[T2_ANCHORS.length - 1];

  for (let i = 0; i < T2_ANCHORS.length - 1; i++) {
    if (id >= T2_ANCHORS[i].id && id <= T2_ANCHORS[i + 1].id) {
      lo = T2_ANCHORS[i];
      hi = T2_ANCHORS[i + 1];
      break;
    }
  }

  // log-space interpolation (the counter grows faster than linear)
  const lx = Math.log(id);
  const ll = Math.log(lo.id);
  const lh = Math.log(hi.id);
  const frac = (lx - ll) / (lh - ll);
  return lo.utc + (hi.utc - lo.utc) * Math.min(1, Math.max(0, frac));
}

async function fetchAccountMeta(name) {
  const meta = {
    createdUtc: null,
    totalKarma: null,
    suspended: null,
    error: null
  };

  try {
    const res = await fetchJSON(
      `https://www.reddit.com/user/${encodeURIComponent(name)}/about.json`
    );
    const d = res && res.data;

    if (d) {
      meta.createdUtc = Number(d.created_utc) || null;
      meta.totalKarma =
        (Number(d.link_karma) || 0) + (Number(d.comment_karma) || 0);
      meta.suspended = Boolean(d.is_suspended);
    }
  } catch (err) {
    meta.error = String(err.message || err);
  }

  // Fallback: arctic-shift user index carries the t2 id even when Reddit's
  // about.json is unreachable (network blocks, suspended accounts).
  if (!meta.createdUtc && !meta.totalKarma) {
    try {
      const p = new URLSearchParams({
        author: name,
        limit: "5"
      });
      const res = await throttled(() =>
        fetchJSON(`${AS_BASE}/users/search?${p.toString()}`)
      );
      const u = extractItems(res).find((x) => x && x.id);

      if (u) {
        meta.createdUtc = estimateCreatedUtc(u.id) || null;
        meta.totalKarma = u._meta
          ? (Number(u._meta.total_karma) || 0)
          : meta.totalKarma;
        meta.estimated = true;
      }
    } catch {
      // best-effort fallback
    }
  }

  return meta;
}

/* ---------- Community bot-accusations ---------- */

const BOT_CALL_LEXICON = [
  /\bbot(s)?\b/i,
  /\bshill(s|ing)?\b/i,
  /\bastroturf/i,
  /\bspam(\s+account)?\b/i,
  /\bsock\s*puppet/i,
  /\bfarm(ing)?\s*(account|bot)?\b/i,
  /\bslop\b/i,
  /\bpaid\s+(actor|troll|poster)\b/i
];

const BOT_BOILERPLATE_RE =
  /\bi am a bot\b|this action was performed (automatically )?by a bot\b|performed automatically|contact the moderators of this subreddit/i;

function isBotCall(text, author) {
  const t = String(text || "");
  if (String(author || "").toLowerCase() === "automoderator") return false;
  if (BOT_BOILERPLATE_RE.test(t)) return false;
  return BOT_CALL_LEXICON.some((re) => re.test(t));
}

/**
 * Fetch replies to the account's most recent posts/comments and look for
 * community members calling the account out. Bounded: N_ITEMS requests.
 */
async function fetchAccusations(items, lite = false) {
  const out = [];

  if (!items.length) return out;

  const lastTs = items.reduce((m, x) => Math.max(m, x.ts), 0);
  const recent = items.filter((x) => lastTs - x.ts <= 7 * 86400).length;
  const bursting = items.length >= 20 && recent / items.length >= 0.4;

  // Burst accounts post so fast that a fixed count barely reaches back
  // (10 posts/day means 15 posts = 1.5 days). Scan a time window instead:
  // the newest items of the last 3 weeks, capped to keep the scan fast.
  // Lite (auto-scan) mode uses a smaller budget so a page full of
  // usernames stays fast; the manual deep scan uses the full budget.
  const windowDays = bursting ? 21 : 7;
  const nPosts = lite ? (bursting ? 10 : 3) : bursting ? 30 : 5;
  const nComments = lite ? (bursting ? 5 : 3) : bursting ? 10 : 5;

  const inWindow = (x) => lastTs - x.ts <= windowDays * 86400;

  const posts = items
    .filter((x) => x.kind === "post" && inWindow(x))
    .slice()
    .sort((a, b) => b.ts - a.ts)
    .slice(0, nPosts);
  const comments = items
    .filter((x) => x.kind === "comment" && inWindow(x))
    .slice()
    .sort((a, b) => b.ts - a.ts)
    .slice(0, nComments);

  const targets = [];

  for (const p of posts) {
    if (p.id && /^[a-z0-9]+$/i.test(String(p.id))) {
      targets.push(["link_id", String(p.id)]);
    }
  }

  for (const c of comments) {
    if (c.id && /^[a-z0-9]+$/i.test(String(c.id))) {
      targets.push(["parent_id", String(c.id)]);
    }
  }

  for (const [key, id] of targets) {
    try {
      const p = new URLSearchParams({
        [key]: `t${key === "link_id" ? "3" : "1"}_${id}`,
        limit: "100",
        sort: "desc"
      });
      const res = await throttled(() =>
        fetchJSON(`${AS_BASE}/comments/search?${p.toString()}`)
      );

      for (const c of extractItems(res)) {
        if (isBotCall(c.body, c.author)) {
          out.push({
            ts: Number(c.created_utc) || 0,
            body: String(c.body || ""),
            author: c.author || "?"
          });
        }
      }
    } catch {
      // Accusations are best-effort; never fail the whole scan.
    }
  }

  return out;
}

/* ---------- Deep scan ---------- */

const scanning = new Set();

async function deepScan(name, domHints = {}, lite = false) {
  const key = String(name || "").toLowerCase();

  if (!key) {
    return { error: "username required" };
  }

  if (scanning.has(key)) {
    return { error: "scan already running" };
  }

  scanning.add(key);

  try {
    const listed = LIST.index.get(key) || null;
    const brands = listed ? listed.brands : [];

    const [comments, posts, accountMeta] = await Promise.all([
      fetchAllComments(name),
      fetchAllPosts(name),
      fetchAccountMeta(name)
    ]);

    let items = mergeItems(comments.items, posts.items);

    // Sequential page-scans can trip the archive rate limiter, which
    // answers with silent empty pages. When BOTH feeds come back empty,
    // cool down and retry once before declaring the account unknown.
    if (!comments.items.length && !posts.items.length && items.length === 0) {
      await new Promise((r) => setTimeout(r, 12000));
      const [c2, p2] = await Promise.all([
        fetchAllComments(name),
        fetchAllPosts(name)
      ]);
      if (c2.items.length || p2.items.length) {
        comments.items = c2.items;
        comments.source = c2.source;
        comments.pages = c2.pages;
        comments.truncated = c2.truncated;
        posts.items = p2.items;
        posts.source = p2.source;
        posts.pages = p2.pages;
        posts.truncated = p2.truncated;
        items = mergeItems(comments.items, posts.items);
      }
    }

    // Last resort for creation date: the t2 fullname embedded in the
    // archive objects themselves (works even when Reddit and the
    // users/search index are both unreachable).
    if (!accountMeta.createdUtc && items.length) {
      const fn = items.find((i) => i.authorFullname)?.authorFullname;
      if (fn && String(fn).startsWith("t2_")) {
        accountMeta.createdUtc = estimateCreatedUtc(String(fn).slice(3));
        accountMeta.estimated = true;
      }
    }

    const sources = [];

    if (comments.source) sources.push(comments.source);

    if (posts.source && !sources.includes(posts.source)) {
      sources.push(posts.source);
    }

    const accusations = items.length
      ? await fetchAccusations(items, Boolean(lite))
      : [];

    const { out, evidence } = DCS.analyzeArchive(items, brands, {
      createdUtc: accountMeta.createdUtc,
      accusations
    });

    const totalKarma =
      Number(domHints.totalKarma || 0) || accountMeta.totalKarma || 0;

    let accountAgeDays = Number(domHints.accountAgeDays || 0);

    if (!accountAgeDays && accountMeta.createdUtc) {
      accountAgeDays = Math.max(
        0,
        Math.floor((Date.now() / 1000 - accountMeta.createdUtc) / 86400)
      );
    }

    const signals = {
      listed: listed ? 1 : 0,
      darkGaps: out.darkGaps,
      burst: out.burst,
      contentSpam: out.contentSpam,
      singlePurpose: out.singlePurpose,
      accused: out.accused,
      newbieLie: out.newbieLie,
      scrubbing: DCS.scrubbingSignal({
        totalKarma,
        archivedCount: out.raw.total ?? null
      }),
      karmaAge: DCS.karmaAgeSignal({
        totalKarma,
        accountAgeDays
      }),
      karmaFarming: out.karmaFarming,
      decisive: Boolean(out.decisive)
    };

    evidence.push(
      `fetched ${comments.items.length} comments, ${posts.items.length} posts`
    );

    if (comments.truncated || posts.truncated) {
      evidence.push("history truncated at scan cap");
    }

    if (!comments.items.length && comments.error) {
      evidence.push(`comment archive error: ${comments.error}`);
    }

    if (!posts.items.length && posts.error) {
      evidence.push(`post archive error: ${posts.error}`);
    }

    if (!sources.length) {
      evidence.push("archives returned nothing");
    }

    if (accountMeta.suspended) {
      evidence.push("account is suspended on Reddit");
    }

    if (accountMeta.createdUtc) {
      const ageY = (Date.now() / 1000 - accountMeta.createdUtc) / 31557600;
      evidence.push(
        `account age ~${ageY.toFixed(1)}y${
          accountMeta.estimated ? " (estimated from id)" : ""
        }`
      );
    }

    if (out.raw.total != null && totalKarma >= 5000) {
      evidence.push(
        `${out.raw.total} archived items vs ${(
          totalKarma / 1000
        ).toFixed(1)}k karma`
      );
    }

    const insufficient = items.length < 5 && !listed;

    let index = null;
    let bandId = "unknown";

    if (!insufficient) {
      index = DCS.computeIndex(signals);
      bandId = DCS.band(index).id;
    }

    const rec = {
      username: name,
      ts: Date.now(),
      index,
      band: bandId,
      signals,
      evidence,
      sources,
      domHints: {
        totalKarma,
        accountAgeDays
      },
      dataQuality: {
        items: items.length,
        comments: comments.items.length,
        posts: posts.items.length,
        commentPages: comments.pages,
        postPages: posts.pages,
        truncated: comments.truncated || posts.truncated,
        accusations: accusations.length,
        sources
      },
      listed: listed
        ? {
            cluster: listed.cluster,
            label: listed.label,
            note: listed.note
          }
        : null
    };

    await cachePut(name, rec);

    return rec;
  } finally {
    scanning.delete(key);
  }
}

/* ---------- Message hub ---------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    const type = msg && msg.type;

    switch (type) {
      case "getMeta": {
        sendResponse({ meta: meta() });
        break;
      }

      case "lookup": {
        sendResponse(await lookup(msg.names || []));
        break;
      }

      case "detail": {
        sendResponse(await detail(msg.name));
        break;
      }

      case "deepScan": {
        sendResponse(
          await deepScan(msg.name, msg.domHints || {}, Boolean(msg.lite))
        );
        break;
      }

      case "refreshList": {
        sendResponse(await loadList());
        break;
      }

      case "clearCache": {
        try {
          const db = await idb();

          await new Promise((resolve) => {
            const tx = db.transaction("scans", "readwrite");
            tx.objectStore("scans").clear();
            tx.oncomplete = resolve;
            tx.onerror = resolve;
            tx.onabort = resolve;
          });

          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: String(err) });
        }

        break;
      }

      default: {
        sendResponse({ error: "unknown message" });
      }
    }
  })().catch((e) => sendResponse({ error: String(e) }));

  return true;
});

/* ---------- Lifecycle ---------- */

chrome.runtime.onInstalled.addListener(() => loadList());
chrome.runtime.onStartup.addListener(() => loadList());