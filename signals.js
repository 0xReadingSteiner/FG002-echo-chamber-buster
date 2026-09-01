(function () {
  "use strict";

  /*
    Echo Chamber Buster — signal engine v0.3

    Full-story model. Every signal is computed from the account's complete
    archived history (comments + posts, chronological), plus optional account
    metadata (creation date, karma) when available. Missing metadata degrades
    the affected signal to 0 instead of poisoning the whole score.

    Signal weights:
      listed          0.20   on the known-cluster list
      darkGaps        0.15   long silences, repeated silences, recent wake
      burst           0.15   share of history in last 7d + velocity spike
      contentSpam     0.15   near-duplicate posts + gif/one-liner spam
      singlePurpose   0.10   activity concentrated in one subreddit
      accused         0.08   community replies calling the account a bot
      newbieLie       0.07   claims "first comment / new account" disproven
                             by its own archived history
      scrubbing       0.04   karma vs. archived volume (mass deletion)
      karmaAge        0.03   implausibly high karma per day of account life
      karmaFarming    0.03   explicit karma begging / farm subs / gif karma
  */

  const WEIGHTS = Object.freeze({
    listed: 0.2,
    darkGaps: 0.15,
    burst: 0.15,
    contentSpam: 0.15,
    singlePurpose: 0.1,
    accused: 0.08,
    newbieLie: 0.07,
    scrubbing: 0.04,
    karmaAge: 0.03,
    karmaFarming: 0.03
  });

  const BANDS = Object.freeze([
    {
      id: "high",
      min: 65,
      label: "HIGH",
      blurb: "multiple independent full-history signals"
    },
    {
      id: "elevated",
      min: 35,
      label: "ELEVATED",
      blurb: "one or two signals; needs a human look"
    },
    { id: "low", min: 0, label: "LOW", blurb: "consistent with organic use" }
  ]);

  const clamp01 = (x) => Math.max(0, Math.min(1, x));

  /* ---------------- text helpers ---------------- */

  function normText(t) {
    return String(t || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function triGrams(t) {
    const s = normText(t);
    if (s.length < 3) return new Set([s]);
    const set = new Set();
    for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3));
    return set;
  }

  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const g of a) if (b.has(g)) inter++;
    return inter / (a.size + b.size - inter);
  }

  const GIF_ONLY_RE =
    /^\s*(!\[gif\]\([^)]*\)|!\[img\]\([^)]*\)|https?:\/\/\S+\.(gif|gifv)(\?\S*)?)\s*$/i;
  const GIF_MARK_RE = /!\[gif\]\([^)]*\)/i;

  // Only account-self-referential claims. "my first comment", "first time
  // posting", "I'm never on here" — never bare "first time" (that matches
  // ordinary speech like "the first time I went to the doctor").
  const NEWBIE_CLAIM_RE =
    /(?:this\s+is\s+)?my\s+first\s+(reddit\s+)?(comment|post|account)|first\s+time\s+(posting|commenting|on\s+(?:here|reddit|this\s+(?:site|app)))|new\s+to\s+reddit|brand\s+new\s+account|just\s+(?:made|created)\s+(?:this|an|my)\s+account|(?:i(?:'m|\s+am)|im|i)\s+never\s+(?:use|on|comment|post)\s+(?:here|reddit|this\s+(?:site|app|shit))/i;

  const BEG_LEXICON = [
    "upvote me",
    "upvote my",
    "upvote this",
    "pls upvote",
    "please upvote",
    "upvotes appreciated",
    "karma for karma",
    "k4k",
    "free karma"
  ];

  const KARMA_FARM_SUBS = new Set([
    "freekarma4u",
    "freekarma4you",
    "freekarmasubs",
    "karmafarms",
    "upvote",
    "needkarma",
    "freekarma_4all",
    "karma4karma"
  ]);

  function containsKarmaBeg(text) {
    const t = ` ${normText(text)} `;
    return BEG_LEXICON.some((w) => t.includes(` ${w} `));
  }

  /* ---------------- archive analysis ---------------- */

  function sortedItems(items) {
    return items
      .filter((it) => it && Number(it.ts) > 0)
      .slice()
      .sort((a, b) => a.ts - b.ts);
  }

  /**
   * items: [{id, ts (unix s), subreddit, body, kind: 'comment'|'post'}]
   * brands: list of brand strings for sentiment (listed accounts)
   * meta: { createdUtc, totalKarma, commentKarma, linkKarma, accusations: [{ts, body, author}] }
   */
  function analyzeArchive(items, brands, meta = {}) {
    const evidence = [];
    const out = {
      darkGaps: 0,
      burst: 0,
      contentSpam: 0,
      singlePurpose: 0,
      accused: 0,
      newbieLie: 0,
      karmaFarming: 0,
      scrubbing: null,
      karmaAge: null,
      sentiment: null,
      raw: {}
    };

    const arr = sortedItems(items);

    out.raw.total = arr.length;

    if (!arr.length) {
      evidence.push("no archived items found");
      return { out, evidence };
    }

    const comments = arr.filter((x) => x.kind === "comment");
    const posts = arr.filter((x) => x.kind !== "comment");

    const firstTs = arr[0].ts;
    const lastTs = arr[arr.length - 1].ts;
    const spanDays = Math.max(1, (lastTs - firstTs) / 86400);

    out.raw.comments = comments.length;
    out.raw.posts = posts.length;
    out.raw.spanDays = Math.round(spanDays);

    /* ---------- darkGaps ---------- */

    /*
      darkGaps = dormancy structure, not raw gap size.

      Every long-lived human account has silences (vacations, abandoned
      years). What separates a parked bot is the FRACTION of its life that
      is dark, plus a deployment pop: waking from a long silence directly
      into a much higher posting rate.
    */
    const MIN_GAP = 45;
    const gaps = []; // {days, startTs, endTs}

    if (meta.createdUtc) {
      const g = (firstTs - meta.createdUtc) / 86400;
      if (g >= MIN_GAP) {
        gaps.push({ days: g, startTs: meta.createdUtc, endTs: firstTs, pre: true });
        out.raw.gestationDays = Math.round(g);
      }
    }

    for (let i = 1; i < arr.length; i++) {
      const g = (arr[i].ts - arr[i - 1].ts) / 86400;
      if (g >= MIN_GAP) {
        gaps.push({ days: g, startTs: arr[i - 1].ts, endTs: arr[i].ts, pre: false });
      }
    }

    const bigGaps = gaps
      .filter((g) => !g.pre)
      .map((g) => Math.round(g.days))
      .sort((a, b) => b - a);

    const maxGap = bigGaps.length ? bigGaps[0] : 0;
    const darkDays = gaps.reduce((s, g) => s + g.days, 0);
    const darkFrac = darkDays / spanDays;

    // dormancy share of the account's archived life
    let base = clamp01((darkFrac - 0.5) / 0.4);

    // one truly massive silence still counts on its own
    let maxComp = 0;
    if (maxGap >= 90) {
      maxComp = clamp01((maxGap - 90) / 220) * 0.3;
    }

    // deployment pop: woke from a long silence within the last 21 days
    // into a posting rate far above the pre-gap rate
    let wakeComp = 0;
    let wakeDays = null;
    let lastGap = null;
    for (const g of gaps) {
      if (g.days >= MIN_GAP) lastGap = g;
    }
    if (lastGap && !lastGap.pre) {
      const d = (lastTs - lastGap.endTs) / 86400;
      if (d <= 21) {
        const postDays = Math.max(1, d);
        const preDays = Math.max(1, (lastGap.endTs - firstTs) / 86400);
        const postRate = arr.filter((x) => x.ts >= lastGap.endTs).length / postDays;
        const preRate = arr.filter((x) => x.ts < lastGap.endTs).length / preDays;
        if (postRate >= preRate * 8 && postDays >= 1) {
          wakeComp = 0.3;
          wakeDays = Math.round(d);
        }
      }
    }

    // never posted for a long time before the first archived item
    if (out.raw.gestationDays != null && out.raw.gestationDays >= 90) {
      base = Math.max(base, 0.5);
    }

    out.darkGaps = clamp01(base + maxComp + wakeComp);

    out.raw.maxGapDays = Math.round(maxGap);
    out.raw.gapCount = bigGaps.length;
    out.raw.darkFrac = darkFrac;
    out.raw.gaps = bigGaps.slice(0, 5);

    if (bigGaps.length) {
      evidence.push(
        `dark gap${bigGaps.length > 1 ? "s" : ""}: ${bigGaps
          .slice(0, 3)
          .map((d) => `${d}d`)
          .join(", ")}${bigGaps.length > 3 ? "…" : ""}`
      );
    }
    if (out.raw.gestationDays != null && out.raw.gestationDays >= 90) {
      evidence.push(
        `account slept ${out.raw.gestationDays}d after creation before first post`
      );
    }
    if (wakeComp > 0) {
      evidence.push(
        `woke ${wakeDays === 0 ? "today" : `${wakeDays}d ago`} from a ${Math.round(lastGap.days)}d silence into ${wakeDays === 1 ? "a" : "an"} abnormally high posting rate`
      );
    }

    /* ---------- burst ---------- */

    const W7 = 7 * 86400;
    const W3 = 3 * 86400;

    const last7 = arr.filter((x) => lastTs - x.ts <= W7).length;
    const last3Posts = posts.filter((x) => lastTs - x.ts <= W3).length;

    const last7Frac = arr.length >= 12 ? last7 / arr.length : 0;
    const overallPostsPerDay = posts.length / spanDays;
    const recentPostsPerDay = last3Posts / 3;
    const spike = overallPostsPerDay > 0.02 ? recentPostsPerDay / overallPostsPerDay : 0;

    const fracScore = clamp01((last7Frac - 0.35) / 0.4);
    const spikeScore = clamp01((Math.log10(Math.max(1, spike)) - 0.4) / 1.2);

    out.burst =
      arr.length >= 12 ? clamp01(fracScore * 0.6 + spikeScore * 0.4) : 0;

    out.raw.last7 = last7;
    out.raw.last7Frac = last7Frac;
    out.raw.recentPostsPerDay = recentPostsPerDay;
    out.raw.overallPostsPerDay = overallPostsPerDay;

    if (last7Frac >= 0.4 && arr.length >= 20 && spanDays >= 60) {
      evidence.push(
        `${Math.round(last7Frac * 100)}% of all history (${last7}/${arr.length} items) in the last 7 days`
      );
    }
    if (spike >= 5) {
      evidence.push(
        `posts/day ${recentPostsPerDay.toFixed(1)} in last 3d vs ${overallPostsPerDay.toFixed(2)} lifetime`
      );
    }

    /* ---------- contentSpam ---------- */

    /*
      Duplicates only count inside ONE subreddit and close in time.
      Cross-posting the same post to two subs is normal human behavior;
      posting the same thing twice in the same sub inside a burst is spam.
    */
    let dupComponent = 0;
    let dupPairs = [];

    if (posts.length >= 5) {
      const grams = posts.map((p) => triGrams(p.body || ""));
      for (let i = 0; i < posts.length; i++) {
        for (let j = i + 1; j < posts.length; j++) {
          const sameSub =
            String(posts[i].subreddit || "").toLowerCase() ===
            String(posts[j].subreddit || "").toLowerCase();
          const closeInTime =
            Math.abs(posts[j].ts - posts[i].ts) <= 14 * 86400;
          // skip emptied bodies: all "[removed]" posts would otherwise
          // look "near-duplicate" of each other
          const bi = normText(posts[i].body || "");
          const bj = normText(posts[j].body || "");
          const empty = (b) => !b || b === "removed" || b === "deleted" || b.length < 10;
          if (
            !empty(bi) &&
            !empty(bj) &&
            sameSub &&
            closeInTime &&
            jaccard(grams[i], grams[j]) >= 0.75
          ) {
            dupPairs.push([posts[i], posts[j]]);
          }
        }
      }
      const involved = new Set();
      for (const [a, b] of dupPairs) {
        involved.add(a.id);
        involved.add(b.id);
      }
      const dupFrac = involved.size / posts.length;
      dupComponent = dupPairs.length >= 2 ? 1 : clamp01(dupFrac / 0.12) * 0.35;

      const removedPosts = posts.filter((p) => {
        const b = normText(p.body || "");
        return b === "removed" || b === "deleted";
      }).length;
      out.raw.removedPosts = removedPosts;
      if (removedPosts >= 3) {
        evidence.push(`${removedPosts} posts were later removed`);
      }
    }

    /*
      Low-effort content only counts when concentrated in the deployment
      subreddit (top sub ≥ 60% of activity). A human with a one-word
      commenting style spreads it across many communities over years;
      a bot's gif/one-liner spam lands almost entirely in its target sub.
    */
    let leComponent = 0;
    if (comments.length >= 10) {
      const subCounts = new Map();
      for (const it of arr) {
        const s = it.subreddit || "";
        subCounts.set(s, (subCounts.get(s) || 0) + 1);
      }
      const top = [...subCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const conc = top ? top[1] / arr.length : 0;

      if (conc >= 0.6) {
        let le = 0;
        let inTop = 0;
        for (const c of comments) {
          if ((c.subreddit || "") !== top[0]) continue;
          inTop++;
          const body = String(c.body || "");
          const t = normText(body);
          if (
            GIF_ONLY_RE.test(body) ||
            (GIF_MARK_RE.test(body) && t.length <= 40) ||
            t.length <= 25
          ) {
            le++;
          }
        }
        const leFrac = inTop ? le / inTop : 0;
        leComponent = clamp01((leFrac - 0.15) / 0.3);
        out.raw.lowEffortFrac = leFrac;

        if (leFrac >= 0.3) {
          evidence.push(
            `${Math.round(leFrac * 100)}% of comments in r/${top[0]} are gif-only or one-liners`
          );
        }
      }
    }

    out.contentSpam = clamp01(Math.max(dupComponent, leComponent));

    out.raw.dupPairs = dupPairs.length;
    if (dupPairs.length >= 2) {
      const ex = dupPairs
        .slice(0, 2)
        .map(
          ([a]) => `“${String(a.body || "").slice(0, 42).replace(/\s+/g, " ")}”`
        );
      evidence.push(`${dupPairs.length} near-duplicate posts (${ex.join(" / ")})`);
    }

    /*
      Decisive duplication: at extreme scale (>=20 pairs covering >=15%
      of all posts) near-duplicate posting is itself conclusive — no
      human posts the same text that many times. Marked decisive so it
      alone can corroborate a HIGH verdict (content farms, copypasta
      bots).
    */
    if (dupPairs.length >= 20) {
      const involved = new Set();
      for (const [a, b] of dupPairs) {
        involved.add(a.id);
        involved.add(b.id);
      }
      const frac = posts.length ? involved.size / posts.length : 0;
      out.raw.dupFrac = frac;
      if (frac >= 0.15) {
        out.decisive = true;
        evidence.push(
          `duplication at decisive scale: ${dupPairs.length} pairs covering ${Math.round(frac * 100)}% of posts`
        );
      }
    }

    /* ---------- singlePurpose ---------- */

    if (arr.length >= 30) {
      const bySub = new Map();
      for (const it of arr) {
        const s = it.subreddit || "";
        bySub.set(s, (bySub.get(s) || 0) + 1);
      }
      const top = [...bySub.entries()].sort((a, b) => b[1] - a[1])[0];
      const conc = top ? top[1] / arr.length : 0;
      out.raw.topSub = top ? top[0] : "";
      out.raw.topConc = conc;
      out.singlePurpose = clamp01((conc - 0.6) / 0.3);

      if (conc >= 0.75) {
        evidence.push(
          `${Math.round(conc * 100)}% of ${arr.length} items in one subreddit (r/${top[0]})`
        );
      }
    }

    /* ---------- accused ---------- */

    const accusations = Array.isArray(meta.accusations) ? meta.accusations : [];
    out.raw.accusationCount = accusations.length;
    if (accusations.length) {
      out.accused = clamp01(accusations.length / 2);
      evidence.push(
        `${accusations.length} community repl${accusations.length === 1 ? "y" : "ies"} call${
          accusations.length === 1 ? "s" : ""
        } this account a bot (e.g. “${String(accusations[0].body || "")
          .slice(0, 60)
          .replace(/\s+/g, " ")}”)`
      );
    }

    /* ---------- newbieLie ---------- */

    let lie = null;
    for (const it of arr) {
      if (NEWBIE_CLAIM_RE.test(String(it.body || ""))) {
        const hasOlder = arr.some(
          (x) => it.ts - x.ts > 30 * 86400 && x.id !== it.id
        );
        if (hasOlder) {
          lie = { ts: it.ts, body: it.body };
          break;
        }
      }
    }
    if (lie) {
      out.newbieLie = 1;
      evidence.push(
        `claims “${String(lie.body || "")
          .slice(0, 60)
          .replace(/\s+/g, " ")}” but archive shows activity months earlier`
      );
    }

    /* ---------- karmaFarming ---------- */

    let beg = 0;
    let farmSubs = 0;
    for (const it of arr) {
      if (containsKarmaBeg(it.body)) beg++;
      if (KARMA_FARM_SUBS.has(String(it.subreddit || "").toLowerCase())) {
        farmSubs++;
      }
    }
    out.raw.begHits = beg;
    out.raw.farmSubItems = farmSubs;
    out.karmaFarming = clamp01(beg / 3 + (farmSubs >= 5 ? 0.6 : farmSubs / 8));
    if (beg >= 1) {
      evidence.push(`explicit karma begging (“upvote me…”) ×${beg}`);
    }
    if (farmSubs >= 5) {
      evidence.push(`${farmSubs} items in free-karma farm subreddits`);
    }

    /* ---------- sentiment (listed accounts only) ---------- */

    if (Array.isArray(brands) && brands.length) {
      let mentions = 0;
      let negatives = 0;
      for (const it of arr) {
        const t = String(it.body || "").toLowerCase();
        if (brands.some((b) => t.includes(String(b).toLowerCase()))) {
          mentions++;
          negatives += negativeFracOf(it.body);
        }
      }
      out.raw.brandMentions = mentions;
      out.raw.negativeFrac = mentions ? negatives / mentions : null;
      out.sentiment = sentimentSignal({
        mentions,
        negativeFrac: out.raw.negativeFrac
      });
      if (mentions >= 3 && negatives === 0) {
        evidence.push(`${mentions} brand mentions, 0 negative`);
      }
    }

    return { out, evidence };
  }

  /* ---------------- account-meta signals ---------------- */

  function scrubbingSignal({ totalKarma = 0, archivedCount = null } = {}) {
    if (archivedCount == null || totalKarma < 5000) return 0;
    const expected = Math.max(30, totalKarma / 20);
    return clamp01(1 - archivedCount / expected);
  }

  function karmaAgeSignal({ totalKarma = 0, accountAgeDays = 0 } = {}) {
    if (!accountAgeDays || accountAgeDays <= 0 || !totalKarma) return 0;
    return clamp01(totalKarma / accountAgeDays / 150);
  }

  function sentimentSignal({ mentions = 0, negativeFrac = null } = {}) {
    if (mentions < 3 || negativeFrac == null) return 0;
    if (negativeFrac === 0) return 1;
    return clamp01(0.5 - negativeFrac);
  }

  /* ---------------- scoring ---------------- */

  const STRONG_SIGNALS = Object.freeze([
    "listed",
    "darkGaps",
    "burst",
    "contentSpam",
    "singlePurpose",
    "accused",
    "newbieLie"
  ]);

  function computeIndex(signals) {
    let idx = 0;
    for (const k in WEIGHTS) idx += WEIGHTS[k] * (signals[k] || 0);

    // HIGH requires at least 3 independent strong signals so a single
    // coincidence (one long vacation gap) can never trigger it.
    let strong = 0;
    for (const k of STRONG_SIGNALS) {
      if ((signals[k] || 0) >= 0.7) strong++;
    }

    // Multi-signal reinforcement: when 4+ independent signals fire
    // together, the composite is more suspicious than the sum of parts.
    if (strong >= 4) {
      idx += Math.min(0.24, (strong - 3) * 0.12);
    }

    // Conclusive duplication (>=20 pairs, >=15% of posts) is itself
    // enough: the composite rises to HIGH regardless of the other,
    // quieter signals.
    const decisive = Boolean(signals.decisive);
    if (decisive) idx = Math.max(idx, 0.78);

    let score = Math.round(idx * 100);

    const corroborated =
      decisive ||
      strong >= 3 ||
      ((signals.listed || 0) >= 0.99 && strong >= 2);

    if (score >= 65 && !corroborated) score = 64;
    return score;
  }

  function band(score) {
    return BANDS.find((b) => score >= b.min) || BANDS[BANDS.length - 1];
  }

  /* ---------------- sentiment lexicon ---------------- */

  const NEGATIVE_LEXICON = Object.freeze([
    "sucks",
    "terrible",
    "awful",
    "worst",
    "hate",
    "scam",
    "garbage",
    "avoid",
    "disappointing",
    "disappointed",
    "refuse",
    "refused",
    "broken",
    "useless",
    "overpriced",
    "nightmare",
    "lawsuit",
    "ripoff",
    "rip-off",
    "unacceptable",
    "incompetent"
  ].map((w) => w.trim().toLowerCase()));

  function containsNegative(text) {
    if (!text) return false;
    const t = ` ${normText(text)} `;
    return NEGATIVE_LEXICON.some((word) => t.includes(` ${word} `));
  }

  function negativeFracOf(text) {
    return containsNegative(text) ? 1 : 0;
  }

  const api = {
    WEIGHTS,
    BANDS,
    NEGATIVE_LEXICON,
    clamp01,
    normText,
    parkingSignal: () => 0, // v0.2 compatibility stub
    scrubbingSignal,
    sentimentSignal,
    karmaAgeSignal,
    computeIndex,
    band,
    analyzeArchive,
    negativeFracOf
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalThis.DCS = Object.freeze(api);
  }
})();
