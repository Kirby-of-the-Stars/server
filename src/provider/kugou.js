// Protocol adapted from MakcRe/KuGouMusicApi (MIT); see THIRD_PARTY_NOTICES.md.
const select = require('./select');
const crypto = require('../crypto');
const request = require('../request');
const { cookieToMap } = require('../utilities');
const { getManagedCacheStorage } = require('../cache');

const credential = cookieToMap(process.env.KUGOU_COOKIE || '');
const lite = credential.KUGOU_API_PLATFORM === 'lite';
const appid = Number(credential.appid) || (lite ? 3116 : 1005);
const mid =
	credential.KUGOU_API_MID ||
	credential.mid ||
	BigInt(
		'0x' +
			crypto.md5.digest(credential.KUGOU_API_GUID || crypto.random.uuid())
	).toString();
const salt = lite
	? 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA'
	: 'OIlwieks28dk2k092lksi2UIkp';

const call = async (path, values, router, key = false) => {
	const params = {
		dfid: credential.dfid || '-',
		mid,
		uuid: '-',
		appid,
		clientver: lite ? 11440 : 20489,
		clienttime: Math.floor(Date.now() / 1000),
		...(credential.token && { token: credential.token }),
		...(credential.userid && { userid: credential.userid }),
		...values,
	};
	if (key)
		params.key = crypto.md5.digest(
			params.hash +
				(lite
					? '185672dd44712f60bb1736df5a377e82'
					: '57ae12eb6890223e355ccfcb74edf70d') +
				appid +
				mid +
				(credential.userid || 0)
		);
	params.signature = crypto.md5.digest(
		salt +
			Object.keys(params)
				.sort()
				.map((name) => `${name}=${params[name]}`)
				.join('') +
			salt
	);
	const response = await request(
		'GET',
		'https://gateway.kugou.com' + path + '?' + new URLSearchParams(params),
		{
			'user-agent':
				'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
			'x-router': router,
			dfid: params.dfid,
			mid,
			clienttime: String(params.clienttime),
			'kg-rc': '1',
			'kg-thash': '5d816a0',
			'kg-rec': '1',
			'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
		}
	);
	if (response.statusCode !== 200)
		throw new Error(`Kugou ${path} HTTP ${response.statusCode}`);
	const body = await response.json();
	if (body.status === 0 || body.error_code)
		throw new Error(
			`Kugou ${path} failed: ${body.error_code || body.status}`
		);
	return body;
};

const search = async (info) => {
	const body = await call(
		'/v2/search/song',
		{
			keyword: info.keyword.replace(' - ', ' '),
			page: 1,
			pagesize: 20,
			platform: 'AndroidFilter',
			iscorrection: 1,
			privilegefilter: 0,
			area_code: 1,
			dopicfull: 1,
			...(lite && { clientver: 201 }),
		},
		'complexsearch.kugou.com'
	);
	const songs = (body.data?.lists || []).map((song) => ({
		id: song.FileHash,
		id_hq: song.HQFileHash,
		id_sq: song.SQFileHash,
		audioId: song.MixSongID,
		name: song.SongName,
		duration: song.Duration * 1000,
		album: { id: song.AlbumID, name: song.AlbumName },
		artists:
			song.Singers ||
			song.SingerName.split('、').map((name) => ({ name })),
	}));
	const matched = select(songs, info);
	if (!matched) throw new Error('Kugou search has no matching song');
	return matched;
};

const single = async (song, quality, hash) => {
	if (!hash) throw new Error(`Kugou has no ${quality} hash`);
	const body = await call(
		'/v5/url',
		{
			hash: hash.toLowerCase(),
			quality,
			album_id: Number(song.album.id) || 0,
			album_audio_id: Number(song.audioId) || 0,
			area_code: 1,
			ssa_flag: 'is_fromtrack',
			version: 11430,
			page_id: lite ? 967177915 : 151369488,
			ppage_id: lite
				? '356753938,823673182,967485191'
				: '463467626,350369493,788954147',
			behavior: 'play',
			pid: lite ? 411 : 2,
			cmd: 26,
			pidversion: 3001,
			IsFreePart: 0,
			cdnBackup: 1,
			module: '',
			clientver: 11430,
		},
		'trackercdn.kugou.com',
		true
	);
	const url = body.url?.[0];
	if (!url)
		throw new Error(
			`Kugou ${quality} returned no full audio (status=${body.status}); check KUGOU_COOKIE login and membership`
		);
	// Some responses explicitly mark a preview or an encrypted track.
	if (body.is_free_part || body.isFreePart || body.encrypt_type)
		throw new Error(`Kugou ${quality} returned preview or encrypted audio`);
	return url;
};

const track = async (song) => {
	const qualities = [
		['flac', song.id_sq],
		[320, song.id_hq],
		[128, song.id],
	].slice(select.ENABLE_FLAC ? 0 : 1);
	const results = await Promise.allSettled(
		qualities.map(([quality, hash]) => single(song, quality, hash))
	);
	const playable = results.find((result) => result.status === 'fulfilled');
	if (playable) return playable.value;
	throw new AggregateError(
		results.map((result) => result.reason),
		`Kugou has no playable audio for ${song.id}`
	);
};
const cs = getManagedCacheStorage('provider/kugou');
const check = (info) => cs.cache(info, () => search(info)).then(track);
module.exports = { check, search, track };
