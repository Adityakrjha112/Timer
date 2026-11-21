/* =========================================================
   Focus Timer — logic
   Vanilla JS. Countdown is timestamp-based (Date.now vs. a
   stored end time), so it stays accurate across pauses, tab
   switches, throttled timers and dropped frames.
   ========================================================= */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const DEFAULT_COLOR = '#F5D90A';
  const STORE_KEY = 'focus-timer:v1';
  const IDLE_MS = 2800;

  const root = document.documentElement;
  const el = {
    setup: $('#setup'),
    stage: $('#stage'),
    fill: $('#fill'),
    inputs: { h: $('#in-h'), m: $('#in-m'), s: $('#in-s') },
    presets: $$('.preset'),
    swatches: $$('.swatch[data-color]'),
    custom: $('#custom-color'),
    customSwatch: $('#custom-swatch'),
    hex: $('#hex'),
    soundToggle: $('#sound-toggle'),
    start: $('#start'),
    srTime: $('#sr-time'),
    btnToggle: $('[data-act="toggle"]'),
    btnSound: $('[data-act="sound"]'),
    btnFs: $('[data-act="fs"]'),
    doneSub: $('#done-sub'),
    rotate: $('#rotate'),
    themeMeta: $('meta[name="theme-color"]'),
  };

  // Digit spans in both clock layers (base + colored), updated together.
  const clockParts = $$('.clock', el.stage).map((c) => ({
    h: $('.h', c), m: $('.m', c), s: $('.s', c),
  }));

  const state = {
    total: 0,        // ms
    remaining: 0,    // ms, authoritative while paused
    endAt: 0,        // epoch ms, authoritative while running
    running: false,
    done: false,
    active: false,   // stage is showing
    color: DEFAULT_COLOR,
    sound: true,
  };

  const isTouch = matchMedia('(pointer: coarse)').matches;
  const portraitMQ = matchMedia('(orientation: portrait)');

  /* ---------------- Utilities ---------------- */

  const pad = (n) => String(n).padStart(2, '0');

  function splitTime(totalSec) {
    return {
      h: Math.floor(totalSec / 3600),
      m: Math.floor((totalSec % 3600) / 60),
      s: totalSec % 60,
    };
  }

  function formatTime(totalSec) {
    const t = splitTime(totalSec);
    return `${pad(t.h)}:${pad(t.m)}:${pad(t.s)}`;
  }

  function describeDuration(ms) {
    const t = splitTime(Math.round(ms / 1000));
    const parts = [];
    if (t.h) parts.push(`${t.h} hr`);
    if (t.m) parts.push(`${t.m} min`);
    if (t.s) parts.push(`${t.s} sec`);
    return parts.join(' ') || '0 sec';
  }

  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  // Pick whichever of near-black / white has more contrast on the color.
  function inkFor(hex) {
    const L = luminance(hex);
    const vsBlack = (L + 0.05) / 0.05;
    const vsWhite = 1.05 / (L + 0.05);
    return vsBlack >= vsWhite ? '#0a0a0a' : '#ffffff';
  }

  function normalizeHex(v) {
    if (typeof v !== 'string') return null;
    const m = v.trim().match(/^#?([0-9a-f]{6})$/i);
    return m ? `#${m[1].toUpperCase()}` : null;
  }

  /* ---------------- Persistence ---------------- */

  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
  }

  function savePrefs() {
    try {
      const { h, m, s } = readFields();
      localStorage.setItem(STORE_KEY, JSON.stringify({ h, m, s, color: state.color, sound: state.sound }));
    } catch { /* storage unavailable — fine */ }
  }

  /* ---------------- Setup: duration ---------------- */

  function fieldValue(input) {
    const max = Number(input.dataset.max);
    const n = parseInt(input.value, 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : 0;
  }

  function readFields() {
    return { h: fieldValue(el.inputs.h), m: fieldValue(el.inputs.m), s: fieldValue(el.inputs.s) };
  }

  function readDurationMs() {
    const { h, m, s } = readFields();
    return (h * 3600 + m * 60 + s) * 1000;
  }

  function setFields(h, m, s) {
    el.inputs.h.value = pad(h);
    el.inputs.m.value = pad(m);
    el.inputs.s.value = pad(s);
    syncSetup();
  }

  function syncSetup() {
    const ms = readDurationMs();
    el.start.disabled = ms <= 0;
    el.presets.forEach((b) => {
      const on = Number(b.dataset.min) * 60000 === ms;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  Object.values(el.inputs).forEach((input) => {
    input.addEventListener('focus', () => requestAnimationFrame(() => input.select()));
    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '').slice(-2);
      if (digits !== input.value) input.value = digits;
      syncSetup();
    });
    input.addEventListener('blur', () => {
      input.value = pad(fieldValue(input));
      syncSetup();
      savePrefs();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const max = Number(input.dataset.max);
        const step = e.key === 'ArrowUp' ? 1 : -1;
        input.value = pad((fieldValue(input) + step + max + 1) % (max + 1));
        input.select();
        syncSetup();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
        startTimer();
      }
    });
  });

  el.presets.forEach((btn) => {
    btn.addEventListener('click', () => {
      const min = Number(btn.dataset.min);
      setFields(Math.floor(min / 60), min % 60, 0);
      savePrefs();
    });
  });

  /* ---------------- Setup: color ---------------- */

  function setColor(hex) {
    hex = normalizeHex(hex) || DEFAULT_COLOR;
    state.color = hex;
    root.style.setProperty('--accent', hex);
    root.style.setProperty('--accent-ink', inkFor(hex));
    el.hex.textContent = hex;

    let matched = false;
    el.swatches.forEach((s) => {
      const on = s.dataset.color.toUpperCase() === hex;
      if (on) matched = true;
      s.classList.toggle('is-active', on);
      s.setAttribute('aria-pressed', String(on));
    });
    el.customSwatch.classList.toggle('is-active', !matched);
    el.customSwatch.classList.toggle('has-color', !matched);
    el.customSwatch.style.setProperty('--sw', hex);
    el.custom.value = hex.toLowerCase();
  }

  el.swatches.forEach((s) => s.addEventListener('click', () => { setColor(s.dataset.color); savePrefs(); }));
  el.custom.addEventListener('input', () => setColor(el.custom.value));
  el.custom.addEventListener('change', () => { setColor(el.custom.value); savePrefs(); });

  /* ---------------- Sound ---------------- */

  let audioCtx = null;

  // Must be called inside a user gesture (iOS/Safari autoplay rules).
  function unlockAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const buf = audioCtx.createBuffer(1, 1, 22050);
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      src.start(0);
    } catch { /* no audio — the timer still works */ }
  }

  function bell(freq, t, out) {
    // A soft bell: fundamental plus two quieter, faster-decaying partials.
    [[1, 0.5, 2.2], [2.01, 0.14, 1.1], [3.02, 0.06, 0.7]].forEach(([mul, amp, decay]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * mul;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(amp, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      osc.connect(gain).connect(out);
      osc.start(t);
      osc.stop(t + decay + 0.05);
    });
  }

  function playChime() {
    if (!audioCtx) return;
    try {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const master = audioCtx.createGain();
      master.gain.value = 0.35;
      master.connect(audioCtx.destination);
      const t0 = audioCtx.currentTime + 0.05;
      const notes = [659.25, 783.99, 1046.5]; // E5, G5, C6
      for (let rep = 0; rep < 3; rep++) {
        notes.forEach((f, i) => bell(f, t0 + rep * 1.7 + i * 0.16, master));
      }
    } catch { /* ignore */ }
  }

  function setSound(on) {
    state.sound = on;
    el.soundToggle.setAttribute('aria-checked', String(on));
    el.btnSound.setAttribute('aria-pressed', String(on));
    el.btnSound.setAttribute('aria-label', on ? 'Mute completion sound' : 'Unmute completion sound');
  }

  el.soundToggle.addEventListener('click', () => {
    setSound(!state.sound);
    if (state.sound) unlockAudio();
    savePrefs();
  });

  /* ---------------- Fullscreen / orientation / wake lock ---------------- */

  const fsSupported = !!(root.requestFullscreen || root.webkitRequestFullscreen);
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

  // Call synchronously from a user gesture: the request itself happens before the first await.
  async function enterFullscreen() {
    const req = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!req) return false;
    try {
      await req.call(root, { navigationUI: 'hide' });
      return true;
    } catch {
      return false;
    }
  }

  async function exitFullscreen() {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (!exit || !fsElement()) return;
    try { await exit.call(document); } catch { /* ignore */ }
  }

  async function lockLandscape() {
    try {
      if (screen.orientation && typeof screen.orientation.lock === 'function') {
        await screen.orientation.lock('landscape');
        return true;
      }
    } catch { /* not allowed / unsupported (e.g. iOS, desktop) */ }
    return false;
  }

  function unlockOrientation() {
    try { screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); } catch { /* ignore */ }
  }

  // On phones: go landscape if the browser lets us, otherwise ask the user to rotate.
  async function goLandscape() {
    if (!isTouch) return;
    const locked = await lockLandscape();
    if (!locked && portraitMQ.matches && state.active && !state.done) showRotateHint();
  }

  function showRotateHint() { el.rotate.hidden = false; }
  function hideRotateHint() { el.rotate.hidden = true; }

  portraitMQ.addEventListener?.('change', (e) => { if (!e.matches) hideRotateHint(); });

  function onFullscreenChange() {
    el.stage.classList.toggle('is-fs', !!fsElement());
    el.btnFs.setAttribute('aria-label', fsElement() ? 'Exit fullscreen' : 'Enter fullscreen');
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  async function toggleFullscreen() {
    if (fsElement()) {
      unlockOrientation();
      await exitFullscreen();
    } else {
      const ok = await enterFullscreen();
      if (ok) goLandscape();
    }
  }

  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch { wakeLock = null; }
  }
  function releaseWake() {
    try { wakeLock && wakeLock.release(); } catch { /* ignore */ }
    wakeLock = null;
  }

  /* ---------------- Countdown engine ---------------- */

  let rafId = 0;
  let beatId = 0;
  let finishId = 0;
  let lastSec = -1;

  function remainingNow() {
    return state.running ? Math.max(0, state.endAt - Date.now()) : state.remaining;
  }

  function setFill(fraction) {
    const cut = ((1 - Math.min(Math.max(fraction, 0), 1)) * 100).toFixed(4);
    const v = `inset(0 ${cut}% 0 0)`;
    el.fill.style.clipPath = v;
    el.fill.style.webkitClipPath = v;
  }

  function paintClock(sec) {
    if (sec === lastSec) return;
    lastSec = sec;
    const t = splitTime(sec);
    const hh = pad(t.h), mm = pad(t.m), ss = pad(t.s);
    for (const p of clockParts) {
      p.h.textContent = hh;
      p.m.textContent = mm;
      p.s.textContent = ss;
    }
    const text = `${hh}:${mm}:${ss}`;
    el.srTime.textContent = text;
    if (state.active) document.title = `${text} · ${state.running ? 'Focus' : 'Paused'}`;
  }

  function render() {
    if (!state.active || state.done) return;
    const rem = remainingNow();
    setFill(state.total ? rem / state.total : 0);
    paintClock(Math.ceil(rem / 1000));
    if (state.running && rem <= 0) finish();
  }

  function frame() {
    render();
    if (state.running) rafId = requestAnimationFrame(frame);
  }

  function clearTimers() {
    cancelAnimationFrame(rafId);
    clearInterval(beatId);
    clearTimeout(finishId);
    rafId = beatId = finishId = 0;
  }

  function run() {
    if (state.running || state.done || state.remaining <= 0) return;
    state.endAt = Date.now() + state.remaining;
    state.running = true;
    clearTimers();
    rafId = requestAnimationFrame(frame);
    // rAF pauses in background tabs; these keep the title fresh and
    // guarantee completion (and the chime) fires even when hidden.
    beatId = setInterval(render, 1000);
    finishId = setTimeout(render, state.remaining + 30);
    keepAwake();
    lastSec = -1;
    updateUI();
  }

  function pause() {
    if (!state.running) return;
    state.remaining = remainingNow();
    state.running = false;
    clearTimers();
    lastSec = -1;
    render();
    updateUI();
  }

  function togglePause() {
    if (state.done) return;
    state.running ? pause() : run();
  }

  function reset() {
    clearTimers();
    state.running = false;
    state.done = false;
    state.remaining = state.total;
    lastSec = -1;
    render();
    updateUI();
  }

  function finish() {
    clearTimers();
    state.running = false;
    state.done = true;
    state.remaining = 0;
    setFill(0);
    lastSec = -1;
    paintClock(0);
    document.title = "Time's up · Focus";
    hideRotateHint();
    updateUI();
    if (state.sound) playChime();
    try { navigator.vibrate && navigator.vibrate([180, 90, 180]); } catch { /* ignore */ }
  }

  /* ---------------- Stage UI ---------------- */

  let idleId = 0;

  function showControls() {
    el.stage.classList.remove('is-idle');
    clearTimeout(idleId);
    if (state.running) idleId = setTimeout(() => el.stage.classList.add('is-idle'), IDLE_MS);
  }

  function updateUI() {
    const s = el.stage.classList;
    s.toggle('is-paused', !state.running && !state.done);
    s.toggle('is-done', state.done);
    el.btnToggle.setAttribute('aria-label', state.running ? 'Pause' : 'Resume');
    el.doneSub.textContent = `${describeDuration(state.total)} of focus, complete.`;
    showControls();
  }

  function startTimer() {
    if (state.active) return;
    const ms = readDurationMs();
    if (ms <= 0) return;

    const { h, m, s } = readFields();
    setFields(h, m, s);
    savePrefs();

    // Both of these need the click's user activation — do them first.
    unlockAudio();
    const fsPromise = enterFullscreen();

    state.total = ms;
    state.remaining = ms;
    state.done = false;
    state.active = true;
    lastSec = -1;

    el.themeMeta && el.themeMeta.setAttribute('content', '#000000');
    el.setup.hidden = true;
    el.stage.hidden = false;
    setFill(1);
    // next frame so the opacity transition runs
    requestAnimationFrame(() => el.stage.classList.add('is-visible'));

    run();
    // Some browsers never settle the fullscreen promise when they ignore the
    // request, so don't let the orientation step wait on it forever.
    Promise.race([fsPromise, new Promise((r) => setTimeout(r, 700))]).then(goLandscape);
  }

  async function exitTimer() {
    clearTimers();
    clearTimeout(idleId);
    state.running = false;
    state.done = false;
    state.active = false;
    releaseWake();
    hideRotateHint();
    unlockOrientation();
    await exitFullscreen();

    el.stage.classList.remove('is-visible', 'is-paused', 'is-done', 'is-idle');
    el.stage.hidden = true;
    el.setup.hidden = false;
    el.themeMeta && el.themeMeta.setAttribute('content', '#0a0a0a');
    document.title = 'Focus Timer';
    el.start.focus({ preventScroll: true });
  }

  function restart() {
    state.done = false;
    state.remaining = state.total;
    lastSec = -1;
    setFill(1);
    updateUI();
    run();
    if (!fsElement() && fsSupported) enterFullscreen();
    if (isTouch) setTimeout(goLandscape, 700);
  }

  const actions = {
    toggle: togglePause,
    reset,
    sound: () => { setSound(!state.sound); if (state.sound) unlockAudio(); savePrefs(); },
    fs: toggleFullscreen,
    close: exitTimer,
    restart,
    'dismiss-rotate': hideRotateHint,
  };

  el.stage.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    e.stopPropagation();
    actions[btn.dataset.act]?.();
    showControls();
  });

  ['pointermove', 'pointerdown', 'touchstart'].forEach((type) =>
    el.stage.addEventListener(type, showControls, { passive: true }));

  // Double-click / double-tap the timer to toggle fullscreen, like a video player.
  el.stage.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, .done, .rotate')) return;
    if (fsSupported) toggleFullscreen();
  });

  if (!fsSupported) el.btnFs.hidden = true; // e.g. iPhone Safari

  /* ---------------- iPhone: Home Screen tip ----------------
     iPhone browsers (all of them use Safari's engine) don't allow websites
     to go fullscreen. Opened from the Home Screen, the site runs with no
     browser bars, so we point iPhone visitors there. */

  const TIP_KEY = 'focus-timer:ios-tip';
  const isIPhone = /iPhone|iPod/.test(navigator.userAgent);
  const isHomeScreenApp = navigator.standalone === true ||
    matchMedia('(display-mode: standalone)').matches ||
    matchMedia('(display-mode: fullscreen)').matches;
  const iosTip = $('#ios-tip');
  const iosSheet = $('#ios-sheet');

  let tipDismissed = false;
  try { tipDismissed = localStorage.getItem(TIP_KEY) === 'dismissed'; } catch { /* ignore */ }
  if (isIPhone && !isHomeScreenApp && !fsSupported && !tipDismissed) iosTip.hidden = false;

  const openSheet = () => { iosSheet.hidden = false; $('#ios-sheet-close').focus(); };
  const closeSheet = () => { iosSheet.hidden = true; };
  $('#ios-tip-how').addEventListener('click', openSheet);
  $('#ios-sheet-close').addEventListener('click', closeSheet);
  iosSheet.addEventListener('click', (e) => { if (e.target === iosSheet) closeSheet(); });
  $('#ios-tip-close').addEventListener('click', () => {
    iosTip.hidden = true;
    try { localStorage.setItem(TIP_KEY, 'dismissed'); } catch { /* ignore */ }
  });

  el.start.addEventListener('click', startTimer);

  /* ---------------- Keyboard ---------------- */

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (!state.active) {
      const tag = e.target.tagName;
      if (e.key === 'Enter' && tag !== 'BUTTON' && tag !== 'INPUT') startTimer();
      return;
    }

    const key = e.key.toLowerCase();
    if (state.done) {
      if (key === 'enter' || key === ' ') { e.preventDefault(); restart(); }
      return;
    }
    if (key === ' ' || key === 'k') { e.preventDefault(); togglePause(); }
    else if (key === 'r') reset();
    else if (key === 'f') toggleFullscreen();
    else if (key === 'm') actions.sound();
    else return;
    showControls();
  });

  /* ---------------- Tab visibility ---------------- */

  document.addEventListener('visibilitychange', () => {
    if (!state.active) return;
    if (document.visibilityState === 'visible') {
      lastSec = -1;
      render(); // snap the bar + digits to the true remaining time
      if (state.running) {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(frame);
        keepAwake(); // wake locks are released when the page is hidden
      }
    }
  });

  /* ---------------- Init ---------------- */

  const prefs = loadPrefs();
  const valid = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
  if (valid(prefs.h, 23) && valid(prefs.m, 59) && valid(prefs.s, 59) && prefs.h + prefs.m + prefs.s > 0) {
    setFields(prefs.h, prefs.m, prefs.s);
  } else {
    setFields(0, 25, 0);
  }
  setColor(normalizeHex(prefs.color) || DEFAULT_COLOR);
  setSound(prefs.sound !== false);
  onFullscreenChange();
})();
