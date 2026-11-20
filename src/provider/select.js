const normalize = (value) =>
	(value || '')
		.normalize('NFKC')
		.toLowerCase()
		.replace(/<[^>]*>/g, '')
		.replace(/[^\p{L}\p{N}]/gu, '');
const variants =
	/\blive\b|\bremix\b|伴奏|翻唱|现场|加速|慢速|\binstrumental\b|\bcover\b/gi;
const version = (name) =>
	(name.toLowerCase().match(variants) || []).sort().join(',');

module.exports = (list, info) => {
	const name = normalize(info.name);
	const artists = (info.artists || [])
		.map((artist) => normalize(artist.name))
		.filter(Boolean);
	const candidates = list.filter((song) => {
		const title = normalize(song.name);
		if (
			name &&
			(Array.isArray(song.artists)
				? title !== name
				: !title.includes(name))
		)
			return false;
		if (info.name && version(song.name || '') !== version(info.name))
			return false;
		if (
			info.duration &&
			song.duration &&
			Math.abs(song.duration - info.duration) > 5000
		)
			return false;
		if (artists.length && song.artists?.length) {
			return song.artists.some((artist) =>
				artists.includes(normalize(artist.name))
			);
		}
		return true;
	});
	return candidates.sort((a, b) => {
		const distance = (song) =>
			info.duration && song.duration
				? Math.abs(song.duration - info.duration)
				: Infinity;
		return distance(a) - distance(b);
	})[0];
};

module.exports.ENABLE_FLAC =
	(process.env.ENABLE_FLAC || '').toLowerCase() === 'true';
