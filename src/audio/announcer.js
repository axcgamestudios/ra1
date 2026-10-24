// Stadium announcer: bundled voice clips ("GOAL!", "What a save!", ...) with a
// speechSynthesis fallback when the audio files cannot load. Also owns a small
// center-screen banner so every announcement is readable while muted.
import { getAudioContext, getAudioInput, getAudioSettings } from './settings.js';

const CLIP_PATH = '/assets/audio/announcer/';
const CLIPS = Object.freeze({
  goal: { file: 'goal.mp3', text: 'GOAL!', banner: 'GOAL!', team: true },
  'nice-shot': { file: 'nice-shot.mp3', text: 'Nice shot!', banner: 'NICE SHOT!' },
  'what-a-save': { file: 'what-a-save.mp3', text: 'What a save!', banner: 'WHAT A SAVE!' },
  'epic-save': { file: 'epic-save.mp3', text: 'Epic save!', banner: 'EPIC SAVE!' },
  'great-pass': { file: 'great-pass.mp3', text: 'Great pass!', banner: 'GREAT PASS!' },
  'what-a-play': { file: 'what-a-play.mp3', text: 'What a play!', banner: 'WHAT A PLAY!' },
  victory: { file: 'victory.mp3', text: 'Victory!', banner: 'VICTORY!' },
  defeat: { file: 'defeat.mp3', text: 'Defeat.', banner: 'DEFEAT' },
});

const BANNER_MS = 1900;
const SAME_KIND_COOLDOWN = 850;
const QUEUE_GAP = 260;
const VOLUME = 0.9;

export function createAnnouncer(root, { isEnabled = () => getAudioSettings().announcer !== false } = {}) {
  const enabled = () => isEnabled();
  const buffers = new Map();
  const failures = new Set();
  const lastPlayed = new Map();
  const queue = [];
  let playing = false;
  let bannerTimer = 0;

  const banner = document.createElement('div');
  banner.className = 'announcer-banner';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  banner.hidden = true;
  (root ?? document.body).append(banner);

  function showBanner(kind, team) {
    const clip = CLIPS[kind];
    if (!clip) return;
    banner.textContent = clip.banner;
    banner.dataset.team = team === 0 ? 'blue' : team === 1 ? 'orange' : '';
    banner.dataset.kind = kind;
    banner.hidden = false;
    banner.classList.remove('is-visible');
    // Restart the CSS animation.
    void banner.offsetWidth;
    banner.classList.add('is-visible');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => { banner.hidden = true; banner.classList.remove('is-visible'); }, BANNER_MS);
  }

  async function loadClip(kind) {
    if (buffers.has(kind)) return buffers.get(kind);
    if (failures.has(kind)) return null;
    try {
      const response = await fetch(CLIP_PATH + CLIPS[kind].file);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.arrayBuffer();
      const buffer = await getAudioContext().decodeAudioData(data.slice(0));
      buffers.set(kind, buffer);
      return buffer;
    } catch {
      failures.add(kind);
      return null;
    }
  }

  function speakFallback(kind) {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      if (synth.speaking) synth.cancel();
      const utterance = new SpeechSynthesisUtterance(CLIPS[kind].text);
      utterance.lang = 'en-US';
      utterance.rate = 1.06;
      utterance.pitch = 0.55;
      utterance.volume = VOLUME * 0.8;
      synth.speak(utterance);
    } catch { /* No voice support at all: the banner still shows. */ }
  }

  async function playNext() {
    const item = queue.shift();
    if (!item) { playing = false; return; }
    playing = true;
    try {
      const buffer = await loadClip(item.kind);
      if (buffer) {
        const context = getAudioContext();
        if (context.state === 'running') {
          const source = context.createBufferSource();
          const gain = context.createGain();
          source.buffer = buffer;
          source.playbackRate.value = 0.97 + Math.random() * 0.06;
          gain.gain.value = VOLUME;
          source.connect(gain).connect(getAudioInput());
          source.start();
          source.onended = () => { gain.disconnect(); };
        }
      } else speakFallback(item.kind);
    } catch { speakFallback(item.kind); }
    setTimeout(() => { void playNext(); }, QUEUE_GAP);
  }

  function say(kind, { team = null } = {}) {
    if (!enabled() || !CLIPS[kind]) return false;
    const now = performance.now();
    const last = lastPlayed.get(kind) ?? -Infinity;
    if (now - last < SAME_KIND_COOLDOWN) return false;
    lastPlayed.set(kind, now);
    showBanner(kind, team);
    queue.push({ kind, team });
    if (!playing) void playNext();
    return true;
  }

  function dispose() {
    clearTimeout(bannerTimer);
    queue.length = 0;
    banner.remove();
  }

  return { say, dispose, get enabled() { return enabled(); }, set enabled(value) { isEnabled = () => !!value; } };
}
