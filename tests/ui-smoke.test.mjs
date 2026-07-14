import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../static/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../static/js/app.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../static/styles.css', import.meta.url), 'utf8');
const mainSource = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');

const songs = [
  {
    id: 1,
    type: 'local',
    title: '夜曲',
    artist: '周杰伦',
    album: '十一月的萧邦',
    year: 2005,
    genre: '流行',
    language: '国语',
    style: '抒情',
    track: '1/12',
    duration: 226,
    file_path: '/music/周杰伦/十一月的萧邦/01 - 夜曲.flac',
    url: '/api/v1/songs/1/play',
    cover_url: '/api/v1/songs/1/cover',
    file_size: 33000000,
    format: 'flac',
    bit_rate: 920,
    sample_rate: 44100,
    added_at: '2026-07-13T10:00:00Z',
    updated_at: '2026-07-13T10:00:00Z',
  },
  {
    id: 2,
    type: 'local',
    title: '晴天',
    artist: '周杰伦',
    album: '叶惠美',
    year: 2003,
    genre: '流行',
    duration: 269,
    file_path: '/music/周杰伦/叶惠美/03 - 晴天.mp3',
    url: '/api/v1/songs/2/play',
    cover_url: '',
    file_size: 10000000,
    format: 'mp3',
    bit_rate: 320,
    sample_rate: 44100,
    added_at: '2026-06-01T10:00:00Z',
    updated_at: '2026-06-01T10:00:00Z',
  },
];

const index = {
  generatedAt: Date.now(),
  rootPath: '/music',
  summary: { total: 2, local: 2, remote: 0, radio: 0, duration: 495, size: 43000000 },
  folders: [
    { path: '', name: '音乐库', parent: '', depth: 0, directCount: 0, totalCount: 2 },
    { path: '周杰伦', name: '周杰伦', parent: '', depth: 1, directCount: 0, totalCount: 2 },
    { path: '周杰伦/十一月的萧邦', name: '十一月的萧邦', parent: '周杰伦', depth: 2, directCount: 1, totalCount: 1 },
    { path: '周杰伦/叶惠美', name: '叶惠美', parent: '周杰伦', depth: 2, directCount: 1, totalCount: 1 },
    { path: '多层目录', name: '多层目录', parent: '', depth: 1, directCount: 0, totalCount: 0 },
    { path: '多层目录/一段非常非常长的文件夹名称用于验证完整显示', name: '一段非常非常长的文件夹名称用于验证完整显示', parent: '多层目录', depth: 2, directCount: 0, totalCount: 0 },
  ],
  facets: {
    artist: [{ value: '周杰伦', count: 2, coverUrl: '/api/v1/songs/1/cover' }, { value: '伍佰 & China Blue', count: 1 }],
    album: [{ value: '十一月的萧邦', count: 1 }, { value: '叶惠美', count: 1 }],
    genre: [{ value: '流行', count: 2 }],
    year: [{ value: '2005', count: 1 }, { value: '2003', count: 1 }],
    decade: [{ value: '2000', count: 2 }],
    language: [{ value: '国语', count: 1 }],
    style: [{ value: '抒情', count: 1 }],
    format: [{ value: 'FLAC', count: 1 }, { value: 'MP3', count: 1 }],
    type: [{ value: 'local', count: 2 }],
  },
};

async function waitFor(predicate, timeout = 1500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for UI');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('紧凑界面、歌曲选择、分类返回、收藏、文件夹布局和歌单弹窗可正常工作', async () => {
  assert.match(styles, /\.modal\[open\] \{ display: grid; place-items: center; \}/);
  assert.match(styles, /\.songs-table thead \{ position: static;/);
  assert.match(styles, /tr\.selected td \{ background: var\(--md-secondary-container, #dfe5ff\) !important;/);
  assert.match(styles, /\.selection-bar \{ position: fixed;/);
  assert.match(styles, /\.selection-bar \{[^}]*bottom: 18px;/);
  assert.match(styles, /\.selection-bar \{[^}]*width: max-content;/);
  assert.match(styles, /\.selection-bar \{[^}]*background: var\(--md-primary-container, #dce3ff\)/);
  assert.match(styles, /\.floating-selection-controls \{[^}]*border-left:/);
  assert.match(styles, /\.col-duration \{[^}]*text-align: left !important;/);
  assert.match(styles, /\.col-size \{ width: 70px;/);
  assert.match(styles, /\.queue-panel \{ position: fixed;/);
  assert.match(styles, /\.favorite-button\.active \{ color: var\(--md-error, #d32f2f\);/);
  assert.match(styles, /\.col-favorite \{ width: 32px; padding: 0 !important; text-align: left !important; \}/);
  assert.match(styles, /\.col-favorite \.sort-header \{ position: relative; width: 28px; justify-content: flex-start;/);
  assert.match(styles, /\.favorite-button:hover \{ background: transparent;/);
  assert.match(styles, /\.toast \{[^}]*background: var\(--md-inverse-surface, #292a30\)/);
  assert.match(styles, /\.nav-item:hover \{ background: var\(--md-surface-container-high, #e8e8ef\)/);
  assert.match(styles, /\.nav-item\.active \{ background: var\(--md-primary-container, #dce3ff\)/);
  assert.match(script, /audio\.paused \? '▶' : '⏸'/);
  assert.match(script, /encodeURIComponent\(value\)/);
  assert.match(mainSource, /normalizedFacetValue\(song\[field as keyof LibrarySong\]\) !== normalizedFacetValue\(expected\)/);
  assert.match(mainSource, /playlist\.type === type && !playlist\.cover_url/);
  assert.match(mainSource, /cover_song_id: selected\.id/);
  assert.match(mainSource, /router\.get\('\/api\/favorites\/ids'/);
  assert.match(mainSource, /router\.post\('\/api\/favorites\/set'/);
  assert.match(mainSource, /query\.sort === 'favorite'/);
  assert.match(mainSource, /sortSongsByFavorite/);
  assert.match(mainSource, /router\.post\('\/api\/playlists\/from-category'/);
  assert.match(mainSource, /cover_song_id: selected\.id/);
  assert.match(mainSource, /coverSet/);
  assert.doesNotMatch(html, /id="filterButton"|organizeDialog|data-action="organize"/);
  assert.doesNotMatch(html, /id="sortSelect"/);
  assert.match(html, /id="pageSizeSelect"/);
  assert.match(html, /播放本页歌曲/);
  const dom = new JSDOM(html, {
    url: 'http://localhost/songloft/api/v1/jsplugin/library-plus/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
  let confirmCalls = 0;
  window.confirm = () => { confirmCalls += 1; return true; };
  window.scrollTo = () => {};
  let playCalls = 0;
  window.HTMLMediaElement.prototype.play = async function play() { playCalls += 1; };
  window.HTMLMediaElement.prototype.pause = function pause() {};
  const posts = [];
  const gets = [];
  let totalSongs = songs.length;
  const playlists = [
    { id: 10, type: 'normal', name: '通勤', description: '上班路上', cover_url: '', labels: [], song_count: 2 },
    { id: 11, type: 'normal', name: '周杰伦', description: '', cover_url: '', labels: [], song_count: 0 },
    ...Array.from({ length: 8 }, (_, index) => ({ id: 30 + index, type: 'normal', name: `歌单 ${index + 1}`, description: '', cover_url: '', labels: [], song_count: index })),
    { id: 20, type: 'radio', name: '新闻电台', description: '实时广播', cover_url: '', labels: [], song_count: 1 },
  ];
  window.SongloftPlugin = {
    apiGet: async (path) => {
      gets.push(path);
      if (path.startsWith('/api/capabilities')) return { hostVersion: '2.10.0', language: true, style: true };
      if (path.startsWith('/api/index')) return index;
      if (path === '/api/favorites/ids') return { ids: [1] };
      if (path.startsWith('/api/songs')) return { songs, total: totalSongs, offset: 0, limit: 100 };
      if (path.startsWith('/api/song-ids')) return { ids: songs.map((song) => song.id), total: songs.length };
      if (path.startsWith('/api/playlists')) {
        if (path.includes('type=radio')) return { playlists: playlists.filter((item) => item.type === 'radio') };
        if (path.includes('type=normal')) return { playlists: playlists.filter((item) => item.type === 'normal') };
        return { playlists };
      }
      throw new Error(`unexpected GET ${path}`);
    },
    apiPost: async (path, body) => {
      posts.push({ path, body });
      if (path === '/api/playlists/create') return { playlist: { ...playlists[0], id: 12, name: body.name, song_count: 0 } };
      if (path === '/api/playlists/remove') return { success: true, removed: body.songIds.length };
      if (path === '/api/playlists/auto-covers') return { updated: 1, skipped: 0, missingCoverSongs: 0, errors: [] };
      if (path === '/api/favorites/add') return { success: true, added: body.songIds.length, skipped: 0 };
      if (path === '/api/favorites/set') return { success: true, id: body.id, favorite: body.favorite };
      if (path === '/api/playlists/from-category') return { success: true, created: false, playlistId: body.playlistId, added: 2, skipped: 0, coverSet: true };
      if (path === '/api/songs/by-ids') return { songs: songs.filter((song) => body.ids.includes(song.id)) };
      return { results: [], added: body?.songIds?.length || 0, skipped: 0 };
    },
    getAuthToken: () => 'test-token',
    announce: () => {},
  };

  window.eval(script);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await waitFor(() => window.document.querySelector('#pageTitle')?.textContent === '音乐库概览');
  assert.doesNotMatch(window.document.body.textContent, /智能分类/);
  assert.equal(window.document.querySelector('[data-nav="recent"]'), null);
  assert.equal(window.document.querySelector('.brand').textContent.trim(), '歌曲库 Plus');
  assert.match(window.document.querySelector('#librarySummary').textContent, /2 首歌曲/);
  await waitFor(() => window.document.querySelector('[data-open-playlist="10"]'));
  assert.match(window.document.querySelector('#dashboard').textContent, /我的歌单/);
  assert.match(window.document.querySelector('#dashboard').textContent, /主要专辑/);
  assert.ok(window.document.querySelector('.dashboard-playlists-panel').compareDocumentPosition(window.document.querySelector('.dashboard-columns')) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(window.document.querySelectorAll('#dashboardPlaylists [data-open-playlist]').length, 8);
  assert.ok(window.document.querySelector('[data-nav="folders"] .ui-icon'));
  assert.ok(window.document.querySelector('[data-nav="artist"] .ui-icon'));
  assert.ok(window.document.querySelector('[data-nav="radios"] .ui-icon'));
  assert.ok(window.document.querySelector('#songsSection').classList.contains('hidden'));
  assert.ok(window.document.querySelector('.list-toolbar #playAllButton'));
  assert.ok(window.document.querySelector('.list-toolbar #viewToggleButton'));
  assert.ok(window.document.querySelector('#categoryCreatePlaylistButton').classList.contains('hidden'));

  window.document.querySelector('[data-nav="all"]').click();
  await waitFor(() => window.document.querySelectorAll('[data-song-row]').length >= 2);
  assert.equal(window.document.querySelector('#resultCount').textContent, '2 首歌曲');
  assert.match(window.document.querySelector('.song-cover').src, /\/songloft\/api\/v1\/songs\/1\/cover/);
  assert.equal(window.document.querySelector('.list-toolbar [data-action="select-all"]'), null);
  assert.ok(window.document.querySelector('#selectionBar [data-action="select-all"]'));
  const tableHeaders = Array.from(window.document.querySelectorAll('.songs-table thead th'));
  assert.equal(tableHeaders[0].className, 'col-check');
  assert.equal(tableHeaders[1].className, 'col-favorite');
  assert.equal(tableHeaders[2].className, 'col-cover');
  assert.equal(window.document.querySelector('[data-sort="favorite"] .favorite-header-icon').textContent, '♥');
  assert.doesNotMatch(window.document.querySelector('[data-sort="favorite"]').textContent, /收藏/);
  const firstRowCells = Array.from(window.document.querySelector('.songs-table [data-song-row="1"]').children);
  assert.equal(firstRowCells[0].className, 'col-check');
  assert.equal(firstRowCells[1].className, 'col-favorite');
  assert.match(firstRowCells[2].className, /col-cover/);
  const listChildren = Array.from(window.document.querySelector('.song-list [data-song-row="1"]').children);
  assert.ok(listChildren[0].querySelector('[data-select-song]'));
  assert.ok(listChildren[1].matches('[data-toggle-favorite]'));
  assert.ok(listChildren[2].matches('[data-play-song]'));
  assert.ok(window.document.querySelector('[data-song-row="1"] [data-toggle-favorite="1"]').classList.contains('active'));
  assert.ok(!window.document.querySelector('[data-song-row="2"] [data-toggle-favorite="2"]').classList.contains('active'));
  window.document.querySelector('[data-sort="favorite"]').click();
  await waitFor(() => gets.some((path) => path.includes('sort=favorite') && path.includes('order=desc'))
    && window.document.querySelector('[data-sort="favorite"] .sort-arrow')?.textContent.includes('↓'));
  assert.match(window.document.querySelector('[data-sort="favorite"] .sort-arrow').textContent, /↓/);
  window.document.querySelector('[data-sort="favorite"]').click();
  await waitFor(() => gets.some((path) => path.includes('sort=favorite') && path.includes('order=asc'))
    && window.document.querySelector('[data-sort="favorite"] .sort-arrow')?.textContent.includes('↑'));
  assert.match(window.document.querySelector('[data-sort="favorite"] .sort-arrow').textContent, /↑/);
  window.document.querySelector('.songs-table [data-toggle-favorite="2"]').click();
  await waitFor(() => posts.some((item) => item.path === '/api/favorites/set')
    && window.document.querySelector('.songs-table [data-toggle-favorite="2"]')?.classList.contains('active'));
  assert.deepEqual(JSON.parse(JSON.stringify(posts.find((item) => item.path === '/api/favorites/set').body)), { id: 2, favorite: true });
  assert.ok(window.document.querySelector('.songs-table [data-toggle-favorite="2"]').classList.contains('active'));
  assert.ok(!window.document.querySelector('.songs-table [data-song-row="2"]').classList.contains('selected'));
  window.document.querySelector('[data-sort="title"]').click();
  await waitFor(() => gets.some((path) => path.includes('sort=title') && path.includes('order=asc')));
  await waitFor(() => window.document.querySelector('[data-sort="title"] .sort-arrow'));
  assert.match(window.document.querySelector('[data-sort="title"] .sort-arrow').textContent, /↑/);

  window.document.querySelector('#viewToggleButton').click();
  totalSongs = 260;
  const pageSizeSelect = window.document.querySelector('#pageSizeSelect');
  pageSizeSelect.value = '25';
  pageSizeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => window.document.querySelector('#pageJumpInput'));
  assert.equal(window.localStorage.getItem('library-plus-page-size'), '25');
  window.document.querySelector('#pageJumpInput').value = '8';
  window.document.querySelector('[data-page-jump]').click();
  await waitFor(() => gets.some((path) => path.includes('offset=175') && path.includes('limit=25')));
  await waitFor(() => window.document.querySelector('.page-number.active')?.textContent === '8');
  assert.match(window.document.querySelector('#pagination').textContent, /8.*11/);
  window.document.querySelector('#columnsDialog footer [data-close-dialog]').click();
  totalSongs = songs.length;
  window.document.querySelector('[data-nav="all"]').click();
  await waitFor(() => window.document.querySelector('.songs-table [data-song-row="1"]'));

  const songGetsBeforePagePlay = gets.filter((path) => path.startsWith('/api/songs')).length;
  window.document.querySelector('#playAllButton').click();
  await waitFor(() => playCalls === 1);
  assert.equal(gets.filter((path) => path.startsWith('/api/songs')).length, songGetsBeforePagePlay);
  assert.ok(window.document.body.classList.contains('player-active'));
  window.document.querySelector('#playerQueueButton').click();
  assert.ok(!window.document.querySelector('#queuePanel').classList.contains('hidden'));
  assert.equal(window.document.querySelectorAll('#queueList [data-queue-index]').length, 2);
  assert.equal(window.document.querySelector('#playerQueueButton').getAttribute('aria-expanded'), 'true');
  window.document.querySelector('#queueClose').click();
  assert.ok(window.document.querySelector('#queuePanel').classList.contains('hidden'));
  window.document.querySelector('#playerClose').click();

  const firstRow = window.document.querySelector('.songs-table [data-song-row="1"]');
  const firstTitle = firstRow.querySelector('.col-title');
  assert.equal(firstTitle.closest('[data-play-song]'), null);
  firstTitle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.match(window.document.querySelector('#selectionCount').textContent, /1 首/);
  assert.ok(firstRow.classList.contains('selected'));
  assert.equal(playCalls, 1);
  assert.ok(!window.document.querySelector('#selectionBar').classList.contains('hidden'));
  assert.ok(window.document.querySelector('[data-action="select-all"]'));
  assert.ok(window.document.querySelector('[data-action="invert"]'));
  assert.ok(window.document.querySelector('[data-action="clear"]'));

  window.document.querySelector('[data-action="invert"]').click();
  await waitFor(() => window.document.querySelector('.songs-table [data-song-row="2"]').classList.contains('selected'));
  assert.ok(!window.document.querySelector('.songs-table [data-song-row="1"]').classList.contains('selected'));

  window.document.querySelector('.songs-table [data-song-row="1"] [data-play-song]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => playCalls === 2);

  window.document.querySelector('[data-action="clear"]').click();
  const dragStart = window.document.querySelector('.songs-table [data-song-row="1"] .col-title');
  const secondRow = window.document.querySelector('.songs-table [data-song-row="2"]');
  const pointerDown = new window.Event('pointerdown', { bubbles: true, cancelable: true });
  Object.assign(pointerDown, { pointerType: 'mouse', pointerId: 1, shiftKey: false, clientX: 0, clientY: 0 });
  dragStart.dispatchEvent(pointerDown);
  const pointerOver = new window.Event('pointerover', { bubbles: true });
  Object.assign(pointerOver, { pointerType: 'mouse', pointerId: 1 });
  secondRow.dispatchEvent(pointerOver);
  const pointerUp = new window.Event('pointerup', { bubbles: true });
  Object.assign(pointerUp, { pointerType: 'mouse', pointerId: 1 });
  window.document.dispatchEvent(pointerUp);
  assert.match(window.document.querySelector('#selectionCount').textContent, /2 首/);

  window.document.querySelector('[data-action="play-selected"]').click();
  await waitFor(() => playCalls === 3);

  window.document.querySelector('[data-action="favorite"]').click();
  await waitFor(() => posts.some((item) => item.path === '/api/favorites/add'));
  assert.deepEqual(Array.from(posts.find((item) => item.path === '/api/favorites/add').body.songIds), [1, 2]);

  window.document.querySelector('[data-action="playlist"]').click();
  await waitFor(() => window.document.querySelector('#playlistSelect option[value="__new__"]'));
  const playlistSelect = window.document.querySelector('#playlistSelect');
  playlistSelect.value = '__new__';
  playlistSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.ok(!window.document.querySelector('#newPlaylistField').classList.contains('hidden'));
  playlistSelect.value = '10';
  playlistSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.ok(window.document.querySelector('#newPlaylistField').classList.contains('hidden'));
  playlistSelect.value = '__new__';
  playlistSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  window.document.querySelector('#newPlaylistName').value = '新歌单';
  window.document.querySelector('#confirmPlaylistButton').click();
  await waitFor(() => posts.some((item) => item.path === '/api/playlists/add'));
  const playlistPost = posts.find((item) => item.path === '/api/playlists/add');
  assert.equal(playlistPost.body.playlistId, 0);
  assert.equal(playlistPost.body.newName, '新歌单');
  assert.equal(playlistPost.body.newType, 'normal');

  window.document.querySelector('[data-action="tags"]').click();
  await waitFor(() => window.document.querySelector('#tagsDialog').open);
  assert.doesNotMatch(window.document.querySelector('#tagsHint').textContent, /相同值|不同值会淡显提示/);
  const tagsForm = window.document.querySelector('#tagsDialog form');
  assert.equal(tagsForm.elements.namedItem('artist').value, '周杰伦');
  assert.equal(tagsForm.elements.namedItem('album').placeholder, '不同的值');
  tagsForm.elements.namedItem('artist').value = '周杰伦（批量）';
  tagsForm.elements.namedItem('artist').dispatchEvent(new window.Event('input', { bubbles: true }));
  window.document.querySelector('#confirmTagsButton').click();
  await waitFor(() => posts.some((item) => item.path === '/api/tags'));
  const tagPost = posts.find((item) => item.path === '/api/tags');
  assert.deepEqual(JSON.parse(JSON.stringify(tagPost.body.fields)), { artist: '周杰伦（批量）', rename_file: false });

  window.document.querySelector('[data-nav="artist"]').click();
  await waitFor(() => window.document.querySelector('[data-category-field="artist"]'));
  const specialArtist = Array.from(window.document.querySelectorAll('[data-category-field="artist"]'))
    .find((element) => element.dataset.categoryValue === '伍佰 & China Blue');
  assert.ok(specialArtist);
  specialArtist.click();
  await waitFor(() => !window.document.querySelector('#categoryBackButton').classList.contains('hidden'));
  await waitFor(() => gets.some((path) => path.includes('artist=%E4%BC%8D%E4%BD%B0%20%26%20China%20Blue')));
  assert.ok(!gets.find((path) => path.includes('artist=%E4%BC%8D%E4%BD%B0+')));
  assert.equal(window.document.querySelectorAll('.filter-chip').length, 0);
  const postsBeforeNewAutoPlaylist = posts.length;
  window.document.querySelector('#categoryCreatePlaylistButton').click();
  await waitFor(() => window.document.querySelector('#autoPlaylistDialog').open);
  assert.match(window.document.querySelector('#autoPlaylistMessage').textContent, /将根据当前分类创建“伍佰 & China Blue”歌单/);
  assert.equal(posts.length, postsBeforeNewAutoPlaylist);
  window.document.querySelector('#autoPlaylistDialog [data-close-dialog]').click();
  window.document.querySelector('#categoryBackButton').click();
  assert.ok(!window.document.querySelector('#categoryBrowser').classList.contains('hidden'));
  assert.match(window.document.querySelector('#categoryBrowser').textContent, /周杰伦/);
  const jayArtist = Array.from(window.document.querySelectorAll('[data-category-field="artist"]'))
    .find((element) => element.dataset.categoryValue === '周杰伦');
  jayArtist.click();
  await waitFor(() => !window.document.querySelector('#categoryCreatePlaylistButton').classList.contains('hidden'));
  assert.match(window.document.querySelector('#categoryCreatePlaylistButton').textContent, /自动创建歌单/);
  const confirmsBeforeAutoPlaylist = confirmCalls;
  window.document.querySelector('#categoryCreatePlaylistButton').click();
  await waitFor(() => window.document.querySelector('#autoPlaylistDialog').open);
  assert.match(window.document.querySelector('#autoPlaylistMessage').textContent, /已经存在“周杰伦”歌单/);
  assert.equal(confirmCalls, confirmsBeforeAutoPlaylist);
  assert.equal(posts.some((item) => item.path === '/api/playlists/from-category'), false);
  window.document.querySelector('#confirmAutoPlaylistButton').click();
  await waitFor(() => posts.some((item) => item.path === '/api/playlists/from-category'));
  const categoryPlaylistPost = posts.find((item) => item.path === '/api/playlists/from-category');
  assert.deepEqual(JSON.parse(JSON.stringify(categoryPlaylistPost.body)), { field: 'artist', value: '周杰伦', name: '周杰伦', playlistId: 11 });

  window.document.querySelector('[data-nav="playlists"]').click();
  await waitFor(() => window.document.querySelector('#playlistBrowser [data-open-playlist="10"]'));
  assert.match(window.document.querySelector('#playlistBrowser').textContent, /通勤/);
  const playlistGetsBeforeRefresh = gets.filter((path) => path === '/api/playlists?type=normal').length;
  const songGetsBeforeRefresh = gets.filter((path) => path.startsWith('/api/songs')).length;
  window.document.querySelector('#refreshButton').click();
  await waitFor(() => gets.filter((path) => path === '/api/playlists?type=normal').length > playlistGetsBeforeRefresh);
  assert.equal(gets.filter((path) => path.startsWith('/api/songs')).length, songGetsBeforeRefresh);
  assert.ok(window.document.querySelector('#songsSection').classList.contains('hidden'));
  assert.ok(!window.document.querySelector('#playlistBrowser').classList.contains('hidden'));
  const playlistGetsBeforeAuto = gets.filter((path) => path === '/api/playlists?type=normal').length;
  window.document.querySelector('[data-auto-covers]').click();
  await waitFor(() => posts.some((item) => item.path === '/api/playlists/auto-covers'));
  assert.equal(posts.find((item) => item.path === '/api/playlists/auto-covers').body.type, 'normal');
  await waitFor(() => gets.filter((path) => path === '/api/playlists?type=normal').length > playlistGetsBeforeAuto
    && window.document.querySelector('#playlistBrowser [data-open-playlist="10"]'));
  window.document.querySelector('[data-playlist-create]').click();
  assert.equal(window.document.querySelector('#playlistManageName').required, false);
  window.document.querySelector('#playlistManageDialog [data-close-dialog]').click();
  assert.equal(window.document.querySelector('#playlistManageDialog').open, false);
  window.document.querySelector('#playlistBrowser [data-open-playlist="10"]').click();
  await waitFor(() => !window.document.querySelector('#playlistContextBar').classList.contains('hidden') && window.document.querySelector('.songs-table [data-song-row="1"] .col-title'));
  assert.match(window.document.querySelector('#playlistContextBar').textContent, /通勤/);
  window.document.querySelector('.songs-table [data-song-row="1"] .col-title').click();
  window.document.querySelector('[data-action="remove-playlist"]').click();
  await waitFor(() => posts.some((item) => item.path === '/api/playlists/remove'));

  window.document.querySelector('[data-nav="radios"]').click();
  await waitFor(() => window.document.querySelector('#playlistBrowser [data-open-playlist="20"]'));
  assert.equal(window.document.querySelector('#pageTitle').textContent, '我的电台');
  assert.match(window.document.querySelector('#playlistBrowser').textContent, /新闻电台/);
  window.document.querySelector('[data-playlist-create]').click();
  assert.equal(window.document.querySelector('#playlistManageType').value, 'radio');
  window.document.querySelector('#playlistManageDialog [data-close-dialog]').click();

  window.document.querySelector('[data-nav="folders"]').click();
  await waitFor(() => !window.document.querySelector('#folderBrowser').classList.contains('hidden'));
  assert.match(window.document.querySelector('#folderTree').textContent, /周杰伦/);
  const longFolder = Array.from(window.document.querySelectorAll('.folder-name')).find((item) => item.title.includes('非常非常长'));
  assert.ok(longFolder);
  assert.equal(longFolder.textContent, longFolder.title);
  assert.match(window.document.querySelector('#pageTitle').textContent, /音乐库/);
  assert.ok(window.document.querySelector('#folderSongsMount > #songsSection'));
  window.document.querySelector('#toggleFolderPane').click();
  assert.ok(window.document.querySelector('#folderBrowser').classList.contains('folder-pane-collapsed'));
  await new Promise((resolve) => setTimeout(resolve, 30));

  dom.window.close();
});
