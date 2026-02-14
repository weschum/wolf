(() => {
  'use strict';

  // -----------------------------
  // Constants / Storage
  // -----------------------------
  const STORAGE_KEY = 'wolf.v1.game';
  const THEME_KEY = 'wolf.v1.theme';

  function applyTheme(theme) {
    if (!theme) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.removeItem(THEME_KEY);
      return;
    }
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
  }

  function loadTheme() {
    return localStorage.getItem(THEME_KEY) || 'graphite';
  }

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
    Object.values(SCREENS).forEach((sid) => $(sid)?.classList.add('hidden'));
    $(name)?.classList.remove('hidden');
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

  function escapeHtml(str) {
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
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
      const shareUnits = Math.floor(potUnits / winners.length);
      const remainder = potUnits - (shareUnits * winners.length);

      for (const pid of losers) totals[pid] -= 1 * multUnits;

      winners.forEach((pid, idx) => {
        totals[pid] += shareUnits + (idx === 0 ? remainder : 0);
      });

      const winLabel = (h.result === 'WOLF') ? 'Wolf Team win' : 'Other Team win';
      perHole.push({ hole: i + 1, mult, pushCount: 0, desc: `${winLabel} (pot ${losers.length})` });
    }

    return { totals, perHole };
  }

  // -----------------------------
  // UI: Setup (buttons for players/holes)
  // -----------------------------
  function setSegmentActive(containerEl, value) {
    if (!containerEl) return;
    qsa('.segBtn', containerEl).forEach(btn => {
      btn.classList.toggle('segBtn--active', btn.dataset.value === String(value));
    });
  }

  function renderHoleOptionsButtons(playerCount, selectedHoleCount) {
    const wrap = $('holeCountBtns');
    if (!wrap) return;

    wrap.innerHTML = '';

    const suggested = playerCount === 4 ? [8, 12, 16, 20] : [10, 15, 20];
    suggested.forEach(v => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'segBtn';
      btn.dataset.value = String(v);
      btn.textContent = String(v);
      btn.addEventListener('click', () => {
        game.holeCount = v;
        setSegmentActive(wrap, v);
        saveGame();
      });
      wrap.appendChild(btn);
    });

    const pick =
      selectedHoleCount && suggested.includes(selectedHoleCount)
        ? selectedHoleCount
        : (playerCount === 4 ? 12 : 15);

    game.holeCount = pick;
    setSegmentActive(wrap, pick);
  }

  function renderPlayerInputs() {
    const pc = Number(game?.playerCount ?? 4);
    const wrap = $('playerInputs');
    if (!wrap) return;

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
    return inputs.map((inp, i) => ({
      id: `p${i + 1}`,
      name: (inp.value || `Player ${i + 1}`).trim(),
    }));
  }

  // -----------------------------
  // UI: Game Screen
  // -----------------------------
  function setPillActive(containerEl, matchFn) {
    if (!containerEl) return;
    qsa('.pill', containerEl).forEach(btn => btn.classList.toggle('pill--active', !!matchFn(btn)));
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
    if (ol) {
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
    }

    const hole = game.holes[i];

    // blind wolf option visibility
    const blindEnabled = !!game.options.blindWolf;
    $('blindWolfBlock')?.classList.toggle('hidden', !blindEnabled);

    // blind wolf toggle
    if ($('blindWolfToggle')) $('blindWolfToggle').checked = !!hole.blind;

    // partner buttons (exclude wolf)
    const pb = $('partnerButtons');
    if (pb) {
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
          if ($('loneWolfToggle')) $('loneWolfToggle').checked = false;
          setPillActive(pb, (b) => b.dataset.pid === pid);
          saveGame();
          $('saveStatus').textContent = 'Saved.';
        });
        pb.appendChild(btn);
      });

      // restore partner highlight
      setPillActive(pb, (b) => b.dataset.pid === (hole.partnerId ?? ''));
    }

    // lone wolf toggle
    if ($('loneWolfToggle')) {
      $('loneWolfToggle').checked = !!hole.loneWolf;
      $('loneWolfToggle').onchange = (e) => {
        const h = game.holes[game.currentHoleIndex];
        h.loneWolf = !!e.target.checked;
        if (h.loneWolf) h.partnerId = null;
        // update partner highlight
        if (pb) setPillActive(pb, (b) => b.dataset.pid === (h.partnerId ?? ''));
        saveGame();
        $('saveStatus').textContent = 'Saved.';
      };
    }

    // Result selection as buttons (requires #resultButtons in index.html)
    const rb = $('resultButtons');
    if (rb) {
      rb.innerHTML = '';
      const results = [
        { value: 'WOLF', label: 'Wolf Team wins' },
        { value: 'OTHER', label: 'Other Team wins' },
        { value: 'TIE', label: 'Tie' },
      ];

      results.forEach(r => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pill';
        btn.dataset.value = r.value;
        btn.textContent = r.label;
        btn.addEventListener('click', () => {
          game.holes[game.currentHoleIndex].result = r.value;
          setPillActive(rb, (b) => b.dataset.value === r.value);
          saveGame();
          $('saveStatus').textContent = 'Saved.';
        });
        rb.appendChild(btn);
      });

      // restore highlight
      setPillActive(rb, (b) => b.dataset.value === (hole.result ?? ''));
    } else {
      // Backward compatibility: if old radios exist, keep them functional
      qsa('input[name="result"]').forEach(r => {
        r.checked = (r.value === hole.result);
        r.onchange = () => {
          game.holes[game.currentHoleIndex].result = r.value;
          saveGame();
          $('saveStatus').textContent = 'Saved.';
        };
      });
    }

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

    const list = $('holesList');
    if (!list) return;

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

  // -----------------------------
  // PWA / Service Worker
  // -----------------------------
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('./service-worker.js').then((reg) => {
      // If a new SW is found, tell it to activate immediately
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            sw.postMessage('SKIP_WAITING');
          }
        });
      });

      // When the controller changes, reload to use the new cached assets
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.location.reload();
      });
    }).catch(() => {});
  }

  // -----------------------------
  // Wire up events
  // -----------------------------
  function updateResumeButton() {
    const has = !!localStorage.getItem(STORAGE_KEY);
    if ($('btnResume')) $('btnResume').disabled = !has;
  }

  function initSetupUI() {
    if (!game) game = newGameTemplate();

    // Setup: player count buttons
    const pcb = $('playerCountBtns');
    if (pcb) {
      qsa('.segBtn', pcb).forEach(btn => {
        btn.addEventListener('click', () => {
          const pc = Number(btn.dataset.value);

          game.playerCount = pc;
          game.players = Array.from({ length: pc }).map((_, i) => ({
            id: `p${i + 1}`,
            name: game.players?.[i]?.name ?? `Player ${i + 1}`,
          }));

          setSegmentActive(pcb, pc);
          renderHoleOptionsButtons(pc, game.holeCount);
          renderPlayerInputs();
          saveGame();
        });
      });

      // initial highlight
      setSegmentActive(pcb, game.playerCount);
    }

    // initial holes buttons
    renderHoleOptionsButtons(game.playerCount, game.holeCount);
    renderPlayerInputs();
  }

  function bindUI() {
    // Top bar
    $('btnRules')?.addEventListener('click', () => $('rulesDialog')?.showModal());
    $('btnCloseRules')?.addEventListener('click', () => $('rulesDialog')?.close());

    $('btnReset')?.addEventListener('click', () => {
      if (confirm('Clear saved game from this device?')) {
        clearGame();
        showScreen(SCREENS.load);
      }
    });
    // Theme picker (top bar)
    const themeSelect = $('themeSelect');
    if (themeSelect) {
      const currentTheme = loadTheme();
      themeSelect.value = currentTheme;
      applyTheme(currentTheme);

      themeSelect.addEventListener('change', (e) => {
        applyTheme(e.target.value);
      });
    }

    // Load screen
    $('btnNewGame')?.addEventListener('click', () => {
      game = newGameTemplate();
      showScreen(SCREENS.setup);

      // reset options UI
      if ($('optPushTies')) $('optPushTies').checked = false;
      if ($('optBlindWolf')) $('optBlindWolf').checked = false;

      initSetupUI();
    });

    $('btnResume')?.addEventListener('click', () => {
      const loaded = loadGame();
      if (!loaded) return;
      game = loaded;
      ensureHolesLength();
      showScreen(SCREENS.game);
      renderGameScreen();
    });

    // Setup screen
    $('btnBackToLoad')?.addEventListener('click', () => showScreen(SCREENS.load));

    $('btnRandomize')?.addEventListener('click', () => {
      const inputs = qsa('.playerNameInput');
      const names = inputs.map(inp => (inp.value || inp.placeholder).trim());
      const shuffled = shuffle(names);
      inputs.forEach((inp, idx) => { inp.value = shuffled[idx]; });
    });

    $('btnStartGame')?.addEventListener('click', () => {
      const pc = Number(game?.playerCount ?? 4);
      const hc = Number(game?.holeCount ?? (pc === 4 ? 12 : 15));

      const players = buildPlayersFromInputs();
      if (players.some(p => !p.name)) {
        alert('Please enter all player names.');
        return;
      }

      game.playerCount = pc;
      game.players = players;
      game.holeCount = hc;
      game.options = {
        pushTies: !!$('optPushTies')?.checked,
        blindWolf: !!$('optBlindWolf')?.checked,
      };
      game.holes = [];
      game.currentHoleIndex = 0;
      game.finishedAt = null;
      ensureHolesLength();
      saveGame();

      showScreen(SCREENS.game);
      renderGameScreen();
    });

    // Game screen
    $('btnPrevHole')?.addEventListener('click', () => goToHole(game.currentHoleIndex - 1));
    $('btnNextHole')?.addEventListener('click', () => goToHole(game.currentHoleIndex + 1));

    $('blindWolfToggle')?.addEventListener('change', (e) => {
      game.holes[game.currentHoleIndex].blind = !!e.target.checked;
      saveGame();
      $('saveStatus').textContent = 'Saved.';
    });

    $('btnSaveHole')?.addEventListener('click', () => {
      const h = game.holes[game.currentHoleIndex];
      const order = rotatedOrderForHole(game.currentHoleIndex);
      const wolfId = order[order.length - 1];

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

      if (game.currentHoleIndex < game.holeCount - 1) {
        goToHole(game.currentHoleIndex + 1);
      }
    });

    $('btnViewScores')?.addEventListener('click', () => {
      showScreen(SCREENS.scoreboard);
      renderScoreboard();
    });

    // Scoreboard
    $('btnBackToGame')?.addEventListener('click', () => {
      showScreen(SCREENS.game);
      renderGameScreen();
    });

    $('btnFinishGame')?.addEventListener('click', () => {
      game.finishedAt = new Date().toISOString();
      saveGame();
      if ($('finishStatus')) $('finishStatus').textContent = `Finished at ${new Date(game.finishedAt).toLocaleString()}`;
    });

    $('btnNewFromScoreboard')?.addEventListener('click', () => {
      if (confirm('Start a new game? This will overwrite the saved game on this device.')) {
        clearGame();
        showScreen(SCREENS.load);
      }
    });
  }

  // -----------------------------
  // Boot
  // -----------------------------
  function init() {
    bindUI();
    updateResumeButton();
    registerServiceWorker();
    applyTheme(loadTheme());
    showScreen(SCREENS.load);
  }

  window.addEventListener('DOMContentLoaded', init);

})();
