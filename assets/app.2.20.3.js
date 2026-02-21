(() => {
  'use strict';

  // -----------------------------
  // Constants / Storage
  // -----------------------------
  
  const STORAGE_KEY = 'wolf.v1.game';
  const THEME_KEY = 'wolf.v1.theme';

  const POINTS_UNIT = 1; // integer scoring only

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

  function holeSnapshot(h) {
    return JSON.stringify({
      partnerId: h?.partnerId ?? null,
      loneWolf: !!h?.loneWolf,
      blind: !!h?.blind,
      result: h?.result ?? null,
    });
  }

  function ensureEditBaselineForCurrentHole() {
    const h = game?.holes?.[game.currentHoleIndex];
    if (!h) return;
    if (!h._editBaseline) h._editBaseline = holeSnapshot(h);
  }

  function clearEditBaselineForCurrentHole() {
    const h = game?.holes?.[game.currentHoleIndex];
    if (!h) return;
    h._editBaseline = null;
  }

  function isCurrentHoleDirty() {
    const h = game?.holes?.[game.currentHoleIndex];
    if (!h) return false;

    // If the user has begun editing this hole, compare to that baseline.
    if (h._editBaseline) return holeSnapshot(h) !== h._editBaseline;

    return false;
  }
  function setBottomStatus(text, isDanger) {
    const el = $('holeMetaBottom');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('danger', !!isDanger);
  }

  function refreshDirtyState() {
    const h = game?.holes?.[game.currentHoleIndex];
    if (!h) return;

    // 1) No result chosen yet
    if (!h.result) {
      setBottomStatus('Not yet scored.', false);
      return;
    }

    // 2) Result chosen but never saved
    if (!h._savedSnapshot) {
      setBottomStatus('Changes Not Saved', true);
      return;
    }

    // 3) Compare against last saved snapshot
    const dirty = holeSnapshot(h) !== h._savedSnapshot;
    setBottomStatus(dirty ? 'Changes Not Saved' : 'Saved.', dirty);
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
  
  let isEditingSettings = false;

  function openEditSettings() {
    if (!game) return;

    isEditingSettings = true;

    // Hide Randomize while editing (prevents scrambling a live scorecard)
    $('btnRandomize')?.classList.add('hidden');

    // Show setup screen + prefill options
    showScreen(SCREENS.setup);

    if ($('optPushTies')) $('optPushTies').checked = !!game.options?.pushTies;
    if ($('optBlindWolf')) $('optBlindWolf').checked = !!game.options?.blindWolf;

    // Rebuild setup UI inputs based on CURRENT game
    initSetupUI();

    // Fill player name inputs from current game
    const inputs = qsa('.playerNameInput');
    inputs.forEach((inp, idx) => {
      if (game.players[idx]) inp.value = game.players[idx].name;
    });

    // Make sure hole count reflects current
    renderHoleOptionsButtons(game.playerCount, game.holeCount);

    // Optional: change button label so it's clear
    if ($('btnStartGame')) $('btnStartGame').textContent = 'Save Settings';

    // Disable player count buttons while editing
    const pcb = $('playerCountBtns');
    if (pcb) {
      qsa('.segBtn', pcb).forEach(btn => {
        btn.disabled = true;
        btn.classList.add('segBtn--disabled');
      });
    }
  }

  function applySettingsFromSetup() {
    // read from setup UI
    const pc = Number(game?.playerCount ?? 4);
    const hc = Number(game?.holeCount ?? (pc === 4 ? 12 : 15));
    const newPlayers = buildPlayersFromInputs();

    // Basic validation
    if (newPlayers.some(p => !p.name)) {
      alert('Please enter all player names.');
      return false;
    }

    // Keep hole objects; adjust length safely
    game.playerCount = pc;
    game.players = newPlayers;
    game.holeCount = hc;

    game.options = {
      pushTies: !!$('optPushTies')?.checked,
      blindWolf: !!$('optBlindWolf')?.checked,
    };

    ensureHolesLength();

    // If blindWolf option is OFF, clear any blind flags
    if (!game.options.blindWolf) {
      game.holes.forEach(h => { h.blind = false; });
    }

    saveGame();
    return true;
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
  // Adds: won/lost/net + per-hole per-player deltas (in setup order)
  // -----------------------------
  function computeScores(g) {
    const playerIds = g.players.map(p => p.id);

    const totals = Object.fromEntries(playerIds.map(pid => [pid, 0]));     // net
    const won = Object.fromEntries(playerIds.map(pid => [pid, 0]));        // credits received
    const lost = Object.fromEntries(playerIds.map(pid => [pid, 0]));       // debits paid (positive magnitude)

    const perHole = [];
    let carryPerPlayer = 0;

    const applyDelta = (deltaByPlayer, pid, deltaUnits) => {
      if (!deltaUnits) return;
      deltaByPlayer[pid] = (deltaByPlayer[pid] ?? 0) + deltaUnits;
      totals[pid] += deltaUnits;
      if (deltaUnits > 0) won[pid] += deltaUnits;
      if (deltaUnits < 0) lost[pid] += Math.abs(deltaUnits);
    };

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
      // Base is always 1; Blind Wolf adds +1 for THIS hole only
      const baseWagerPerPlayer = 1 + (isBlind ? 1 : 0);

      // per-hole delta map (always include keys so rendering order is stable)
      const deltaByPlayer = Object.fromEntries(playerIds.map(pid => [pid, 0]));

      // Not scored
      if (!h.result) {
        perHole.push({
          hole: i + 1,
          status: 'NOT_SCORED',
          statusLabel: 'Not scored',
          deltaByPlayer, // all zeros
        });
        continue;
      }

      // Tie
      if (h.result === 'TIE') {
        // Push logic: tie pushes only +1/player (blind extra refunded)
        if (g.options?.pushTies) carryPerPlayer += 1;

        perHole.push({
          hole: i + 1,
          status: 'TIE',
          statusLabel: 'Tie',
          deltaByPlayer, // all zeros
        });
        continue;
      }

      // Win: compute per-player wager for THIS hole
      const wagerPerPlayer = (g.options?.pushTies ? carryPerPlayer : 0) + baseWagerPerPlayer;
      const wagerUnits = wagerPerPlayer * POINTS_UNIT;

      // Win resets carry
      if (g.options?.pushTies) carryPerPlayer = 0;

      const isLone = !!h.loneWolf;

      let winners = [];
      let losers = [];
      let statusLabel = '';

      if (isLone) {
        // Lone Wolf: Wolf vs all others
        const wolfWon = (h.result === 'WOLF');
        winners = wolfWon ? [wolfId] : others;
        losers = wolfWon ? others : [wolfId];
        statusLabel = wolfWon ? 'Lone Wolf wins' : 'Little Piggie win';
      } else {
        // Team hole: Wolf + partner vs the rest
        const partnerId = h.partnerId;
        if (!partnerId || partnerId === wolfId) {
          perHole.push({
            hole: i + 1,
            status: 'NOT_SCORED',
            statusLabel: 'Not scored',
            deltaByPlayer, // all zeros
          });
          continue;
        }

        const wolfTeam = [wolfId, partnerId];
        const otherTeam = order.filter(pid => !wolfTeam.includes(pid));

        const wolfTeamWon = (h.result === 'WOLF');
        winners = wolfTeamWon ? wolfTeam : otherTeam;
        losers = wolfTeamWon ? otherTeam : wolfTeam;

        statusLabel = wolfTeamWon ? 'Wolf Pack wins' : 'Little Piggies win';
      }

      // Each loser pays EACH winner wagerUnits (no fractions, no pot splitting)
      const winnerCount = winners.length;
      const loserCount = losers.length;

      // Winners receive wagerUnits from each loser
      winners.forEach(pid => {
        applyDelta(deltaByPlayer, pid, +wagerUnits * loserCount);
      });

      // Losers pay wagerUnits to each winner
      losers.forEach(pid => {
        applyDelta(deltaByPlayer, pid, -wagerUnits * winnerCount);
      });

      perHole.push({
        hole: i + 1,
        status: (h.result === 'WOLF' ? 'WOLF_WIN' : 'OTHER_WIN'),
        statusLabel,
        deltaByPlayer,
      });
    }

    const holesScoredCount = perHole.filter(h => h.status !== 'NOT_SCORED').length;

    return {
      totals,
      won,
      lost,
      holesScoredCount,
      perHole,
    };
  }

  // -----------------------------
  // UI: Setup (buttons for players/holes)
  // -----------------------------

  (function initTopbarMenu(){
    const btn = $('btnMenu');
    const panel = $('topbarMenuPanel');
    const overlay = $('menuOverlay');

    if (!btn || !panel || !overlay) return;

    function openMenu(){
      panel.classList.remove('hidden');
      panel.classList.add('open');

      overlay.classList.remove('hidden');
      overlay.classList.add('open');

      btn.setAttribute('aria-expanded','true');
      document.body.classList.add('menuOpen');
    }

    function closeMenu(){
      panel.classList.remove('open');
      panel.classList.add('hidden');

      overlay.classList.remove('open');
      overlay.classList.add('hidden');

      btn.setAttribute('aria-expanded','false');
      document.body.classList.remove('menuOpen');
    }

    function toggleMenu(){
      const isOpen = panel.classList.contains('open');
      isOpen ? closeMenu() : openMenu();
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenu();
    });

    // Close when tapping overlay
    overlay.addEventListener('click', closeMenu);

    // Close when clicking outside
    document.addEventListener('click', (e) => {
      if (!panel.classList.contains('open')) return;
      if (!panel.contains(e.target) && e.target !== btn) {
        closeMenu();
      }
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });

    // Close after clicking a menu button
    panel.addEventListener('click', (e) => {
      if (e.target.matches('button')) closeMenu();
    });
  })();

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

    const suggested = playerCount === 4 ? [8, 12, 16, 20] : [10, 15, 20, 25];
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

    // ----- Bottom footer updates -----
    if ($('holeTitleBottom')) {
      $('holeTitleBottom').textContent = `Hole ${holeNum} of ${game.holeCount}`;
    }

    refreshDirtyState();

    const atStart = (i === 0);
    const atEnd = (i === game.holeCount - 1);

    $('btnPrevHole')?.toggleAttribute('disabled', atStart);
    $('btnNextHole')?.toggleAttribute('disabled', atEnd);

    $('btnPrevHoleBottom')?.toggleAttribute('disabled', atStart);
    $('btnNextHoleBottom')?.toggleAttribute('disabled', atEnd);

    // ----- Order list -----
    const ol = $('orderList');
    if (ol) {
      ol.innerHTML = '';

      const partnerId = hole.partnerId;
      const isSoloMode = !!hole.loneWolf || !!hole.blind;
      const hasPartner =
        !!partnerId &&
        partnerId !== wolfId &&
        !isSoloMode;

      order.forEach((pid) => {
        const li = document.createElement('li');
        li.textContent = idToName(pid);

        let tagText = '';
        let tagClass = 'tag';

        if (pid === wolfId) {
          tagText = 'WOLF';
        } else if (isSoloMode) {
          tagText = 'PIGGIE';
          tagClass = 'tag tag--piggie';
        } else if (hasPartner) {
          if (pid === partnerId) {
            tagText = 'WOLF PACK';
            tagClass = 'tag tag--wolfpack';
          } else {
            tagText = 'PIGGIE';
            tagClass = 'tag tag--piggie';
          }
        }

        if (tagText) {
          const tag = document.createElement('span');
          tag.className = tagClass;
          tag.textContent = tagText;
          li.appendChild(tag);
        }

        ol.appendChild(li);
      });
    }

    // ----- Blind wolf feature visibility -----
    const blindEnabled = !!game.options.blindWolf;
    $('blindWolfBlock')?.classList.toggle('hidden', !blindEnabled);

    // ----- Partner buttons -----
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
          if (h.blind || h.loneWolf) return;

          ensureEditBaselineForCurrentHole();
          h.partnerId = pid;
          saveGame();

          setPillActive(pb, (b) => b.dataset.pid === pid);
          refreshDirtyState();
        });

        pb.appendChild(btn);
      });
    }

    // ----- Blind implies lone -----
    function enforceBlindImpliesLone() {
      if (!blindEnabled) return;
      if (!hole.blind) return;

      if (!hole.loneWolf) hole.loneWolf = true;
      if (hole.partnerId) hole.partnerId = null;
    }
    enforceBlindImpliesLone();

    // ----- Blind toggle -----
    const blindToggle = $('blindWolfToggle');
    if (blindToggle) {
      blindToggle.checked = !!hole.blind;

      blindToggle.onchange = (e) => {
        const h = game.holes[game.currentHoleIndex];
        ensureEditBaselineForCurrentHole();
        h.blind = !!e.target.checked;

        if (h.blind) {
          h.loneWolf = true;
          h.partnerId = null;
          if ($('loneWolfToggle')) $('loneWolfToggle').checked = true;
        }

        saveGame();
        renderGameScreen();
      };
    }

    // ----- Lone toggle -----
    const loneToggle = $('loneWolfToggle');
    if (loneToggle) {
      loneToggle.checked = !!hole.loneWolf;

      loneToggle.onchange = (e) => {
        const h = game.holes[game.currentHoleIndex];
        ensureEditBaselineForCurrentHole();
        h.loneWolf = !!e.target.checked;

        if (!h.loneWolf && h.blind) {
          h.blind = false;
          if (blindToggle) blindToggle.checked = false;
        }

        if (h.loneWolf) {
          h.partnerId = null;
        }

        saveGame();
        renderGameScreen();
      };
    }

    // ----- Partner pill state -----
    if (pb) {
      const disablePartners = !!hole.loneWolf || !!hole.blind;
      setPillDisabled(pb, disablePartners);

      setPillActive(pb, (b) => b.dataset.pid === (hole.partnerId ?? ''));
      if (disablePartners) setPillActive(pb, () => false);
    }

    // ----- Result buttons -----
    const rb = $('resultButtons');
    if (rb) {
      rb.innerHTML = '';

      const results = [
        { value: 'WOLF', label: hole.loneWolf ? 'Lone Wolf wins' : 'Wolf Pack wins' },
        { value: 'OTHER', label: 'Little Piggies win' },
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
          ensureEditBaselineForCurrentHole();
          h.result = r.value;

          setPillActive(rb, (b) => b.dataset.value === r.value);
          saveGame();
          refreshDirtyState();
        });

        rb.appendChild(btn);
      });

      setPillActive(rb, (b) => b.dataset.value === (hole.result ?? ''));
    } else {
      qsa('input[name="result"]').forEach(r => {
        r.checked = (r.value === hole.result);
        r.onchange = () => {
          const h = game.holes[game.currentHoleIndex];
          h.result = r.value;
          saveGame();
          refreshDirtyState();
        };
      });
    }
  }

  function goToHole(index) {
    const target = clamp(index, 0, game.holeCount - 1);

    // If dirty, confirm before leaving
    if (isCurrentHoleDirty()) {
      const discard = confirm(
        'You have unsaved changes.\n\n' +
        'Press OK to discard changes and continue.\n' +
        'Press Cancel to stay and save.'
      );

      if (!discard) return;

      // Revert to the state when you entered this hole
      const h = game.holes[game.currentHoleIndex];
      if (h?._editBaseline) {
        const saved = JSON.parse(h._editBaseline);
        h.partnerId = saved.partnerId;
        h.loneWolf = saved.loneWolf;
        h.blind = saved.blind;
        h.result = saved.result;
        clearEditBaselineForCurrentHole();
        saveGame();
      }
    }

    game.currentHoleIndex = target;
    saveGame();
    renderGameScreen();
  }

  // -----------------------------
  // UI: Scoreboard
  // -----------------------------
  function renderScoreboard() {
    ensureHolesLength();
    const { totals, won, lost, holesScoredCount, perHole } = computeScores(game);

    // --- Totals card: "# holes scored" + table headers Player/Won/Lost/Net ---
    const rows = game.players.map(p => ({
      id: p.id,
      name: p.name,
      wonUnits: won[p.id] ?? 0,
      lostUnits: lost[p.id] ?? 0,
      netUnits: totals[p.id] ?? 0,
    }));

    const tableHtml = `
      <div class="row row--between row--center" style="margin-bottom:10px">
        <h2 style="margin:0">${holesScoredCount} holes scored</h2>
      </div>

      <table class="table">
        <thead>
          <tr>
            <th>Player</th>
            <th>Won</th>
            <th>Lost</th>
            <th>Net</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>${escapeHtml(r.name)}</td>
              <td>${escapeHtml(formatPoints(r.wonUnits))}</td>
              <td>${escapeHtml(formatPoints(r.lostUnits))}</td>
              <td>${escapeHtml(formatPoints(r.netUnits))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    $('scoreTableWrap').innerHTML = tableHtml;

    // --- Holes list ---
    const list = $('holesList');
    if (!list) return;

    list.innerHTML = '';
    perHole.forEach((h) => {
    const div = document.createElement('div');
    div.className = 'holeRow';

    // whole card clickable
    const goEdit = () => {
      showScreen(SCREENS.game);
      goToHole(h.hole - 1);
    };

    div.setAttribute('role', 'button');
    div.setAttribute('tabindex', '0');
    div.setAttribute('aria-label', `Edit hole ${h.hole}`);

    div.addEventListener('click', goEdit);
    div.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        goEdit();
      }
    });

    const left = document.createElement('div');

    // Title line
    const title = document.createElement('div');
    title.innerHTML = `<b>Hole ${h.hole}</b> <span class="muted small">(${escapeHtml(h.statusLabel)})</span>`;
    left.appendChild(title);

    // Only show mini table if hole is scored (or tie)
    if (h.status !== 'NOT_SCORED') {
      const mini = document.createElement('div');
      mini.className = 'holeMini';
      mini.style.setProperty('--cols', String(game.players.length));

      // Names row
      game.players.forEach((p) => {
        const cell = document.createElement('div');
        cell.className = 'holeMini__name';
        cell.textContent = p.name;
        mini.appendChild(cell);
      });

      // Deltas row
      game.players.forEach((p) => {
        const cell = document.createElement('div');
        cell.className = 'holeMini__delta';

        const u = h.deltaByPlayer?.[p.id] ?? 0;

        let txt = '0';

        if (h.status === 'TIE') {
          txt = '0';
        } else {
          if (u > 0) {
            cell.classList.add('isPlus');
            txt = `+${formatPoints(u)}`;
          } else if (u < 0) {
            cell.classList.add('isMinus');
            txt = `-${formatPoints(Math.abs(u))}`;
          } else {
            txt = '0';
          }
        }

        cell.textContent = txt;
        mini.appendChild(cell);
      });

      left.appendChild(mini);
    }

    div.appendChild(left);
    list.appendChild(div);
  });

  }

  // -----------------------------
  // PWA / Service Worker
  // (iOS PWA: force update checks + short polling for "waiting")
  // -----------------------------
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    const banner = $('updateBanner');
    const btn = $('btnUpdateNow');
    const versionEl = $('appVersion');

    function hideUpdateBanner() {
      if (!banner) return;
      banner.classList.add('hidden');
    }

    function showUpdateBanner(reg) {
      if (!banner || !btn) return;

      banner.classList.remove('hidden');

      btn.onclick = async () => {
        try {
          const r = reg || await navigator.serviceWorker.getRegistration();
          if (r?.waiting) r.waiting.postMessage({ type: 'SKIP_WAITING' });
        } catch {}
      };
    }

    // ---- Version display via SW messaging ----
    async function requestSwVersion() {
      if (!versionEl) return;

      try {
        // Preferred: controller (when already controlled)
        if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: 'GET_VERSION' });
          return;
        }

        // First-load / not-yet-controlled: message the active worker directly
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg?.active) {
          reg.active.postMessage({ type: 'GET_VERSION' });
        }
      } catch {}
    }

    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'VERSION' && versionEl) {
        // SW sends "v2.17.2" already
        versionEl.textContent = ` ${event.data.version}`;
      }
    });

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      hideUpdateBanner();
      requestSwVersion();
      window.location.reload();
    });

    // ---- Register ----
    navigator.serviceWorker.register('./service-worker.js').then((reg) => {
      // Ask for version immediately (works even on first-load now)
      requestSwVersion();

      // If already waiting (rare but possible)
      if (reg.waiting) showUpdateBanner(reg);

      // iOS PWA often doesn't check aggressively — nudge it shortly after launch
      setTimeout(() => {
        reg.update().catch(() => {});
      }, 1500);

      // Poll briefly after launch for waiting SW (iOS delay workaround)
      let tries = 0;
      const poll = setInterval(async () => {
        tries += 1;
        try {
          const r = await navigator.serviceWorker.getRegistration();
          if (r?.waiting) {
            showUpdateBanner(r);
            clearInterval(poll);
          }
        } catch {}
        if (tries >= 8) clearInterval(poll); // ~16s max
      }, 2000);

      // When a new SW is found
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;

        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            navigator.serviceWorker.getRegistration().then((r) => {
              if (r?.waiting) showUpdateBanner(r);
            }).catch(() => {
              showUpdateBanner(reg);
            });
          }
        });
      });

      // Re-check when app becomes visible again (helps on iOS PWA)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          reg.update().catch(() => {});
        }
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

    $('btnSetup')?.addEventListener('click', () => {
      // If there's no active game loaded, just go to setup normally
      const loaded = game || loadGame();
      if (!loaded) {
        isEditingSettings = false;
        $('btnRandomize')?.classList.remove('hidden');

        showScreen(SCREENS.setup);
        initSetupUI();
        return;
      }
      game = loaded;
      ensureHolesLength();
      openEditSettings();
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

      isEditingSettings = false;
      $('btnRandomize')?.classList.remove('hidden');

      if ($('optPushTies')) $('optPushTies').checked = false;
      if ($('optBlindWolf')) $('optBlindWolf').checked = false;

      initSetupUI();

      // Ensure player count buttons are enabled for new game
      const pcb = $('playerCountBtns');
      if (pcb) {
        qsa('.segBtn', pcb).forEach(btn => {
          btn.disabled = false;
          btn.classList.remove('segBtn--disabled');
        });
      }
    });

    $('btnResume')?.addEventListener('click', () => {
      const loaded = loadGame();
      if (!loaded) return;
      game = loaded;
      ensureHolesLength();
      showScreen(SCREENS.game);
      renderGameScreen();
    });

    // ✅ Start screen only: manual "Check for update" (iOS-friendly + user feedback)
    $('btnCheckUpdate')?.addEventListener('click', async () => {
      const btn = $('btnCheckUpdate');
      const originalLabel = btn?.textContent || 'Check for update';

      const setBusy = (busy) => {
        if (!btn) return;
        btn.disabled = !!busy;
        btn.textContent = busy ? 'Checking…' : originalLabel;
      };

      try {
        setBusy(true);

        // Find the SW registration (getRegistration is usually enough, but iOS can be weird)
        let reg = await navigator.serviceWorker.getRegistration();
        if (!reg) {
          const regs = await navigator.serviceWorker.getRegistrations();
          reg = regs?.[0] || null;
        }

        if (!reg) {
          alert('Offline cache is not enabled (no service worker registered).');
          return;
        }

        // If a saved game exists, confirm before applying updates (reload)
        const hasSavedGame = !!localStorage.getItem(STORAGE_KEY);
        if (hasSavedGame) {
          const ok = confirm(
            'A game is saved on this device.\n\nChecking for updates is safe, but applying an update will reload the app.\n\nContinue?'
          );
          if (!ok) return;
        }

        // Force an update check
        await reg.update();

        // iOS often needs a moment before "waiting" appears
        await new Promise(r => setTimeout(r, 1200));

        // Re-read registration to see if update is waiting
        const reg2 = await navigator.serviceWorker.getRegistration() || reg;

        if (reg2?.waiting) {
          const apply = confirm('Update found. Apply now? (The app will reload)');
          if (!apply) return;

          reg2.waiting.postMessage({ type: 'SKIP_WAITING' });
          // controllerchange listener will reload
          return;
        }

        alert('No update found.');
      } catch (e) {
        alert('Update check failed. Try again when you have a connection.');
      } finally {
        setBusy(false);
      }
    });

    $('btnBackToLoad')?.addEventListener('click', () => showScreen(SCREENS.load));

    $('btnRandomize')?.addEventListener('click', () => {
      const inputs = qsa('.playerNameInput');
      const names = inputs.map(inp => (inp.value || inp.placeholder).trim());
      const shuffled = shuffle(names);
      inputs.forEach((inp, idx) => { inp.value = shuffled[idx]; });
    });

    $('btnStartGame')?.addEventListener('click', () => {
      // EDIT MODE: apply changes without resetting holes/scores
      if (isEditingSettings) {
        const ok = applySettingsFromSetup();
        if (!ok) return;

        isEditingSettings = false;
        if ($('btnStartGame')) $('btnStartGame').textContent = 'Start Game';

        showScreen(SCREENS.game);
        renderGameScreen();
        return;
      }

      // NORMAL MODE: start a brand new game (your existing behavior)
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

    // Top buttons
    $('btnPrevHole')?.addEventListener('click', () => goToHole(game.currentHoleIndex - 1));
    $('btnNextHole')?.addEventListener('click', () => goToHole(game.currentHoleIndex + 1));

    // Bottom buttons
    $('btnPrevHoleBottom')?.addEventListener('click', () => goToHole(game.currentHoleIndex - 1));
    $('btnNextHoleBottom')?.addEventListener('click', () => goToHole(game.currentHoleIndex + 1));

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
        alert('Select a result (Wolf Pack / Little Piggies / Tie).');
        return;
      }

      const isTie = h.result === 'TIE';
      if (!isTie) {
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

      // Lock snapshot so future edits show dirty
      h._savedSnapshot = holeSnapshot(h);
      clearEditBaselineForCurrentHole();
      refreshDirtyState();

      // Auto-advance if not last hole
      if (game.currentHoleIndex < game.holeCount - 1) {
        goToHole(game.currentHoleIndex + 1);
      } else {
        renderGameScreen();
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
  
  function setAppVersionFromFilename() {
    const versionEl = document.getElementById('appVersion');
    if (!versionEl) return;

    // Find the script tag that loaded this file
    const scripts = document.getElementsByTagName('script');
    let src = '';

    for (const s of scripts) {
      if (s.src && s.src.includes('/assets/app.')) {
        src = s.src;
        break;
      }
    }

    const match = src.match(/app\.(v[\d.]+)\.js/);
    if (match && match[1]) {
      versionEl.textContent = ` ${match[1]}`;
    }
  }

  function init() {
    setAppVersionFromFilename();

    bindUI();
    updateResumeButton();
    registerServiceWorker();
    applyTheme(loadTheme());
    showScreen(SCREENS.load);
  }

  window.addEventListener('DOMContentLoaded', init);

})();
