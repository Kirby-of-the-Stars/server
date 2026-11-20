const insure = require('./insure');
const select = require('./select');
const crypto = require('../crypto');
const request = require('../request');
const { getManagedCacheStorage } = require('../cache');

const format = (song) => ({
	id: song.MUSICRID.split('_').pop(),
	name: song.SONGNAME,
	duration: song.DURATION * 1000,
	album: { id: song.ALBUMID, name: song.ALBUM },
	artists: song.ARTIST.split('&').map((name, index) => ({
		id: index ? null : song.ARTISTID,
		name,
	})),
});

const search = (info) => {
	const keyword = encodeURIComponent(info.keyword.replace(' - ', ' '));
	const url =
		'http://search.kuwo.cn/r.s?&correct=1&vipver=1&stype=comprehensive&encoding=utf8' +
		'&rformat=json&mobi=1&show_copyright_off=1&searchapi=6&all=' +
		keyword;

	return request('GET', url)
		.then((response) => response.json())
		.then((jsonBody) => {
			const page = jsonBody.content?.find(
				(section) => section.musicpage
			)?.musicpage;
			const songs = page?.abslist || [];
			const list = songs
				.flatMap((song) => [song, ...(song.SUBLIST || [])])
				.map(format);
			const matched = select(list, info);
			if (!matched) throw new Error('Kuwo search has no matching song');
			return matched.id;
		});
};

const track = (id) => {
	const url = crypto.kuwoapi
		? 'http://mobi.kuwo.cn/mobi.s?f=kuwo&q=' +
			crypto.kuwoapi.encryptQuery(
				'user=0&corp=kuwo&source=kwplayer_ar_5.1.0.0_B_jiakong_vh.apk&p2p=1&type=convert_url2&sig=0&format=' +
					['flac', 'mp3']
						.slice(select.ENABLE_FLAC ? 0 : 1)
						.join('|') +
					'&rid=' +
					id
			)
		: 'http://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid=MUSIC_' +
			id; // flac refuse

	return request('GET', url, { 'user-agent': 'okhttp/3.10.0' })
		.then((response) => {
			if (response.statusCode !== 200)
				throw new Error(
					`Kuwo URL HTTP ${response.statusCode} for ${id}`
				);
			return response.body();
		})
		.then((body) => {
			// '$' belongs to Kuwo's signed query string; do not truncate it.
			const url =
				body.match(/^url=(https?:\/\/[^\r\n]+)/m)?.[1] || body.trim();
			if (!/^https?:\/\/\S+$/.test(url))
				throw new Error(`Kuwo returned no audio URL for ${id}`);
			return url;
		})
		.catch((error) => {
			if (!global.cnrelay) throw error;
			return insure().kuwo.track(id);
		});
};

const cs = getManagedCacheStorage('provider/kuwo');
const check = (info) => cs.cache(info, () => search(info)).then(track);

module.exports = { check, track, search };
