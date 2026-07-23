/// <reference types="@songloft/plugin-sdk" />

import {
  createRouter,
  jsonResponse,
  parseQuery,
  type HTTPRequest,
  type HTTPResponse,
  type Song,
} from '@songloft/plugin-sdk';

type LibrarySong = Song & {
  language?: string;
  style?: string;
  track?: string;
  file_modified_at?: string;
};

type FolderNode = {
  path: string;
  name: string;
  parent: string;
  depth: number;
  directCount: number;
  totalCount: number;
};

type FacetItem = {
  value: string;
  count: number;
  coverUrl?: string;
  subtitle?: string;
};

type LibraryIndex = {
  generatedAt: number;
  rootPath: string;
  songs: LibrarySong[];
  folders: FolderNode[];
  facets: Record<string, FacetItem[]>;
  summary: {
    total: number;
    local: number;
    remote: number;
    radio: number;
    duration: number;
    size: number;
  };
};

const router = createRouter();
const cacheTtlMs = 2 * 60 * 1000;
let indexCache: LibraryIndex | null = null;
let indexPromise: Promise<LibraryIndex> | null = null;

function normalizePath(input: string): string {
  if (!input) return '';
  const path = input.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  return path.length > 1 ? path.replace(/\/$/, '') : path;
}

function dirname(input: string): string {
  const path = normalizePath(input);
  const i = path.lastIndexOf('/');
  if (i < 0) return '';
  if (i === 0) return '/';
  return path.slice(0, i);
}

function commonRoot(paths: string[]): string {
  if (paths.length === 0) return '';
  const normalized = paths.map(normalizePath);
  const absolute = normalized.every((path) => path.startsWith('/'));
  const parts = normalized.map((path) => path.split('/').filter(Boolean));
  const common: string[] = [];
  const shortest = Math.min(...parts.map((item) => item.length));
  for (let i = 0; i < shortest; i += 1) {
    const segment = parts[0][i];
    if (!parts.every((item) => item[i] === segment)) break;
    common.push(segment);
  }
  const joined = common.join('/');
  if (!joined) return absolute ? '/' : '';
  return (absolute ? '/' : '') + joined;
}

function relativeFolder(filePath: string, rootPath: string): string {
  const folder = dirname(filePath);
  if (!rootPath || rootPath === '/') return folder.replace(/^\//, '');
  if (folder === rootPath) return '';
  if (folder.startsWith(`${rootPath}/`)) return folder.slice(rootPath.length + 1);
  return folder.replace(/^\//, '');
}

function addFacet(
  maps: Record<string, Map<string, FacetItem>>,
  field: string,
  value: unknown,
  song: LibrarySong,
  subtitle?: string,
): void {
  const text = String(value ?? '').trim();
  if (!text) return;
  const map = maps[field];
  const existing = map.get(text);
  if (existing) {
    existing.count += 1;
    if (!existing.coverUrl && song.cover_url) existing.coverUrl = song.cover_url;
    return;
  }
  map.set(text, {
    value: text,
    count: 1,
    coverUrl: song.cover_url || undefined,
    subtitle,
  });
}

function buildIndex(songs: LibrarySong[], configuredRoot = ''): LibraryIndex {
  const localPaths = songs
    .filter((song) => song.type === 'local' && song.file_path)
    .map((song) => dirname(song.file_path));
  const normalizedConfiguredRoot = normalizePath(configuredRoot);
  const configuredRootMatches = normalizedConfiguredRoot
    && localPaths.length > 0
    && localPaths.every((path) => path === normalizedConfiguredRoot || path.startsWith(`${normalizedConfiguredRoot}/`));
  const rootPath = configuredRootMatches ? normalizedConfiguredRoot : commonRoot(localPaths);
  const folderMap = new Map<string, FolderNode>();
  folderMap.set('', {
    path: '',
    name: '音乐库',
    parent: '',
    depth: 0,
    directCount: 0,
    totalCount: 0,
  });

  const facetFields = [
    'artist', 'album', 'genre', 'year', 'decade', 'language', 'style',
    'format', 'type',
  ];
  const facetMaps: Record<string, Map<string, FacetItem>> = {};
  for (const field of facetFields) facetMaps[field] = new Map();

  let duration = 0;
  let size = 0;
  let local = 0;
  let remote = 0;
  let radio = 0;

  for (const song of songs) {
    duration += Number(song.duration || 0);
    size += Number(song.file_size || 0);
    if (song.type === 'local') local += 1;
    if (song.type === 'remote') remote += 1;
    if (song.type === 'radio') radio += 1;

    addFacet(facetMaps, 'artist', song.artist, song);
    addFacet(facetMaps, 'album', song.album, song, song.artist || '未知歌手');
    addFacet(facetMaps, 'genre', song.genre, song);
    addFacet(facetMaps, 'language', song.language, song);
    addFacet(facetMaps, 'style', song.style, song);
    addFacet(facetMaps, 'format', String(song.format || '').toUpperCase(), song);
    addFacet(facetMaps, 'type', song.type, song);
    if (song.year > 0) {
      addFacet(facetMaps, 'year', String(song.year), song);
      addFacet(facetMaps, 'decade', String(Math.floor(song.year / 10) * 10), song);
    }

    if (song.type !== 'local' || !song.file_path) continue;
    const folder = relativeFolder(song.file_path, rootPath);
    const segments = folder.split('/').filter(Boolean);
    folderMap.get('')!.totalCount += 1;
    if (segments.length === 0) folderMap.get('')!.directCount += 1;

    let current = '';
    for (let i = 0; i < segments.length; i += 1) {
      const parent = current;
      current = current ? `${current}/${segments[i]}` : segments[i];
      let node = folderMap.get(current);
      if (!node) {
        node = {
          path: current,
          name: segments[i],
          parent,
          depth: i + 1,
          directCount: 0,
          totalCount: 0,
        };
        folderMap.set(current, node);
      }
      node.totalCount += 1;
      if (i === segments.length - 1) node.directCount += 1;
    }
  }

  const facets: Record<string, FacetItem[]> = {};
  for (const field of facetFields) {
    const items = Array.from(facetMaps[field].values());
    items.sort((a, b) => {
      if (field === 'year' || field === 'decade') return Number(b.value) - Number(a.value);
      return b.count - a.count || a.value.localeCompare(b.value, 'zh-CN');
    });
    facets[field] = items;
  }

  const folders = Array.from(folderMap.values()).sort((a, b) => {
    if (a.path === '') return -1;
    if (b.path === '') return 1;
    return a.path.localeCompare(b.path, 'zh-CN');
  });

  return {
    generatedAt: Date.now(),
    rootPath,
    songs,
    folders,
    facets,
    summary: { total: songs.length, local, remote, radio, duration, size },
  };
}

async function getIndex(force = false): Promise<LibraryIndex> {
  if (!force && indexCache && Date.now() - indexCache.generatedAt < cacheTtlMs) {
    return indexCache;
  }
  if (!force && indexPromise) return indexPromise;
  indexPromise = (async () => {
    const [songs, musicPath] = await Promise.all([
      songloft.songs.list({ limit: 100000, offset: 0 }) as Promise<LibrarySong[]>,
      hostRequest('/api/v1/settings/music-path')
        .then((result) => String((result as Record<string, unknown>)?.path || ''))
        .catch(() => ''),
    ]);
    indexCache = buildIndex(songs, musicPath);
    indexPromise = null;
    return indexCache;
  })();
  try {
    return await indexPromise;
  } catch (error) {
    indexPromise = null;
    throw error;
  }
}

function invalidateIndex(): void {
  indexCache = null;
}

function parseRequestBody(req: HTTPRequest): Record<string, unknown> {
  if (!req.body) return {};
  const raw = typeof req.body === 'string'
    ? req.body
    : String.fromCharCode.apply(null, Array.from(req.body as Uint8Array));
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('请求数据不是有效的 JSON');
  }
}

function boolValue(value: string | undefined, fallback = false): boolean {
  if (value == null || value === '') return fallback;
  return value === '1' || value === 'true';
}

function textIncludes(value: unknown, keyword: string): boolean {
  return String(value ?? '').toLocaleLowerCase().includes(keyword);
}

function normalizedFacetValue(value: unknown): string {
  const text = String(value ?? '');
  const unicodeNormalized = typeof text.normalize === 'function' ? text.normalize('NFKC') : text;
  return unicodeNormalized
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

function filterSongs(index: LibraryIndex, query: Record<string, string>): LibrarySong[] {
  const keyword = String(query.keyword || '').trim().toLocaleLowerCase();
  const folder = String(query.folder || '');
  const recursive = boolValue(query.recursive, true);
  const exactFields = ['type', 'artist', 'album', 'genre', 'language', 'style'];

  return index.songs.filter((song) => {
    if (keyword && ![
      song.title, song.artist, song.album, song.genre, song.language,
      song.style, song.file_path,
    ].some((value) => textIncludes(value, keyword))) return false;

    for (const field of exactFields) {
      const expected = query[field];
      if (expected && normalizedFacetValue(song[field as keyof LibrarySong]) !== normalizedFacetValue(expected)) return false;
    }
    if (query.format && String(song.format || '').toUpperCase() !== query.format.toUpperCase()) return false;
    if (query.year && song.year !== Number(query.year)) return false;
    if (query.decade && Math.floor(song.year / 10) * 10 !== Number(query.decade)) return false;

    if (query.folder != null && song.type === 'local') {
      const songFolder = relativeFolder(song.file_path, index.rootPath);
      if (folder === '') {
        if (!recursive && songFolder !== '') return false;
      } else if (recursive) {
        if (songFolder !== folder && !songFolder.startsWith(`${folder}/`)) return false;
      } else if (songFolder !== folder) return false;
    } else if (query.folder != null && song.type !== 'local') {
      return false;
    }

    return true;
  });
}

function trackNumber(track?: string): number {
  const parsed = Number.parseInt(String(track || '').split('/')[0], 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortSongs(songs: LibrarySong[], sort: string, order: string): LibrarySong[] {
  if (sort === 'position') return [...songs];
  const direction = order === 'desc' ? -1 : 1;
  const getValue = (song: LibrarySong): string | number => {
    if (sort === 'track') return trackNumber(song.track);
    if (sort === 'year') return song.year || 0;
    if (sort === 'duration') return song.duration || 0;
    if (sort === 'file_size') return song.file_size || 0;
    if (sort === 'bit_rate') return song.bit_rate || 0;
    if (sort === 'added_at') return Date.parse(song.added_at || '') || 0;
    if (sort === 'updated_at') return Date.parse(song.updated_at || '') || 0;
    if (sort === 'file_modified_at') return Date.parse(song.file_modified_at || '') || 0;
    return String(song[sort as keyof LibrarySong] ?? '').toLocaleLowerCase();
  };
  return [...songs].sort((a, b) => {
    const av = getValue(a);
    const bv = getValue(b);
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * direction;
    return String(av).localeCompare(String(bv), 'zh-CN', { numeric: true }) * direction;
  });
}

async function hostRequest(path: string, options: RequestInit = {}): Promise<unknown> {
  const [host, token] = await Promise.all([
    songloft.plugin.getHostUrl(),
    songloft.plugin.getToken(),
  ]);
  const response = await fetch(`${host.replace(/\/$/, '')}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const raw = await response.text();
  let body: unknown = null;
  if (raw) {
    try { body = JSON.parse(raw); } catch { body = raw; }
  }
  if (!response.ok) {
    const object = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    throw new Error(String(object.error || object.message || `HTTP ${response.status}`));
  }
  return body;
}

async function songsForQuery(index: LibraryIndex, query: Record<string, string>): Promise<LibrarySong[]> {
  const playlistId = Number(query.playlist_id || 0);
  if (!playlistId) return index.songs;
  return songloft.playlists.getSongs(playlistId, { limit: 100000, offset: 0 }) as Promise<LibrarySong[]>;
}

async function getFavoriteSongIds(): Promise<Set<number>> {
  const readFavorite = async (playlistId: number): Promise<LibrarySong[]> => {
    try {
      return await songloft.playlists.getSongs(playlistId, { limit: 100000, offset: 0 }) as LibrarySong[];
    } catch {
      return [];
    }
  };
  const [normalSongs, radioSongs] = await Promise.all([readFavorite(1), readFavorite(2)]);
  return new Set([...normalSongs, ...radioSongs].map((song) => song.id));
}

function sortSongsByFavorite(songs: LibrarySong[], favoriteIds: Set<number>, order: string): LibrarySong[] {
  const direction = order === 'asc' ? 1 : -1;
  return [...songs].sort((a, b) => {
    const favoriteDifference = (Number(favoriteIds.has(a.id)) - Number(favoriteIds.has(b.id))) * direction;
    if (favoriteDifference) return favoriteDifference;
    return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN', { numeric: true });
  });
}

router.get('/api/index', async (req) => {
  try {
    const query = parseQuery(req.query);
    const index = await getIndex(boolValue(query.refresh));
    return jsonResponse({
      generatedAt: index.generatedAt,
      rootPath: index.rootPath,
      folders: index.folders,
      facets: index.facets,
      summary: index.summary,
    });
  } catch (error) {
    return jsonResponse({ error: String((error as Error).message || error) }, 500);
  }
});

router.get('/api/songs', async (req) => {
  try {
    const query = parseQuery(req.query);
    const index = await getIndex(false);
    const scopedSongs = await songsForQuery(index, query);
    const filtered = filterSongs({ ...index, songs: scopedSongs }, query);
    const sorted = query.sort === 'favorite'
      ? sortSongsByFavorite(filtered, await getFavoriteSongIds(), query.order || 'desc')
      : sortSongs(filtered, query.sort || 'added_at', query.order || 'desc');
    const offset = Math.max(0, Number(query.offset || 0));
    const limit = Math.min(500, Math.max(1, Number(query.limit || 100)));
    const songs = sorted.slice(offset, offset + limit).map((song) => ({
      ...song,
      folder_path: song.type === 'local' ? relativeFolder(song.file_path, index.rootPath) : '',
    }));
    return jsonResponse({ songs, total: sorted.length, offset, limit });
  } catch (error) {
    return jsonResponse({ error: String((error as Error).message || error) }, 500);
  }
});

router.get('/api/song-ids', async (req) => {
  try {
    const index = await getIndex(false);
    const query = parseQuery(req.query);
    const scopedSongs = await songsForQuery(index, query);
    const songs = filterSongs({ ...index, songs: scopedSongs }, query);
    return jsonResponse({ ids: songs.map((song) => song.id), total: songs.length });
  } catch (error) {
    return jsonResponse({ error: String((error as Error).message || error) }, 500);
  }
});

router.post('/api/songs/by-ids', async (req) => {
  try {
    const body = parseRequestBody(req);
    const ids = new Set(Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : []);
    if (ids.size === 0) return jsonResponse({ songs: [] });
    const index = await getIndex(false);
    const songs = index.songs
      .filter((song) => ids.has(song.id))
      .map((song) => ({
        ...song,
        folder_path: song.type === 'local' ? relativeFolder(song.file_path, index.rootPath) : '',
      }));
    return jsonResponse({ songs });
  } catch (error) {
    return jsonResponse({ error: String((error as Error).message || error) }, 400);
  }
});

router.get('/api/playlists', async (req) => {
  try {
    const query = parseQuery(req.query);
    const playlists = await songloft.playlists.list();
    const type = query.type === 'normal' || query.type === 'radio' ? query.type : '';
    return jsonResponse({ playlists: type ? playlists.filter((item) => item.type === type) : playlists });
  } catch (error) {
    return jsonResponse({ error: String((error as Error).message || error) }, 500);
  }
});

router.post('/api/playlists/create', async (req) => {
  try {
    const body = parseRequestBody(req);
    const name = String(body.name || '').trim();
    if (!name) throw new Error('请输入歌单名称');
    const playlist = await songloft.playlists.create({
      name,
      type: body.type === 'radio' ? 'radio' : 'normal',
      description: String(body.description || '').trim(),
      coverUrl: String(body.coverUrl || '').trim() || undefined,
    });
    return jsonResponse({ playlist });
  } catch (error) {
    return jsonResponse({ error: String((error as Error).message || error) }, 400);
  }
});

router.post('/api/playlists/update', async (req) => {
  try {
    const body = parseRequestBody(req);
    const id = Number(body.id || 0);
    if (!id) throw new Error('歌单不存在');
    const fields: { name?: string; description?: string; coverUrl?: string } = {};
    if (body.name != null) fields.name = String(body.name).trim();
    if (body.description != null) fields.description = String(body.description).trim();
    if (body.coverUrl != null) fields.coverUrl = String(body.coverUrl).trim();
    const playlist = await songloft.playlists.update(id, fields);
    return jsonResponse({ playlist });
  } catch (error) {
    return jsonResponse({ error: String((error as Error).message || error) }, 400);
  }
});

router.post('/api/playlists/auto-covers', async (req) => {
  try {
    const body = parseRequestBody(req);
    const type = body.type === 'radio' ? 'radio' : 'normal';
    const playlists = (await songloft.playlists.list()).filter((playlist) => playlist.type === type && !playlist.cover_url);
    let updated = 0;
    let missingCoverSongs = 0;
    const errors: Array<{ id: number; message: string }> = [];
    for (const playlist of playlists) {
      try {
        const songs = await songloft.playlists.getSongs(playlist.id, { limit: 100000, offset: 0 }) as LibrarySong[];
        const candidates = songs.filter((song) => Boolean(song.cover_url));
        if (!candidates.length) {
          missingCoverSongs += 1;
          continue;
        }
        const selected = candidates[Math.floor(Math.random() * candidates.length)];
        await hostRequest(`/api/v1/playlists/${playlist.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: playlist.name,
            description: playlist.description || '',
            cover_song_id: selected.id,
          }),
        });
        updated += 1;
      } catch (error) {
        errors.push({ id: playlist.id, message: String((error as Error).message || error) });
      }
    }
    return jsonResponse({ updated, skipped: playlists.length - updated, missingCoverSongs, errors });
  } catch (error) {
    return jsonResponse({ error: String((error as Error).message || error) }, 400);
  }
});

router.post('/api/playlists/delete', async (req) => {
  try {
    const body = parseRequestBody(req);
    const id = Number(body.id || 0);
    if (!id) throw new Error('歌单不存在');
    await songloft.playlists.delete(id);
    return jsonResponse({ success: true });
  } catch (error) {
    return jsonResponse({ error: String((error as Error).message || error) }, 400);
  }
});

router.post('/api/playlists/remove', async (req) => {
  try {
    const body = parseRequestBody(req);
    const playlistId = Number(body.playlistId || 0);
    const songIds = Array.isArray(body.songIds) ? body.songIds.map(Number).filter(Boolean) : [];
    if (!playlistId || songIds.length === 0) throw new Error('请选择歌单和歌曲');
    await songloft.playlists.removeSongs(playlistId, songIds);
    return jsonResponse({ success: true, removed: songIds.length });
  } catch (error) {
    return jsonResponse({ error: String((error as Error).message || error) }, 400);
  }
});

router.post('/api/playlists/reorder', async (req) => {
  try {
    const body = parseRequestBody(req);
    const playlistId = Number(body.playlistId || 0);
    const songIds = Array.isArray(body.songIds) ? body.songIds.map(Number).filter(Boolean) : [];
    if (!playlistId || songIds.length === 0) throw new Error('歌单排序数据不完整');
    await songloft.playlists.reorder(playlistId, songIds);
    return jsonResponse({ success: true });
  } catch (error) {
    return jsonResponse({ error: String((error as Error).message || error) }, 400);
  }
});

router.post('/api/playlists/add', async (req) => {
  try {
    const body = parseRequestBody(req);
    const ids = Array.isArray(body.songIds) ? body.songIds.map(Number).filter(Boolean) : [];
    let playlistId = Number(body.playlistId || 0);
    if (!playlistId && String(body.newName || '').trim()) {
      const playlist = await songloft.playlists.create({
        name: String(body.newName).trim(),
        type: body.newType === 'radio' ? 'radio' : 'normal',
        description: '由歌曲库 Plus 创建',
      });
      playlistId = playlist.id;
    }
    if (!playlistId || ids.length === 0) throw new Error('请选择歌单和歌曲');
    const result = await songloft.playlists.addSongs(playlistId, ids);
    return jsonResponse({ success: true, playlistId, ...result });
  } catch (error) {
    return jsonResponse({ error: String((error as Error).message || error) }, 400);
  }
});

router.post('/api/playlists/from-category', async (req) => {
  try {
    const body = parseRequestBody(req);
    const field = String(body.field || '');
    const value = String(body.value || '').trim();
    const name = String(body.name || value).trim().slice(0, 50);
    if (!['artist', 'album', 'genre', 'year'].includes(field) || !value || !name) {
      throw new Error('当前分类不能创建歌单');
    }
    const index = await getIndex(false);
    const matched = filterSongs(index, { [field]: value });
    const normalSongs = matched.filter((song) => song.type !== 'radio');
    if (!normalSongs.length) throw new Error('当前分类没有可加入普通歌单的歌曲');

    let playlistId = Number(body.playlistId || 0);
    let created = false;
    let playlistName = name;
    let playlistDescription = '';
    let playlistHasCover = false;
    if (playlistId) {
      const playlist = (await songloft.playlists.list()).find((item) => item.id === playlistId);
      if (!playlist || playlist.type !== 'normal') throw new Error('目标歌单不存在或不是普通歌单');
      playlistName = playlist.name;
      playlistDescription = playlist.description || '';
      playlistHasCover = Boolean(playlist.cover_url);
    } else {
      playlistDescription = `由歌曲库 Plus 根据${FIELD_LABELS_FOR_SERVER[field] || field}“${value}”创建`;
      const playlist = await songloft.playlists.create({
        name,
        type: 'normal',
        description: playlistDescription,
      });
      playlistId = playlist.id;
      playlistName = playlist.name;
      created = true;
    }
    const result = await songloft.playlists.addSongs(playlistId, normalSongs.map((song) => song.id));
    let coverSet = false;
    if (created || !playlistHasCover) {
      const coverSongs = normalSongs.filter((song) => Boolean(song.cover_url));
      if (coverSongs.length) {
        const selected = coverSongs[Math.floor(Math.random() * coverSongs.length)];
        await hostRequest(`/api/v1/playlists/${playlistId}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: playlistName,
            description: playlistDescription,
            cover_song_id: selected.id,
          }),
        });
        coverSet = true;
      }
    }
    return jsonResponse({
      success: true,
      created,
      playlistId,
      name,
      added: result.added,
      skipped: result.skipped,
      coverSet,
      excludedRadio: matched.length - normalSongs.length,
    });
  } catch (error) {
    return jsonResponse({ error: String((error as Error).message || error) }, 400);
  }
});

const FIELD_LABELS_FOR_SERVER: Record<string, string> = {
  artist: '歌手', album: '专辑', genre: '流派', year: '年份',
};

router.get('/api/favorites/ids', async () => {
  try {
    const ids = Array.from(await getFavoriteSongIds());
    return jsonResponse({ ids });
  } catch (error) {
    return jsonResponse({ error: String((error as Error).message || error) }, 500);
  }
});

router.post('/api/favorites/set', async (req) => {
  try {
    const body = parseRequestBody(req);
    const id = Number(body.id || 0);
    if (!id) throw new Error('歌曲不存在');
    const index = await getIndex(false);
    const song = index.songs.find((item) => item.id === id);
    if (!song) throw new Error('歌曲不存在');
    const playlistId = song.type === 'radio' ? 2 : 1;
    const favorite = body.favorite === true;
    if (favorite) await songloft.playlists.addSongs(playlistId, [id]);
    else await songloft.playlists.removeSongs(playlistId, [id]);
    return jsonResponse({ success: true, id, favorite });
  } catch (error) {
    return jsonResponse({ error: String((error as Error).message || error) }, 400);
  }
});

router.post('/api/favorites/add', async (req) => {
  try {
    const body = parseRequestBody(req);
    const ids = Array.isArray(body.songIds) ? body.songIds.map(Number).filter(Boolean) : [];
    if (ids.length === 0) throw new Error('没有选择歌曲');
    const index = await getIndex(false);
    const songMap = new Map(index.songs.map((song) => [song.id, song]));
    const normalIds = ids.filter((id) => songMap.get(id)?.type !== 'radio');
    const radioIds = ids.filter((id) => songMap.get(id)?.type === 'radio');
    let added = 0;
    let skipped = 0;
    if (normalIds.length) {
      const result = await songloft.playlists.addSongs(1, normalIds);
      added += result.added;
      skipped += result.skipped;
    }
    if (radioIds.length) {
      const result = await songloft.playlists.addSongs(2, radioIds);
      added += result.added;
      skipped += result.skipped;
    }
    return jsonResponse({ success: true, added, skipped });
  } catch (error) {
    return jsonResponse({ error: String((error as Error).message || error) }, 400);
  }
});

router.post('/api/tags', async (req) => {
  try {
    const body = parseRequestBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
    const fields = body.fields && typeof body.fields === 'object'
      ? body.fields as Record<string, unknown>
      : {};
    const lyrics = fields.lyrics == null ? '' : String(fields.lyrics);
    const tagFields = { ...fields };
    delete tagFields.lyrics;
    if (ids.length === 0) throw new Error('没有选择歌曲');
    const index = await getIndex(false);
    const songMap = new Map(index.songs.map((song) => [song.id, song]));
    const results: Array<{ id: number; status: string; error?: string }> = [];
    for (const id of ids) {
      try {
        const song = songMap.get(id);
        if (!song) throw new Error('歌曲不存在');
        if (song.type === 'local') {
          await hostRequest(`/api/v1/songs/${id}/tags`, {
            method: 'PUT',
            body: JSON.stringify(tagFields),
          });
        } else {
          const allowed: Record<string, string> = {};
          for (const key of ['title', 'artist', 'album']) {
            if (tagFields[key] != null && String(tagFields[key]).trim()) allowed[key] = String(tagFields[key]);
          }
          if (Object.keys(allowed).length) await songloft.songs.update(id, allowed);
        }
        if (lyrics.trim()) {
          await hostRequest(`/api/v1/songs/${id}/lyrics`, {
            method: 'PUT',
            body: JSON.stringify({ lyric_source: 'manual', lyric: lyrics }),
          });
        }
        results.push({ id, status: 'ok' });
      } catch (error) {
        results.push({ id, status: 'error', error: String((error as Error).message || error) });
      }
    }
    invalidateIndex();
    return jsonResponse({ results });
  } catch (error) {
    return jsonResponse({ error: String((error as Error).message || error) }, 400);
  }
});

router.post('/api/delete', async (req) => {
  try {
    const body = parseRequestBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
    const deleteFiles = body.deleteFiles === true;
    if (ids.length === 0) throw new Error('没有选择歌曲');
    const results: Array<{ id: number; status: string; error?: string }> = [];
    for (const id of ids) {
      try {
        await hostRequest(`/api/v1/songs/${id}${deleteFiles ? '?delete_files=true' : ''}`, {
          method: 'DELETE',
        });
        results.push({ id, status: 'ok' });
      } catch (error) {
        results.push({ id, status: 'error', error: String((error as Error).message || error) });
      }
    }
    invalidateIndex();
    return jsonResponse({ results });
  } catch (error) {
    return jsonResponse({ error: String((error as Error).message || error) }, 400);
  }
});

router.get('/api/capabilities', async () => {
  const capabilities = {
    minHostVersion: '2.11.0',
    hostVersion: '',
    categoryFacets: false,
    language: false,
    style: false,
    nativePlayerBridge: false,
  };
  try {
    const version = await hostRequest('/api/v1/version') as Record<string, unknown>;
    capabilities.hostVersion = String(version?.version || version?.data || '');
  } catch { /* version endpoint is advisory */ }
  try {
    await hostRequest('/api/v1/songs/facets?field=language');
    capabilities.categoryFacets = true;
    capabilities.language = true;
    capabilities.style = true;
  } catch { /* v2.10.0 does not expose category facets */ }
  return jsonResponse(capabilities);
});

router.get('/api/config', async () => {
  const config = await songloft.storage.get('config');
  return jsonResponse(config || {});
});

router.post('/api/config', async (req) => {
  try {
    const body = parseRequestBody(req);
    await songloft.storage.set('config', body);
    return jsonResponse({ success: true });
  } catch (error) {
    return jsonResponse({ error: String((error as Error).message || error) }, 400);
  }
});

async function onInit(): Promise<void> {
  songloft.log.info('歌曲库 Plus 已初始化');
}

async function onDeinit(): Promise<void> {
  indexCache = null;
  indexPromise = null;
  songloft.log.info('歌曲库 Plus 已停止');
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  try {
    return await router.handle(req);
  } catch (error) {
    songloft.log.error(`请求失败: ${String((error as Error).message || error)}`);
    return jsonResponse({ error: String((error as Error).message || error) }, 500);
  }
}

globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;
