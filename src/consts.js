const DEFAULT_SOURCE = ['qq', 'kuwo', 'kugou', 'migu', 'bodian', 'bilivideo'];
const PROVIDERS = {
	qq: require('./provider/qq'),
	kuwo: require('./provider/kuwo'),
	kugou: require('./provider/kugou'),
	migu: require('./provider/migu'),
	bodian: require('./provider/bodian'),
	bilivideo: require('./provider/bilivideo'),
};

module.exports = { DEFAULT_SOURCE, PROVIDERS };
