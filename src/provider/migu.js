// Protocol adapted from Domdkw/miguMusic-api-enhanced (MIT); see THIRD_PARTY_NOTICES.md.
const select = require('./select');
const request = require('../request');
const { getManagedCacheStorage } = require('../cache');
const { cookieToMap } = require('../utilities');
const crypto = require('../crypto');

const credential = cookieToMap(process.env.MIGU_COOKIE || '');
const pacmtoken = process.env.MIGU_PACMTOKEN || credential.pacmtoken || '';
const secure = Buffer.from('Jk8qzuePiJ1qE3mDYhLQ3T73DtDoAhLP');
const headers = {
	referer: 'https://music.migu.cn/',
	channel: '014X031',
	subchannel: '014X031',
	ua: 'Android_migu',
	version: '6.8.8',
	activityId: 'MUSIC-WWW',
	birth: 'h5page',
	...(pacmtoken && { pacmtoken }),
};

const search = async (info) => {
	const url =
		'https://app.c.nf.migu.cn/bmw/search/song/v1.0?' +
		new URLSearchParams({
			pageNo: '1',
			text: info.keyword.replace(' - ', ' '),
		});
	const response = await request('GET', url, headers);
	const body = await response.json();
	if (body.code !== '000000')
		throw new Error(`Migu search failed: ${body.code}`);
	const songs = (body.data?.items || [])
		.filter((item) => item.song)
		.map(({ song }) => ({
			id: { contentId: song.contentId, copyrightId: song.copyrightId },
			name: song.songName,
			duration: song.duration * 1000,
			album: { id: song.albumId, name: song.album },
			artists: song.singerList,
		}));
	const matched = select(songs, info);
	if (!matched) throw new Error('Migu search has no matching song');
	return matched.id;
};

const single = async (id, toneFlag) => {
	const url =
		'https://app.c.nf.migu.cn/strategy/pc/listen/v2.0?' +
		new URLSearchParams({
			contentId: id.contentId,
			copyrightId: id.copyrightId,
			scene: '',
			netType: '01',
			resourceType: '2',
			toneFlag,
		});
	const response = await request('GET', url, {
		...headers,
		signature: '1',
		deviceId: crypto.random.uuid(),
		timestamp: String(Date.now()),
	});
	if (response.statusCode !== 200)
		throw new Error(`Migu ${toneFlag} HTTP ${response.statusCode}`);
	const bytes = await response.body(true);
	let decoded = bytes;
	if (bytes[0] === 0xab && bytes[1] === 0xcd && bytes[2] === 1) {
		decoded = Buffer.alloc(bytes.length - 4);
		for (let index = 0; index < decoded.length; index++)
			decoded[index] =
				bytes[index + 4] + bytes[3] - secure[index % secure.length];
	}
	const body = JSON.parse(decoded.toString());
	const data = body.data;
	if (!data?.url)
		throw new Error(
			`Migu ${toneFlag} returned no audio: ${data?.cannotCode || body.code}; check MIGU_PACMTOKEN login and membership`
		);
	if (
		Number(data.auditionsLength) > 0 ||
		Number(data.auditionsFlag) > 0 ||
		data.auditionsTooltips?.includes('试听')
	) {
		throw new Error(
			`Migu ${toneFlag} returned a preview instead of the full track`
		);
	}
	return data.url;
};

const track = async (id) => {
	const results = await Promise.allSettled(
		['SQ', 'HQ', 'PQ']
			.slice(select.ENABLE_FLAC ? 0 : 1)
			.map((quality) => single(id, quality))
	);
	const playable = results.find((result) => result.status === 'fulfilled');
	if (playable) return playable.value;
	throw new AggregateError(
		results.map((result) => result.reason),
		`Migu has no playable audio for ${id.contentId}`
	);
};
const cs = getManagedCacheStorage('provider/migu');
const check = (info) => cs.cache(info, () => search(info)).then(track);
module.exports = { check, track };
