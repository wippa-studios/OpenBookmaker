'use strict';
// lib/seed.js — idempotent demo seeding (first run). Creates sports,
// competitions, events with markets/fair prices, and the demo users
// (admin, customer, MarketMakers liquidity bot). Bot LADDERS are quoted by
// lib/bots.js at server boot, not here.
const { openStore } = require('./store');
const { hashPassword } = require('./auth');
const { snapToTick } = require('./odds');
const config = require('./config');

// [name, competition, [[selection, fair_price], ...]]
const DEMO_EVENTS = [
  ['Arsenal vs Chelsea', 'Premier League', [['Arsenal', 2.4], ['Draw', 3.5], ['Chelsea', 3.1]]],
  ['Liverpool vs Manchester City', 'Premier League', [['Liverpool', 2.75], ['Draw', 3.6], ['Manchester City', 2.65]]],
  ['Brighton vs Newcastle', 'Premier League', [['Brighton', 2.9], ['Draw', 3.5], ['Newcastle', 2.5]]],
  ['Everton vs Tottenham', 'Premier League', [['Everton', 3.3], ['Draw', 3.4], ['Tottenham', 2.3]]],
  ['Real Madrid vs Barcelona', 'Champions League', [['Real Madrid', 2.35], ['Draw', 3.55], ['Barcelona', 3.05]]],
  ['Sinner vs Alcaraz', 'ATP Tour', [['Sinner', 1.95], ['Alcaraz', 2.1]]],
  ['Swiatek vs Sabalenka', 'ATP Tour', [['Swiatek', 1.75], ['Sabalenka', 2.3]]],
  ['Djokovic vs Zverev', 'ATP Tour', [['Djokovic', 1.65], ['Zverev', 2.55]]],
  ['LA Lakers vs Boston Celtics', 'NBA', [['LA Lakers', 2.1], ['Boston Celtics', 1.85]]],
  ['Park Meadings T1-T6', 'Park Meadings', [['Trap 1', 3.5], ['Trap 2', 4.2], ['Trap 3', 5.5], ['Trap 4', 6.0], ['Trap 5', 8.0], ['Trap 6', 12.0]]],
];

// sport → (competition → country)
const DEMO_SPORTS = [
  ['Football', 'football', 1, [['Premier League', 'ENG'], ['Champions League', 'EUR']]],
  ['Tennis', 'tennis', 2, [['ATP Tour', 'INT']]],
  ['Basketball', 'basketball', 3, [['NBA', 'USA']]],
  ['Greyhounds', 'greyhounds', 4, [['Park Meadings', 'UK']]],
];

const MARKET_NAME = {
  football: 'Match Odds',
  tennis: 'Match Odds',
  basketball: 'Money Line',
  greyhounds: 'Winner',
};

function hoursFromNow(h) {
  return new Date(Date.now() + h * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function seed(db) {
  db.exec('BEGIN');
  try {
    const insSport = db.prepare('INSERT INTO sports (name, slug, sort) VALUES (?, ?, ?)');
    const insComp = db.prepare('INSERT INTO competitions (sport_id, name, country) VALUES (?, ?, ?)');
    const insEvent = db.prepare("INSERT INTO events (sport_id, competition_id, name, starts_at) VALUES (?, ?, ?, ?)");
    const insMarket = db.prepare("INSERT INTO markets (event_id, name) VALUES (?, ?)");
    const insSelection = db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, ?)');
    const insUser = db.prepare('INSERT INTO users (username, pass_hash, is_admin, is_bot, balance_cents) VALUES (?, ?, ?, ?, ?)');

    // Sport/competition ids
    const sportIdBySlug = {};
    const compId = {};
    for (const [name, slug, sort, comps] of DEMO_SPORTS) {
      insSport.run(name, slug, sort);
      const sid = db.prepare('SELECT id FROM sports WHERE slug = ?').get(slug).id;
      sportIdBySlug[slug] = sid;
      compId[slug] = {};
      for (const [cname, country] of comps) {
        insComp.run(sid, cname, country);
        compId[slug][cname] = db.prepare('SELECT id FROM competitions WHERE sport_id = ? AND name = ?').get(sid, cname).id;
      }
    }

    // Events (spread over the next ~48h)
    const offsets = [2, 5, 26, 30, 28, 3, 6, 44, 8, 1];
    DEMO_EVENTS.forEach(([name, compName, selections], i) => {
      const slug = DEMO_SPORTS.find(([, s]) => compId[s] && compId[s][compName])[1];
      const sid = sportIdBySlug[slug];
      const cid = compId[slug][compName];
      insEvent.run(sid, cid, name, hoursFromNow(offsets[i]));
      const eid = db.prepare('SELECT id FROM events WHERE sport_id = ? AND name = ?').get(sid, name).id;
      insMarket.run(eid, MARKET_NAME[slug]);
      const mid = db.prepare('SELECT id FROM markets WHERE event_id = ?').get(eid).id;
      for (const [selName, fair] of selections) {
        // Fair prices are stored ON the ladder: a hand-written 2.75 is not a
        // tick (the 2.02-3.00 band steps by 0.02), and a fair price the ladder
        // cannot express makes the bot's derived quotes and the desk display
        // disagree with the engine.
        insSelection.run(mid, selName, snapToTick(fair));
      }
    });

    // Users: admin / demo / MarketMakers bot (bots never log in)
    insUser.run('admin', hashPassword('admin123'), 1, 0, 1000000);
    insUser.run('demo', hashPassword('demo123'), 0, 0, 100000);
    insUser.run('MarketMakers', hashPassword(Math.random().toString(36).slice(2)), 0, 1, 100000000);

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Idempotent: guarded by the 'seeded' settings key.
function seedIfNeeded(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'seeded'").get();
  if (row && row.value === '1') return false;
  seed(db);
  db.prepare("INSERT INTO settings (key, value) VALUES ('seeded', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
  return true;
}

// Board hygiene for a long-running demo: an event whose start time has passed
// is in-play, not "upcoming". Without this the board slowly empties itself as
// the seeded fixtures age. Returns the number of events rolled forward.
function rollForwardEvents(db) {
  const res = db
    .prepare("UPDATE events SET status = 'live' WHERE status = 'upcoming' AND starts_at <= datetime('now')")
    .run();
  return res.changes;
}

if (require.main === module) {
  const db = openStore(config.DB_PATH);
  const fresh = seedIfNeeded(db);
  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  console.log(fresh ? '[seed] demo data created:' : '[seed] already seeded:');
  console.log(`  sports=${count('sports')} competitions=${count('competitions')} events=${count('events')} markets=${count('markets')} selections=${count('selections')} users=${count('users')}`);
}

module.exports = { seed, seedIfNeeded, rollForwardEvents };
