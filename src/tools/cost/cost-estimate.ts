/**
 * Construction cost estimation tool for openclaw-mini.
 *
 * Generates detailed cost estimates with CSI MasterFormat division breakdowns,
 * adjusted for location, quality level, building type, and inflation.
 * Cost data sourced from an RSMeans-style database (data/cost-database.json).
 */

import * as fs from "fs";
import * as path from "path";

// ── Types ────────────────────────────────────────────────────────────────────

type BuildingType =
  | "residential_single"
  | "residential_multi"
  | "commercial_office"
  | "commercial_retail"
  | "industrial"
  | "institutional"
  | "healthcare";

type QualityLevel = "economy" | "average" | "above_average" | "luxury";

interface DivisionCosts {
  [divisionKey: string]: number;
}

interface CostDatabase {
  version: string;
  base_year: number;
  unit_costs_per_sqm: {
    [buildingType: string]: {
      [quality: string]: DivisionCosts;
    };
  };
  location_factors: { [location: string]: number };
  inflation_rates: { [year: string]: number };
  division_names: { [divisionKey: string]: string };
  soft_cost_rates: {
    architecture_engineering: { min: number; max: number; typical: number };
    permits_fees: { min: number; max: number; typical: number };
    insurance: { min: number; max: number; typical: number };
    contingency: { min: number; max: number; typical: number };
  };
}

interface ElementOverride {
  division: string;
  cost_per_sqm: number;
}

interface CostEstimateArgs {
  building_type: BuildingType;
  gross_area_sqm: number;
  stories?: number;
  location?: string;
  quality?: QualityLevel;
  year?: number;
  elements?: ElementOverride[];
  include_soft_costs?: boolean;
}

interface DivisionLineItem {
  division: string;
  name: string;
  cost_per_sqm: number;
  total_cost: number;
}

interface SoftCostItem {
  name: string;
  percentage: number;
  total_cost: number;
}

interface CostEstimateResult {
  summary: {
    building_type: string;
    gross_area_sqm: number;
    stories: number;
    quality: string;
    location: string;
    location_factor: number;
    year: number;
    inflation_factor: number;
    story_premium: number;
  };
  hard_costs: {
    divisions: DivisionLineItem[];
    subtotal_per_sqm: number;
    subtotal: number;
  };
  soft_costs?: {
    items: SoftCostItem[];
    subtotal: number;
  };
  total_cost: number;
  total_cost_per_sqm: number;
  total_cost_per_sqft: number;
  notes: string[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const SQM_TO_SQFT = 10.7639;
const STORY_PREMIUM_RATE = 0.03; // 3% per story above 3
const STORY_PREMIUM_THRESHOLD = 3;

const BUILDING_TYPE_LABELS: Record<BuildingType, string> = {
  residential_single: "Residential - Single Family",
  residential_multi: "Residential - Multi-Family",
  commercial_office: "Commercial - Office",
  commercial_retail: "Commercial - Retail",
  industrial: "Industrial",
  institutional: "Institutional",
  healthcare: "Healthcare",
};

const VALID_BUILDING_TYPES: BuildingType[] = [
  "residential_single",
  "residential_multi",
  "commercial_office",
  "commercial_retail",
  "industrial",
  "institutional",
  "healthcare",
];

const VALID_QUALITY_LEVELS: QualityLevel[] = [
  "economy",
  "average",
  "above_average",
  "luxury",
];

// ── Database loading ─────────────────────────────────────────────────────────

let cachedDatabase: CostDatabase | null = null;

function loadCostDatabase(): CostDatabase {
  if (cachedDatabase) return cachedDatabase;

  const dbPath = path.resolve(__dirname, "..", "..", "..", "data", "cost-database.json");
  const raw = fs.readFileSync(dbPath, "utf-8");
  cachedDatabase = JSON.parse(raw) as CostDatabase;
  return cachedDatabase;
}

// ── Division key helpers ─────────────────────────────────────────────────────

/**
 * Maps a CSI division number (e.g. "03", "23") to the corresponding database
 * key (e.g. "div_03_concrete").
 */
function divisionNumberToKey(divNumber: string, db: CostDatabase): string | null {
  const padded = divNumber.padStart(2, "0");
  const prefix = `div_${padded}_`;
  for (const key of Object.keys(db.division_names)) {
    if (key.startsWith(prefix)) return key;
  }
  return null;
}

// ── Location factor resolution ───────────────────────────────────────────────

function resolveLocationFactor(location: string, db: CostDatabase): { factor: number; matched: string } {
  // Exact match
  if (db.location_factors[location] !== undefined) {
    return { factor: db.location_factors[location], matched: location };
  }

  // Case-insensitive search
  const lower = location.toLowerCase();
  for (const [key, value] of Object.entries(db.location_factors)) {
    if (key.toLowerCase() === lower) {
      return { factor: value, matched: key };
    }
  }

  // Partial match (city name without state)
  for (const [key, value] of Object.entries(db.location_factors)) {
    if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase().split(",")[0])) {
      return { factor: value, matched: key };
    }
  }

  // Default to national average
  return { factor: 1.0, matched: "National Average" };
}

// ── Inflation factor resolution ──────────────────────────────────────────────

function resolveInflationFactor(year: number, db: CostDatabase): number {
  const baseRate = db.inflation_rates[String(db.base_year)];
  const targetRate = db.inflation_rates[String(year)];

  if (baseRate !== undefined && targetRate !== undefined) {
    return targetRate / baseRate;
  }

  // Extrapolate if year is outside the table, using ~3.5% annual escalation
  const maxYearInTable = Math.max(...Object.keys(db.inflation_rates).map(Number));
  const minYearInTable = Math.min(...Object.keys(db.inflation_rates).map(Number));

  if (year > maxYearInTable) {
    const maxRate = db.inflation_rates[String(maxYearInTable)];
    const extraYears = year - maxYearInTable;
    const projected = maxRate * Math.pow(1.035, extraYears);
    return projected / (baseRate ?? 1.22);
  }

  if (year < minYearInTable) {
    const minRate = db.inflation_rates[String(minYearInTable)];
    const extraYears = minYearInTable - year;
    const projected = minRate / Math.pow(1.035, extraYears);
    return projected / (baseRate ?? 1.22);
  }

  return 1.0;
}

// ── Core estimation logic ────────────────────────────────────────────────────

function generateEstimate(args: CostEstimateArgs): CostEstimateResult {
  const db = loadCostDatabase();

  // Resolve parameters with defaults
  const buildingType = args.building_type;
  const grossArea = args.gross_area_sqm;
  const stories = args.stories ?? 1;
  const quality: QualityLevel = args.quality ?? "average";
  const location = args.location ?? "National Average";
  const year = args.year ?? new Date().getFullYear();
  const includeSoftCosts = args.include_soft_costs !== false;
  const elementOverrides = args.elements ?? [];

  // Validate building type
  if (!VALID_BUILDING_TYPES.includes(buildingType)) {
    throw new Error(
      `Invalid building_type "${buildingType}". Must be one of: ${VALID_BUILDING_TYPES.join(", ")}`
    );
  }

  // Validate quality
  if (!VALID_QUALITY_LEVELS.includes(quality)) {
    throw new Error(
      `Invalid quality "${quality}". Must be one of: ${VALID_QUALITY_LEVELS.join(", ")}`
    );
  }

  // Validate area
  if (typeof grossArea !== "number" || grossArea <= 0 || !Number.isFinite(grossArea)) {
    throw new Error("gross_area_sqm must be a positive finite number.");
  }

  // Look up base costs
  const baseCosts = db.unit_costs_per_sqm[buildingType]?.[quality];
  if (!baseCosts) {
    throw new Error(
      `No cost data found for building_type="${buildingType}", quality="${quality}".`
    );
  }

  // Resolve location factor
  const { factor: locationFactor, matched: matchedLocation } = resolveLocationFactor(location, db);

  // Resolve inflation factor
  const inflationFactor = resolveInflationFactor(year, db);

  // Calculate story premium
  const extraStories = Math.max(0, stories - STORY_PREMIUM_THRESHOLD);
  const storyPremium = 1 + extraStories * STORY_PREMIUM_RATE;

  // Build a map of overrides keyed by division database key
  const overrideMap = new Map<string, number>();
  const overrideNotes: string[] = [];
  for (const override of elementOverrides) {
    const divKey = divisionNumberToKey(override.division, db);
    if (divKey) {
      overrideMap.set(divKey, override.cost_per_sqm);
      overrideNotes.push(
        `Division ${override.division} overridden to $${override.cost_per_sqm.toFixed(2)}/sqm`
      );
    } else {
      overrideNotes.push(
        `Warning: Division "${override.division}" not found in database, override ignored.`
      );
    }
  }

  // Calculate per-division costs
  const divisions: DivisionLineItem[] = [];
  let hardCostSubtotal = 0;

  for (const [divKey, baseCostPerSqm] of Object.entries(baseCosts)) {
    const divName = db.division_names[divKey] ?? divKey;

    // Use override if provided; otherwise apply location + inflation + story premium
    let adjustedCostPerSqm: number;
    if (overrideMap.has(divKey)) {
      adjustedCostPerSqm = overrideMap.get(divKey)!;
    } else {
      adjustedCostPerSqm = baseCostPerSqm * locationFactor * inflationFactor * storyPremium;
    }

    const totalCost = adjustedCostPerSqm * grossArea;

    divisions.push({
      division: divKey,
      name: divName,
      cost_per_sqm: round2(adjustedCostPerSqm),
      total_cost: round2(totalCost),
    });

    hardCostSubtotal += totalCost;
  }

  const hardCostSubtotalPerSqm = hardCostSubtotal / grossArea;

  // Soft costs
  let softCosts: CostEstimateResult["soft_costs"] = undefined;
  let softCostTotal = 0;

  if (includeSoftCosts) {
    const rates = db.soft_cost_rates;
    const softItems: SoftCostItem[] = [
      {
        name: "Architecture & Engineering Fees",
        percentage: rates.architecture_engineering.typical,
        total_cost: round2(hardCostSubtotal * rates.architecture_engineering.typical),
      },
      {
        name: "Permits & Fees",
        percentage: rates.permits_fees.typical,
        total_cost: round2(hardCostSubtotal * rates.permits_fees.typical),
      },
      {
        name: "Insurance",
        percentage: rates.insurance.typical,
        total_cost: round2(hardCostSubtotal * rates.insurance.typical),
      },
      {
        name: "Contingency",
        percentage: rates.contingency.typical,
        total_cost: round2(hardCostSubtotal * rates.contingency.typical),
      },
    ];

    softCostTotal = softItems.reduce((sum, item) => sum + item.total_cost, 0);

    softCosts = {
      items: softItems,
      subtotal: round2(softCostTotal),
    };
  }

  // Totals
  const totalCost = hardCostSubtotal + softCostTotal;
  const totalCostPerSqm = totalCost / grossArea;
  const totalCostPerSqft = totalCostPerSqm / SQM_TO_SQFT;

  // Notes
  const notes: string[] = [];

  if (matchedLocation !== location) {
    notes.push(`Location "${location}" matched to "${matchedLocation}" (factor: ${locationFactor}).`);
  }

  if (year !== db.base_year) {
    notes.push(
      `Costs adjusted from base year ${db.base_year} to ${year} (inflation factor: ${inflationFactor.toFixed(4)}).`
    );
  }

  if (extraStories > 0) {
    notes.push(
      `Story premium applied: ${(storyPremium - 1) * 100}% for ${extraStories} stories above ${STORY_PREMIUM_THRESHOLD} (${stories} total stories).`
    );
  }

  if (overrideNotes.length > 0) {
    notes.push(...overrideNotes);
  }

  notes.push(
    `Estimate based on ${db.version} RSMeans-style cost data. Actual costs may vary based on site conditions, market availability, and project-specific requirements.`
  );

  if (includeSoftCosts) {
    notes.push(
      "Soft costs include A/E fees (10%), permits (3%), insurance (4%), and contingency (7.5%), totaling ~24.5% of hard costs."
    );
  }

  return {
    summary: {
      building_type: BUILDING_TYPE_LABELS[buildingType] ?? buildingType,
      gross_area_sqm: grossArea,
      stories,
      quality,
      location: matchedLocation,
      location_factor: locationFactor,
      year,
      inflation_factor: round4(inflationFactor),
      story_premium: round4(storyPremium),
    },
    hard_costs: {
      divisions,
      subtotal_per_sqm: round2(hardCostSubtotalPerSqm),
      subtotal: round2(hardCostSubtotal),
    },
    ...(softCosts ? { soft_costs: softCosts } : {}),
    total_cost: round2(totalCost),
    total_cost_per_sqm: round2(totalCostPerSqm),
    total_cost_per_sqft: round2(totalCostPerSqft),
    notes,
  };
}

// ── Utility ──────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ── Tool definition ──────────────────────────────────────────────────────────

export function createCostEstimateToolDefinition() {
  return {
    name: "cost_estimate",
    label: "Cost Estimate",
    description:
      "Generate a construction cost estimate with detailed CSI division breakdown, adjusted for location and quality level.",
    parameters: {
      type: "object",
      properties: {
        building_type: {
          type: "string",
          enum: [
            "residential_single",
            "residential_multi",
            "commercial_office",
            "commercial_retail",
            "industrial",
            "institutional",
            "healthcare",
          ],
          description:
            "Type of building to estimate. Residential single/multi-family, commercial office/retail, industrial, institutional (schools, government), or healthcare.",
        },
        gross_area_sqm: {
          type: "number",
          description: "Total gross building area in square meters.",
          minimum: 1,
        },
        stories: {
          type: "number",
          description:
            "Number of stories. Adds a ~3% vertical construction premium per story above 3. Default: 1.",
          minimum: 1,
          default: 1,
        },
        location: {
          type: "string",
          description:
            'City name for location cost factor (e.g. "New York, NY", "San Francisco, CA"). Defaults to "National Average" (factor 1.0).',
        },
        quality: {
          type: "string",
          enum: ["economy", "average", "above_average", "luxury"],
          description:
            'Construction quality level affecting material and finish selections. Default: "average".',
          default: "average",
        },
        year: {
          type: "number",
          description:
            "Target cost year for inflation adjustment. Database base year is 2024. Default: current year.",
        },
        elements: {
          type: "array",
          description:
            "Override specific CSI division costs with custom values. Overrides bypass location and inflation adjustments.",
          items: {
            type: "object",
            properties: {
              division: {
                type: "string",
                description:
                  'CSI division number (e.g. "03" for Concrete, "23" for HVAC, "26" for Electrical).',
              },
              cost_per_sqm: {
                type: "number",
                description: "Custom cost per square meter for this division.",
                minimum: 0,
              },
            },
            required: ["division", "cost_per_sqm"],
          },
        },
        include_soft_costs: {
          type: "boolean",
          description:
            "Include soft costs (A/E fees ~10%, permits ~3%, insurance ~4%, contingency ~7.5%). Default: true.",
          default: true,
        },
      },
      required: ["building_type", "gross_area_sqm"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }> => {
      const params = (args ?? {}) as Record<string, unknown>;

      // Parse and validate required parameters
      const buildingType = String(params.building_type ?? "").trim() as BuildingType;
      if (!buildingType) {
        throw new Error("building_type is required.");
      }

      const grossAreaRaw = params.gross_area_sqm;
      if (grossAreaRaw === undefined || grossAreaRaw === null) {
        throw new Error("gross_area_sqm is required.");
      }
      const grossArea = Number(grossAreaRaw);

      // Parse optional parameters
      const stories =
        params.stories !== undefined && params.stories !== null
          ? Math.max(1, Math.round(Number(params.stories)))
          : undefined;

      const location =
        typeof params.location === "string" && params.location.trim()
          ? params.location.trim()
          : undefined;

      const quality =
        typeof params.quality === "string" && params.quality.trim()
          ? (params.quality.trim() as QualityLevel)
          : undefined;

      const year =
        params.year !== undefined && params.year !== null
          ? Math.round(Number(params.year))
          : undefined;

      const includeSoftCosts =
        params.include_soft_costs !== undefined
          ? Boolean(params.include_soft_costs)
          : undefined;

      // Parse element overrides
      let elements: ElementOverride[] | undefined;
      if (Array.isArray(params.elements)) {
        elements = (params.elements as Array<Record<string, unknown>>).map((el) => ({
          division: String(el.division ?? ""),
          cost_per_sqm: Number(el.cost_per_sqm ?? 0),
        }));
      }

      const estimateArgs: CostEstimateArgs = {
        building_type: buildingType,
        gross_area_sqm: grossArea,
        ...(stories !== undefined && { stories }),
        ...(location !== undefined && { location }),
        ...(quality !== undefined && { quality }),
        ...(year !== undefined && { year }),
        ...(elements !== undefined && { elements }),
        ...(includeSoftCosts !== undefined && { include_soft_costs: includeSoftCosts }),
      };

      const result = generateEstimate(estimateArgs);

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {
          building_type: result.summary.building_type,
          gross_area_sqm: result.summary.gross_area_sqm,
          total_cost: result.total_cost,
          total_cost_per_sqm: result.total_cost_per_sqm,
        },
      };
    },
  };
}
