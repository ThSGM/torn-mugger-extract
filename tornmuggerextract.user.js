// ==UserScript==
// @name         Torn Mugger Extractor
// @namespace    torn-mugger-extract
// @version      1.3
// @description  Extract names/IDs of everyone who mugged/attacked you from the Torn activity log.
// @author       a1ry [3583932]
// @match        https://www.torn.com/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      ffscouter.com
// @updateURL    https://raw.githubusercontent.com/ThSGM/torn-mugger-extract/main/tornmuggerextract.user.js
// @downloadURL  https://raw.githubusercontent.com/ThSGM/torn-mugger-extract/main/tornmuggerextract.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---- config -------------------------------------------------------
  const XID_RE = /XID=(\d+)/;
  // Full sentence anchor: captures the subject name up front, so we never
  // have to guess which nearby profile link (e.g. your own, in a sidebar)
  // belongs to the line.
  const LINE_RE = /^(.*?)\s+mugged you for \$([\d,]+)\s+sending you to the hospital for ([0-9]+h [0-9]+m|[0-9]+m)/i;

  // The "Attack / Mug received" log — the only page this scraper works on.
  const TARGET_LOG_URL = 'https://www.torn.com/page.php?sid=log&log=8156';

  function isOnTargetPage() {
    try {
      const u = new URL(window.location.href);
      return u.pathname === '/page.php' && u.searchParams.get('sid') === 'log' && u.searchParams.get('log') === '8156';
    } catch (e) {
      return false;
    }
  }

  const FFSCOUT_URL = 'https://ffscouter.com/api/v1/get-stats';
  const FFSCOUT_CHUNK = 100; // targets per request, kept conservative
  const DEFAULT_MAX_AGE_DAYS = 7;
  const DEFAULT_FF_MIN = 0;
  const DEFAULT_FF_MAX = 1.5;

  // Per-row abbreviated time, e.g. "6d", "22d", "1mo" — checked against the
  // START of an ancestor's full text (the row wraps the icon + sentence).
  const ROW_TIME_RE = /^(\d+)\s*(mo|[hdwy])\b/i;
  // Section header, e.g. "6 DAYS AGO", "1 MONTH AGO", "TODAY".
  const HEADER_RE = /^(TODAY|YESTERDAY|(\d+)\s*(HOUR|HOURS|DAY|DAYS|WEEK|WEEKS|MONTH|MONTHS|YEAR|YEARS)\s*AGO)$/i;

  function unitToDays(num, unit) {
    const u = unit.toLowerCase();
    if (u === 'h' || u.startsWith('hour')) return num / 24;
    if (u === 'd' || u.startsWith('day')) return num;
    if (u === 'w' || u.startsWith('week')) return num * 7;
    if (u === 'mo' || u.startsWith('month')) return num * 30;
    if (u === 'y' || u.startsWith('year')) return num * 365;
    return null;
  }

  function headerToDays(text) {
    if (/^TODAY$/i.test(text)) return 0;
    if (/^YESTERDAY$/i.test(text)) return 1;
    const m = text.match(HEADER_RE);
    if (!m || !m[2]) return null;
    return unitToDays(parseInt(m[2], 10), m[3]);
  }

  // ---- scraping -------------------------------------------------------

  // Find the smallest (deepest) elements whose own text matches `regex`.
  // Starting from the matched *line* rather than walking up from every
  // profile link on the page is what keeps this from picking up unrelated
  // links (nav bar, sidebar, "your profile" etc.) that happen to sit in
  // some shared ancestor with a real log entry.
  function findMinimalMatches(regex) {
    const candidates = Array.from(document.querySelectorAll('body *')).filter((el) =>
      regex.test(el.textContent.replace(/\s+/g, ' ').trim())
    );
    return candidates.filter(
      (el) => !candidates.some((other) => other !== el && el.contains(other))
    );
  }

  // Climb from the matched line element looking for the row wrapper that
  // starts with an abbreviated age like "6d" / "1mo" (finer-grained than
  // the section header, and specific to this one entry).
  function getRowDaysAgo(lineEl) {
    let el = lineEl;
    for (let i = 0; i < 8 && el; i++) {
      const t = el.textContent.replace(/\s+/g, ' ').trim();
      const m = t.match(ROW_TIME_RE);
      if (m) return unitToDays(parseInt(m[1], 10), m[2]);
      el = el.parentElement;
    }
    return null;
  }

  // Nearest preceding section header ("6 DAYS AGO" etc.) in document order,
  // used as a fallback when the per-row abbreviation can't be found.
  function buildHeaderMap(lineEls) {
    const lineSet = new Set(lineEls);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let currentHeader = null;
    const map = new Map();
    let node;
    while ((node = walker.nextNode())) {
      if (node.children.length === 0) {
        const t = node.textContent.replace(/\s+/g, ' ').trim();
        if (HEADER_RE.test(t)) currentHeader = t;
      }
      if (lineSet.has(node)) map.set(node, currentHeader);
    }
    return map;
  }

  function estimatedDateFromDays(days) {
    if (days == null) return null;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - Math.round(days));
    return d.toISOString().slice(0, 10); // YYYY-MM-DD, sortable as text
  }

  function scrapeVisible() {
    const events = [];
    const anonymous = [];

    const lines = findMinimalMatches(LINE_RE);
    const headerMap = buildHeaderMap(lines);

    lines.forEach((el) => {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      const m = text.match(LINE_RE);
      if (!m) return;
      const name = m[1].trim();
      const amt = parseInt(m[2].replace(/,/g, ''), 10);
      const hosp = m[3];

      // Attack log link ("[view]") lives inside the same line.
      const logAnchor = Array.from(el.querySelectorAll('a[href*="sid=attackLog"]'))[0];
      const logUrl = logAnchor ? logAnchor.href : null;

      let daysAgo = getRowDaysAgo(el);
      if (daysAgo == null) {
        const headerText = headerMap.get(el);
        daysAgo = headerText ? headerToDays(headerText) : null;
      }
      const estimatedDate = estimatedDateFromDays(daysAgo);

      if (/anonymously$/i.test(name) || /^someone$/i.test(name)) {
        anonymous.push({ raw: text, amount: amt, hospital: hosp, logUrl, daysAgo, estimatedDate });
        return;
      }

      // Only accept a profile link that lives INSIDE this specific line
      // and whose visible text matches the name the sentence names —
      // this is what rules out an unrelated link merely sitting nearby.
      const anchor = Array.from(el.querySelectorAll('a[href*="profiles.php?XID="]')).find(
        (a) => a.textContent.trim() === name
      );
      if (!anchor) {
        // Named in the sentence but we couldn't safely bind an ID to it —
        // report it as such rather than silently guessing.
        anonymous.push({
          raw: `${text} (no matching profile link found)`,
          amount: amt,
          hospital: hosp,
          logUrl,
          daysAgo,
          estimatedDate,
        });
        return;
      }
      const idMatch = anchor.getAttribute('href').match(XID_RE);
      if (!idMatch) return;
      const id = idMatch[1];

      events.push({
        id,
        name,
        url: `https://www.torn.com/profiles.php?XID=${id}`,
        attackUrl: `https://www.torn.com/page.php?sid=attack&user2ID=${id}`,
        amount: amt,
        hospital: hosp,
        logUrl,
        daysAgo,
        estimatedDate,
        raw: text,
      });
    });

    // aggregated per-attacker summary, derived from the event list
    const summaryMap = new Map();
    events.forEach((ev) => {
      const rec = summaryMap.get(ev.id) || {
        id: ev.id,
        name: ev.name,
        url: ev.url,
        count: 0,
        totalTaken: 0,
        mostRecentDaysAgo: Infinity,
      };
      rec.count += 1;
      rec.totalTaken += ev.amount;
      if (ev.daysAgo != null) rec.mostRecentDaysAgo = Math.min(rec.mostRecentDaysAgo, ev.daysAgo);
      summaryMap.set(ev.id, rec);
    });

    return { events, named: Array.from(summaryMap.values()), anonymous };
  }

  // ---- FFScouter stat lookup ------------------------------------------
  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 20000,
        onload: resolve,
        onerror: () => reject(new Error('network error contacting FFScouter')),
        ontimeout: () => reject(new Error('FFScouter request timed out')),
      });
    });
  }

  // Mirrors the filtering logic of the existing Python fetch_ffscout(): a
  // flat JSON list of {player_id, fair_fight, bs_estimate, last_updated}, entries older
  // than maxAgeDays are kept but flagged stale rather than dropped, so the
  // CSV shows what happened instead of silently omitting rows.
  async function fetchFFScoutStats(ids, apiKey, maxAgeDays, onProgress) {
    const statsMap = new Map(); // id -> { bsEstimate, fairFight, ageDays, stale }
    const uniqueIds = Array.from(new Set(ids));
    for (let i = 0; i < uniqueIds.length; i += FFSCOUT_CHUNK) {
      const chunk = uniqueIds.slice(i, i + FFSCOUT_CHUNK);
      const url = `${FFSCOUT_URL}?key=${encodeURIComponent(apiKey)}&targets=${chunk.join(',')}`;
      if (onProgress) onProgress(i, uniqueIds.length);
      const res = await gmGet(url);
      if (res.status !== 200) {
        throw new Error(`FFScouter HTTP ${res.status}: ${(res.responseText || '').slice(0, 150)}`);
      }
      let data;
      try {
        data = JSON.parse(res.responseText);
      } catch (e) {
        throw new Error('FFScouter: could not parse response as JSON');
      }
      if (data && !Array.isArray(data) && data.error) {
        throw new Error(`FFScouter API error: ${data.error}`);
      }
      if (!Array.isArray(data)) continue;
      const now = Date.now() / 1000;
      data.forEach((u) => {
        if (u.bs_estimate == null && u.fair_fight == null) return;
        const ageDays = (now - (u.last_updated || 0)) / 86400;
        statsMap.set(String(u.player_id), {
          bsEstimate: u.bs_estimate ?? null,
          fairFight: u.fair_fight ?? null,
          ageDays: Math.round(ageDays * 10) / 10,
          stale: maxAgeDays != null && ageDays > maxAgeDays,
        });
      });
    }
    return statsMap;
  }

  // Merge stats into both the per-attacker summary and the per-event rows
  // (events repeat the same id, so the same stat is copied onto every row).
  function applyFFScoutStats(result, statsMap) {
    [...result.named, ...result.events].forEach((r) => {
      const s = statsMap.get(String(r.id));
      r.bsEstimate = s ? s.bsEstimate : null;
      r.fairFight = s ? s.fairFight : null;
      r.statAgeDays = s ? s.ageDays : null;
      r.statStale = s ? s.stale : null;
    });
    return result;
  }

  // ---- fair fight filter ----------------------------------------------

  // Drops named attackers (and their events) whose FFScouter fair fight
  // score lies outside [min, max]. Anyone without a known FF score (stats
  // not fetched, or not in FFScouter) is kept — we can't judge them, so
  // they're not silently hidden. Anonymous entries are untouched.
  function filterByFairFight(result, min, max) {
    const inRange = (r) =>
      r.fairFight == null ||
      ((min == null || r.fairFight >= min) && (max == null || r.fairFight <= max));
    const named = result.named.filter(inRange);
    const keepIds = new Set(named.map((r) => r.id));
    const events = result.events.filter((e) => keepIds.has(e.id));
    return {
      ...result,
      events,
      named,
      filteredOut: result.named.length - named.length,
    };
  }

  // ---- export helpers -------------------------------------------------

  // Anonymous entries have no ID, no profile, no per-event detail worth
  // showing — they can't be attacked back, so they don't belong as rows.
  // They're rolled up into a single count/total tally instead.
  function tallyAnonymous(anonymous) {
    const total = anonymous.reduce((sum, a) => sum + (a.amount || 0), 0);
    return { count: anonymous.length, total };
  }

  // One row per mugging event (not per attacker), since the log URL and
  // date are per-event. Sorted most-recent-first (ascending days_since_attack).
  // Anonymous entries are excluded — see tallyAnonymous.
  function buildRows(events) {
    return events.slice().sort((a, b) => (a.daysAgo ?? Infinity) - (b.daysAgo ?? Infinity));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // YATA-style breakdown, e.g. 5,015,234,000 -> "5b 15m 234,000" — each
  // magnitude split out (trillions/billions/millions), remainder comma-grouped.
  function formatBattlestatBreakdown(n) {
    if (n == null) return '';
    let remaining = Math.round(Number(n));
    const units = [{ suffix: 't', value: 1e12 }, { suffix: 'b', value: 1e9 }, { suffix: 'm', value: 1e6 }];
    const parts = [];
    units.forEach((u) => {
      const count = Math.floor(remaining / u.value);
      if (count > 0) {
        parts.push(count + u.suffix);
        remaining -= count * u.value;
      }
    });
    if (remaining > 0 || parts.length === 0) parts.push(remaining.toLocaleString());
    return parts.join(' ');
  }

  const HTML_COLS = [
    { key: 'name', label: 'Name', type: 'string' },
    { key: 'id', label: 'ID', type: 'number' },
    { key: 'url', label: 'Profile', type: 'string', isLink: true, linkText: 'Profile' },
    { key: 'attackUrl', label: 'Attack', type: 'string', isLink: true, linkText: 'Attack' },
    { key: 'amount', label: 'Amount', type: 'number', isMoney: true },
    { key: 'hospital', label: 'Hospital Time', type: 'string' },
    { key: 'logUrl', label: 'Attack Log', type: 'string', isLink: true, linkText: 'Log' },
    { key: 'daysAgo', label: 'Days Since Attack', type: 'number' },
    { key: 'estimatedDate', label: 'Estimated Date', type: 'string' },
    { key: 'bsEstimate', label: 'FFS BS Estimate', type: 'number', isFormattedNumber: true },
    { key: 'fairFight', label: 'FFS Fair Fight', type: 'number' },
    { key: 'statAgeDays', label: 'FFS Stat Age (d)', type: 'number' },
    { key: 'statStale', label: 'FFS Stale', type: 'string' },
  ];

  // A standalone HTML page (no external dependencies) with a table you can
  // click column headers on to sort ascending/descending. Opened directly
  // in a new tab — nothing to install, just double-click if saved to disk.
  function buildHTMLPage(events, anonymous) {
    const all = buildRows(events);
    const anon = tallyAnonymous(anonymous);

    const theadCells = HTML_COLS
      .map((c, i) => `<th onclick="sortByColumn(${i})" data-type="${c.type}">${escapeHtml(c.label)}</th>`)
      .join('');

    const tbodyRows = all.map((e) => {
      const cells = HTML_COLS.map((c) => {
        const raw = e[c.key];
        let display;
        let sortVal;
        if (c.isLink) {
          display = raw ? `<a href="${escapeHtml(raw)}" target="_blank" rel="noopener">${c.linkText}</a>` : '';
          sortVal = raw ? '1' : '0';
        } else if (c.isMoney) {
          display = raw != null ? '$' + Number(raw).toLocaleString() : '';
          sortVal = raw == null ? '' : String(raw);
        } else if (c.isFormattedNumber) {
          // YATA-style breakdown (e.g. "5b 15m 234,000") for readability,
          // but data-sort keeps the raw numeric value so ordering stays
          // numeric, not alphabetical on the formatted string.
          display = raw != null ? formatBattlestatBreakdown(raw) : '';
          sortVal = raw == null ? '' : String(raw);
        } else {
          display = raw == null ? '' : escapeHtml(String(raw));
          sortVal = raw == null ? '' : String(raw);
        }
        return `<td data-sort="${escapeHtml(sortVal)}">${display}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('\n');

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Torn Mugger Log</title>
<style>
  body { font: 14px/1.4 -apple-system, sans-serif; background: #fafafa; color: #111; margin: 24px; }
  h1 { font-size: 18px; }
  table { border-collapse: collapse; width: 100%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.15); }
  th, td { padding: 6px 10px; border-bottom: 1px solid #eee; text-align: left; white-space: nowrap; }
  th { position: sticky; top: 0; background: #222; color: #fff; cursor: pointer; user-select: none; }
  th:hover { background: #333; }
  th.sort-asc::after { content: ' \\25B2'; }
  th.sort-desc::after { content: ' \\25BC'; }
  tr:nth-child(even) { background: #f5f5f5; }
  tr:hover { background: #eef6ff; }
  a { color: #1a5fb4; }
  .anon-tally { margin-top: 12px; color: #444; }
</style>
</head>
<body>
<h1>Torn Mugger Log — ${all.length} identified entries (click a column header to sort)</h1>
<table id="t">
<thead><tr>${theadCells}</tr></thead>
<tbody>
${tbodyRows}
</tbody>
</table>
<p class="anon-tally">Anonymous (unidentified) attackers: ${anon.count} attacks, $${anon.total.toLocaleString()} total taken. These can't be attacked back, so they're excluded from the table above.</p>
<script>
var sortState = { col: null, dir: 1 };
function sortByColumn(idx) {
  console.log('[Torn Mugger Log] sorting column', idx);
  var table = document.getElementById('t');
  var ths = table.querySelectorAll('th');
  var th = ths[idx];
  var type = th.getAttribute('data-type');
  var dir = sortState.col === idx ? -sortState.dir : 1;
  sortState = { col: idx, dir: dir };
  var tbody = table.querySelector('tbody');
  var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
  rows.sort(function (a, b) {
    var av = a.children[idx].getAttribute('data-sort');
    var bv = b.children[idx].getAttribute('data-sort');
    if (type === 'number') {
      var an = parseFloat(av), bn = parseFloat(bv);
      var aNil = av === '' || isNaN(an), bNil = bv === '' || isNaN(bn);
      if (aNil && bNil) return 0;
      if (aNil) return 1;
      if (bNil) return -1;
      return (an - bn) * dir;
    }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
  for (var i = 0; i < rows.length; i++) tbody.appendChild(rows[i]);
  for (var j = 0; j < ths.length; j++) ths[j].className = '';
  th.className = dir === 1 ? 'sort-asc' : 'sort-desc';
}
console.log('[Torn Mugger Log] sortable table script loaded,', document.querySelectorAll('#t tbody tr').length, 'rows');
</script>
</body>
</html>`;
  }

  function downloadBlob(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Downloads (rather than opens in a tab) deliberately: Torn's own CSP
  // blocks inline <script> in anything opened with window.open from a
  // torn.com page, because blob: URLs inherit the creating page's CSP.
  // A file opened from disk (file://) has no CSP at all, so the sort
  // script runs fine there.
  function downloadSortableTable(events, anonymous) {
    const html = buildHTMLPage(events, anonymous);
    downloadBlob('torn-muggers.html', html, 'text/html');
  }

  // ---- YATA export ------------------------------------------------------
  // Mirrors generate_yata_list(): a template entry per attacker with mostly
  // placeholder values (YATA/Torn API fields we don't have access to from
  // this page), keyed by attacker ID, with a note carrying the FFScout
  // battlestat estimate and how much they've stolen from you in total.

  const YATA_DEFAULTS = {
    life_current: 890,
    life_maximum: 890,
    status_description: 'H for 4 hrs 1 mins ',
    status_details: 'Hospitalized by someone',
    status_color: 'red',
    status_state: 'Hospital',
    status_until: 1774576204,
    level: 16,
    last_action_relative: '7 hours ago',
    last_action_timestamp: 1774535487,
    last_action_status: 'Offline',
    update_timestamp: 1774561705,
    last_attack_attacker: true,
    last_attack_timestamp: 0,
    color: 0,
    result: '',
    fair_fight: 1.0,
    flat_respect: 0.9431471805599453,
    base_respect: 0.9431471805599453,
    win: 1,
  };

  const YATA_FIELD_ORDER = [
    'name', 'life_current', 'life_maximum', 'status_description', 'status_details',
    'status_color', 'status_state', 'status_until', 'level', 'last_action_relative',
    'last_action_timestamp', 'last_action_status', 'update_timestamp',
    'last_attack_attacker', 'last_attack_timestamp', 'note', 'color', 'result',
    'fair_fight', 'flat_respect', 'base_respect', 'win',
  ];

  // NOTE: this abbreviation (K/M/B, 1 decimal place) is a guess at your
  // Python script's format_stat_estimate() — I don't have that function's
  // source. Swap this out if your real formatting differs.
  function formatStatEstimate(bs) {
    if (bs == null) return '---';
    const n = Number(bs);
    if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + 'b';
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'm';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  function buildYataData(named) {
    const data = {};
    named.forEach((r) => {
      const bsNote = formatStatEstimate(r.bsEstimate);
      const stolen = '$' + (r.totalTaken || 0).toLocaleString();
      const note = `BS: ${bsNote} | Stolen: ${stolen} (${r.count} mug${r.count === 1 ? '' : 's'})`;

      const entryValues = { ...YATA_DEFAULTS, name: r.name, note };
      if (r.fairFight != null) entryValues.fair_fight = r.fairFight;
      const ordered = {};
      YATA_FIELD_ORDER.forEach((k) => { ordered[k] = entryValues[k]; });
      data[String(r.id)] = ordered;
    });
    return data;
  }

  function downloadYataJSON(named) {
    const data = buildYataData(named);
    downloadBlob('yata_import.json', JSON.stringify(data, null, 2), 'application/json');
  }

  // ---- UI ---------------------------------------------------------------
  function buildPanel() {
    const style = document.createElement('style');
    style.textContent = `
      #tme-panel button {
        width: 100%; margin-bottom: 6px; padding: 8px 10px;
        background: #3b82f6; color: #fff; border: none; border-radius: 4px;
        font: 12px/1.3 sans-serif; font-weight: 600; cursor: pointer;
      }
      #tme-panel button:hover:not(:disabled) { background: #2563eb; }
      #tme-panel button:disabled { background: #3a3a3a; color: #888; cursor: not-allowed; }
      #tme-panel input {
        background: #111; color: #eee; border: 1px solid #555; padding: 4px;
      }
      #tme-panel #tme-collapse {
        width: auto; margin: 0; padding: 0 6px; background: transparent;
        color: #eee; font-size: 14px; line-height: 1;
      }
      #tme-panel #tme-collapse:hover { background: #333; }
      #tme-panel.tme-collapsed { width: auto; }
      #tme-panel.tme-collapsed #tme-body { display: none; }
      #tme-panel.tme-collapsed #tme-header { margin-bottom: 0; }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'tme-panel';
    panel.style.cssText = `
      position: fixed; top: 80px; right: 12px; z-index: 999999;
      background: #1e1e1e; color: #eee; font: 12px/1.4 sans-serif;
      padding: 10px; border-radius: 6px; box-shadow: 0 2px 10px rgba(0,0,0,.5);
      width: 240px;
    `;
    panel.innerHTML = `
      <div id="tme-header" style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px;">
        <span style="font-weight:bold;">Mugger Extractor</span>
        <button id="tme-collapse" title="Collapse / expand">&minus;</button>
      </div>
      <div id="tme-body">
      <div id="tme-nav-warning" style="display:none; margin-bottom:8px; padding:8px; background:#7c2d12; border-radius:4px;">
        You're not on the Attack/Mug log page.
        <button id="tme-nav-btn" style="margin-top:6px; background:#f97316;">Go to Attack &amp; Mug Log</button>
      </div>
      <button id="tme-scrape">1. Scrape visible</button>
      <div id="tme-status" style="margin:6px 0; opacity:.8;"></div>
      <hr style="border-color:#444; margin:8px 0;">
      <div style="font-weight:bold; margin-bottom:4px;">2. FFScouter stats (optional)</div>
      <input id="tme-ffs-key" type="password" placeholder="Enter API key used by FFScouter"
        style="width:100%; box-sizing:border-box; margin-bottom:4px;">
      <div style="display:flex; align-items:center; gap:4px; margin-bottom:6px;">
        <label for="tme-ffs-age" style="flex:1;">Max age (days)</label>
        <input id="tme-ffs-age" type="number" min="0" step="1" style="width:50px;">
      </div>
      <button id="tme-ffs-fetch" disabled>2. Fetch FFScouter stats</button>
      <div id="tme-ffs-status" style="margin:2px 0 4px; opacity:.8;"></div>
      <div style="display:flex; align-items:center; gap:4px; margin-bottom:4px;">
        <label style="flex:1;" title="Exports skip attackers whose fair fight score is outside this range (unknown FF is kept)">Fair fight range</label>
        <input id="tme-ff-min" type="number" min="0" step="0.1" placeholder="min" style="width:45px;">
        <span>&ndash;</span>
        <input id="tme-ff-max" type="number" min="0" step="0.1" placeholder="max" style="width:45px;">
      </div>
      <hr style="border-color:#444; margin:8px 0;">
      <button id="tme-html" disabled>3. Download sortable table (HTML)</button>
      <button id="tme-yata" disabled>3. Download YATA JSON</button>
      <button id="tme-json" disabled>3. Copy JSON</button>
      <hr style="border-color:#444; margin:8px 0;">
      <div style="opacity:.85; font-size:11px; line-height:1.5;">
        Manually scroll to the bottom (or where desired) of your "Attack mug receive" log screen.
        Press to scrape. Can add FFScouter API code to retrieve estimated stats.
        Output to HTML to get a website to attack or JSON to import into yata.yt targets list.
        Exports only include attackers within the fair fight range (once stats are fetched).
      </div>
      </div>
    `;
    document.body.appendChild(panel);

    if (!isOnTargetPage()) {
      panel.querySelector('#tme-nav-warning').style.display = 'block';
    }
    panel.querySelector('#tme-nav-btn').addEventListener('click', () => {
      window.location.href = TARGET_LOG_URL;
    });

    const collapseBtn = panel.querySelector('#tme-collapse');
    function setCollapsed(collapsed) {
      panel.classList.toggle('tme-collapsed', collapsed);
      collapseBtn.innerHTML = collapsed ? '+' : '&minus;';
      GM_setValue('panel_collapsed', collapsed);
    }
    setCollapsed(GM_getValue('panel_collapsed', false));
    collapseBtn.addEventListener('click', () => setCollapsed(!panel.classList.contains('tme-collapsed')));

    let lastResult = null;
    const status = panel.querySelector('#tme-status');
    const htmlBtn = panel.querySelector('#tme-html');
    const yataBtn = panel.querySelector('#tme-yata');
    const jsonBtn = panel.querySelector('#tme-json');
    const ffsKeyInput = panel.querySelector('#tme-ffs-key');
    const ffsAgeInput = panel.querySelector('#tme-ffs-age');
    const ffsFetchBtn = panel.querySelector('#tme-ffs-fetch');
    const ffsStatus = panel.querySelector('#tme-ffs-status');
    const ffMinInput = panel.querySelector('#tme-ff-min');
    const ffMaxInput = panel.querySelector('#tme-ff-max');

    // persist the key/max-age locally (per-browser, via the userscript
    // manager's own storage) so you don't have to retype them every visit
    ffsKeyInput.value = GM_getValue('ffs_api_key', '');
    ffsAgeInput.value = GM_getValue('ffs_max_age_days', DEFAULT_MAX_AGE_DAYS);
    ffsKeyInput.addEventListener('change', () => GM_setValue('ffs_api_key', ffsKeyInput.value.trim()));
    ffsAgeInput.addEventListener('change', () => GM_setValue('ffs_max_age_days', ffsAgeInput.value));
    ffMinInput.value = GM_getValue('ff_min', DEFAULT_FF_MIN);
    ffMaxInput.value = GM_getValue('ff_max', DEFAULT_FF_MAX);
    ffMinInput.addEventListener('change', () => GM_setValue('ff_min', ffMinInput.value));
    ffMaxInput.addEventListener('change', () => GM_setValue('ff_max', ffMaxInput.value));

    // The result as it should be exported: lastResult with attackers
    // outside the fair fight range removed. An empty box means no bound.
    function exportResult() {
      const min = ffMinInput.value === '' ? null : parseFloat(ffMinInput.value);
      const max = ffMaxInput.value === '' ? null : parseFloat(ffMaxInput.value);
      return filterByFairFight(lastResult, min, max);
    }

    function filterNote(r) {
      return r.filteredOut ? ` (${r.filteredOut} outside FF range skipped)` : '';
    }

    function finish(result) {
      lastResult = result;
      status.textContent =
        `${result.events.length} events / ${result.named.length} unique, ${result.anonymous.length} anonymous`;
      htmlBtn.disabled = false;
      yataBtn.disabled = false;
      jsonBtn.disabled = false;
      ffsFetchBtn.disabled = result.named.length === 0;
      console.log('[Torn Mugger Extractor]', result);
    }

    panel.querySelector('#tme-scrape').addEventListener('click', () => {
      finish(scrapeVisible());
    });

    htmlBtn.addEventListener('click', () => {
      if (!lastResult) return;
      const r = exportResult();
      downloadSortableTable(r.events, r.anonymous);
      status.textContent = `torn-muggers.html downloaded${filterNote(r)} — open it from your Downloads folder.`;
    });

    yataBtn.addEventListener('click', () => {
      if (!lastResult) return;
      const r = exportResult();
      downloadYataJSON(r.named);
      status.textContent = `yata_import.json downloaded${filterNote(r)}.`;
    });

    jsonBtn.addEventListener('click', () => {
      if (!lastResult) return;
      const r = exportResult();
      const text = JSON.stringify(r, null, 2);
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text);
      } else {
        navigator.clipboard.writeText(text);
      }
      status.textContent = `JSON copied to clipboard${filterNote(r)}`;
    });

    ffsFetchBtn.addEventListener('click', async () => {
      if (!lastResult) return;
      const apiKey = ffsKeyInput.value.trim();
      if (!apiKey) {
        ffsStatus.textContent = 'Enter your FFScouter API key first.';
        return;
      }
      const maxAge = ffsAgeInput.value === '' ? null : parseFloat(ffsAgeInput.value);
      const ids = lastResult.named.map((r) => r.id);
      ffsFetchBtn.disabled = true;
      ffsStatus.textContent = `querying FFScouter for ${ids.length} targets...`;
      try {
        const statsMap = await fetchFFScoutStats(ids, apiKey, maxAge, (done, total) => {
          ffsStatus.textContent = `querying FFScouter... ${done}/${total}`;
        });
        applyFFScoutStats(lastResult, statsMap);
        const found = [...statsMap.values()].filter((s) => !s.stale).length;
        const stale = [...statsMap.values()].filter((s) => s.stale).length;
        ffsStatus.textContent = `${found} fresh, ${stale} stale (>${maxAge}d), ${ids.length - statsMap.size} not found`;
      } catch (e) {
        ffsStatus.textContent = `Error: ${e.message}`;
      } finally {
        ffsFetchBtn.disabled = false;
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel);
  } else {
    buildPanel();
  }
})();
