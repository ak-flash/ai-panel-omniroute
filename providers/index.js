const { createXKiroProvider } = require('./xkiro');
const FACTORIES = { xkiro: createXKiroProvider };
function loadProviders(){ return [FACTORIES.xkiro({})]; }
module.exports = { loadProviders, FACTORIES };
