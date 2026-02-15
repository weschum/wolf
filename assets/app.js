(() => {
  'use strict';

  // -----------------------------
  // Constants / Storage
  // -----------------------------
  const STORAGE_KEY = 'wolf.v1.game';
  const THEME_KEY = 'wolf.v1.theme';

  const POINTS_UNIT = 6; // store points as "sixths" to avoid floats (handles 1.5, 2/3, etc.)

  const SCREENS = {
    load: 'screenLoad',
    setup: 'screenSetup',
    game: 'screenGame',
    scoreboard: 'screenScoreboard',
  };

  // -----------------------------
  // Theme helpers
  // -----------------------------
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
    const n = game.players.length;
    const offset = holeIndex % n;
    const base = game.players.map(p => p.id);

    // Right-rotation: last becomes first each hole
    const cut = (n - offset) % n;
    return base.slice(cut).concat(base.slice(0, cut));
  }

  function idToName(id) {
    return game.players.find(p => p.id === id)?.name ?? 'Unknown';
  }

  // -----------------------------
  // Scoring Engine (Pot model, net transfers)
  // -----------------------------
  function computeScores(g) {
    const totals = Object.fromEntries(g.players.map(p => [p.id, 0]));
    const perHole = [];

    let carryPerPlayer = 0;

    for (let i = 0; i < g.holeCount; i++) {
      const h = g.holes[i] ?? {};
      const n = g.players.length;

      const order = (function () {
        const offset = i % n;
        const base = g.players.map(p => p.id);
        const cut = (n - offset) % n;
        return base.slice(cut).concat(base.slice(0, cut));
      })();

      const wolfId = order[order.length - 1];
      const others = order.slice(0, -1);

      const isBlind = !!(g.options?.blindWolf && h.blind);
      const baseWagerPerPlayer = isBlind ? 2 : 1;

      if (!h.result) {
        perHole.push({
          hole: i + 1,
          desc: 'Not scored',
          meta: { carryPerPlayer, baseWagerPerPlayer, isBlind },
        });
        continue;
      }

      if (h.result === 'TIE') {
        if (g.options?.pushTies) carryPerPlayer += 1;

        perHole.push({
          hole: i + 1,
          desc: g.options?.pushTies
            ? (isBlind
              ? `Tie — push +1/player (Blind extra refunded). Carry is now ${carryPerPlayer}/player.`
              : `Tie — push +1/player. Carry is now ${carryPerPlayer}/player.`)
            : 'Tie',
          meta: { carryPerPlayer, baseWagerPerPlayer, isBlind },
        });
        continue;
      }

      const wagerPerPlayer = (g.options?.pushTies ? carryPerPlayer : 0) + baseWagerPerPlayer;
      const wagerUnits = wagerPerPlayer * POINTS_UNIT;

      if (g.options?.pushTies) carryPerPlayer = 0;

      const isLone = !!h.loneWolf;

      let winners = [];
      let losers = [];

      if (isLone) {
        winners = (h.result === 'WOLF') ? [wolfId] : others;
        losers = (h.result === 'WOLF') ? others : [wolfId];
      } else {
        const partnerId = h.partnerId;
        if (!partnerId || partnerId === wolfId) {
          perHole.push({
            hole: i + 1,
            desc: 'Invalid partner (not scored)',
            meta: { carryPerPlayer: 0, baseWagerPerPlayer, isBlind },
          });
          continue;
        }

        const wolfTeam = [wolfId, partnerId];
        const otherTeam = order.filter(pid => !wolfTeam.includes(pid));

        winners = (h.result === 'WOLF') ? wolfTeam : otherTeam;
        losers = (h.result === 'WOLF') ? otherTeam : wolfTeam;
      }

      losers.forEach(pid => { totals[pid] -= wagerUnits; });

      const potUnits = losers.length * wagerUnits;

      const shareUnits = Math.floor(potUnits / winners.length);
      const remainder = potUnits - (shareUnits * winners.length);

      winners.forEach((pid, idx) => {
        totals[pid] += shareUnits + (idx === 0 ? remainder : 0);
      });

      const potPoints = potUnits / POINTS_UNIT;

      const whoWon =
        (h.result === 'WOLF')
          ? (isLone ? 'Lone Wolf win' : 'Wolf Team win')
          : (isLone ? 'Lone Wolf loss (others win)' : 'Other Team win');

      const blindNote = isBlind ? ' (Blind)' : '';
      const splitNote = `split ${winners.length} ways`;

      perHole.push({
        hole: i + 1,
        desc: `${whoWon}${blindNote} — wager ${wagerPerPlayer}/player, net pot ${potPoints} (${splitNote})`,
        meta: { carryPerPlayer: 0, baseWagerPerPlayer, isBlind },
      });
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

  function setPillDisabled(containerEl, disabled) {
    if (!containerEl) return;
    qsa('.pill', containerEl).forEach(btn => {
      btn.disabled = !!disabled;
      btn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    });
  }

  function renderGameScreen() {
    ensureHolesLength();

    const i = game.currentHoleIndex;
    const holeNum = i + 1;

    const hole = game.holes[i];

    $('holeTitle').textContent = `Hole ${holeNum} of ${game.holeCount}`;

    const order = rotatedOrderForHole(i);
    const wolfId = order[order.length - 1];
    $('holeMeta').textContent = `Wolf: ${idToName(wolfId)}`;

    // Bottom hole info (centered between Scores + Save)
    if ($('holeTitleBottom')) {
      $('holeTitleBottom').textContent = `Hole ${holeNum} of ${game.holeCount}`;
    }
    if ($('holeMetaBottom')) {
      $('holeMetaBottom').textContent = (hole?.result ? 'Saved.' : 'Not yet scored.');
    }

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

    // blind wolf option visibility (feature flag)
    const blindEnabled = !!game.options.blindWolf;
    $('blindWolfBlock')?.classList.toggle('hidden', !blindEnabled);

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

          // If blind or lone wolf, partner selection is not allowed
          if (h.blind || h.loneWolf) return;

          h.partnerId = pid;
          saveGame();

          setPillActive(pb, (b) => b.dataset.pid === pid);

          if ($('saveStatus')) $('saveStatus').textContent = 'Saved.';
          if ($('holeMetaBottom')) $('holeMetaBottom').textContent = (h.result ? 'Saved.' : 'Not yet scored.');
        });
        pb.appendChild(btn);
      });
    }

    // ---- Enforce rule: Blind Wolf implies Lone Wolf ----
    function enforceBlindImpliesLone() {
      if (!blindEnabled) return;
      if (!hole.blind) return;

      if (!hole.loneWolf) hole.loneWolf = true;
      if (hole.partnerId) hole.partnerId = null;
    }
    enforceBlindImpliesLone();

    // Blind Wolf toggle
    const blindToggle = $('blindWolfToggle');
    if (blindToggle) {
      blindToggle.checked = !!hole.blind;

      blindToggle.onchange = (e) => {
        const h = game.holes[game.currentHoleIndex];
        h.blind = !!e.target.checked;

        // Blind Wolf implies Lone Wolf
        if (h.blind) {
          h.loneWolf = true;
          h.partnerId = null;
          if ($('loneWolfToggle')) $('loneWolfToggle').checked = true;
        }

        saveGame();
        renderGameScreen();
      };
    }

    // Lone Wolf toggle
    const loneToggle = $('loneWolfToggle');
    if (loneToggle) {
      loneToggle.checked = !!hole.loneWolf;

      loneToggle.onchange = (e) => {
        const h = game.holes[game.currentHoleIndex];
        h.loneWolf = !!e.target.checked;

        // If Lone Wolf is turned off, Blind must also turn off
        if (!h.loneWolf && h.blind) {
          h.blind = false;
          if (blindToggle) blindToggle.checked = false;
        }

        // If Lone Wolf is turned on manually, clear partner
        if (h.loneWolf) {
          h.partnerId = null;
        }

        saveGame();
        renderGameScreen();
      };
    }

    // partner pills state
    if (pb) {
      const disablePartners = !!hole.loneWolf || !!hole.blind;
      setPillDisabled(pb, disablePartners);

      setPillActive(pb, (b) => b.dataset.pid === (hole.partnerId ?? ''));
      if (disablePartners) setPillActive(pb, () => false);
    }

    // Result selection buttons (optional)
    const rb = $('resultButtons');
    if (rb) {
      rb.innerHTML = '';
      const results = [
        { value: 'WOLF', label: hole.loneWolf ? 'Wolf wins (Lone Wolf)' : 'Wolf Team wins' },
        { value: 'OTHER', label: hole.loneWolf ? 'Others win' : 'Other Team wins' },
        { value: 'TIE', label: 'Tie' },
      ];

      results.forEach(r => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pill';
        btn.dataset.value = r.value;
        btn.textContent = r.label;
        btn.addEventListener('click', () => {
          const h = game.holes[game.currentHoleIndex];
          h.result = r.value;

          setPillActive(rb, (b) => b.dataset.value === r.value);
          saveGame();

          if ($('saveStatus')) $('saveStatus').textContent = 'Saved.';
          if ($('holeMetaBottom')) $('holeMetaBottom').textContent = (h.result ? 'Saved.' : 'Not yet scored.');
        });
        rb.appendChild(btn);
      });

      setPillActive(rb, (b) => b.dataset.value === (hole.result ?? ''));
    } else {
      // Backward compatibility: radios
      qsa('input[name="result"]').forEach(r => {
        r.checked = (r.value === hole.result);
        r.onchange = () => {
          const h = game.holes[game.currentHoleIndex];
          h.result = r.value;
          saveGame();

          if ($('saveStatus')) $('saveStatus').textContent = 'Saved.';
          if ($('holeMetaBottom')) $('holeMetaBottom').textContent = (h.result ? 'Saved.' : 'Not yet scored.');
        };
      });
    }
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
      left.innerHTML = `<b>Hole ${h.hole}</b><div class="muted small">${escapeHtml(h.desc)}</div>`;

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
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            sw.postMessage('SKIP_WAITING');
          }
        });
      });

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

    const pcb = $('playerCountBtns');
    if (pcb) {
      qsa('.segBtn', pcb).forEach(btn => {
        btn.addEventListener('click', () => {
          const pc = Number(btn.dataset.value);

          const existingNames = qsa('.playerNameInput').length
            ? buildPlayersFromInputs().map(p => p.name)
            : (game.players?.map(p => p.name) ?? []);

          game.playerCount = pc;
          game.players = Array.from({ length: pc }).map((_, i) => ({
            id: `p${i + 1}`,
            name: existingNames[i] ?? `Player ${i + 1}`,
          }));

          setSegmentActive(pcb, pc);
          renderHoleOptionsButtons(pc, game.holeCount);
          renderPlayerInputs();
          saveGame();
        });
      });

      setSegmentActive(pcb, game.playerCount);
    }

    renderHoleOptionsButtons(game.playerCount, game.holeCount);
    renderPlayerInputs();
  }

  function bindUI() {
    $('btnRules')?.addEventListener('click', () => $('rulesDialog')?.showModal());
    $('btnCloseRules')?.addEventListener('click', () => $('rulesDialog')?.close());

    $('btnReset')?.addEventListener('click', () => {
      if (confirm('Clear saved game from this device?')) {
        clearGame();
        showScreen(SCREENS.load);
      }
    });

    const themeSelect = $('themeSelect');
    if (themeSelect) {
      const currentTheme = loadTheme();
      themeSelect.value = currentTheme;
      applyTheme(currentTheme);

      themeSelect.addEventListener('change', (e) => {
        applyTheme(e.target.value);
      });
    }

    $('btnNewGame')?.addEventListener('click', () => {
      game = newGameTemplate();
      showScreen(SCREENS.setup);

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

      // Enforce: if blindWolf option is OFF, clear any blind flags in holes
      if (!game.options.blindWolf) {
        game.holes.forEach(h => { h.blind = false; });
      }

      saveGame();

      showScreen(SCREENS.game);
      renderGameScreen();
    });

    $('btnPrevHole')?.addEventListener('click', () => goToHole(game.currentHoleIndex - 1));
    $('btnNextHole')?.addEventListener('click', () => goToHole(game.currentHoleIndex + 1));

    $('btnSaveHole')?.addEventListener('click', () => {
      const h = game.holes[game.currentHoleIndex];
      const order = rotatedOrderForHole(game.currentHoleIndex);
      const wolfId = order[order.length - 1];

      // Enforce rule again at save-time
      if (h.blind) {
        h.loneWolf = true;
        h.partnerId = null;
      }

      if (!h.result) {
        alert('Select a result (Wolf Team / Other Team / Tie).');
        return;
      }

      const isTie = h.result === 'TIE';
      if (!isTie) {
        // If not tie:
        // - Blind implies lone (already enforced)
        // - If not lone, must have partner
        if (!h.loneWolf) {
          if (!h.partnerId) {
            alert('Choose a Wolf partner, or select Lone Wolf.');
            return;
          }
          if (h.partnerId === wolfId) {
            alert('Partner cannot be the Wolf.');
            return;
          }
        }
      }

      saveGame();

      if ($('saveStatus')) $('saveStatus').textContent = 'Saved.';
      if ($('holeMetaBottom')) $('holeMetaBottom').textContent = 'Saved.';

      // auto-advance if not last hole
      if (game.currentHoleIndex < game.holeCount - 1) {
        goToHole(game.currentHoleIndex + 1);
      } else {
        renderGameScreen(); // last hole: just refresh UI
      }
    });

    $('btnViewScores')?.addEventListener('click', () => {
      showScreen(SCREENS.scoreboard);
      renderScoreboard();
    });

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
