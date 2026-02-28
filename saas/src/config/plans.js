/**
 * Plan definitions and quota limits.
 *
 * Free users get hard caps. Full members bypass all limits.
 * Add new plans here — route handlers read from this config.
 */

export const PLANS = {
  free: { memories: 100, items: 20, workspaces: 1 },
  pro: { memories: 1000, items: 100, workspaces: 5 },
  full: { memories: Infinity, items: Infinity, workspaces: Infinity },
};

/**
 * Get the limits for a given plan name, defaulting to free.
 */
export function getLimits(plan) {
  return PLANS[plan] || PLANS.free;
}
