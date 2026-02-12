(() => {
  'use strict';

  // -----------------------------
  // Constants / Storage
  // -----------------------------
  const STORAGE_KEY = 'wolf.v1.game';
  const POINTS_UNIT = 6; // store points as "sixths" to avoid floats (handles 1.5, 2/3, etc.)

  const SCREENS = {
    load: 'screenLoad',
    setup: 'screenSetup',
    game: 'screenGame',
    scoreboard: 'screenScoreboard',
  };

  // -----------------------------
  // DOM Helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function showScreen(name) {
    Object.values(SCREENS).forEach((sid) => $(sid).classList.add('hidden'));
    $(name).classList.remove('hidden');
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function formatPoints(units) {
    // units are in sixths
    const sign = units < 0 ? '-' : '';
    const abs = Math.abs(units);

    const whole = Math.floor(abs / POINTS_UNIT);
    const rem = abs % POINTS_UNIT;

    if (rem === 0) return `${sign}${whole}`;

    // reduce rem/6
    const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
    const g = gcd(rem, POINTS_UNIT);
    const num = rem / g;
    const den = POINTS_UNIT / g;

    if (whole === 0) return `${sign}${num}/${den}`;
    return `${sign}${whole} ${num}/${den}`;
  }

  function safeParse(json) {
    try { return JSON.parse(json); } catch { return null; }
  }

  // -----------------------------
  // Game State
  // -----------------------------
  /**
   * game = {
   *   id, createdAt,
   *   playerCount, players: [{id,name}],
   *   holeCount,
   *   options: { pushTies, blindWolf },
   *   holes: [ { partnerId|null, loneWolf:boolean, result:'WOLF'|'OTHER'|'TIE', blind:boolean } ],
   *   currentHoleIndex: 0
   * }
   */
  let game = null;

  function newGameTemplate() {
    return {
      id: crypto?.randomUUID?.() ?? String(Date.now()),
      createdAt: new Date().toISOString(),
      playerCount: 4,
      players: [
        { id: 'p1', name: 'Player 1' },
        { id: 'p2', name: 'Player 2' },
        { id: 'p3', name: 'Player 3' },
        { id: 'p4', name: 'Player 4' },
      ],
      holeCount: 12,
      options: { pushTies: false, blindWolf: false },
      holes: [],
      currentHoleIndex: 0,
      finishedAt: null,
    };
  }

  function ensureHolesLength() {
    if (!game) return;
    if (!Array.isArray(game.holes)) game.holes = [];
    while (game.holes.length < game.holeCount) {
      game.holes.push({
        partnerId: null,
        loneWolf: false,
        result: null,   // 'WOLF'|'OTHER'|'TIE'
        blind: false,
      });
    }
    if (game.holes.length > game.holeCount) {
      game.holes = game.holes.slice(0, game.holeCount);
    }
    game.currentHoleIndex = clamp(game.currentHoleIndex ?? 0, 0, game.holeCount - 1);
  }

  function saveGame() {
    if (!game) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(game));
    updateResumeButton();
  }

  function loadGame() {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? safeParse(raw) : null;
    if (!parsed || !parsed.players || !parsed.holes) return null;
    return parsed;
  }

  function clearGame() {
    localStorage.removeItem(STORAGE_KEY);
    game = null;
    updateResumeButton();
  }

  // -----------------------------
  // Rotation / Order helpers
  // -----------------------------
  function rotatedOrderForHole(holeIndex) {
    // holeIndex is 0-based
    const n = game.players.length;
    const offset = holeIndex % n;
    const base = game.players.map(p => p.id);

    // Right-rotation: last becomes first each hole
    const cut = (n - offset) % n;
    return base.slice(cut).concat(base.slice(0, cut));
  }


  function wolfIdForHole(holeIndex) {
    const order = rotatedOrderForHole(holeIndex);
    return order[order.length - 1];
  }

  function idToName(id) {
    return game.players.find(p => p.id === id)?.name ?? 'Unknown';
  }

  // -----------------------------
  // Scoring Engine (recompute from scratch)
  // -----------------------------
  function computeScores(g) {
    const totals = Object.fromEntries(g.players.map(p => [p.id, 0]));
    const perHole = []; // breakdown: {hole, mult, pushCount, desc}

    let pushCount = 0; // number of consecutive pushed ties leading into current hole

    for (let i = 0; i < g.holeCount; i++) {
      const h = g.holes[i] ?? {};
      const order = (function () {
        const n = g.players.length;
        const offset = i % n;
        const base = g.players.map(p => p.id);

        // Right-rotation: last becomes first each hole
        const cut = (n - offset) % n;
        return base.slice(cut).concat(base.slice(0, cut));
      })();


      const wolfId = order[order.length - 1];
      const others = order.slice(0, order.length - 1);

      const baseMult = (g.options.pushTies ? (pushCount + 1) : 1);
      const blindMult = (g.options.blindWolf && h.blind) ? 2 : 1;
      const mult = baseMult * blindMult;

      const multUnits = mult * POINTS_UNIT;

      // If no result yet, just record meta and continue
      if (!h.result) {
        perHole.push({
          hole: i + 1,
          mult,
          pushCount,
          desc: 'Not scored',
        });
        continue;
      }

      if (h.result === 'TIE') {
        perHole.push({
          hole: i + 1,
          mult,
          pushCount,
          desc: 'Tie',
        });
        if (g.options.pushTies) pushCount += 1;
        continue;
      }

      // Win/loss resets pushCount (for push-ties mode)
      if (g.options.pushTies) pushCount = 0;

      const isLone = !!h.loneWolf;

      if (isLone) {
        const k = others.length; // 3 or 4
        const swingUnits = k * 1 * multUnits; // wolf gains/loses k points (in units)
        if (h.result === 'WOLF') {
          totals[wolfId] += swingUnits;
          for (const pid of others) totals[pid] -= 1 * multUnits;
          perHole.push({ hole: i + 1, mult, pushCount: 0, desc: `Lone Wolf win (+${k} each)` });
        } else {
          totals[wolfId] -= swingUnits;
          for (const pid of others) totals[pid] += 1 * multUnits;
          perHole.push({ hole: i + 1, mult, pushCount: 0, desc: `Lone Wolf loss (-${k} each)` });
        }
        continue;
      }

      // Team hole
      const partnerId = h.partnerId;
      if (!partnerId || partnerId === wolfId) {
        // invalid / not chosen -> treat as not scored
        perHole.push({ hole: i + 1, mult, pushCount: 0, desc: 'Invalid partner (not scored)' });
        continue;
      }

      const wolfTeam = [wolfId, partnerId];
      const otherTeam = order.filter(pid => !wolfTeam.includes(pid));

      const winners = (h.result === 'WOLF') ? wolfTeam : otherTeam;
      const losers = (h.result === 'WOLF') ? otherTeam : wolfTeam;

      // pot = losers.length points, each loser pays 1 point (times mult)
      const potUnits = losers.length * 1 * multUnits;

      // each winner receives pot / winners.length
      // store as sixth-units: divisible for 4-player games; for 5-player games this yields thirds -> still integer with POINTS_UNIT=6
      const shareUnits = Math.floor(potUnits / winners.length); // should divide evenly with our unit choice
      // Safety: if not divisible, we still distribute with remainder to keep totals consistent
      const remainder = potUnits - (shareUnits * winners.length);

      for (const pid of losers) totals[pid] -= 1 * multUnits;

      // distribute to winners (with remainder to first winner)
      winners.forEach((pid, idx) => {
        totals[pid] += shareUnits + (idx === 0 ? remainder : 0);
      });

      const winLabel = (h.result === 'WOLF') ? 'Wolf Team win' : 'Other Team win';
      perHole.push({ hole: i + 1, mult, pushCount: 0, desc: `${winLabel} (pot ${losers.length})` });
    }

    return { totals, perHole };
  }

  // -----------------------------
  // UI: Setup
  // -----------------------------
  function renderHoleOptions() {
    const pc = Number($('playerCount').value);
    const holes = $('holeCount');
    holes.innerHTML = '';

    const suggested = pc === 4 ? [8, 12, 16, 20] : [10, 15, 20];
    suggested.forEach(v => {
      const opt = document.createElement('option');
      opt.value = String(v);
      opt.textContent = String(v);
      holes.appendChild(opt);
    });

    // default selection
    holes.value = String(pc === 4 ? 12 : 15);
  }

  function renderPlayerInputs() {
    const pc = Number($('playerCount').value);
    const wrap = $('playerInputs');
    wrap.innerHTML = '';

    for (let i = 0; i < pc; i++) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'playerNameInput';
      input.placeholder = `Player ${i + 1}`;
      input.value = game?.players?.[i]?.name ?? `Player ${i + 1}`;
      input.dataset.index = String(i);
      input.autocomplete = 'off';
      wrap.appendChild(input);
    }
  }

  function buildPlayersFromInputs() {
    const inputs = qsa('.playerNameInput');
    const players = inputs.map((inp, i) => ({
      id: `p${i + 1}`,
      name: (inp.value || `Player ${i + 1}`).trim(),
    }));
    return players;
  }

  // -----------------------------
  // UI: Game Screen
  // -----------------------------
  function setPartnerActive(partnerId) {
    qsa('.pill').forEach(btn => {
      btn.classList.toggle('pill--active', btn.dataset.pid === partnerId);
    });
  }

  function renderGameScreen() {
    ensureHolesLength();

    const i = game.currentHoleIndex;
    const holeNum = i + 1;

    $('holeTitle').textContent = `Hole ${holeNum} of ${game.holeCount}`;

    const order = rotatedOrderForHole(i);
    const wolfId = order[order.length - 1];
    const wolfName = idToName(wolfId);
    $('holeMeta').textContent = `Wolf: ${wolfName}`;

    // order list
    const ol = $('orderList');
    ol.innerHTML = '';
    order.forEach((pid, idx) => {
      const li = document.createElement('li');
      li.textContent = idToName(pid);
      if (idx === order.length - 1) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'WOLF';
        li.appendChild(tag);
      }
      ol.appendChild(li);
    });

    // blind wolf option visibility
    const blindEnabled = !!game.options.blindWolf;
    $('blindWolfBlock').classList.toggle('hidden', !blindEnabled);

    const hole = game.holes[i];

    // blind wolf toggle
    $('blindWolfToggle').checked = !!hole.blind;

    // partner buttons (exclude wolf)
    const pb = $('partnerButtons');
    pb.innerHTML = '';
    order.slice(0, -1).forEach(pid => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pill';
      btn.dataset.pid = pid;
      btn.textContent = idToName(pid);
      btn.addEventListener('click', () => {
        const h = game.holes[game.currentHoleIndex];
        h.partnerId = pid;
        h.loneWolf = false;
        $('loneWolfToggle').checked = false;
        setPartnerActive(pid);
        saveGame();
      });
      pb.appendChild(btn);
    });

    // lone wolf toggle
    $('loneWolfToggle').checked = !!hole.loneWolf;
    $('loneWolfToggle').onchange = (e) => {
      const h = game.holes[game.currentHoleIndex];
      h.loneWolf = !!e.target.checked;
      if (h.loneWolf) h.partnerId = null;
      setPartnerActive(h.partnerId);
      saveGame();
    };

    // restore partner selection highlight
    setPartnerActive(hole.partnerId);

    // restore result radio
    qsa('input[name="result"]').forEach(r => {
      r.checked = (r.value === hole.result);
      r.onchange = () => {
        game.holes[game.currentHoleIndex].result = r.value;
        saveGame();
      };
    });

    // status
    $('saveStatus').textContent = hole.result ? 'Saved.' : 'Not yet scored.';
  }

  function goToHole(index) {
    game.currentHoleIndex = clamp(index, 0, game.holeCount - 1);
    saveGame();
    renderGameScreen();
  }

  // -----------------------------
  // UI: Scoreboard
  // -----------------------------
  function renderScoreboard() {
    ensureHolesLength();
    const { totals, perHole } = computeScores(game);

    // totals table
    const rows = game.players
      .map(p => ({ id: p.id, name: p.name, units: totals[p.id] ?? 0 }))
      .sort((a, b) => b.units - a.units);

    const tableHtml = `
      <table class="table">
        <thead>
          <tr><th>Player</th><th>Points</th></tr>
        </thead>
        <tbody>
          ${rows.map(r => `<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(formatPoints(r.units))}</td></tr>`).join('')}
        </tbody>
      </table>
      <div class="hint">Points may display as fractions in 5-player games (exact scoring, no rounding).</div>
    `;
    $('scoreTableWrap').innerHTML = tableHtml;

    // holes list w/ jump buttons
    const list = $('holesList');
    list.innerHTML = '';
    perHole.forEach((h) => {
      const div = document.createElement('div');
      div.className = 'holeRow';

      const left = document.createElement('div');
      left.innerHTML = `<b>Hole ${h.hole}</b> <span class="muted small">• x${h.mult}</span><div class="muted small">${escapeHtml(h.desc)}</div>`;

      const btn = document.createElement('button');
      btn.className = 'btn btn--ghost';
      btn.type = 'button';
      btn.textContent = 'Edit';
      btn.addEventListener('click', () => {
        showScreen(SCREENS.game);
        goToHole(h.hole - 1);
      });

      div.appendChild(left);
      div.appendChild(btn);
      list.appendChild(div);
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  // -----------------------------
  // PWA / Service Worker
  // -----------------------------
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // register relative so it works in /wolf subfolder
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  }

  // -----------------------------
  // Wire up events
  // -----------------------------
  function updateResumeButton() {
    const has = !!localStorage.getItem(STORAGE_KEY);
    $('btnResume').disabled = !has;
  }

  function bindUI() {
    // Top bar
    $('btnRules').onclick = () => $('rulesDialog').showModal();
    $('btnCloseRules').onclick = () => $('rulesDialog').close();

    $('btnReset').onclick = () => {
      if (confirm('Clear saved game from this device?')) {
        clearGame();
        showScreen(SCREENS.load);
      }
    };

    // Load screen
    $('btnNewGame').onclick = () => {
      game = newGameTemplate();
      showScreen(SCREENS.setup);
      // render setup defaults
      $('playerCount').value = '4';
      renderHoleOptions();
      renderPlayerInputs();
      $('optPushTies').checked = false;
      $('optBlindWolf').checked = false;
    };

    $('btnResume').onclick = () => {
      const loaded = loadGame();
      if (!loaded) return;
      game = loaded;
      ensureHolesLength();
      showScreen(SCREENS.game);
      renderGameScreen();
    };

    // Setup screen controls
    $('btnBackToLoad').onclick = () => showScreen(SCREENS.load);

    $('playerCount').onchange = () => {
      const pc = Number($('playerCount').value);
      // ensure template exists for setup phase
      if (!game) game = newGameTemplate();
      game.playerCount = pc;
      game.players = Array.from({ length: pc }).map((_, i) => ({
        id: `p${i + 1}`,
        name: game.players?.[i]?.name ?? `Player ${i + 1}`,
      }));
      renderHoleOptions();
      renderPlayerInputs();
    };

    $('btnRandomize').onclick = () => {
      const inputs = qsa('.playerNameInput');
      const names = inputs.map(inp => (inp.value || inp.placeholder).trim());
      const shuffled = shuffle(names);
      inputs.forEach((inp, idx) => { inp.value = shuffled[idx]; });
    };

    $('btnStartGame').onclick = () => {
      const pc = Number($('playerCount').value);
      const hc = Number($('holeCount').value);

      const players = buildPlayersFromInputs();
      if (players.some(p => !p.name)) {
        alert('Please enter all player names.');
        return;
      }

      game.playerCount = pc;
      game.players = players;
      game.holeCount = hc;
      game.options = {
        pushTies: $('optPushTies').checked,
        blindWolf: $('optBlindWolf').checked,
      };
      game.holes = [];
      game.currentHoleIndex = 0;
      game.finishedAt = null;
      ensureHolesLength();
      saveGame();

      showScreen(SCREENS.game);
      renderGameScreen();
    };

    // Game screen
    $('btnPrevHole').onclick = () => goToHole(game.currentHoleIndex - 1);
    $('btnNextHole').onclick = () => goToHole(game.currentHoleIndex + 1);

    $('blindWolfToggle').onchange = (e) => {
      game.holes[game.currentHoleIndex].blind = !!e.target.checked;
      saveGame();
      $('saveStatus').textContent = 'Saved.';
    };

    $('btnSaveHole').onclick = () => {
      const h = game.holes[game.currentHoleIndex];
      const order = rotatedOrderForHole(game.currentHoleIndex);
      const wolfId = order[order.length - 1];

      // validate
      if (!h.result) {
        alert('Select a result (Wolf Team / Other Team / Tie).');
        return;
      }

      const isTie = h.result === 'TIE';
      if (!isTie && !h.loneWolf) {
        if (!h.partnerId) {
          alert('Choose a Wolf partner, or select Lone Wolf.');
          return;
        }
        if (h.partnerId === wolfId) {
          alert('Partner cannot be the Wolf.');
          return;
        }
      }

      saveGame();
      $('saveStatus').textContent = 'Saved.';

      // auto-advance if not last hole
      if (game.currentHoleIndex < game.holeCount - 1) {
        goToHole(game.currentHoleIndex + 1);
      }
    };

    $('btnViewScores').onclick = () => {
      showScreen(SCREENS.scoreboard);
      renderScoreboard();
    };

    // Scoreboard
    $('btnBackToGame').onclick = () => {
      showScreen(SCREENS.game);
      renderGameScreen();
    };

    $('btnFinishGame').onclick = () => {
      game.finishedAt = new Date().toISOString();
      saveGame();
      $('finishStatus').textContent = `Finished at ${new Date(game.finishedAt).toLocaleString()}`;
    };

    $('btnNewFromScoreboard').onclick = () => {
      if (confirm('Start a new game? This will overwrite the saved game on this device.')) {
        clearGame();
        showScreen(SCREENS.load);
      }
    };
  }

  // -----------------------------
  // Boot
  // -----------------------------
  function init() {
    bindUI();
    updateResumeButton();
    registerServiceWorker();

    // start at load screen
    showScreen(SCREENS.load);
  }

  window.addEventListener('DOMContentLoaded', init);

})();
