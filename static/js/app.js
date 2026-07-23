/* global SongloftPlugin */
'use strict';

const { apiGet, apiPost, getAuthToken, announce } = SongloftPlugin;

// ---- Theme sync -----------------------------------------------------------
// The host (Songloft) themes itself via Material 3 CSS variables. The plugin
// must mirror the host's dark/light state so its own surfaces stay readable.
// We detect the host's effective theme by reading the *actual* computed value
// of --md-surface (which the host always sets), so this works whether the host
// follows the OS preference or an in-app toggle. We then tag #app with
// `.theme-dark`, which is what styles.css keys its dark overrides off of.
function slpColorLuminance(css) {
  css = (css || '').trim();
  let r, g, b;
  if (css.startsWith('#')) {
    let h = css.slice(1);
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
  } else {
    const m = css.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((s) => parseFloat(s));
    [r, g, b] = [p[0], p[1], p[2]];
  }
  if ([r, g, b].some((v) => isNaN(v))) return null;
  const a = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}

function slpApplyTheme() {
  const app = document.getElementById('app');
  if (!app) return;
  const surface = getComputedStyle(document.documentElement).getPropertyValue('--md-surface').trim();
  const lum = slpColorLuminance(surface);
  const dark = lum !== null ? lum < 0.5 : (window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false);
  app.classList.toggle('theme-dark', dark);
}

function slpInitThemeSync() {
  slpApplyTheme();
  const root = document.documentElement;
  if (window.MutationObserver) {
    new MutationObserver(() => slpApplyTheme()).observe(root, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-mode', 'color-scheme'],
    });
  }
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', slpApplyTheme);
    else if (mq.addListener) mq.addListener(slpApplyTheme);
  }
}

// ---- Player bridge (official Songloft SDK) --------------------------------
// Playback is delegated entirely to the Songloft host player through
// window.SongloftPlugin.player. The plugin keeps no local audio element and no
// local queue: the host player is the single source of truth. This mirrors the
// approach used by songloft-now-playing — calls are retried on timeout and
// rapid togglePlay taps are coalesced to avoid flooding the host bridge.
class PlayerBridge {
  constructor() {
    this.listeners = new Set();
    this.sdkBound = false;
    this.toggleBusy = false;
    this.toggleQueued = false;
  }

  player() { return window.SongloftPlugin?.player; }

  available() {
    const host = window.SongloftPlugin?.host;
    if (host && typeof host.isAvailable === 'function') return Boolean(host.isAvailable());
    return Boolean(this.player());
  }

  invoke(method, args) {
    const player = this.player();
    if (!player || typeof player[method] !== 'function') {
      return Promise.reject(new Error(`播放器桥接不可用：${method}`));
    }
    return Promise.resolve(player[method](...args));
  }

  async call(method, args, retries = 3) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.invoke(method, args);
      } catch (error) {
        lastError = error;
        const isTimeout = /timeout|超时/i.test(String(error?.message || error));
        if (!isTimeout || attempt === retries) throw error;
        await new Promise((resolve) => setTimeout(resolve, 320 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  getState() { return this.call('getState', []); }
  play(id) { return this.call('play', [id]); }
  setQueue(ids, startIndex = 0) { return this.call('setQueue', [ids, { startIndex }]); }
  addToQueue(ids) { return this.call('addToQueue', [ids]); }
  previous() { return this.call('prev', []); }
  next() { return this.call('next', []); }
  seek(seconds) { return this.call('seek', [seconds]); }
  pause() { return this.invoke('pause', []); }
  setMode(mode) { return this.call('setPlayMode', [mode]); }
  setVolume(volume) { return this.invoke('setVolume', [volume]); }

  toggle() {
    if (this.toggleBusy) {
      this.toggleQueued = true;
      return Promise.resolve({ coalesced: true });
    }
    this.toggleBusy = true;
    return this.call('togglePlay', []).finally(() => {
      this.toggleBusy = false;
      if (this.toggleQueued) {
        this.toggleQueued = false;
        setTimeout(() => { this.toggle().catch(() => {}); }, 80);
      }
    });
  }

  onState(fn) {
    this.listeners.add(fn);
    const player = this.player();
    if (!this.sdkBound && player && typeof player.onStateChange === 'function') {
      this.sdkBound = true;
      player.onStateChange((state) => this.listeners.forEach((listener) => listener(state)));
    }
  }
}

const playerBridge = new PlayerBridge();

// Host-driven playback state. Populated exclusively from player.getState() and
// player.onStateChange(); never mutated by local playback logic.
const playerState = {
  queue: [],
  currentIndex: -1,
  playing: false,
  currentSong: null,
  duration: 0,
  posAnchor: null,
  dismissed: false,
};

function rawSong(song) { return song?.song || song?.track || song || {}; }

function songId(song) {
  const s = rawSong(song);
  const id = s.id ?? song?.id ?? s.song_id ?? song?.song_id ?? s.songId ?? song?.songId;
  return id == null ? '' : String(id);
}

function normalizeSong(song, index = 0) {
  const s = rawSong(song);
  const id = songId(song);
  return { ...s, ...song, id: id || String(index + 1) };
}

function stateQueue(state) {
  const q = state.queue ?? state.play_queue ?? state.playQueue ?? state.queue_songs
    ?? state.queueSongs ?? state.songs ?? state.playlist;
  const list = Array.isArray(q) ? q
    : Array.isArray(q?.songs) ? q.songs
    : Array.isArray(q?.items) ? q.items
    : Array.isArray(q?.queue) ? q.queue : [];
  return list.map(normalizeSong).filter(songId);
}

function stateIndex(state, queue) {
  const raw = Number.isInteger(state.current_index) ? state.current_index
    : Number.isInteger(state.currentIndex) ? state.currentIndex : -1;
  const id = songId(state.current_song ?? state.currentSong);
  const found = id ? queue.findIndex((s) => songId(s) === id) : -1;
  if (found >= 0 && (raw < 0 || raw >= queue.length || songId(queue[raw]) !== id)) return found;
  return raw >= 0 && raw < queue.length ? raw : found;
}

function statePlaying(state, fallback) {
  const value = state.is_playing ?? state.isPlaying ?? state.playing ?? state.player_state
    ?? state.playerState ?? state.status;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (['paused', 'pause', 'stopped', 'stop', 'idle', 'false', '0'].includes(normalized)) return false;
    if (['playing', 'play', 'true', '1'].includes(normalized)) return true;
  }
  return fallback;
}

function statePosition(state) {
  const v = state.position ?? state.progress ?? state.current_time ?? state.currentTime
    ?? state.current_position ?? state.currentPosition ?? state.played_seconds
    ?? state.playback_position ?? state.playbackPosition ?? state.playback_time
    ?? state.playbackTime ?? state.audio_position ?? state.audioPosition
    ?? state.elapsed ?? state.offset ?? state.pos;
  const num = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Number(v) : NaN);
  if (!Number.isFinite(num) || num < 0) return null;
  return num >= 1000 ? num / 1000 : num;
}

function isCurrentSong(song) {
  return Boolean(playerState.currentSong) && songId(playerState.currentSong) === songId(song);
}

// Interpolated playback position. The host only emits discrete state changes,
// so between them we advance the last known position with a local clock.
function playerPosition() {
  if (!playerState.posAnchor) return 0;
  const elapsed = playerState.posAnchor.playing ? (performance.now() - playerState.posAnchor.t) / 1000 : 0;
  return Math.max(0, playerState.posAnchor.pos + elapsed);
}

// ---- Lyrics -----------------------------------------------------------------
// Lyrics are read straight from the Songloft server (GET /api/v1/songs/{id}/lyric)
// because the plugin SDK exposes no lyrics method. The response may be plain LRC
// text or JSON wrapping the text, so both are tolerated. The active line is
// derived from the interpolated playback position on every tick.
let lyricSongId = '';
let lyricLines = [];
let lyricLineIdx = -1;
const lyricCache = new Map();

function serverBasePath() {
  const marker = '/api/v1/jsplugin/';
  const index = window.location.pathname.indexOf(marker);
  return index >= 0 ? window.location.pathname.slice(0, index) : '';
}

function lyricText(data) {
  if (typeof data === 'string') return data;
  const text = data?.lyric ?? data?.lyrics ?? data?.lrc ?? data?.text ?? data?.content
    ?? data?.data?.lyric ?? data?.data?.lyrics ?? data?.data?.lrc;
  return typeof text === 'string' ? text : '';
}

function parseLrc(text) {
  const lines = [];
  if (!text) return lines;
  const re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of String(text).split(/\r?\n/)) {
    re.lastIndex = 0;
    const times = [];
    let match;
    while ((match = re.exec(raw))) {
      times.push(Number(match[1]) * 60 + Number(match[2]) + (match[3] ? Number(match[3]) / 10 ** match[3].length : 0));
    }
    const words = raw.replace(re, '').trim();
    if (!times.length || !words) continue;
    for (const time of times) lines.push([time, words]);
  }
  lines.sort((a, b) => a[0] - b[0]);
  return lines;
}

function setLyricText(text) {
  const element = $('#playerLyric');
  if (!element || element.textContent === text) return;
  element.textContent = text;
  element.classList.remove('swap');
  void element.offsetWidth;
  element.classList.add('swap');
}

function updateLyricLine(position) {
  const element = $('#playerLyric');
  if (!element) return;
  if (!lyricLines.length) { setLyricText(''); return; }
  let idx = lyricLineIdx < 0 ? 0 : lyricLineIdx;
  while (idx + 1 < lyricLines.length && lyricLines[idx + 1][0] <= position) idx += 1;
  while (idx > 0 && lyricLines[idx][0] > position) idx -= 1;
  if (idx === 0 && lyricLines[0][0] > position) idx = -1;
  if (idx !== lyricLineIdx) {
    lyricLineIdx = idx;
    setLyricText(idx >= 0 ? lyricLines[idx][1] : '');
  }
}

function resetLyric() {
  lyricLines = [];
  lyricLineIdx = -1;
  setLyricText('');
}

async function loadLyric(id) {
  if (!id) { resetLyric(); return; }
  if (lyricCache.has(id)) {
    lyricLines = lyricCache.get(id);
    lyricLineIdx = -1;
    updateLyricLine(playerPosition());
    return;
  }
  let lines = [];
  if (typeof fetch === 'function') {
    try {
      const headers = {};
      const token = getAuthToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`${serverBasePath()}/api/v1/songs/${id}/lyric`, { headers });
      if (response.ok) {
        const text = await response.text();
        let data = text;
        try { data = JSON.parse(text); } catch { /* plain LRC text */ }
        lines = parseLrc(lyricText(data));
      }
    } catch { /* lyrics are best-effort */ }
  }
  if (lyricSongId !== id) return; // a newer song superseded this request
  if (lyricCache.size > 30) lyricCache.delete(lyricCache.keys().next().value);
  lyricCache.set(id, lines);
  lyricLines = lines;
  lyricLineIdx = -1;
  updateLyricLine(playerPosition());
}

const NAV_ITEMS = [
  { group: '浏览', id: 'dashboard', label: '概览', icon: 'home' },
  { group: '浏览', id: 'all', label: '全部歌曲', icon: 'music' },
  { group: '浏览', id: 'folders', label: '文件夹', icon: 'folder' },
  { group: '浏览', id: 'artist', label: '歌手', icon: 'artist', field: 'artist' },
  { group: '浏览', id: 'album', label: '专辑', icon: 'album', field: 'album' },
  { group: '浏览', id: 'genre', label: '流派', icon: 'genre', field: 'genre' },
  { group: '浏览', id: 'year', label: '年份', icon: 'calendar', field: 'year' },
  { group: '管理', id: 'playlists', label: '歌单管理', icon: 'playlist' },
  { group: '管理', id: 'radios', label: '电台管理', icon: 'radio' },
  { group: '更多分类', id: 'language', label: '语种', icon: 'language', field: 'language', capability: 'language' },
  { group: '更多分类', id: 'style', label: '风格', icon: 'style', field: 'style', capability: 'style' },
  { group: '更多分类', id: 'format', label: '文件格式', icon: 'file', field: 'format' },
  { group: '更多分类', id: 'type', label: '来源类型', icon: 'source', field: 'type' },
];

const FIELD_LABELS = {
  type: '来源', artist: '歌手', album: '专辑', genre: '流派', year: '年份',
  decade: '年代', language: '语种', style: '风格', format: '格式', folder: '文件夹',
};

const TYPE_LABELS = { local: '本地歌曲', remote: '网络歌曲', radio: '电台' };

const ICON_PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5v9a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H4.5A1.5 1.5 0 0 1 3 19.5z"/>',
  music: '<path d="M9 18V5l11-2v13M9 18a3 3 0 1 1-3-3h3m11 1a3 3 0 1 1-3-3h3M9 9l11-2"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  artist: '<path d="M12 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 6a7 7 0 0 1 14 0M18 4v7m0-7 3-1v6"/>',
  album: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M12 3v3m9 6h-3M6 12H3"/>',
  genre: '<path d="M4 5h8l8 8-7 7-9-9z"/><circle cx="8.5" cy="9.5" r="1"/><path d="m14 4 6 6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18M8 14h2m4 0h2m-8 4h2m4 0h2"/>',
  playlist: '<path d="M4 6h10M4 11h10M4 16h7M18 17V8l3-1v8m-3 2a2 2 0 1 1-2-2h2"/>',
  radio: '<path d="M5 10h14v10H5zM8 10l8-6M8 14h5m-5 3h3"/><circle cx="16.5" cy="15.5" r="1.5"/>',
  language: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
  style: '<path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4zM19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z"/>',
  file: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 13h6m-6 4h6"/>',
  source: '<path d="M7 7h11l-3-3m3 3-3 3M17 17H6l3 3m-3-3 3-3"/>',
};

function iconSvg(name, className = 'ui-icon') {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ICON_PATHS.music}</svg>`;
}

const COLUMNS = [
  { id: 'title', label: '标题', locked: true },
  { id: 'artist', label: '歌手' },
  { id: 'album', label: '专辑' },
  { id: 'year', label: '年份' },
  { id: 'genre', label: '流派' },
  { id: 'format', label: '格式' },
  { id: 'bitrate', label: '码率' },
  { id: 'size', label: '大小' },
  { id: 'duration', label: '时长', locked: true },
];

const PAGE_SIZES = [25, 50, 100, 200, 500];
const storedPageSize = Number(localStorage.getItem('library-plus-page-size') || 100);

const state = {
  initialized: false,
  index: null,
  capabilities: {},
  mode: 'dashboard',
  categoryField: null,
  categoryValue: null,
  filters: {},
  keyword: '',
  sort: 'added_at',
  order: 'desc',
  page: 0,
  pageSize: PAGE_SIZES.includes(storedPageSize) ? storedPageSize : 100,
  songs: [],
  total: 0,
  selected: new Set(),
  favoriteIds: new Set(),
  lastSelectedIndex: null,
  visibleColumns: new Set(JSON.parse(localStorage.getItem('library-plus-columns') || '["title","artist","album","year","genre","format","duration"]')),
  expandedFolders: new Set(['']),
  currentFolder: '',
  recursive: true,
  searchTimer: null,
  toastTimer: null,
  dragSelecting: false,
  dragTargetValue: true,
  dragPointerId: null,
  touchTimer: null,
  touchStart: null,
  suppressRowClick: false,
  playlists: [],
  currentPlaylist: null,
  playlistManagerType: 'normal',
  playlistTargetType: 'normal',
  pendingAutoPlaylist: null,
  viewMode: localStorage.getItem('library-plus-view-mode') || 'auto',
  folderPaneCollapsed: localStorage.getItem('library-plus-folder-pane-collapsed') === '1',
};

try {
  state.expandedFolders = new Set(JSON.parse(localStorage.getItem('library-plus-folders') || '[""]'));
  state.currentFolder = localStorage.getItem('library-plus-current-folder') || '';
} catch {
  state.expandedFolders = new Set(['']);
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function qs(params) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
    if (value === '' && key === 'folder') search.set(key, '');
  });
  return Array.from(search.entries())
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function apiPath(path, params) {
  const query = params ? qs(params) : '';
  return query ? `${path}?${query}` : path;
}

function authUrl(raw) {
  if (!raw) return '';
  try {
    let resolved = raw;
    if (String(raw).startsWith('/')) {
      const marker = '/api/v1/jsplugin/';
      const markerIndex = window.location.pathname.indexOf(marker);
      const basePath = markerIndex >= 0 ? window.location.pathname.slice(0, markerIndex) : '';
      if (basePath && !String(raw).startsWith(`${basePath}/`)) resolved = `${basePath}${raw}`;
    }
    const url = new URL(resolved, window.location.href);
    if (url.origin === window.location.origin) {
      const token = getAuthToken();
      if (token && !url.searchParams.has('access_token')) url.searchParams.set('access_token', token);
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatSize(bytes) {
  const size = Number(bytes || 0);
  if (!size) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  return `${(size / (1024 ** i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function formatLongDuration(seconds) {
  const hours = Math.floor(Number(seconds || 0) / 3600);
  if (hours >= 1) return `${hours.toLocaleString()} 小时`;
  return `${Math.round(Number(seconds || 0) / 60).toLocaleString()} 分钟`;
}

function showToast(message, type = 'info') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast show${type === 'error' ? ' error' : ''}`;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3200);
  if (announce) announce(message, type === 'error' ? 'assertive' : 'polite');
}

function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    if (window.innerWidth <= 760) {
      button.classList.add('busy');
      button.disabled = true;
    } else {
      button.dataset.originalHtml = button.innerHTML;
      button.innerHTML = label || '处理中…';
      button.disabled = true;
    }
  } else {
    if (window.innerWidth <= 760) {
      button.classList.remove('busy');
      button.disabled = false;
    } else {
      button.innerHTML = button.dataset.originalHtml || button.innerHTML;
      button.disabled = false;
    }
  }
}

function renderNav() {
  const nav = $('#sideNav');
  let group = '';
  let html = '';
  NAV_ITEMS.forEach((item) => {
    if (item.capability && !state.capabilities[item.capability]) return;
    if (item.group !== group) {
      group = item.group;
      html += `<div class="nav-group-label">${escapeHtml(group)}</div>`;
    }
    html += `<button class="nav-item${state.mode === item.id ? ' active' : ''}" type="button" data-nav="${item.id}"><span class="nav-icon">${iconSvg(item.icon)}</span><span>${escapeHtml(item.label)}</span></button>`;
  });
  nav.innerHTML = html;
}

function renderSummary() {
  if (!state.index) return;
  const { summary } = state.index;
  $('#librarySummary').innerHTML = `<strong>${summary.total.toLocaleString()} 首歌曲</strong><br>${formatLongDuration(summary.duration)} · ${formatSize(summary.size)}<br>本地 ${summary.local.toLocaleString()} · 网络 ${summary.remote.toLocaleString()} · 电台 ${summary.radio.toLocaleString()}`;
}

function setPageHeading(eyebrow, title, subtitle) {
  $('#pageEyebrow').textContent = eyebrow;
  $('#pageTitle').textContent = title;
  $('#pageSubtitle').textContent = subtitle;
}

function setCategoryPlaylistAction(field = null, value = null) {
  const button = $('#categoryCreatePlaylistButton');
  const available = ['artist', 'album', 'genre', 'year'].includes(field) && value != null && value !== '';
  state.categoryValue = available ? String(value) : null;
  button.classList.toggle('hidden', !available);
  button.title = available ? `用"${value}"分类中的歌曲创建或更新同名歌单` : '';
}

function showSection(name) {
  ['dashboard', 'folderBrowser', 'categoryBrowser', 'playlistBrowser', 'songsSection'].forEach((id) => $(`#${id}`).classList.add('hidden'));
  if (name) $(`#${name}`).classList.remove('hidden');
}

function mountSongs(inFolder) {
  const songsSection = $('#songsSection');
  const target = inFolder ? $('#folderSongsMount') : $('#songsDefaultMount');
  if (inFolder) target.appendChild(songsSection);
  else target.parentNode.insertBefore(songsSection, target.nextSibling);
}

function categoryCard(item, field, icon = 'music') {
  const value = field === 'type' ? (TYPE_LABELS[item.value] || item.value) : item.value;
  const subtitle = item.subtitle ? `${item.subtitle} · ${item.count} 首` : `${item.count} 首歌曲`;
  const cover = item.coverUrl
    ? `<img class="category-cover" src="${escapeHtml(authUrl(item.coverUrl))}" alt="" loading="lazy">`
    : `<span class="category-cover" aria-hidden="true">${iconSvg(icon, 'category-icon')}</span>`;
  return `<button class="category-card" type="button" data-category-field="${field}" data-category-value="${escapeHtml(item.value)}">${cover}<span class="meta"><strong>${escapeHtml(value)}</strong><small>${escapeHtml(subtitle)}</small></span></button>`;
}

function renderDashboard() {
  const { summary, facets } = state.index;
  setPageHeading('歌曲库', '音乐库概览', `索引于 ${new Date(state.index.generatedAt).toLocaleString()}`);
  $('#categoryBackButton').classList.add('hidden');
  setCategoryPlaylistAction();
  showSection('dashboard');
  const topArtists = (facets.artist || []).slice(0, 6).map((item) => categoryCard(item, 'artist', 'artist')).join('');
  const topAlbums = (facets.album || []).slice(0, 6).map((item) => categoryCard(item, 'album', 'album')).join('');
  const recentYears = (facets.year || []).slice(0, 8).map((item) => categoryCard(item, 'year', 'calendar')).join('');
  $('#dashboard').innerHTML = `
    <div class="stats-grid">
      <article class="stat-card"><span>全部歌曲</span><strong>${summary.total.toLocaleString()}</strong></article>
      <article class="stat-card"><span>本地歌曲</span><strong>${summary.local.toLocaleString()}</strong></article>
      <article class="stat-card"><span>总时长</span><strong>${escapeHtml(formatLongDuration(summary.duration))}</strong></article>
      <article class="stat-card"><span>音乐文件</span><strong>${escapeHtml(formatSize(summary.size))}</strong></article>
    </div>
    <div class="dashboard-insights">
      <button type="button" data-nav="artist"><strong>${(facets.artist || []).length.toLocaleString()}</strong><span>位歌手</span></button>
      <button type="button" data-nav="album"><strong>${(facets.album || []).length.toLocaleString()}</strong><span>张专辑</span></button>
      <button type="button" data-nav="genre"><strong>${(facets.genre || []).length.toLocaleString()}</strong><span>种流派</span></button>
      <button type="button" data-nav="folders"><strong>${Math.max(0, state.index.folders.length - 1).toLocaleString()}</strong><span>个文件夹</span></button>
    </div>
    <section class="dashboard-panel dashboard-playlists-panel">
      <div class="section-heading"><h2>我的歌单</h2><button class="text-button" type="button" data-nav="playlists">管理歌单</button></div>
      <div id="dashboardPlaylists" class="dashboard-playlist-grid"><div class="dashboard-empty">正在加载歌单…</div></div>
    </section>
    <div class="dashboard-columns">
      <section class="dashboard-panel">
        <div class="section-heading"><h2>主要歌手</h2><button class="text-button" type="button" data-nav="artist">查看全部</button></div>
        <div class="dashboard-category-grid">${topArtists || '<div class="dashboard-empty">暂无歌手信息</div>'}</div>
      </section>
      <section class="dashboard-panel">
        <div class="section-heading"><h2>主要专辑</h2><button class="text-button" type="button" data-nav="album">查看全部</button></div>
        <div class="dashboard-category-grid">${topAlbums || '<div class="dashboard-empty">暂无专辑信息</div>'}</div>
      </section>
    </div>
    <section class="dashboard-panel dashboard-years-panel">
      <div class="section-heading"><h2>年份速览</h2><button class="text-button" type="button" data-nav="year">查看全部</button></div>
      <div class="dashboard-year-grid">${recentYears || '<div class="dashboard-empty">暂无年份信息</div>'}</div>
    </section>`;
  loadDashboardPlaylists();
}

async function loadDashboardPlaylists() {
  const mount = $('#dashboardPlaylists');
  if (!mount) return;
  try {
    const data = await apiGet('/api/playlists?type=normal');
    state.playlists = data.playlists || [];
    if (state.mode !== 'dashboard' || !mount.isConnected) return;
    const playlists = state.playlists.slice(0, 8);
    mount.innerHTML = playlists.length ? playlists.map((playlist) => `
      <article class="dashboard-playlist-card" data-open-playlist="${playlist.id}" tabindex="0">
        <div class="playlist-cover">${playlistCover(playlist)}</div>
        <div class="playlist-card-meta"><strong>${escapeHtml(playlist.name)}</strong><span>${playlist.type === 'radio' ? '电台歌单' : '普通歌单'} · ${Number(playlist.song_count || 0).toLocaleString()} 首</span></div>
      </article>`).join('') : '<div class="dashboard-empty">还没有歌单，可以从歌曲列表创建。</div>';
  } catch (error) {
    if (state.mode === 'dashboard' && mount.isConnected) mount.innerHTML = `<div class="dashboard-empty">歌单加载失败：${escapeHtml(error.message)}</div>`;
  }
}

function renderCategory(field) {
  const nav = NAV_ITEMS.find((item) => item.field === field);
  const items = state.index.facets[field] || [];
  const title = nav?.label || FIELD_LABELS[field] || '分类';
  setPageHeading('分类浏览', title, `${items.length.toLocaleString()} 个分类项目`);
  $('#categoryBackButton').classList.add('hidden');
  renderActiveFilters();
  showSection('categoryBrowser');
  const icon = nav?.icon || 'music';
  $('#categoryBrowser').innerHTML = items.length
    ? `<div class="category-grid">${items.map((item) => categoryCard(item, field, icon)).join('')}</div>`
    : `<div class="empty-state"><div><strong>没有${escapeHtml(title)}信息</strong><span>扫描或编辑歌曲标签后会自动出现在这里。</span></div></div>`;
}

function folderChildrenMap() {
  const map = new Map();
  state.index.folders.forEach((folder) => {
    if (!map.has(folder.parent)) map.set(folder.parent, []);
    if (folder.path !== '') map.get(folder.parent).push(folder);
  });
  return map;
}

function renderFolderTree() {
  const map = folderChildrenMap();
  const root = state.index.folders.find((item) => item.path === '');
  function renderNode(node) {
    const children = map.get(node.path) || [];
    const expanded = state.expandedFolders.has(node.path);
    return `<div class="folder-node">
      <button class="folder-row${state.currentFolder === node.path ? ' active' : ''}" type="button" data-folder="${escapeHtml(node.path)}" style="padding-left:${8 + node.depth * 13}px">
        <span data-folder-toggle="${escapeHtml(node.path)}">${children.length ? (expanded ? '▾' : '▸') : ''}</span><span aria-hidden="true">${iconSvg('folder', 'folder-icon')}</span><span class="folder-name" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</span><span class="folder-count">${node.totalCount}</span>
      </button>
      ${children.length ? `<div class="folder-children${expanded ? '' : ' collapsed'}">${children.map(renderNode).join('')}</div>` : ''}
    </div>`;
  }
  $('#folderTree').innerHTML = root ? renderNode(root) : '';
}

function renderFolderContent() {
  const current = state.index.folders.find((item) => item.path === state.currentFolder) || state.index.folders[0];
  const segments = state.currentFolder.split('/').filter(Boolean);
  let path = '';
  const crumbs = [{ label: '音乐库', path: '' }, ...segments.map((segment) => {
    path = path ? `${path}/${segment}` : segment;
    return { label: segment, path };
  })];
  $('#breadcrumbs').innerHTML = crumbs.map((crumb, index) => `<button type="button" data-folder="${escapeHtml(crumb.path)}">${escapeHtml(crumb.label)}</button>${index < crumbs.length - 1 ? '<span>/</span>' : ''}`).join('');
  const children = state.index.folders.filter((item) => item.parent === state.currentFolder && item.path !== '');
  $('#folderCards').innerHTML = children.map((item) => `<button class="subfolder-card" type="button" data-folder="${escapeHtml(item.path)}"><span class="category-cover" aria-hidden="true">${iconSvg('folder', 'category-icon')}</span><span class="meta"><strong>${escapeHtml(item.name)}</strong><small>${item.totalCount} 首歌曲</small></span></button>`).join('');
  setPageHeading('文件夹浏览', current?.name || '音乐库', `${state.recursive ? '包含子文件夹' : '仅当前文件夹'} · ${current?.totalCount || 0} 首歌曲`);
}

async function enterFolder(path) {
  state.currentFolder = path;
  state.expandedFolders.add(path);
  localStorage.setItem('library-plus-current-folder', path);
  localStorage.setItem('library-plus-folders', JSON.stringify(Array.from(state.expandedFolders)));
  state.filters = { folder: path, recursive: state.recursive };
  state.page = 0;
  state.selected.clear();
  renderFolderTree();
  renderFolderContent();
  await loadSongs();
}

function renderFolders() {
  mountSongs(true);
  $('#folderBrowser').classList.toggle('folder-pane-collapsed', state.folderPaneCollapsed);
  $('#toggleFolderPane').setAttribute('aria-label', state.folderPaneCollapsed ? '展开文件夹栏' : '折叠文件夹栏');
  $('#toggleFolderPane').title = state.folderPaneCollapsed ? '展开文件夹栏' : '折叠文件夹栏';
  setPageHeading('文件夹浏览', '音乐库', `${state.index.folders.length - 1} 个文件夹`);
  showSection('folderBrowser');
  $('#songsSection').classList.remove('hidden');
  renderFolderTree();
  renderFolderContent();
}

function currentQuery(extra = {}) {
  return {
    ...state.filters,
    keyword: state.keyword,
    sort: state.sort,
    order: state.order,
    ...extra,
  };
}

function renderActiveFilters() {
  $('#activeFilters').innerHTML = state.keyword
    ? `<button class="filter-chip" type="button" data-remove-filter="keyword">搜索：${escapeHtml(state.keyword)}<span>×</span></button>`
    : '';
}

async function loadSongs() {
  const container = $('#songsContainer');
  container.innerHTML = '<div class="loading-state"><div><div class="spinner"></div><p>正在加载歌曲…</p></div></div>';
  $('#songsSection').classList.remove('hidden');
  renderActiveFilters();
  try {
    const data = await apiGet(apiPath('/api/songs', currentQuery({ offset: state.page * state.pageSize, limit: state.pageSize })));
    state.songs = data.songs || [];
    state.total = data.total || 0;
    renderSongs();
    renderPagination();
    updateSelectionBar();
  } catch (error) {
    container.innerHTML = `<div class="error-state"><div><strong>歌曲加载失败</strong><span>${escapeHtml(error.message)}</span><br><button class="tonal-button" type="button" data-retry-songs>重试</button></div></div>`;
  }
}

function coverHtml(song, className = 'song-cover') {
  return song.cover_url
    ? `<img class="${className}" src="${escapeHtml(authUrl(song.cover_url))}" alt="" loading="lazy">`
    : `<span class="${className} cover-placeholder" aria-hidden="true">♫</span>`;
}

function songCheckbox(song) {
  return `<input type="checkbox" data-select-song="${song.id}" aria-label="选择 ${escapeHtml(song.title)}" ${state.selected.has(song.id) ? 'checked' : ''}>`;
}

function heartSvg() {
  return '<svg class="heart-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.08C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53L12 21.35z"/></svg>';
}

function sortableHeader(column, label, className, defaultOrder = 'asc') {
  const active = state.sort === column;
  const arrow = active ? (state.order === 'asc' ? '↑' : '↓') : '';
  const ariaSort = active ? (state.order === 'asc' ? 'ascending' : 'descending') : 'none';
  const favoriteLabel = column === 'favorite' ? ' aria-label="按收藏状态排序" title="按收藏状态排序"' : '';
  return `<th class="${className}" aria-sort="${ariaSort}"><button class="sort-header${active ? ' active' : ''}" type="button" data-sort="${column}" data-default-order="${defaultOrder}"${favoriteLabel}>${label}<span class="sort-arrow" aria-hidden="true">${arrow}</span></button></th>`;
}

function renderTable() {
  const cols = state.visibleColumns;
  const optionalHeaders = [
    ['artist', '歌手', 'artist', 'asc'], ['album', '专辑', 'album', 'asc'], ['year', '年份', 'year', 'desc'], ['genre', '流派', 'genre', 'asc'],
    ['format', '格式', 'format', 'asc'], ['bitrate', '码率', 'bit_rate', 'desc'], ['size', '大小', 'file_size', 'desc'],
  ].filter(([id]) => cols.has(id)).map(([id, label, sort, order]) => sortableHeader(sort, label, `col-${id}`, order)).join('');
  const favoriteHeader = sortableHeader('favorite', '<span class="favorite-header-icon" aria-hidden="true">' + heartSvg() + '</span>', 'col-favorite', 'desc');
  return `<table class="songs-table"><thead><tr><th class="col-check"><input id="pageSelectCheckbox" type="checkbox" aria-label="选择本页"></th>${favoriteHeader}<th class="col-cover"></th>${sortableHeader('title', '标题', 'col-title')}${optionalHeaders}${sortableHeader('duration', '时长', 'col-duration')}</tr></thead><tbody>${state.songs.map((song, index) => {
    const optional = [
      ['artist', song.artist || '未知歌手'], ['album', song.album || '未知专辑'], ['year', song.year || '—'],
      ['genre', song.genre || '—'], ['format', `<span class="type-pill">${escapeHtml(String(song.format || song.type).toUpperCase())}</span>`],
      ['bitrate', song.bit_rate ? `${song.bit_rate}k` : '—'], ['size', formatSize(song.file_size)],
    ].filter(([id]) => cols.has(id)).map(([id, value]) => `<td class="col-${id}" title="${escapeHtml(String(value).replace(/<[^>]*>/g, ''))}">${id === 'format' ? value : escapeHtml(value)}</td>`).join('');
    const favorite = state.favoriteIds.has(song.id);
    return `<tr data-song-row="${song.id}" data-song-index="${index}" class="${state.selected.has(song.id) ? 'selected' : ''}"><td class="col-check">${songCheckbox(song)}</td><td class="col-favorite"><button class="favorite-button${favorite ? ' active' : ''}" type="button" data-toggle-favorite="${song.id}" aria-label="${favorite ? '取消收藏' : '收藏'} ${escapeHtml(song.title)}" aria-pressed="${favorite}">${heartSvg()}</button></td><td class="col-cover play-cover" data-play-song="${song.id}" title="点击封面试听">${coverHtml(song)}</td><td class="col-title"><div class="song-title-cell"><span class="song-title-text">${escapeHtml(song.title)}</span>${isCurrentSong(song) ? '<span class="playing-indicator">▶</span>' : ''}</div></td>${optional}<td class="col-duration">${formatDuration(song.duration)}</td></tr>`;
  }).join('')}</tbody></table>`;
}

function renderList() {
  return `<div class="song-list">${state.songs.map((song, index) => {
    const favorite = state.favoriteIds.has(song.id);
    return `<div class="song-list-item${state.selected.has(song.id) ? ' selected' : ''}" data-song-row="${song.id}" data-song-index="${index}"><div>${songCheckbox(song)}</div><button class="favorite-button${favorite ? ' active' : ''}" type="button" data-toggle-favorite="${song.id}" aria-label="${favorite ? '取消收藏' : '收藏'} ${escapeHtml(song.title)}" aria-pressed="${favorite}">${heartSvg()}</button><div class="play-cover" data-play-song="${song.id}" title="点击封面试听">${coverHtml(song)}</div><div class="song-list-meta"><strong>${escapeHtml(song.title)}${isCurrentSong(song) ? '　▶' : ''}</strong><span>${escapeHtml(song.artist || '未知歌手')} · ${escapeHtml(song.album || '未知专辑')}</span></div><div class="song-list-tail"><div>${formatDuration(song.duration)}</div><div>${escapeHtml(String(song.format || '').toUpperCase())}</div></div></div>`;
  }).join('')}</div>`;
}

function renderSongs() {
  const section = $('#songsSection');
  section.classList.remove('view-auto', 'view-table', 'view-list');
  section.classList.add(`view-${state.viewMode}`);
  $('#resultCount').textContent = `${state.total.toLocaleString()} 首歌曲`;
  if (!state.songs.length) {
    $('#songsContainer').innerHTML = '<div class="empty-state"><div><strong>没有找到歌曲</strong><span>尝试清除部分筛选条件或刷新曲库。</span></div></div>';
    return;
  }
  $('#songsContainer').innerHTML = `${renderTable()}${renderList()}`;
  const pageCheckbox = $('#pageSelectCheckbox');
  if (pageCheckbox) {
    pageCheckbox.checked = state.songs.length > 0 && state.songs.every((song) => state.selected.has(song.id));
    pageCheckbox.indeterminate = state.songs.some((song) => state.selected.has(song.id)) && !pageCheckbox.checked;
  }
}

function renderPagination() {
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  if (pages <= 1) {
    $('#pagination').innerHTML = '';
    return;
  }
  const visible = new Set([0, pages - 1]);
  for (let i = Math.max(0, state.page - 2); i <= Math.min(pages - 1, state.page + 2); i += 1) visible.add(i);
  const pageButtons = Array.from(visible).sort((a, b) => a - b).map((page, index, values) => {
    const gap = index > 0 && page - values[index - 1] > 1 ? '<span class="page-gap">…</span>' : '';
    return `${gap}<button type="button" class="page-number${page === state.page ? ' active' : ''}" data-page="${page}" ${page === state.page ? 'aria-current="page"' : ''}>${page + 1}</button>`;
  }).join('');
  $('#pagination').innerHTML = `
    <button type="button" data-page="${state.page - 1}" ${state.page <= 0 ? 'disabled' : ''}>上一页</button>
    <div class="page-numbers">${pageButtons}</div>
    <button type="button" data-page="${state.page + 1}" ${state.page >= pages - 1 ? 'disabled' : ''}>下一页</button>
    <label class="page-jump">跳至 <input id="pageJumpInput" type="number" min="1" max="${pages}" value="${state.page + 1}" aria-label="页码"> / ${pages} 页 <button type="button" data-page-jump>前往</button></label>`;
}

async function jumpToPage() {
  const input = $('#pageJumpInput');
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  const target = Math.min(pages, Math.max(1, Number(input?.value || 1))) - 1;
  state.page = target;
  await loadSongs();
  window.scrollTo({ top: $('#songsSection').offsetTop - 80, behavior: 'smooth' });
}

function updateSelectionBar() {
  const count = state.selected.size;
  $('#selectionBar').classList.toggle('hidden', count === 0);
  $('#selectionCount').textContent = `已选 ${count.toLocaleString()} 首`;
  $('[data-action="remove-playlist"]').classList.toggle('hidden', !state.currentPlaylist);
  $('[data-action="select-all"]').disabled = state.total === 0;
  $('[data-action="invert"]').disabled = state.total === 0;
  $('[data-action="clear"]').disabled = count === 0;
}

function setSelected(id, selected, rerender = true) {
  if (selected) state.selected.add(id); else state.selected.delete(id);
  if (rerender) {
    $$(`[data-song-row="${id}"]`).forEach((row) => row.classList.toggle('selected', selected));
    $$(`[data-select-song="${id}"]`).forEach((checkbox) => { checkbox.checked = selected; });
    updateSelectionBar();
  }
}

function toggleSongSelection(id, index, shiftKey) {
  const next = !state.selected.has(id);
  if (shiftKey && state.lastSelectedIndex != null) {
    const start = Math.min(state.lastSelectedIndex, index);
    const end = Math.max(state.lastSelectedIndex, index);
    for (let i = start; i <= end; i += 1) setSelected(state.songs[i].id, next, false);
    renderSongs();
  } else {
    setSelected(id, next);
  }
  state.lastSelectedIndex = index;
}

async function selectAllResults() {
  const button = $('[data-action="select-all"]');
  setBusy(button, true, '正在全选…');
  try {
    const data = await apiGet(apiPath('/api/song-ids', currentQuery()));
    state.selected = new Set(data.ids || []);
    renderSongs();
    updateSelectionBar();
    showToast(`已选择当前筛选范围内的 ${state.selected.size.toLocaleString()} 首歌曲`);
  } catch (error) {
    showToast(`全选失败：${error.message}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function invertSelection() {
  const button = $('[data-action="invert"]');
  setBusy(button, true, '反选中…');
  try {
    const data = await apiGet(apiPath('/api/song-ids', currentQuery()));
    state.selected = new Set((data.ids || []).filter((id) => !state.selected.has(id)));
    renderSongs();
    updateSelectionBar();
    showToast(`已反选，当前选择 ${state.selected.size.toLocaleString()} 首歌曲`);
  } catch (error) {
    showToast(`反选失败：${error.message}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

function switchMode(id) {
  const item = NAV_ITEMS.find((entry) => entry.id === id);
  if (!item) return;
  const leavingPlaylist = Boolean(state.currentPlaylist);
  if (id !== 'folders') mountSongs(false);
  state.mode = id;
  state.categoryField = item.field || null;
  state.categoryValue = null;
  state.filters = {};
  state.page = 0;
  state.selected.clear();
  state.currentPlaylist = null;
  $('#playlistContextBar').classList.add('hidden');
  $('#categoryBackButton').classList.add('hidden');
  setCategoryPlaylistAction();
  if (leavingPlaylist) {
    state.sort = 'added_at';
    state.order = 'desc';
  }
  renderNav();
  closeMobileNav();
  updateSelectionBar();
  if (id === 'dashboard') return renderDashboard();
  if (id === 'folders') {
    renderFolders();
    return enterFolder(state.currentFolder || '');
  }
  if (id === 'playlists' || id === 'radios') return loadPlaylistManager(id === 'radios' ? 'radio' : 'normal');
  if (item.field) return renderCategory(item.field);
  setPageHeading('歌曲库', item.label, '浏览和管理 Songloft 中的全部歌曲');
  showSection('songsSection');
  loadSongs();
}

function openCategory(field, value) {
  mountSongs(false);
  state.mode = field;
  state.categoryField = field;
  setCategoryPlaylistAction(field, value);
  renderNav();
  state.filters = { [field]: value };
  setCategoryDetailHeading(field, value);
  $('#categoryBackButton').classList.remove('hidden');
  state.page = 0;
  state.selected.clear();
  showSection('songsSection');
  loadSongs();
}

function setCategoryDetailHeading(field, value) {
  const display = field === 'type' ? TYPE_LABELS[value] || value : field === 'decade' ? `${value} 年代` : value;
  setPageHeading(FIELD_LABELS[field] || '分类', display, `按${FIELD_LABELS[field] || field}浏览歌曲`);
}

function returnToCategory() {
  if (!state.categoryField) return;
  state.filters = {};
  state.keyword = '';
  $('#searchInput').value = '';
  $('#clearSearch').style.visibility = 'hidden';
  state.page = 0;
  state.selected.clear();
  setCategoryPlaylistAction();
  updateSelectionBar();
  renderCategory(state.categoryField);
}

function playlistIsBuiltIn(playlist) {
  return Array.isArray(playlist?.labels) && playlist.labels.includes('built_in');
}

function playlistCover(playlist) {
  return playlist.cover_url
    ? `<img src="${escapeHtml(authUrl(playlist.cover_url))}" alt="" loading="lazy">`
    : '<span aria-hidden="true">♫</span>';
}

async function loadPlaylistManager(type = state.playlistManagerType) {
  const managerType = type === 'radio' ? 'radio' : 'normal';
  const isRadio = managerType === 'radio';
  state.playlistManagerType = managerType;
  state.mode = isRadio ? 'radios' : 'playlists';
  state.currentPlaylist = null;
  state.filters = {};
  state.sort = 'added_at';
  state.order = 'desc';
  $('#playlistContextBar').classList.add('hidden');
  renderNav();
  setPageHeading(isRadio ? '电台管理' : '歌单管理', isRadio ? '我的电台' : '我的歌单', isRadio ? '创建、编辑电台歌单并管理其中的电台' : '创建、编辑歌单并管理其中的歌曲');
  showSection('playlistBrowser');
  const browser = $('#playlistBrowser');
  browser.innerHTML = `<div class="loading-state"><div><div class="spinner"></div><p>正在加载${isRadio ? '电台' : '歌单'}…</p></div></div>`;
  try {
    const data = await apiGet(`/api/playlists?type=${managerType}`);
    state.playlists = data.playlists || [];
    browser.innerHTML = `
      <div class="playlist-toolbar"><div><strong>${state.playlists.length.toLocaleString()} 个${isRadio ? '电台歌单' : '歌单'}</strong><span>${isRadio ? '仅收录 Songloft 电台类型内容' : '仅收录本地歌曲和网络歌曲'}</span></div><div class="playlist-toolbar-actions"><button class="tonal-button" type="button" data-auto-covers>▣ 自动设置封面</button><button class="primary-button" type="button" data-playlist-create>＋ 新建${isRadio ? '电台' : '歌单'}</button></div></div>
      <div class="playlist-grid">${state.playlists.map((playlist) => `
        <article class="playlist-card" data-open-playlist="${playlist.id}" tabindex="0">
          <div class="playlist-cover">${playlistCover(playlist)}</div>
          <div class="playlist-card-meta"><strong>${escapeHtml(playlist.name)}</strong><span>${playlist.type === 'radio' ? '电台歌单' : '普通歌单'} · ${Number(playlist.song_count || 0).toLocaleString()} 首</span>${playlist.description ? `<small>${escapeHtml(playlist.description)}</small>` : ''}</div>
          <button class="icon-button playlist-edit" type="button" data-playlist-edit="${playlist.id}" aria-label="编辑 ${escapeHtml(playlist.name)}">⋮</button>
        </article>`).join('')}</div>
      ${state.playlists.length ? '' : `<div class="empty-state"><div><strong>还没有${isRadio ? '电台歌单' : '歌单'}</strong><span>新建一个${isRadio ? '电台歌单，再从电台列表添加内容' : '歌单，再从歌曲列表中添加内容'}。</span></div></div>`}`;
  } catch (error) {
    browser.innerHTML = `<div class="error-state"><div><strong>${isRadio ? '电台' : '歌单'}加载失败</strong><span>${escapeHtml(error.message)}</span><br><button class="tonal-button" type="button" data-retry-playlists>重试</button></div></div>`;
  }
}

async function autoSetPlaylistCovers(button) {
  setBusy(button, true, '正在设置…');
  try {
    const data = await apiPost('/api/playlists/auto-covers', { type: state.playlistManagerType });
    if (data.updated) showToast(`已为 ${data.updated} 个${state.playlistManagerType === 'radio' ? '电台' : '歌单'}设置封面`);
    else if (data.missingCoverSongs) showToast('未找到带封面的内容，暂时无法自动设置', 'error');
    else showToast('当前没有需要自动设置封面的歌单');
    await loadPlaylistManager(state.playlistManagerType);
  } catch (error) {
    showToast(`自动设置封面失败：${error.message}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

function openPlaylistManageDialog(playlist = null) {
  const builtIn = playlistIsBuiltIn(playlist);
  $('#playlistManageId').value = playlist?.id || '';
  $('#playlistManageName').value = playlist?.name || '';
  $('#playlistManageDescription').value = playlist?.description || '';
  const type = playlist?.type || state.playlistManagerType;
  const isRadio = type === 'radio';
  $('#playlistManageType').value = type;
  $('#playlistManageCover').value = playlist?.cover_url || '';
  $('#playlistManageTitle').textContent = playlist ? `编辑${isRadio ? '电台' : '歌单'}` : `新建${isRadio ? '电台' : '歌单'}`;
  $('#playlistManageHint').textContent = builtIn ? '内置歌单只能修改封面' : (playlist ? `${Number(playlist.song_count || 0)} ${isRadio ? '个电台' : '首歌曲'}` : `创建后可从${isRadio ? '电台' : '歌曲'}选择栏添加内容`);
  $('#playlistManageName').disabled = builtIn;
  $('#playlistManageDescription').disabled = builtIn;
  $('#playlistManageType').disabled = Boolean(playlist);
  $('#playlistTypeLabel').classList.add('hidden');
  $('#deletePlaylistButton').classList.toggle('hidden', !playlist || builtIn);
  $('#playlistManageDialog').showModal();
}

async function savePlaylist() {
  const button = $('#savePlaylistButton');
  const id = Number($('#playlistManageId').value || 0);
  const existing = state.playlists.find((item) => item.id === id);
  const name = $('#playlistManageName').value.trim();
  if (!playlistIsBuiltIn(existing) && !name) return showToast('请输入歌单名称', 'error');
  setBusy(button, true, '正在保存…');
  try {
    let payload = {
      id,
      name,
      description: $('#playlistManageDescription').value.trim(),
      type: $('#playlistManageType').value,
      coverUrl: $('#playlistManageCover').value.trim(),
    };
    if (playlistIsBuiltIn(existing)) payload = { id, coverUrl: payload.coverUrl };
    const data = await apiPost(id ? '/api/playlists/update' : '/api/playlists/create', payload);
    $('#playlistManageDialog').close();
    showToast(id ? '歌单已更新' : '歌单已创建');
    if (state.currentPlaylist?.id === id) state.currentPlaylist = data.playlist;
    await loadPlaylistManager(state.playlistManagerType);
  } catch (error) {
    showToast(`歌单保存失败：${error.message}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function deletePlaylist(playlist = null) {
  const id = playlist?.id || Number($('#playlistManageId').value || 0);
  const target = playlist || state.playlists.find((item) => item.id === id);
  if (!target || playlistIsBuiltIn(target)) return;
  if (!window.confirm(`确定删除歌单"${target.name}"吗？歌曲本身不会被删除。`)) return;
  const button = $('#deletePlaylistButton');
  setBusy(button, true, '正在删除…');
  try {
    await apiPost('/api/playlists/delete', { id });
    $('#playlistManageDialog').close();
    state.currentPlaylist = null;
    state.selected.clear();
    showToast('歌单已删除');
    await loadPlaylistManager(state.playlistManagerType);
  } catch (error) {
    showToast(`歌单删除失败：${error.message}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function openPlaylist(playlist) {
  state.playlistManagerType = playlist.type === 'radio' ? 'radio' : 'normal';
  state.mode = playlist.type === 'radio' ? 'radios' : 'playlists';
  state.categoryField = null;
  renderNav();
  state.currentPlaylist = playlist;
  state.filters = { playlist_id: playlist.id };
  state.sort = 'position';
  state.order = 'asc';
  state.page = 0;
  state.selected.clear();
  $('#playlistContextName').textContent = playlist.name;
  $('#playlistContextMeta').textContent = `${playlist.type === 'radio' ? '电台歌单' : '普通歌单'} · ${Number(playlist.song_count || 0).toLocaleString()} 首`;
  $('#playlistContextBar').classList.remove('hidden');
  setPageHeading('歌单', playlist.name, `${playlist.type === 'radio' ? '电台歌单' : '普通歌单'} · ${Number(playlist.song_count || 0).toLocaleString()} 首歌曲`);
  showSection('songsSection');
  await loadSongs();
}

async function removeSelectedFromPlaylist() {
  if (!state.currentPlaylist || !state.selected.size) return;
  $('#removePlaylistHint').textContent = `确定从"${state.currentPlaylist.name}"移除已选的 ${state.selected.size} 首歌曲吗？`;
  $('#removePlaylistDialog').showModal();
}

async function confirmRemoveFromPlaylist() {
  const button = $('#confirmRemovePlaylistButton');
  setBusy(button, true, '正在移除…');
  try {
    const data = await apiPost('/api/playlists/remove', { playlistId: state.currentPlaylist.id, songIds: Array.from(state.selected) });
    $('#removePlaylistDialog').close();
    state.selected.clear();
    state.currentPlaylist.song_count = Math.max(0, Number(state.currentPlaylist.song_count || 0) - Number(data.removed || 0));
    setPageHeading('歌单', state.currentPlaylist.name, `${state.currentPlaylist.type === 'radio' ? '电台歌单' : '普通歌单'} · ${state.currentPlaylist.song_count.toLocaleString()} 首歌曲`);
    showToast(`已从歌单移除 ${data.removed || 0} 首歌曲`);
    await loadSongs();
  } catch (error) {
    showToast(`移除失败：${error.message}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function loadPlaylists() {
  const select = $('#playlistSelect');
  select.innerHTML = '<option value="">正在加载…</option>';
  try {
    let selectedSongs = selectedSongsOnPage();
    if (selectedSongs.length !== state.selected.size) {
      const selectedData = await apiPost('/api/songs/by-ids', { ids: Array.from(state.selected) });
      selectedSongs = selectedData.songs || [];
    }
    const type = selectedSongs.length && selectedSongs.every((song) => song.type === 'radio') ? 'radio' : 'normal';
    state.playlistTargetType = type;
    const data = await apiGet(`/api/playlists?type=${type}`);
    select.innerHTML = '<option value="">请选择</option>'
      + (data.playlists || []).map((item) => `<option value="${item.id}">${escapeHtml(item.name)}（${item.song_count || 0}）</option>`).join('')
      + '<option value="__new__">＋ 新建歌单…</option>';
  } catch (error) {
    select.innerHTML = '<option value="">加载失败</option>';
    showToast(`歌单加载失败：${error.message}`, 'error');
  }
}

async function confirmAddToPlaylist() {
  const button = $('#confirmPlaylistButton');
  const selectedValue = $('#playlistSelect').value;
  const createNew = selectedValue === '__new__';
  const newName = $('#newPlaylistName').value.trim();
  if (!selectedValue) return showToast('请选择一个歌单', 'error');
  if (createNew && !newName) return showToast('请输入新歌单名称', 'error');
  setBusy(button, true, '正在添加…');
  try {
    const data = await apiPost('/api/playlists/add', {
      songIds: Array.from(state.selected),
      playlistId: createNew ? 0 : Number(selectedValue),
      newName: createNew ? newName : '',
      newType: state.playlistTargetType,
    });
    $('#playlistDialog').close();
    $('#playlistSelect').value = '';
    $('#newPlaylistName').value = '';
    $('#newPlaylistField').classList.add('hidden');
    showToast(`已添加 ${data.added || 0} 首，跳过 ${data.skipped || 0} 首`);
  } catch (error) {
    showToast(`加入歌单失败：${error.message}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function favoriteSelected() {
  if (!state.selected.size) return;
  try {
    const data = await apiPost('/api/favorites/add', { songIds: Array.from(state.selected) });
    Array.from(state.selected).forEach((id) => state.favoriteIds.add(id));
    renderSongs();
    showToast(`已收藏 ${data.added || 0} 首，已有 ${data.skipped || 0} 首`);
  } catch (error) {
    showToast(`收藏失败：${error.message}`, 'error');
  }
}

async function setSongFavorite(id, favorite) {
  const song = state.songs.find((item) => item.id === id);
  if (!song) return;
  try {
    await apiPost('/api/favorites/set', { id, favorite });
    if (favorite) state.favoriteIds.add(id); else state.favoriteIds.delete(id);
    renderSongs();
    showToast(favorite ? `已收藏《${song.title}》` : `已取消收藏《${song.title}》`);
  } catch (error) {
    showToast(`${favorite ? '收藏' : '取消收藏'}失败：${error.message}`, 'error');
  }
}

async function openAutoPlaylistDialog() {
  const field = state.categoryField;
  const value = state.categoryValue;
  if (!['artist', 'album', 'genre', 'year'].includes(field) || !value) return;
  const button = $('#categoryCreatePlaylistButton');
  setBusy(button, true, '正在检查…');
  try {
    const data = await apiGet('/api/playlists?type=normal');
    const existing = (data.playlists || []).find((playlist) => String(playlist.name).trim() === value.trim());
    state.pendingAutoPlaylist = { field, value, playlistId: existing?.id || 0 };
    $('#autoPlaylistSubtitle').textContent = `${FIELD_LABELS[field] || field} · ${value}`;
    $('#autoPlaylistMessage').textContent = existing
      ? `已经存在"${value}"歌单。确认后会把当前分类中的歌曲添加进去，并自动去重。`
      : `将根据当前分类创建"${value}"歌单，并加入其中的全部歌曲。`;
    $('#confirmAutoPlaylistButton').textContent = existing ? '确认添加' : '确认创建';
    $('#autoPlaylistDialog').showModal();
  } catch (error) {
    showToast(`读取歌单失败：${error.message}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function confirmAutoPlaylist() {
  const pending = state.pendingAutoPlaylist;
  if (!pending) return;
  const button = $('#confirmAutoPlaylistButton');
  setBusy(button, true, pending.playlistId ? '正在添加…' : '正在创建…');
  try {
    const result = await apiPost('/api/playlists/from-category', {
      field: pending.field,
      value: pending.value,
      name: pending.value,
      playlistId: pending.playlistId,
    });
    $('#autoPlaylistDialog').close();
    state.pendingAutoPlaylist = null;
    const prefix = result.created ? `已创建"${pending.value}"歌单` : `已更新"${pending.value}"歌单`;
    showToast(`${prefix}：加入 ${result.added || 0} 首，跳过 ${result.skipped || 0} 首`);
  } catch (error) {
    showToast(`创建歌单失败：${error.message}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

function selectedSongsOnPage() {
  return state.songs.filter((song) => state.selected.has(song.id));
}

async function openTagsDialog() {
  const dialog = $('#tagsDialog');
  const form = $('form', dialog);
  form.reset();
  let songs = selectedSongsOnPage();
  if (songs.length !== state.selected.size) {
    try {
      const data = await apiPost('/api/songs/by-ids', { ids: Array.from(state.selected) });
      songs = data.songs || [];
    } catch (error) {
      return showToast(`读取歌曲标签失败：${error.message}`, 'error');
    }
  }
  const batch = state.selected.size > 1;
  $('#tagsHint').textContent = batch ? `批量编辑 ${state.selected.size} 首歌曲` : '修改后会写回本地歌曲文件标签';
  ['title', 'artist', 'album', 'track', 'year', 'genre', 'language', 'style'].forEach((key) => {
    const input = form.elements.namedItem(key);
    if (!input) return;
    input.dataset.defaultPlaceholder ||= input.placeholder || '';
    input.placeholder = input.dataset.defaultPlaceholder;
    input.dataset.dirty = 'false';
    input.dataset.mixed = 'false';
    const values = songs.map((song) => String(song[key] ?? ''));
    const unique = new Set(values);
    if (unique.size === 1) input.value = values[0];
    else {
      input.value = '';
      input.placeholder = '不同的值';
      input.dataset.mixed = 'true';
    }
  });
  $('.single-song-fields', dialog).classList.toggle('hidden', state.selected.size !== 1);
  form.elements.namedItem('title').disabled = batch;
  form.elements.namedItem('track').disabled = batch;
  form.elements.namedItem('rename_file').disabled = batch;
  dialog.showModal();
}

async function confirmTags() {
  const button = $('#confirmTagsButton');
  const form = $('form', $('#tagsDialog'));
  const fields = {};
  const batch = state.selected.size > 1;
  ['title', 'artist', 'album', 'track', 'year', 'genre', 'language', 'style'].forEach((key) => {
    const input = form.elements.namedItem(key);
    if (!input || input.disabled) return;
    const value = String(input.value).trim();
    if (batch && input.dataset.dirty === 'true') fields[key] = key === 'year' ? Number(value || 0) : value;
    else if (!batch && value !== '') fields[key] = key === 'year' ? Number(value) : value;
  });
  fields.rename_file = Boolean(form.elements.namedItem('rename_file').checked);
  if (state.selected.size === 1) {
    const coverUrl = form.elements.namedItem('cover_url').value.trim();
    const lyrics = form.elements.namedItem('lyrics').value;
    if (coverUrl) fields.cover_url = coverUrl;
    if (form.elements.namedItem('clear_cover').checked) fields.clear_cover = true;
    if (lyrics.trim()) fields.lyrics = lyrics;
  }
  setBusy(button, true, '正在保存…');
  try {
    const data = await apiPost('/api/tags', { ids: Array.from(state.selected), fields });
    const errors = (data.results || []).filter((item) => item.status !== 'ok');
    $('#tagsDialog').close();
    showToast(errors.length ? `已完成，${errors.length} 首失败` : '歌曲标签已保存', errors.length ? 'error' : 'info');
    await refreshIndex(false);
  } catch (error) {
    showToast(`标签保存失败：${error.message}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

function openDeleteDialog() {
  $('#deleteFilesCheckbox').checked = false;
  $('#deleteHint').textContent = `确定从曲库删除选中的 ${state.selected.size} 首歌曲吗？`;
  $('#confirmDeleteButton').textContent = '删除记录';
  $('#deleteDialog').showModal();
}

async function confirmDelete() {
  const button = $('#confirmDeleteButton');
  const deleteFiles = $('#deleteFilesCheckbox').checked;
  if (deleteFiles && !window.confirm('将永久删除服务器上的本地音乐文件，且无法撤销。确定继续吗？')) return;
  setBusy(button, true, '正在删除…');
  try {
    const data = await apiPost('/api/delete', { ids: Array.from(state.selected), deleteFiles });
    const errors = (data.results || []).filter((item) => item.status !== 'ok');
    $('#deleteDialog').close();
    state.selected.clear();
    showToast(errors.length ? `删除完成，${errors.length} 首失败` : '歌曲已删除', errors.length ? 'error' : 'info');
    await refreshIndex(true);
  } catch (error) {
    showToast(`删除失败：${error.message}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

function renderColumnOptions() {
  $('#columnOptions').innerHTML = COLUMNS.map((column) => `<label><input type="checkbox" data-column="${column.id}" ${state.visibleColumns.has(column.id) ? 'checked' : ''} ${column.locked ? 'disabled' : ''}> ${escapeHtml(column.label)}${column.locked ? '（固定）' : ''}</label>`).join('');
  const viewRadio = $(`[name="view_mode"][value="${state.viewMode}"]`);
  if (viewRadio) viewRadio.checked = true;
  $('#pageSizeSelect').value = String(state.pageSize);
}

function playSongs(songs, startIndex = 0) {
  if (!playerBridge.available()) return Promise.reject(new Error('当前环境不支持播放'));
  const ids = songs.map((song) => Number(songId(song))).filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return Promise.reject(new Error('没有可播放的歌曲'));
  playerState.dismissed = false;
  const index = Math.max(0, Math.min(startIndex, ids.length - 1));
  return playerBridge.setQueue(ids, index);
}

// Play a single song without touching the rest of the queue. The song is
// appended to the host queue only if it is not already present (no duplicates),
// then started by id — unlike playSongs, which replaces the whole queue.
async function playSingleSong(id) {
  if (!playerBridge.available()) throw new Error('当前环境不支持播放');
  if (!Number.isFinite(id) || id <= 0) throw new Error('歌曲无效');
  playerState.dismissed = false;
  const inQueue = playerState.queue.some((song) => Number(songId(song)) === id);
  if (!inQueue) await playerBridge.addToQueue([id]);
  return playerBridge.play(id);
}

function syncPlayerState(raw) {
  if (!raw || typeof raw !== 'object') return;
  const queue = stateQueue(raw);
  const index = stateIndex(raw, queue);
  const current = index >= 0 && index < queue.length ? queue[index] : null;
  playerState.queue = queue;
  playerState.currentIndex = index;
  playerState.playing = statePlaying(raw, playerState.playing);
  playerState.currentSong = current;
  playerState.duration = Number(current?.duration || 0);
  const pos = statePosition(raw);
  if (pos != null) {
    playerState.posAnchor = { pos, t: performance.now(), playing: playerState.playing };
  } else if (playerState.posAnchor) {
    playerState.posAnchor.playing = playerState.playing;
  }
  const nextLyricId = current ? songId(current) : '';
  if (nextLyricId !== lyricSongId) {
    lyricSongId = nextLyricId;
    resetLyric();
    loadLyric(nextLyricId);
  }
  updatePlayerUI();
}

function updatePlayerUI() {
  const song = playerState.currentSong;
  const visible = Boolean(song) && !playerState.dismissed;
  $('#playerBar').classList.toggle('hidden', !visible);
  document.body.classList.toggle('player-active', visible);
  if (song) {
    $('#playerTitle').textContent = song.title || song.name || '未播放';
    $('#playerArtist').textContent = `${song.artist || '未知歌手'} · ${song.album || '未知专辑'}`;
    $('#playerCover').src = authUrl(song.cover_url) || authUrl('static/icon.svg');
  }
  $('#playerToggle').classList.toggle('paused', playerState.playing);
  $('#playerToggle').setAttribute('aria-label', playerState.playing ? '暂停' : '播放');
  updatePlayerFavoriteUI();
  renderQueue();
  tickPlayer();
  if (visible && state.songs.length && !$('#songsSection').classList.contains('hidden')) renderSongs();
}

function updatePlayerFavoriteUI() {
  const button = $('#playerFavorite');
  if (!button) return;
  const id = playerState.currentSong ? Number(songId(playerState.currentSong)) : NaN;
  const favorite = Number.isFinite(id) && id > 0 && state.favoriteIds.has(id);
  button.classList.toggle('active', favorite);
  button.setAttribute('aria-pressed', String(favorite));
  button.setAttribute('aria-label', favorite ? '取消收藏当前歌曲' : '收藏当前歌曲');
  button.title = favorite ? '取消收藏' : '收藏';
}

async function togglePlayerFavorite() {
  const song = playerState.currentSong;
  const id = song ? Number(songId(song)) : NaN;
  if (!Number.isFinite(id) || id <= 0) return;
  const favorite = !state.favoriteIds.has(id);
  const name = song.title || song.name || '';
  try {
    await apiPost('/api/favorites/set', { id, favorite });
    if (favorite) state.favoriteIds.add(id); else state.favoriteIds.delete(id);
    updatePlayerFavoriteUI();
    if (!$('#songsSection').classList.contains('hidden')) renderSongs();
    showToast(favorite ? `已收藏《${name}》` : `已取消收藏《${name}》`);
  } catch (error) {
    showToast(`${favorite ? '收藏' : '取消收藏'}失败：${error.message}`, 'error');
  }
}

function renderQueue() {
  const queue = playerState.queue;
  $('#queueCount').textContent = `${queue.length.toLocaleString()} 首`;
  $('#queueList').innerHTML = queue.length ? queue.map((song, index) => `
    <button class="queue-item${index === playerState.currentIndex ? ' active' : ''}" type="button" data-queue-index="${index}">
      ${coverHtml(song, 'queue-cover')}
      <span><strong>${escapeHtml(song.title || song.name || '')}</strong><small>${escapeHtml(song.artist || '未知歌手')}</small></span>
      ${index === playerState.currentIndex ? '<i aria-label="正在播放">▶</i>' : ''}
    </button>`).join('') : '<div class="queue-empty">播放列表为空</div>';
}

function setQueuePanel(open) {
  const panel = $('#queuePanel');
  panel.classList.toggle('hidden', !open);
  $('#playerQueueButton').setAttribute('aria-expanded', String(open));
}

function setPlayerCollapsed(collapsed) {
  $('#playerBar').classList.toggle('collapsed', collapsed);
  const button = $('#playerCollapse');
  if (button) button.setAttribute('aria-expanded', String(!collapsed));
}

function togglePlayerCollapsed() {
  setPlayerCollapsed(!$('#playerBar').classList.contains('collapsed'));
}

function tickPlayer() {
  if ($('#playerBar').classList.contains('hidden')) return;
  const pos = playerPosition();
  const duration = playerState.duration || 0;
  $('#playerCurrent').textContent = formatDuration(pos);
  $('#playerDuration').textContent = formatDuration(duration);
  $('#playerSeek').value = duration ? String(Math.min(1000, Math.round(pos / duration * 1000))) : '0';
  updateLyricLine(pos);
}

function playCurrentPage() {
  const button = $('#playAllButton');
  setBusy(button, true, '正在准备…');
  playSongs(state.songs, 0)
    .catch((error) => showToast(`播放失败：${error.message}`, 'error'))
    .finally(() => setBusy(button, false));
}

async function playSelectedSongs() {
  const button = $('[data-action="play-selected"]');
  setBusy(button, true, '正在准备…');
  try {
    const data = await apiPost('/api/songs/by-ids', { ids: Array.from(state.selected) });
    await playSongs(data.songs || [], 0);
  } catch (error) {
    showToast(`播放选中歌曲失败：${error.message}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

function closeMobileNav() {
  $('.sidebar').classList.remove('open');
  $('#mobileNavBackdrop').classList.add('hidden');
}

async function refreshIndex(force) {
  const button = $('#refreshButton');
  setBusy(button, true, '…');
  try {
    state.index = await apiGet(`/api/index${force ? '?refresh=1' : ''}`);
    renderSummary();
    if (state.mode === 'dashboard') renderDashboard();
    else if (state.mode === 'folders') {
      renderFolders();
      await enterFolder(state.currentFolder);
    } else if ((state.mode === 'playlists' || state.mode === 'radios') && state.currentPlaylist) await openPlaylist(state.currentPlaylist);
    else if (state.mode === 'playlists' || state.mode === 'radios') await loadPlaylistManager(state.mode === 'radios' ? 'radio' : 'normal');
    else if (state.categoryField && Object.keys(state.filters).length === 0) renderCategory(state.categoryField);
    else await loadSongs();
    if (force) showToast('歌曲库索引已刷新');
  } catch (error) {
    showToast(`刷新失败：${error.message}`, 'error');
  } finally {
    setBusy(button, false);
  }
}

function bindEvents() {
  document.addEventListener('click', async (event) => {
    const closeDialog = event.target.closest('[data-close-dialog]');
    if (closeDialog) {
      closeDialog.closest('dialog')?.close();
      return;
    }
    if (event.target.matches('dialog.modal')) {
      event.target.close();
      return;
    }

    const nav = event.target.closest('[data-nav]');
    if (nav) return switchMode(nav.dataset.nav);

    const sortHeader = event.target.closest('[data-sort]');
    if (sortHeader) {
      const nextSort = sortHeader.dataset.sort;
      state.order = state.sort === nextSort
        ? (state.order === 'asc' ? 'desc' : 'asc')
        : (sortHeader.dataset.defaultOrder || 'asc');
      state.sort = nextSort;
      state.page = 0;
      renderSongs();
      return loadSongs();
    }

    if (event.target.closest('#categoryBackButton')) return returnToCategory();

    if (event.target.closest('[data-playlist-create]')) return openPlaylistManageDialog();
    if (event.target.closest('[data-retry-playlists]')) return loadPlaylistManager();
    const autoCovers = event.target.closest('[data-auto-covers]');
    if (autoCovers) return autoSetPlaylistCovers(autoCovers);
    const playlistEdit = event.target.closest('[data-playlist-edit]');
    if (playlistEdit) {
      event.stopPropagation();
      return openPlaylistManageDialog(state.playlists.find((item) => item.id === Number(playlistEdit.dataset.playlistEdit)));
    }
    const playlistCard = event.target.closest('[data-open-playlist]');
    if (playlistCard) return openPlaylist(state.playlists.find((item) => item.id === Number(playlistCard.dataset.openPlaylist)));
    if (event.target.closest('[data-back-playlists]')) return loadPlaylistManager(state.currentPlaylist?.type || state.playlistManagerType);
    if (event.target.closest('[data-edit-current-playlist]')) return openPlaylistManageDialog(state.currentPlaylist);

    const category = event.target.closest('[data-category-field]');
    if (category) return openCategory(category.dataset.categoryField, category.dataset.categoryValue);

    const folderToggle = event.target.closest('[data-folder-toggle]');
    if (folderToggle) {
      event.stopPropagation();
      const path = folderToggle.dataset.folderToggle;
      if (state.expandedFolders.has(path)) state.expandedFolders.delete(path); else state.expandedFolders.add(path);
      localStorage.setItem('library-plus-folders', JSON.stringify(Array.from(state.expandedFolders)));
      return renderFolderTree();
    }

    const folder = event.target.closest('[data-folder]');
    if (folder) return enterFolder(folder.dataset.folder);

    const remove = event.target.closest('[data-remove-filter]');
    if (remove) {
      if (remove.dataset.removeFilter === 'keyword') {
        state.keyword = '';
        $('#searchInput').value = '';
        $('#clearSearch').style.visibility = 'hidden';
      }
      state.page = 0;
      if (state.categoryField && state.filters[state.categoryField] != null) {
        setCategoryDetailHeading(state.categoryField, state.filters[state.categoryField]);
      }
      return loadSongs();
    }

    const retry = event.target.closest('[data-retry-songs]');
    if (retry) return loadSongs();

    if (event.target.closest('[data-page-jump]')) return jumpToPage();

    const page = event.target.closest('[data-page]');
    if (page && !page.disabled) {
      state.page = Number(page.dataset.page);
      await loadSongs();
      window.scrollTo({ top: $('#songsSection').offsetTop - 80, behavior: 'smooth' });
      return;
    }

    const play = event.target.closest('[data-play-song]');
    if (play) {
      event.stopPropagation();
      const id = Number(play.dataset.playSong);
      return playSingleSong(id).catch((error) => showToast(`播放失败：${error.message}`, 'error'));
    }

    const favoriteToggle = event.target.closest('[data-toggle-favorite]');
    if (favoriteToggle) {
      event.stopPropagation();
      const id = Number(favoriteToggle.dataset.toggleFavorite);
      return setSongFavorite(id, !state.favoriteIds.has(id));
    }

    const queueItem = event.target.closest('[data-queue-index]');
    if (queueItem) {
      const song = playerState.queue[Number(queueItem.dataset.queueIndex)];
      if (!song) return;
      return playerBridge.play(Number(songId(song))).catch((error) => showToast(`播放失败：${error.message}`, 'error'));
    }

    if (event.target.closest('[data-select-song]')) return;

    const row = event.target.closest('[data-song-row]');
    if (row) {
      if (state.suppressRowClick) {
        state.suppressRowClick = false;
        return;
      }
      const id = Number(row.dataset.songRow);
      return toggleSongSelection(id, Number(row.dataset.songIndex), event.shiftKey);
    }

    const action = event.target.closest('[data-action]');
    if (action) {
      if (action.dataset.action === 'clear') { state.selected.clear(); renderSongs(); return updateSelectionBar(); }
      if (action.dataset.action === 'select-all') return selectAllResults();
      if (action.dataset.action === 'invert') return invertSelection();
      if (action.dataset.action === 'play-selected') return playSelectedSongs();
      if (action.dataset.action === 'favorite') return favoriteSelected();
      if (action.dataset.action === 'playlist') {
        $('#playlistSelect').value = '';
        $('#newPlaylistName').value = '';
        $('#newPlaylistField').classList.add('hidden');
        $('#playlistDialog').showModal();
        return loadPlaylists();
      }
      if (action.dataset.action === 'remove-playlist') return removeSelectedFromPlaylist();
      if (action.dataset.action === 'tags') return openTagsDialog();
      if (action.dataset.action === 'delete') return openDeleteDialog();
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target.closest('#tagsDialog') && event.target.matches('input, textarea, select')) event.target.dataset.dirty = 'true';
    const checkbox = event.target.closest('[data-select-song]');
    if (checkbox) {
      event.stopPropagation();
      const row = checkbox.closest('[data-song-row]');
      return toggleSongSelection(Number(checkbox.dataset.selectSong), Number(row.dataset.songIndex), event.shiftKey);
    }
    if (event.target.id === 'pageSelectCheckbox') {
      state.songs.forEach((song) => setSelected(song.id, event.target.checked, false));
      renderSongs();
      return updateSelectionBar();
    }
    const column = event.target.closest('[data-column]');
    if (column) {
      if (column.checked) state.visibleColumns.add(column.dataset.column); else state.visibleColumns.delete(column.dataset.column);
      localStorage.setItem('library-plus-columns', JSON.stringify(Array.from(state.visibleColumns)));
      return renderSongs();
    }
    if (event.target.matches('[name="view_mode"]')) {
      state.viewMode = event.target.value;
      localStorage.setItem('library-plus-view-mode', state.viewMode);
      return renderSongs();
    }
    if (event.target.id === 'pageSizeSelect') {
      state.pageSize = PAGE_SIZES.includes(Number(event.target.value)) ? Number(event.target.value) : 100;
      state.page = 0;
      localStorage.setItem('library-plus-page-size', String(state.pageSize));
      if (!$('#songsSection').classList.contains('hidden')) return loadSongs();
      return undefined;
    }
    if (event.target.id === 'playlistSelect') {
      const createNew = event.target.value === '__new__';
      $('#newPlaylistField').classList.toggle('hidden', !createNew);
      if (createNew) $('#newPlaylistName').focus();
    }
  });

  document.addEventListener('input', (event) => {
    if (event.target.closest('#tagsDialog') && event.target.matches('input, textarea, select')) event.target.dataset.dirty = 'true';
  });

  document.addEventListener('keydown', (event) => {
    if (event.target.id === 'pageJumpInput' && event.key === 'Enter') {
      event.preventDefault();
      jumpToPage();
    }
  });

  document.addEventListener('pointerdown', (event) => {
    const row = event.target.closest('[data-song-row]');
    if (!row || event.target.closest('[data-play-song], input, button, a, select, textarea')) return;
    const id = Number(row.dataset.songRow);
    const index = Number(row.dataset.songIndex);
    state.dragPointerId = event.pointerId;
    state.dragTargetValue = !state.selected.has(id);
    if (event.pointerType === 'mouse') {
      event.preventDefault();
      state.dragSelecting = true;
      state.suppressRowClick = true;
      toggleSongSelection(id, index, event.shiftKey);
      return;
    }
    state.touchStart = { x: event.clientX, y: event.clientY, row };
    clearTimeout(state.touchTimer);
    state.touchTimer = setTimeout(() => {
      state.dragSelecting = true;
      state.suppressRowClick = true;
      setSelected(id, state.dragTargetValue);
    }, 360);
  });
  document.addEventListener('pointerover', (event) => {
    if (!state.dragSelecting || event.pointerType !== 'mouse') return;
    const row = event.target.closest('[data-song-row]');
    if (row) setSelected(Number(row.dataset.songRow), state.dragTargetValue);
  });
  document.addEventListener('pointermove', (event) => {
    if (event.pointerId !== state.dragPointerId || event.pointerType === 'mouse') return;
    if (!state.dragSelecting && state.touchStart) {
      const distance = Math.hypot(event.clientX - state.touchStart.x, event.clientY - state.touchStart.y);
      if (distance > 10) {
        clearTimeout(state.touchTimer);
        state.touchTimer = null;
      }
      return;
    }
    if (!state.dragSelecting) return;
    event.preventDefault();
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-song-row]');
    if (row) setSelected(Number(row.dataset.songRow), state.dragTargetValue);
  }, { passive: false });
  const endDrag = () => {
    clearTimeout(state.touchTimer);
    state.touchTimer = null;
    state.touchStart = null;
    state.dragSelecting = false;
    state.dragPointerId = null;
    setTimeout(() => { state.suppressRowClick = false; }, 0);
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  $('#searchInput').addEventListener('input', (event) => {
    $('#clearSearch').style.visibility = event.target.value ? 'visible' : 'hidden';
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.keyword = event.target.value.trim();
      state.page = 0;
      if (state.mode === 'dashboard' || state.categoryField) {
        setPageHeading('搜索', state.keyword || '全部歌曲', '跨标题、歌手、专辑和路径搜索');
        showSection('songsSection');
      }
      loadSongs();
    }, 300);
  });
  $('#clearSearch').addEventListener('click', () => {
    $('#searchInput').value = '';
    state.keyword = '';
    state.page = 0;
    if (state.categoryField && state.filters[state.categoryField] != null) {
      setCategoryDetailHeading(state.categoryField, state.filters[state.categoryField]);
    }
    loadSongs();
  });
  $('#recursiveToggle').addEventListener('change', (event) => {
    state.recursive = event.target.checked;
    enterFolder(state.currentFolder);
  });
  $('#collapseFolders').addEventListener('click', () => { state.expandedFolders = new Set(['']); localStorage.setItem('library-plus-folders', '[""]'); renderFolderTree(); });
  $('#toggleFolderPane').addEventListener('click', () => {
    state.folderPaneCollapsed = !state.folderPaneCollapsed;
    localStorage.setItem('library-plus-folder-pane-collapsed', state.folderPaneCollapsed ? '1' : '0');
    $('#folderBrowser').classList.toggle('folder-pane-collapsed', state.folderPaneCollapsed);
    $('#toggleFolderPane').setAttribute('aria-label', state.folderPaneCollapsed ? '展开文件夹栏' : '折叠文件夹栏');
    $('#toggleFolderPane').title = state.folderPaneCollapsed ? '展开文件夹栏' : '折叠文件夹栏';
  });
  $('#refreshButton').addEventListener('click', () => refreshIndex(true));
  $('#playAllButton').addEventListener('click', playCurrentPage);
  $('#viewToggleButton').addEventListener('click', () => { renderColumnOptions(); $('#columnsDialog').showModal(); });
  $('#categoryCreatePlaylistButton').addEventListener('click', openAutoPlaylistDialog);
  $('#confirmAutoPlaylistButton').addEventListener('click', confirmAutoPlaylist);
  $('#confirmPlaylistButton').addEventListener('click', confirmAddToPlaylist);
  $('#savePlaylistButton').addEventListener('click', savePlaylist);
  $('#deletePlaylistButton').addEventListener('click', () => deletePlaylist());
  $('#confirmTagsButton').addEventListener('click', confirmTags);
  $('#confirmDeleteButton').addEventListener('click', confirmDelete);
  $('#confirmRemovePlaylistButton').addEventListener('click', confirmRemoveFromPlaylist);
  $('#deleteFilesCheckbox').addEventListener('change', (event) => { $('#confirmDeleteButton').textContent = event.target.checked ? '永久删除文件' : '删除记录'; });
  $('#mobileNavButton').addEventListener('click', () => { $('.sidebar').classList.add('open'); $('#mobileNavBackdrop').classList.remove('hidden'); });
  $('#mobileNavBackdrop').addEventListener('click', closeMobileNav);

  const playerError = (error) => showToast(`操作失败：${error.message}`, 'error');
  $('#playerToggle').addEventListener('click', () => playerBridge.toggle().catch(playerError));
  $('#playerPrev').addEventListener('click', () => playerBridge.previous().catch(playerError));
  $('#playerNext').addEventListener('click', () => playerBridge.next().catch(playerError));
  $('#playerQueueButton').addEventListener('click', () => setQueuePanel($('#queuePanel').classList.contains('hidden')));
  $('#queueClose').addEventListener('click', () => setQueuePanel(false));
  $('#playerFavorite').addEventListener('click', () => togglePlayerFavorite());
  document.addEventListener('click', (event) => {
    if ($('#queuePanel').classList.contains('hidden')) return;
    if (event.target.closest('#queuePanel') || event.target.closest('#playerQueueButton')) return;
    setQueuePanel(false);
  });
  $('#playerSeek').addEventListener('input', (event) => {
    const duration = playerState.duration;
    if (!duration) return;
    const seconds = Number(event.target.value) / 1000 * duration;
    playerState.posAnchor = { pos: seconds, t: performance.now(), playing: playerState.playing };
    tickPlayer();
    playerBridge.seek(seconds).catch(playerError);
  });
  $('#playerClose').addEventListener('click', () => {
    playerState.dismissed = true;
    setQueuePanel(false);
    playerBridge.pause().catch(() => {});
    updatePlayerUI();
  });
  $('#playerCollapse').addEventListener('click', () => togglePlayerCollapsed());
  $('#playerCover').addEventListener('click', () => {
    if ($('#playerBar').classList.contains('collapsed')) setPlayerCollapsed(false);
  });
  setInterval(tickPlayer, 500);
}

function initPlayer() {
  if (!playerBridge.available()) return;
  playerBridge.onState(syncPlayerState);
  playerBridge.getState().then(syncPlayerState).catch(() => {});
}

async function init() {
  if (state.initialized) return;
  state.initialized = true;
  slpInitThemeSync();
  bindEvents();
  $('#clearSearch').style.visibility = 'hidden';
  $('#dashboard').classList.remove('hidden');
  $('#dashboard').innerHTML = '<div class="loading-state"><div><div class="spinner"></div><p>正在建立歌曲库索引…</p></div></div>';
  $('#songsSection').classList.add('hidden');
  try {
    const [capabilities, index, favorites] = await Promise.all([
      apiGet('/api/capabilities').catch(() => ({ language: false, style: false })),
      apiGet('/api/index'),
      apiGet('/api/favorites/ids').catch(() => ({ ids: [] })),
    ]);
    state.capabilities = capabilities;
    state.index = index;
    state.favoriteIds = new Set(favorites.ids || []);
    $$('[data-capability]').forEach((element) => { element.hidden = !capabilities[element.dataset.capability]; });
    renderNav();
    renderSummary();
    renderDashboard();
    initPlayer();
  } catch (error) {
    $('#dashboard').innerHTML = `<div class="error-state"><div><strong>歌曲库 Plus 无法启动</strong><span>${escapeHtml(error.message)}</span><p>请确认 Songloft 版本不低于 v2.11.0，并已授予插件歌曲读取权限。</p><button class="primary-button" type="button" onclick="location.reload()">重新加载</button></div></div>`;
  }
}

document.addEventListener('DOMContentLoaded', init);
