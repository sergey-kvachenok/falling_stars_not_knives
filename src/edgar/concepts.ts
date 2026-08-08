// Tag fallback chains (PLAN.md §4.1): companies do not use identical XBRL tags.
// Order matters — first tag with usable data wins; which tag matched is recorded
// in bundle provenance. Expect to extend these chains as real companyfacts are
// inspected; log misses (trap #3).

export type ConceptKind = "duration" | "instant";

export interface ConceptDef {
  name: string;
  taxonomy: "us-gaap" | "dei";
  unit: "USD" | "shares";
  kind: ConceptKind;
  tags: string[];
}

export const CONCEPTS: ConceptDef[] = [
  {
    name: "revenue",
    taxonomy: "us-gaap",
    unit: "USD",
    kind: "duration",
    tags: [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "Revenues",
      "SalesRevenueNet",
      "RevenueFromContractWithCustomerIncludingAssessedTax",
      "SalesRevenueGoodsNet",
    ],
  },
  {
    name: "costOfRevenue",
    taxonomy: "us-gaap",
    unit: "USD",
    kind: "duration",
    tags: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold", "CostOfServices"],
  },
  { name: "grossProfit", taxonomy: "us-gaap", unit: "USD", kind: "duration", tags: ["GrossProfit"] },
  {
    name: "operatingIncome",
    taxonomy: "us-gaap",
    unit: "USD",
    kind: "duration",
    tags: ["OperatingIncomeLoss"],
  },
  {
    name: "netIncome",
    taxonomy: "us-gaap",
    unit: "USD",
    kind: "duration",
    tags: ["NetIncomeLoss", "ProfitLoss"],
  },
  {
    name: "depreciationAmortization",
    taxonomy: "us-gaap",
    unit: "USD",
    kind: "duration",
    tags: [
      "DepreciationDepletionAndAmortization",
      "DepreciationAmortizationAndAccretionNet",
      "DepreciationAndAmortization",
    ],
  },
  {
    name: "cfo",
    taxonomy: "us-gaap",
    unit: "USD",
    kind: "duration",
    tags: [
      "NetCashProvidedByUsedInOperatingActivities",
      "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
    ],
  },
  {
    name: "capex",
    taxonomy: "us-gaap",
    unit: "USD",
    kind: "duration",
    tags: [
      "PaymentsToAcquirePropertyPlantAndEquipment",
      "PaymentsToAcquireProductiveAssets",
      "PaymentsToAcquirePropertyPlantAndEquipmentAndIntangibleAssets",
    ],
  },
  {
    // Stock-based compensation — a real economic cost paid in dilution; FCF
    // subtracts it (the SBC illusion: CFO adds it back as "non-cash").
    name: "sbc",
    taxonomy: "us-gaap",
    unit: "USD",
    kind: "duration",
    tags: ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"],
  },
  {
    name: "interestExpense",
    taxonomy: "us-gaap",
    unit: "USD",
    kind: "duration",
    tags: ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt"],
  },
  {
    name: "cash",
    taxonomy: "us-gaap",
    unit: "USD",
    kind: "instant",
    tags: [
      "CashAndCashEquivalentsAtCarryingValue",
      "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    ],
  },
  {
    name: "shortTermInvestments",
    taxonomy: "us-gaap",
    unit: "USD",
    kind: "instant",
    tags: ["ShortTermInvestments", "AvailableForSaleSecuritiesDebtSecuritiesCurrent", "MarketableSecuritiesCurrent"],
  },
  {
    name: "longTermDebt",
    taxonomy: "us-gaap",
    unit: "USD",
    kind: "instant",
    tags: ["LongTermDebtNoncurrent", "LongTermDebt", "LongTermDebtAndCapitalLeaseObligations"],
  },
  {
    name: "currentDebt",
    taxonomy: "us-gaap",
    unit: "USD",
    kind: "instant",
    tags: ["LongTermDebtCurrent", "DebtCurrent", "ShortTermBorrowings"],
  },
  { name: "inventory", taxonomy: "us-gaap", unit: "USD", kind: "instant", tags: ["InventoryNet"] },
  { name: "assets", taxonomy: "us-gaap", unit: "USD", kind: "instant", tags: ["Assets"] },
  { name: "liabilities", taxonomy: "us-gaap", unit: "USD", kind: "instant", tags: ["Liabilities"] },
  {
    name: "equity",
    taxonomy: "us-gaap",
    unit: "USD",
    kind: "instant",
    tags: [
      "StockholdersEquity",
      "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ],
  },
  {
    name: "sharesOutstanding",
    taxonomy: "dei",
    unit: "shares",
    kind: "instant",
    tags: ["EntityCommonStockSharesOutstanding"],
  },
  // Dual-class companies (e.g. APP, RBLX) report dei shares per class as
  // dimensioned facts, which companyfacts omits — weighted averages are the
  // reliable dilution fallback.
  {
    name: "weightedSharesDiluted",
    taxonomy: "us-gaap",
    unit: "shares",
    kind: "duration",
    tags: [
      "WeightedAverageNumberOfDilutedSharesOutstanding",
      "WeightedAverageNumberOfSharesOutstandingBasic",
    ],
  },
];
