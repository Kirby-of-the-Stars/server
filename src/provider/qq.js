const select = require('./select');
const request = require('../request');
const { cookieToMap, mapToCookie } = require('../utilities');
const { getManagedCacheStorage } = require('../cache');
const { logScope } = require('../logger');

const logger = logScope('provider/qq');
const endpoint = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const userAgent =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const credential = cookieToMap(
	process.env.NEW_QQ_COOKIE || process.env.QQ_COOKIE || ''
);
const aliases = {
	musicid: ['uin'],
	musickey: ['qm_keyst', 'qqmusic_key'],
	refresh_token: ['psrf_qqrefresh_token', 'qqrefresh_token'],
	openid: ['psrf_qqopenid'],
	access_token: ['psrf_qqaccess_token'],
	expired_at: ['psrf_access_token_expiresAt'],
	unionid: ['psrf_qqunionid'],
	musickey_create_time: ['psrf_musickey_createtime'],
};
for (const [name, names] of Object.entries(aliases)) {
	if (!credential[name])
		credential[name] =
			names.map((key) => credential[key]).find(Boolean) || '';
}

// JMusicKook's playback request uses only these four browser aliases.
const getMediaHeaders = (url) => {
	const { hostname, protocol } = new URL(url);
	if (
		protocol !== 'https:' ||
		!(hostname === 'qq.com' || hostname.endsWith('.qq.com'))
	)
		return {};
	const musicid = credential.str_musicid || credential.musicid;
	const cookie = mapToCookie({
		...(musicid && { uin: musicid, qqmusic_uin: musicid }),
		...(credential.musickey && {
			qm_keyst: credential.musickey,
			qqmusic_key: credential.musickey,
		}),
	});
	return {
		'user-agent': userAgent,
		referer: 'https://y.qq.com/',
		...(cookie && { cookie }),
	};
};

const loginType = () =>
	Number(
		credential.tmeLoginType || credential.login_type || credential.loginType
	) || (credential.musickey.startsWith('W_X') ? 1 : 2);
const hash33 = (key) => {
	let hash = 5381;
	for (let index = 0; index < key.length; index++)
		hash = (hash * 33 + key.charCodeAt(index)) | 0;
	return hash & 0x7fffffff;
};
const call = async (name, module, method, param) => {
	const comm = {
		ct: 24,
		cv: 4747474,
		format: 'json',
		platform: 'yqq.json',
		inCharset: 'utf-8',
		outCharset: 'utf-8',
		needNewCode: 1,
		uin: credential.str_musicid || credential.musicid || '0',
	};
	if (method === 'Login')
		Object.assign(comm, {
			chid: 0,
			notice: 0,
			tmeLoginType: loginType(),
			g_tk: hash33(credential.musickey),
			g_tk_new_20200303: hash33(credential.musickey),
		});
	// Only comm.uin and Login.musicid are numeric; vkey.param.uin is a string.
	// Preserve 64-bit account IDs without rounding through a JS Number.
	const serializedComm = JSON.stringify(comm).replace(
		/"uin":"(\d+)"/,
		'"uin":$1'
	);
	const serializedRequest = JSON.stringify({
		[name]: { module, method, param },
	}).replace(/"musicid":"(\d+)"/, '"musicid":$1');
	const payload = `{"comm":${serializedComm},${serializedRequest.slice(1)}`;
	const response = await request(
		'POST',
		endpoint,
		{
			...getMediaHeaders(endpoint),
			'content-type': 'application/json',
		},
		payload
	);
	if (response.statusCode !== 200)
		throw new Error(`QQ ${method} HTTP ${response.statusCode}`);
	const body = await response.json();
	if (body.code !== 0 || body[name]?.code !== 0) {
		throw new Error(
			`QQ ${method} failed: ${body.code}/${body[name]?.code}`
		);
	}
	return body[name].data;
};

let refreshing;
let lastRefresh = 0;
const refresh = () => {
	if (refreshing) return refreshing;
	const type = loginType();
	if (
		!credential.openid ||
		!credential.refresh_token ||
		!credential.musickey ||
		!credential.musicid ||
		(type !== 1 && !credential.access_token) ||
		Date.now() - lastRefresh < 300000
	)
		return Promise.resolve(false);
	lastRefresh = Date.now();
	const param = {
		openid: credential.openid,
		refresh_token: credential.refresh_token,
		musickey: credential.musickey,
		refresh_key: credential.refresh_key || '',
		loginMode: 2,
	};
	if (type !== 2)
		Object.assign(param, {
			str_musicid: credential.str_musicid || credential.musicid,
			unionid: credential.unionid,
		});
	if (type !== 1)
		Object.assign(param, {
			access_token: credential.access_token,
			expired_in: Number(credential.expired_at) || 0,
			musicid: credential.musicid,
		});
	refreshing = call('req_0', 'music.login.LoginServer', 'Login', param)
		.then((data) => {
			if (!data.musickey)
				throw new Error('QQ refresh response has no musickey');
			for (const key of [
				'openid',
				'refresh_token',
				'access_token',
				'musicid',
				'musickey',
				'unionid',
				'str_musicid',
				'refresh_key',
				'tmeLoginType',
			]) {
				if (
					data[key] !== undefined &&
					data[key] !== null &&
					data[key] !== ''
				)
					credential[key] = String(data[key]);
			}
			credential.musickey_create_time = String(
				data.musickey_create_time ||
					data.musickeyCreateTime ||
					Math.floor(Date.now() / 1000)
			);
			credential.expired_at = String(
				data.expired_at ??
					data.expiredIn ??
					data.expired_in ??
					credential.expired_at
			);
			credential.login_type = String(
				data.login_type || data.loginType || type
			);
			process.env.NEW_QQ_COOKIE = mapToCookie({
				...credential,
				...cookieToMap(getMediaHeaders(endpoint).cookie),
			});
			return true;
		})
		.catch((error) => {
			logger.warn(error, 'QQ credential refresh failed.');
			return false;
		})
		.finally(() => {
			refreshing = undefined;
		});
	return refreshing;
};

const search = async (info) => {
	const url = new URL('https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp');
	url.search = new URLSearchParams({
		w: info.keyword.replace(' - ', ' '),
		format: 'json',
		p: '1',
		n: '10',
	});
	const response = await request('GET', url.href, getMediaHeaders(url.href));
	if (response.statusCode !== 200)
		throw new Error(`QQ search HTTP ${response.statusCode}`);
	const body = await response.json();
	if (body.code !== 0) throw new Error(`QQ search failed: ${body.code}`);
	const songs = (body.data?.song?.list || []).map((song) => ({
		id: {
			song: song.songmid || song.mid,
			file: song.file?.media_mid || song.file?.strMediaMid,
		},
		name: song.songname || song.name || song.title,
		duration: (song.interval ?? song.duration) * 1000,
		album: {
			id: song.album?.mid || song.albummid,
			name: song.album?.name || song.albumname,
		},
		artists: song.singer.map(({ mid, name }) => ({ id: mid, name })),
	}));
	const selected = select(songs, info);
	if (!selected) throw new Error('QQ search has no matching song');
	return selected.id;
};

const resolveMediaMid = async (id) => {
	if (id.file) return id.file;
	const url = `https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=${encodeURIComponent(id.song)}&format=json`;
	try {
		const response = await request('GET', url, getMediaHeaders(url));
		if (response.statusCode !== 200)
			throw new Error(`QQ detail HTTP ${response.statusCode}`);
		const body = await response.json();
		if (body.code !== 0 || !body.data?.length)
			throw new Error(`QQ detail failed: ${body.code}`);
		const file = body.data[0].file;
		return file?.media_mid || file?.strMediaMid || id.song;
	} catch (error) {
		logger.debug(
			error,
			`QQ detail unavailable for ${id.song}; using song MID.`
		);
		return id.song;
	}
};
const resolve = async (id, mediaMid) => {
	const formats = [
		['F000', '.flac'],
		['M800', '.mp3'],
		['M500', '.mp3'],
	].slice(select.ENABLE_FLAC ? 0 : 1);
	const data = await call('req_1', 'music.vkey.GetVkey', 'UrlGetVkey', {
		guid: '10000',
		loginflag: 1,
		platform: '20',
		uin: credential.str_musicid || credential.musicid || '0',
		songmid: formats.map(() => id.song),
		songtype: formats.map(() => 0),
		filename: formats.map(
			([prefix, suffix]) => `${prefix}${mediaMid}${mediaMid}${suffix}`
		),
	});
	const item = data.midurlinfo?.find((item) => item.purl);
	if (!item) return null;
	return new URL(item.purl, 'https://ws.stream.qqmusic.qq.com/').href;
};
const track = async (id) => {
	const created = Number(credential.musickey_create_time);
	if (created && Date.now() / 1000 - created > 258600) await refresh();
	let url = await resolve(id, await resolveMediaMid(id));
	if (!url && (await refresh()))
		url = await resolve(id, await resolveMediaMid(id));
	if (!url) throw new Error(`QQ has no playable URL for ${id.song}`);
	return url;
};
const cs = getManagedCacheStorage('provider/qq');
const check = async (info) => track(await cs.cache(info, () => search(info)));
module.exports = { check, track, getMediaHeaders };
