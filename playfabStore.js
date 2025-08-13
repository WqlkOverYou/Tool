// playfabStore.js
// Minimal JSON persistence for pending approvals, audit history, and notes.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'data');
const FILE = path.join(DIR, 'playfab_store.json');

function ensureFile() {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    if (!fs.existsSync(FILE)) {
        fs.writeFileSync(FILE, JSON.stringify({ pending: {}, history: [] }, null, 2));
    }
}
function load() {
    ensureFile();
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch { return { pending: {}, history: [] }; }
}
function save(db) {
    ensureFile();
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

function newId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
    newId,

    // Pending approvals
    addPending(obj) { const db = load(); db.pending[obj.id] = obj; save(db); },
    getPending(id) { const db = load(); return db.pending[id] || null; },
    updatePending(obj) { const db = load(); if (db.pending[obj.id]) { db.pending[obj.id] = obj; save(db); } },
    removePending(id) { const db = load(); delete db.pending[id]; save(db); },
    listPendingByRequester(userId) {
        const db = load(); return Object.values(db.pending).filter(p => p.requestedBy === userId);
    },

    // History (bans, mutes, resets, notes)
    addHistory(entry) { const db = load(); db.history.push(entry); save(db); },
    historyForPlayFabId(pfid) {
        const db = load(); return db.history.filter(h => h.playFabId === pfid);
    },
};
