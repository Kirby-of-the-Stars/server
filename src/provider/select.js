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
		const artistMatched =
			artists.length > 0 &&
			Array.isArray(song.artists) &&
			song.artists.some((artist) =>
				artists.includes(normalize(artist.name))
			);
		if (artists.length && song.artists?.length && !artistMatched)
			return false;
		// Imported/orphan Netease entries can have inaccurate durations. A
		// matching title AND performer permit 5% drift; videos stay within 5s.
		const tolerance =
			title === name && artistMatched
				? Math.max(5000, info.duration * 0.05)
				: 5000;
		if (
			info.duration &&
			song.duration &&
			Math.abs(song.duration - info.duration) > tolerance
		)
			return false;
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
