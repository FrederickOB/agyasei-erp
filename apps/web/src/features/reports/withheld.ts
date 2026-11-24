/**
 * Why a figure is withheld, in words.
 *
 * The server withholds a figure rather than show a wrong one (a margin on an
 * incomplete cost basis, a percentage of nothing) and says why with a CODE.
 * Codes are for machines; these are the two ways a person reads them:
 *   · `withheld` — a short phrase that sits in a table cell;
 *   · `withheldSentence` — what happened AND what would fix it, for a tile
 *     with room to say so. A withheld figure nobody knows how to unblock
 *     stays withheld.
 * Unknown codes (newer server, older client) show as themselves.
 */
export function withheld(reason: string | null): string {
  switch (reason) {
    case 'INCOMPLETE_COST_BASIS':
      return 'no full cost basis';
    case 'NO_COGS_IN_PERIOD':
      return 'nothing sold in this period';
    case 'NO_DISTRIBUTION_COST_SOURCE':
      return 'not recorded anywhere yet';
    case 'NO_REVENUE_IN_PERIOD':
      // A percentage of nothing is undefined, not zero. The COST is still
      // shown beside this: a warehouse has no till and still pays hauliers.
      return 'nothing was sold here in this period';
    case 'INCOMPLETE_FREIGHT_BASIS':
      return 'some freight was never agreed';
    case null:
      return 'not available';
    default:
      return reason;
  }
}

export function withheldSentence(reason: string | null): string {
  switch (reason) {
    case 'INCOMPLETE_COST_BASIS':
      return 'Some products sold in this period have no cost price yet, so margin would be guessed. Load opening stock at cost or receive goods against an order to complete it.';
    case 'NO_COGS_IN_PERIOD':
      return 'Nothing with a cost was sold in this period, so there is no margin to show yet.';
    case 'NO_DISTRIBUTION_COST_SOURCE':
      return 'Distribution costs are not recorded anywhere yet.';
    case 'NO_REVENUE_IN_PERIOD':
      return 'Nothing was sold in this period, so a share of sales cannot be worked out.';
    case 'INCOMPLETE_FREIGHT_BASIS':
      return 'Some deliveries have no agreed freight price, so the cost of moving goods would be understated. Agree freight on those deliveries to complete it.';
    case null:
      return 'This figure is not available for the period.';
    default:
      return reason;
  }
}
