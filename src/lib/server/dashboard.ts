import { getDb } from './db.ts';

const countBy = (sql: string) =>
  Object.fromEntries((getDb().prepare(sql).all() as { k: string; c: number }[]).map((r) => [r.k, r.c]));

/** Real counts straight from the database — the dashboard shows nothing else. */
export function dashboardCounts() {
  return {
    locationsByStatus: countBy('SELECT status AS k, COUNT(*) AS c FROM service_locations GROUP BY status'),
    locationsPublished: (getDb().prepare('SELECT COUNT(*) AS c FROM service_locations WHERE published = 1').get() as { c: number }).c,
    enquiriesByStatus: countBy('SELECT status AS k, COUNT(*) AS c FROM enquiries GROUP BY status'),
  };
}
