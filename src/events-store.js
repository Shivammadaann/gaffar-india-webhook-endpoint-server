const fs = require('fs');
const path = require('path');

const storePath = path.resolve(process.cwd(), 'events.json');

function loadEvents(maxItems) {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-maxItems);
  } catch (error) {
    return [];
  }
}

function saveEvents(events) {
  try {
    fs.writeFileSync(storePath, JSON.stringify(events, null, 2), 'utf8');
  } catch (error) {
    console.error('Unable to save events:', error.message);
  }
}

module.exports = {
  loadEvents,
  saveEvents,
};
