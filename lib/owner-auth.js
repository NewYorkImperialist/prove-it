"use strict";
// Gate for every /admin* route — checked against the OWNER_KEY secret (a Fly secret, never in the repo).
function ownerOk(req) { const key = req.query.key || req.get("x-owner-key"); return process.env.OWNER_KEY && key === process.env.OWNER_KEY; }

module.exports = { ownerOk };
