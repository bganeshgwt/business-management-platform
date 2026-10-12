// Every business type other than the kirana and the supermarket (grocery.js).
const { books } = require('./books');
const { pharmacy, clinic } = require('./health');
const { meat, dryfruits } = require('./weight');
const { fashion } = require('./fashion');
const { electronics } = require('./electronics');
const { salon } = require('./salon');
const { wholesale } = require('./wholesale');

module.exports = { all: [wholesale, fashion, electronics, salon, meat, dryfruits, books, pharmacy, clinic] };
