/**
 * Synthetic corpus for a fictional company, Northwind Commerce.
 *
 * Every document is invented for this demo - no real, private or scraped data
 * is used anywhere in Recant.
 *
 * The corpus is shaped around one deliberate trap: a September load test whose
 * numbers are wrong, and four downstream documents that quietly build on it -
 * a capacity plan, a spend decision, an on-call rota and a vendor contract.
 * The October postmortem is what reveals the load test was invalid. That is
 * the moment a normal agent memory has no answer for, and the one Recant is
 * built around.
 *
 * Order matters: documents are ingested in sequence so later ones can
 * reference claims the earlier ones created.
 */

export const CORPUS = [
  {
    id: 'doc-infra-inventory',
    phase: 1,
    title: 'Infrastructure inventory (Q3 2026)',
    kind: 'wiki',
    trust: 0.9,
    at: '2026-08-02T10:00:00Z',
    text: `Service inventory for Northwind Commerce, Q3 2026.

Checkout API runs on 3 application nodes in eu-west-1, behind the shared ALB.
Each node is a c7g.2xlarge. Checkout API owns the orders table in the primary
Postgres cluster. The Payments Gateway is a separate service and is not covered
by this inventory. Priya Raman is the service owner for Checkout API.`,
  },

  {
    id: 'doc-loadtest-sep',
    phase: 1,
    title: 'Load test report: Checkout API, September 2026',
    kind: 'report',
    trust: 0.8,
    at: '2026-09-11T09:30:00Z',
    text: `Load test report, Checkout API, run 2026-09-10 against staging.

Checkout API sustained 1,200 requests per second with a p99 latency of 180ms on
3 nodes. CPU peaked at 54 percent. No error-rate increase was observed up to
1,200 rps. The team considers 1,200 rps the safe sustained ceiling for the
current 3-node configuration.`,
  },

  {
    id: 'doc-infra-audit',
    phase: 1,
    title: 'Platform audit note: node counts verified',
    kind: 'audit',
    trust: 0.95,
    at: '2026-09-14T12:00:00Z',
    text: `Quarterly platform audit, independent verification of node counts.

Confirmed: Checkout API runs on 3 application nodes in eu-west-1. Confirmed:
the Search service runs on 2 nodes. The audit did not review performance
figures or capacity planning, only the deployed node counts.`,
  },

  {
    id: 'doc-capacity-plan',
    phase: 1,
    title: 'Black Friday capacity plan',
    kind: 'plan',
    trust: 0.7,
    at: '2026-09-18T15:00:00Z',
    text: `Black Friday 2026 capacity plan for Checkout API.

Forecast peak traffic for Black Friday is 900 requests per second. Based on the
September load test, which measured a sustained ceiling of 1,200 rps on 3
nodes, Checkout API can absorb the forecast Black Friday peak on its current
3-node configuration with roughly 25 percent headroom. Therefore no additional
capacity is required for Checkout API before Black Friday.`,
  },

  {
    id: 'doc-decision-no-scaleup',
    phase: 1,
    title: 'Decision record: no pre-Black-Friday scale-up',
    kind: 'decision',
    trust: 0.75,
    at: '2026-09-22T11:00:00Z',
    text: `Decision record DR-118, approved by Priya Raman.

Given the Black Friday capacity plan concluded that 3 nodes are sufficient for
the forecast 900 rps peak, Northwind will not scale up Checkout API before
Black Friday. This decision avoids 18,000 dollars of additional infrastructure
spend in Q4. The decision will be revisited only if the capacity assumption
changes.`,
  },

  {
    id: 'doc-oncall-rota',
    phase: 1,
    title: 'Black Friday on-call rota',
    kind: 'ops',
    trust: 0.7,
    at: '2026-09-25T08:00:00Z',
    text: `Black Friday weekend on-call rota.

Because decision record DR-118 means no scale-up work is planned for Checkout
API, the Black Friday weekend will be covered by a single on-call engineer
rather than the usual surge rota of three. Marcus Udoh takes the primary pager
for the weekend.`,
  },

  {
    id: 'doc-vendor-contract',
    phase: 1,
    title: 'Vendor commitment: reserved instances',
    kind: 'contract',
    trust: 0.85,
    at: '2026-09-29T16:20:00Z',
    text: `Reserved instance commitment, finance record FR-2291.

Following decision record DR-118, Northwind has committed to a 12-month
reserved instance contract sized for 3 Checkout API nodes. The commitment is
non-refundable after 2026-10-15. Breaking the sizing would forfeit the
reserved-instance discount of 31 percent.`,
  },

  {
    id: 'doc-incident-4412',
    phase: 2,
    title: 'Incident INC-4412: checkout latency during flash sale',
    kind: 'incident',
    trust: 0.9,
    at: '2026-10-04T02:10:00Z',
    text: `Incident INC-4412, 2026-10-03 flash sale.

Checkout API reached 640 requests per second during the flash sale and p99
latency rose to 2,100ms. The error rate reached 4.2 percent and 211 checkouts
failed. Traffic was well below the 1,200 rps figure from the September load
test, yet the service degraded badly. Marcus Udoh was paged at 21:40.`,
  },

  {
    id: 'doc-postmortem-4412',
    phase: 2,
    title: 'Postmortem INC-4412: the September load test was invalid',
    kind: 'postmortem',
    trust: 0.95,
    at: '2026-10-07T13:00:00Z',
    text: `Postmortem for INC-4412, signed off by Priya Raman.

Root cause: the September load test ran against a staging database holding a
product catalog roughly ten times smaller than production, with its cache
pre-warmed before measurement began. Under those conditions the orders query
never touched cold storage. The resulting 1,200 rps figure does not transfer to
production and must not be used for capacity planning. A corrected test on
production-shaped data measured a sustained ceiling of 520 rps on 3 nodes.`,
  },
];

/** September: everything the team knew before the flash sale. */
export const PHASE1 = CORPUS.filter((d) => d.phase === 1);

/** October: the incident and the postmortem that invalidates the load test. */
export const PHASE2 = CORPUS.filter((d) => d.phase === 2);

export default CORPUS;
