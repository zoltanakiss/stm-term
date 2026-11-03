'use strict';
// Every agent stm-term knows how to launch, recognize, resume, and import. Add one by adding a file.
const claude = require('./claude');
const codex = require('./codex');

const agents = { claude, codex };
const forProcess = (args) => Object.values(agents).find((a) => a.matches(args)) || null;
module.exports = { agents, forProcess };
