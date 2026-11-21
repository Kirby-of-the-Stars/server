// Run with Node >=18: node --test test/provider-regression.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, wrap } = require('node:module');
const { Readable } = require('node:stream');
const crypto = require('../src/crypto');
const select = require('../src/provider/select');
const logger = {
	debug() {},
	info() {},
	warn() {},
	error(error) {
		throw error;
	},
};
const cache = {
	getManagedCacheStorage: () => ({
		cache: (key, load) => Promise.resolve().then(load),
	}),
};
const response = (data) => ({ statusCode: 200, json: async () => data });
function load(file, mocks = {}, env = {}) {
	const filename = path.resolve(__dirname, '..', file);
	const realRequire = createRequire(filename);
	const module = { exports: {} };
	const context = vm.createContext({
		Buffer,
		URL,
		URLSearchParams,
		console,
		setTimeout,
		clearTimeout,
		process: { env },
		global: {},
	});
	const fn = vm.runInContext(
		wrap(fs.readFileSync(filename, 'utf8')),
		context,
		{ filename }
	);
	fn(
		module.exports,
		(id) => {
			if (id.endsWith('/logger')) return { logScope: () => logger };
			if (id.endsWith('/cache')) return cache;
			if (id === './insure')
				return () => ({
					bilibili: {
						track: async () => {
							throw new Error('Bilibili request failed');
						},
					},
				});
			return Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id);
		},
		module,
		filename,
		path.dirname(filename)
	);
	return module.exports;
}

test('matching rejects different artists, versions and durations; chooses closest match', () => {
	const info = {
		name: 'Song',
		duration: 180000,
		artists: [{ name: 'Artist' }],
	};
	const base = {
		name: 'Song',
		duration: 180000,
		artists: [{ name: 'Artist' }],
	};
	assert.equal(
		select([{ ...base, artists: [{ name: 'Someone else' }] }], info),
		undefined
	);
	assert.equal(select([{ ...base, name: 'Song (Live)' }], info), undefined);
	assert.equal(select([{ ...base, duration: 200000 }], info), undefined);
	assert.equal(select([{ ...base, name: 'Other song' }], info), undefined);
	const closer = { ...base, duration: 180500 };
	assert.equal(select([{ ...base, duration: 184000 }, closer], info), closer);
	assert.equal(
		select([{ name: 'Artist - Song', duration: 180000 }], info).duration,
		180000
	);
});

test('exact title and performer tolerate inaccurate imported track durations without accepting videos or wrong versions', () => {
	const info = {
		name: '你听得到',
		duration: 239647,
		artists: [{ name: '周杰伦' }],
	};
	const original = {
		name: '你听得到',
		duration: 230000,
		artists: [{ name: '周杰伦' }],
	};
	assert.equal(select([original], info), original);
	assert.equal(
		select([{ ...original, artists: [{ name: '翻唱歌手' }] }], info),
		undefined
	);
	assert.equal(
		select([{ ...original, name: '你听得到 (Live)' }], info),
		undefined
	);
	assert.equal(select([{ ...original, duration: 190000 }], info), undefined);
	assert.equal(
		select([{ name: '你听得到', duration: 230000 }], info),
		undefined
	);
});

test('QQ uses JMusicKook search/detail and batches media MID vkeys', async () => {
	const calls = [];
	const qq = load(
		'src/provider/qq.js',
		{
			'../request': async (method, url, headers, payload) => {
				calls.push(url);
				assert.ok(!headers.cookie.includes('refresh_token'));
				assert.ok(headers.cookie.includes('qm_keyst=key=='));
				assert.ok(headers['user-agent']);
				if (url.includes('/search_for_qq_cp')) {
					assert.equal(method, 'GET');
					assert.equal(
						new URL(url).searchParams.get('w'),
						'Song Artist'
					);
					return response({
						code: 0,
						data: {
							song: {
								list: [
									{
										songmid: 'song',
										songname: 'Song',
										interval: 180,
										albummid: 'a',
										albumname: 'A',
										singer: [{ mid: 's', name: 'Artist' }],
									},
								],
							},
						},
					});
				}
				if (url.includes('/fcg_play_single_song.fcg')) {
					assert.equal(
						new URL(url).searchParams.get('songmid'),
						'song'
					);
					return response({
						code: 0,
						data: [{ file: { media_mid: 'media' } }],
					});
				}
				assert.equal(method, 'POST');
				const body = JSON.parse(payload);
				assert.equal(body.req_1.module, 'music.vkey.GetVkey');
				assert.equal(body.req_1.method, 'UrlGetVkey');
				assert.deepEqual(body.req_1.param.filename, [
					'M800mediamedia.mp3',
					'M500mediamedia.mp3',
				]);
				assert.equal(body.req_1.param.uin, '123');
				return response({
					code: 0,
					req_1: {
						code: 0,
						data: {
							midurlinfo: [{ purl: 'song.mp3' }],
						},
					},
				});
			},
		},
		{ QQ_COOKIE: 'musicid=123; musickey=key==; refresh_token=secret' }
	);
	assert.equal(
		await qq.check({
			name: 'Song',
			keyword: 'Song - Artist',
			duration: 180000,
			artists: [{ name: 'Artist' }],
		}),
		'https://ws.stream.qqmusic.qq.com/song.mp3'
	);
	assert.equal(
		Object.keys(qq.getMediaHeaders('https://example.com/')).length,
		0
	);
	assert.equal(
		Object.keys(qq.getMediaHeaders('http://ws.stream.qqmusic.qq.com/'))
			.length,
		0
	);
	assert.equal(calls.length, 3);
});

test('QQ and WeChat refresh use reference parameters, rotate credentials and share in-flight work', async () => {
	for (const type of [1, 2]) {
		let refreshes = 0;
		const env = {
			QQ_COOKIE: `musicid=123; musickey=${type === 1 ? 'W_Xold' : 'old'}; openid=openid; refresh_token=refresh; access_token=access; refresh_key=refreshKey; unionid=union; expired_at=900; musickey_create_time=1`,
		};
		const qq = load(
			'src/provider/qq.js',
			{
				'../request': async (method, url, headers, payload) => {
					const body = JSON.parse(payload);
					if (body.req_0) {
						refreshes++;
						assert.equal(body.comm.tmeLoginType, type);
						assert.equal(
							body.comm.g_tk,
							body.comm.g_tk_new_20200303
						);
						assert.ok(body.comm.g_tk > 0);
						assert.equal(
							body.req_0.param.refresh_key,
							'refreshKey'
						);
						assert.equal(body.req_0.param.loginMode, 2);
						if (type === 1) {
							assert.equal(body.req_0.param.str_musicid, '123');
							assert.equal(body.req_0.param.unionid, 'union');
							assert.equal(body.req_0.param.musicid, undefined);
						} else {
							assert.equal(body.req_0.param.musicid, 123);
							assert.equal(
								body.req_0.param.access_token,
								'access'
							);
							assert.equal(body.req_0.param.expired_in, 900);
							assert.equal(
								body.req_0.param.str_musicid,
								undefined
							);
						}
						await new Promise((resolve) => setTimeout(resolve, 10));
						return response({
							code: 0,
							req_0: {
								code: 0,
								data: {
									musickey: 'fresh',
									refresh_token: 'rotated',
									refresh_key: 'newKey',
									expired_in: 1200,
								},
							},
						});
					}
					assert.ok(headers.cookie.includes('qm_keyst=fresh'));
					assert.ok(!headers.cookie.includes('refresh_token'));
					return response({
						code: 0,
						req_1: {
							code: 0,
							data: {
								midurlinfo: [{ purl: 'song.mp3' }],
							},
						},
					});
				},
			},
			env
		);
		await Promise.all([
			qq.track({ song: 'a', file: 'fileA' }),
			qq.track({ song: 'b', file: 'fileB' }),
		]);
		assert.equal(refreshes, 1);
		assert.ok(env.NEW_QQ_COOKIE.includes('refresh_token=rotated'));
		assert.ok(env.NEW_QQ_COOKIE.includes('expired_at=1200'));
	}
});

test('QQ uses song MID if detail is unavailable and retains 64-bit IDs on the wire', async () => {
	const qq = load(
		'src/provider/qq.js',
		{
			'../request': async (method, url, headers, payload) => {
				if (method === 'GET') throw new Error('Detail unavailable');
				assert.ok(payload.includes('"uin":9007199254740993'));
				const body = JSON.parse(payload);
				assert.equal(body.req_1.param.uin, '9007199254740993');
				assert.equal(
					body.req_1.param.filename[0],
					'M800songIdsongId.mp3'
				);
				return response({
					code: 0,
					req_1: {
						code: 0,
						data: {
							midurlinfo: [
								{
									purl: 'https://ws.stream.qqmusic.qq.com/audio.mp3',
								},
							],
						},
					},
				});
			},
		},
		{ QQ_COOKIE: 'musicid=9007199254740993; musickey=test' }
	);
	assert.equal(
		await qq.track({ song: 'songId' }),
		'https://ws.stream.qqmusic.qq.com/audio.mp3'
	);
});

test('Bilibili matches duration and chooses highest bandwidth backup URL with configured login', async () => {
	const bili = load(
		'src/provider/bilivideo.js',
		{
			'../request': async (method, url, headers) => {
				assert.equal(headers.cookie, 'SESSDATA=test');
				if (url.endsWith('/nav'))
					return response({
						data: {
							wbi_img: {
								img_url: `https://example.com/${'a'.repeat(64)}.png`,
								sub_url: `https://example.com/${'b'.repeat(64)}.png`,
							},
						},
					});
				if (url.includes('/search/type?'))
					return response({
						data: {
							result: [
								{
									bvid: 'wrong',
									title: 'Song',
									duration: '0:20',
								},
								{
									bvid: 'correct',
									title: '<em>Song</em>',
									duration: '3:00',
								},
							],
						},
					});
				if (url.includes('/view?')) {
					assert.ok(url.includes('bvid=correct'));
					return response({ code: 0, data: { cid: 123 } });
				}
				return response({
					code: 0,
					data: {
						dash: {
							audio: [
								{
									base_url: 'https://example.com/low.m4s',
									bandwidth: 64000,
								},
								{
									backupUrl: ['https://example.com/high.m4s'],
									bandwidth: 192000,
								},
							],
						},
					},
				});
			},
		},
		{ BILIBILI_COOKIE: 'SESSDATA=test' }
	);
	assert.equal(
		await bili.check({ name: 'Song', duration: 180000, keyword: 'Song' }),
		'https://example.com/high.m4s'
	);
});

test('media probe supports ignored Range, detects AAC container and uses provider headers', async () => {
	const bytes = Buffer.alloc(32000);
	bytes.write('ftyp', 4);
	let stream;
	const match = load('src/provider/match.js', {
		'./find': async () => ({ id: 1, name: 'Song', duration: 180000 }),
		'../consts': {
			DEFAULT_SOURCE: ['qq'],
			PROVIDERS: {
				qq: {
					check: async () =>
						'https://ws.stream.qqmusic.qq.com/song.m4a',
					getMediaHeaders: () => ({ cookie: 'qm_keyst=test' }),
				},
			},
		},
		'../request': async (method, url, headers) => {
			assert.equal(headers.cookie, 'qm_keyst=test');
			stream = Readable.from([bytes]);
			stream.statusCode = 200;
			stream.url = new URL(url);
			stream.headers = {
				'content-length': String(bytes.length),
				'content-type': 'audio/mp4',
			};
			return stream;
		},
	});
	const song = await match(1);
	assert.equal(song.type, 'm4a');
	assert.equal(song.size, 32000);
	assert.equal(song.duration, 180000);
	assert.ok(stream.destroyed);
});

test('hook reports M4A/AAC and forwards QQ credentials only to QQ media', async () => {
	const hook = load('src/hook.js', {
		'./provider/match': async () => ({
			url: 'https://example.com/a.m4a',
			type: 'm4a',
			size: 12000,
			br: 192000,
		}),
		'./provider/qq': {
			getMediaHeaders: (url) =>
				url.includes('.qq.com/') ? { cookie: 'qm_keyst=playback' } : {},
		},
		'./request': { read: async (res) => res.body },
	});
	const ctx = {
		req: {
			headers: {},
			url: 'https://music.163.com/api/song/enhance/player/url',
		},
		netease: {
			path: '/api/song/enhance/player/url',
			param: { ids: '[1]' },
		},
		proxyRes: {
			statusCode: 200,
			headers: {},
			body: Buffer.from(
				JSON.stringify({
					code: 200,
					data: [{ id: 1, code: 404, url: null }],
				})
			),
		},
	};
	await hook.request.after(ctx);
	const item = JSON.parse(ctx.proxyRes.body).data[0];
	assert.equal(item.type, 'm4a');
	assert.equal(item.encodeType, 'aac');
	for (const target of [
		'https://ws.stream.qqmusic.qq.com/a.mp3',
		'https://example.com/a.mp3',
	]) {
		const req = {
			method: 'GET',
			url: `http://localhost/package/${crypto.base64.encode(target)}/1.mp3`,
			headers: {
				host: 'localhost',
				cookie: 'netease=secret',
				authorization: 'secret',
			},
		};
		hook.request.before({ req });
		assert.equal(req.headers.authorization, undefined);
		assert.equal(
			req.headers.cookie,
			target.includes('.qq.com/') ? 'qm_keyst=playback' : undefined
		);
	}
});

test('media probe accepts a short FLAC range and preserves the resource size', async () => {
	const bytes = Buffer.alloc(300);
	bytes.write('fLaC');
	const match = load('src/provider/match.js', {
		'./find': async () => ({ id: 1, name: 'Song', duration: 180000 }),
		'../consts': {
			DEFAULT_SOURCE: ['test'],
			PROVIDERS: {
				test: { check: async () => 'https://example.com/song.flac' },
			},
		},
		'../request': async (method, url) =>
			Object.assign(Readable.from([bytes]), {
				statusCode: 206,
				url: new URL(url),
				headers: {
					'content-length': '300',
					'content-range': 'bytes 0-299/1000000',
				},
			}),
	});
	const song = await match(1);
	assert.equal(song.type, 'flac');
	assert.equal(song.br, 999000);
	assert.equal(song.size, 1000000);
});

test('cross-host media redirects remove authentication headers', async () => {
	const { EventEmitter } = require('node:events');
	const calls = [];
	const fakeHttp = {
		request(options) {
			calls.push(options.headers);
			const client = new EventEmitter();
			client.setTimeout = () => client;
			client.end = () =>
				queueMicrotask(() =>
					client.emit(
						'response',
						calls.length === 1
							? {
									statusCode: 302,
									headers: {
										location:
											'https://other.example.com/audio',
									},
								}
							: { statusCode: 206, headers: {} }
					)
				);
			return client;
		},
	};
	const request = load('src/request.js', { http: fakeHttp, https: fakeHttp });
	await request('GET', 'https://ws.stream.qqmusic.qq.com/audio', {
		Cookie: 'secret',
		Authorization: 'secret',
	});
	assert.equal(calls[1].Cookie, undefined);
	assert.equal(calls[1].Authorization, undefined);
});

test('Kuwo finds relocated song pages and grouped versions, preserving signed URL parameters', async () => {
	const media =
		'http://kw-er.kuwo.cn/song.mp3?bitrate$320&format$mp3&loginUid$';
	const kuwo = load('src/provider/kuwo.js', {
		'../request': async (method, url) => {
			if (url.includes('search.kuwo.cn'))
				return response({
					content: [
						{
							musicpage: {
								abslist: [
									{
										MUSICRID: 'MUSIC_1',
										SONGNAME: 'Song (Live)',
										DURATION: '180',
										ARTIST: 'Artist',
										SUBLIST: [
											{
												MUSICRID: 'MUSIC_2',
												SONGNAME: 'Song',
												DURATION: '180',
												ARTIST: 'Artist',
											},
										],
									},
								],
							},
						},
					],
				});
			return {
				statusCode: 200,
				body: async () => `format=mp3\r\nurl=${media}\r\nsig=123`,
			};
		},
		'../crypto': {
			kuwoapi: {
				encryptQuery: (query) => {
					assert.ok(query.includes('rid=2'));
					assert.ok(query.includes('format=mp3'));
					return 'encrypted';
				},
			},
		},
	});
	assert.equal(
		await kuwo.check({
			name: 'Song',
			keyword: 'Song - Artist',
			duration: 180000,
			artists: [{ name: 'Artist' }],
		}),
		media
	);
});

test('Kuwo requests FLAC when enabled and reports upstream failures', async () => {
	const media = 'http://kw-er.kuwo.cn/song.flac?bitrate$2000&format$flac';
	let fail = false;
	const selector = (list, info) => select(list, info);
	selector.ENABLE_FLAC = true;
	const kuwo = load('src/provider/kuwo.js', {
		'./select': selector,
		'../crypto': {
			kuwoapi: {
				encryptQuery: (query) => {
					assert.ok(query.includes('format=flac|mp3'));
					return 'encrypted';
				},
			},
		},
		'../request': async () => ({
			statusCode: fail ? 503 : 200,
			body: async () => `url=${media}\r\n`,
		}),
	});
	assert.equal(await kuwo.track('123'), media);
	fail = true;
	await assert.rejects(kuwo.track('123'), /Kuwo URL HTTP 503 for 123/);
});

test('QQ keeps FLAC priority, falls back to MP3 and retries after credential refresh', async () => {
	let attempts = 0;
	let refreshed = false;
	const selector = (list, info) => select(list, info);
	selector.ENABLE_FLAC = true;
	const qq = load(
		'src/provider/qq.js',
		{
			'./select': selector,
			'../request': async (method, url, headers, payload) => {
				const body = JSON.parse(payload);
				if (body.req_0) {
					refreshed = true;
					return response({
						code: 0,
						req_0: { code: 0, data: { musickey: 'refreshed' } },
					});
				}
				attempts++;
				assert.deepEqual(body.req_1.param.filename, [
					'F000mediamedia.flac',
					'M800mediamedia.mp3',
					'M500mediamedia.mp3',
				]);
				return response({
					code: 0,
					req_1: {
						code: 0,
						data: {
							midurlinfo: refreshed
								? [
										{ purl: '' },
										{ purl: 'M800song.mp3' },
										{ purl: 'M500song.mp3' },
									]
								: [{ purl: '' }, { purl: '' }, { purl: '' }],
						},
					},
				});
			},
		},
		{
			QQ_COOKIE:
				'musicid=123; musickey=old; openid=id; refresh_token=refresh; access_token=access',
		}
	);
	assert.equal(
		await qq.track({ song: 'song', file: 'media' }),
		'https://ws.stream.qqmusic.qq.com/M800song.mp3'
	);
	assert.equal(attempts, 2);
});

test('QQ anonymous playback sends no fabricated login cookie and reports an unavailable track', async () => {
	const qq = load('src/provider/qq.js', {
		'../request': async (method, url, headers) => {
			assert.equal(headers.cookie, undefined);
			return response({
				code: 0,
				req_1: { code: 0, data: { midurlinfo: [{ purl: '' }] } },
			});
		},
	});
	await assert.rejects(
		qq.track({ song: 'song', file: 'media' }),
		/QQ has no playable URL for song/
	);
});

test('Migu modern search, binary response and login produce full audio; previews are rejected', async () => {
	let preview = false;
	const secure = Buffer.from('Jk8qzuePiJ1qE3mDYhLQ3T73DtDoAhLP');
	const migu = load(
		'src/provider/migu.js',
		{
			'../request': async (method, url, headers) => {
				assert.equal(headers.pacmtoken, 'login-token');
				if (url.includes('/bmw/search/song/')) {
					assert.equal(
						new URL(url).searchParams.get('text'),
						'Song Artist'
					);
					return response({
						code: '000000',
						data: {
							items: [
								{
									song: {
										contentId: 'content',
										copyrightId: 'copyright',
										songName: 'Song',
										duration: 180,
										singerList: [{ name: 'Artist' }],
										album: 'Album',
										albumId: 'a',
									},
								},
							],
						},
					});
				}
				const target = new URL(url);
				assert.ok(url.includes('/strategy/pc/listen/v2.0'));
				assert.equal(target.searchParams.get('contentId'), 'content');
				assert.equal(
					target.searchParams.get('copyrightId'),
					'copyright'
				);
				assert.equal(headers.signature, '1');
				const data = Buffer.from(
					JSON.stringify({
						code: '000000',
						data: {
							url: 'https://example.com/full.mp3',
							...(preview && { auditionsLength: 60 }),
						},
					})
				);
				const encrypted = Buffer.alloc(data.length + 4);
				encrypted.set([0xab, 0xcd, 1, 43]);
				for (let i = 0; i < data.length; i++)
					encrypted[i + 4] = data[i] - 43 + secure[i % secure.length];
				return {
					statusCode: 200,
					body: async (raw) => {
						assert.equal(raw, true);
						return encrypted;
					},
				};
			},
		},
		{ MIGU_PACMTOKEN: 'login-token' }
	);
	assert.equal(
		await migu.check({
			name: 'Song',
			keyword: 'Song - Artist',
			duration: 180000,
			artists: [{ name: 'Artist' }],
		}),
		'https://example.com/full.mp3'
	);
	preview = true;
	await assert.rejects(
		migu.track({ contentId: 'content', copyrightId: 'copyright' }),
		(e) => e.errors.every((x) => x.message.includes('preview'))
	);
});

test('Bodian reuses Kuwo matching and signs the playback request', async () => {
	let calls = 0;
	const bodian = load('src/provider/bodian.js', {
		'./kuwo': { search: async () => '123' },
		'../request': async (method, url, headers, payload) => {
			calls++;
			const target = new URL(url);
			if (method === 'POST') {
				assert.equal(JSON.parse(payload).type, 5);
				return { body: async () => '{}' };
			}
			const timestamp = Number(target.searchParams.get('timestamp'));
			assert.ok(Math.abs(Date.now() - timestamp) < 10000);
			const params = target.search.slice(1).split('&sign=')[0];
			const expected = crypto.md5.digest(
				'kuwotest' +
					params
						.replace(/[^a-zA-Z0-9]/g, '')
						.split('')
						.sort()
						.join('') +
					target.pathname
			);
			assert.equal(target.searchParams.get('sign'), expected);
			assert.equal(target.searchParams.get('musicId'), '123');
			assert.equal(target.searchParams.get('br'), '320kmp3');
			return response({
				code: 200,
				data: { audioUrl: 'https://example.com/bodian.mp3' },
			});
		},
	});
	assert.equal(await bodian.check({}), 'https://example.com/bodian.mp3');
	assert.equal(calls, 2);
});

test('Kugou signed gateway requests include login and device identity, and prefer high quality', async () => {
	const seen = [];
	const credential =
		'token=login-token; userid=123; dfid=device; KUGOU_API_MID=456; appid=1005';
	const kugou = load(
		'src/provider/kugou.js',
		{
			'../request': async (method, url, headers) => {
				const target = new URL(url),
					params = Object.fromEntries(target.searchParams);
				seen.push(target.pathname);
				assert.equal(params.token, 'login-token');
				assert.equal(params.userid, '123');
				assert.equal(params.mid, '456');
				assert.equal(params.dfid, 'device');
				const signature = params.signature;
				delete params.signature;
				const salt = 'OIlwieks28dk2k092lksi2UIkp';
				assert.equal(
					signature,
					crypto.md5.digest(
						salt +
							Object.keys(params)
								.sort()
								.map((k) => `${k}=${params[k]}`)
								.join('') +
							salt
					)
				);
				if (target.pathname === '/v2/search/song') {
					assert.equal(
						headers['x-router'],
						'complexsearch.kugou.com'
					);
					return response({
						status: 1,
						error_code: 0,
						data: {
							lists: [
								{
									FileHash: 'NORMAL',
									HQFileHash: 'HIGH',
									SongName: 'Song',
									Duration: 180,
									AlbumID: '1',
									AlbumName: 'Album',
									MixSongID: '2',
									Singers: [{ name: 'Artist' }],
								},
							],
						},
					});
				}
				assert.equal(headers['x-router'], 'trackercdn.kugou.com');
				assert.equal(params.IsFreePart, '0');
				assert.equal(params.album_audio_id, '2');
				assert.equal(
					params.key,
					crypto.md5.digest(
						params.hash +
							'57ae12eb6890223e355ccfcb74edf70d' +
							'1005' +
							'456' +
							'123'
					)
				);
				return response({
					status: 1,
					url: [`https://example.com/${params.quality}.mp3`],
				});
			},
		},
		{ KUGOU_COOKIE: credential }
	);
	assert.equal(
		await kugou.check({
			name: 'Song',
			keyword: 'Song Artist',
			duration: 180000,
			artists: [{ name: 'Artist' }],
		}),
		'https://example.com/320.mp3'
	);
	assert.equal(seen.filter((x) => x === '/v5/url').length, 2);
});

test('Kugou lite credentials select their matching signing keys and reject unavailable audio', async () => {
	const kugou = load(
		'src/provider/kugou.js',
		{
			'../request': async (method, url) => {
				const target = new URL(url),
					params = Object.fromEntries(target.searchParams);
				assert.equal(params.appid, '3116');
				assert.equal(params.pid, '411');
				assert.equal(
					params.key,
					crypto.md5.digest(
						params.hash +
							'185672dd44712f60bb1736df5a377e82' +
							'3116' +
							'456' +
							'123'
					)
				);
				const signature = params.signature;
				delete params.signature;
				const salt = 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA';
				assert.equal(
					signature,
					crypto.md5.digest(
						salt +
							Object.keys(params)
								.sort()
								.map((k) => `${k}=${params[k]}`)
								.join('') +
							salt
					)
				);
				return response({ status: 2 });
			},
		},
		{
			KUGOU_COOKIE:
				'token=t; userid=123; KUGOU_API_MID=456; KUGOU_API_PLATFORM=lite',
		}
	);
	await assert.rejects(
		kugou.track({
			id: 'normal',
			id_hq: 'high',
			audioId: 2,
			album: { id: 1 },
		}),
		(e) => e.errors.every((x) => x.message.includes('status=2'))
	);
});

test('only the six retained providers are registered and enabled by default', () => {
	const names = ['qq', 'kuwo', 'kugou', 'migu', 'bodian', 'bilivideo'];
	const mocks = Object.fromEntries(
		names.map((name) => [`./provider/${name}`, { check() {} }])
	);
	const constants = load('src/consts.js', mocks);
	assert.deepEqual(Array.from(constants.DEFAULT_SOURCE), names);
	assert.deepEqual(Object.keys(constants.PROVIDERS), names);
});
