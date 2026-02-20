/**
 * Quantity takeoff tool for openclaw-mini.
 *
 * Generates material quantity estimates from building parameters.
 * Covers structural, envelope, interior, and site work quantities
 * using industry-standard ratios and rules of thumb.
 *
 * Pure TypeScript — no external dependencies.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

interface QuantityItem {
  csi_division: string;
  category: string;
  item: string;
  quantity: number;
  unit: string;
  notes: string;
}

interface QuantityTakeoffResult {
  project_name: string;
  building_type: string;
  gross_area_sqm: number;
  stories: number;
  perimeter_m: number;
  floor_to_floor_m: number;
  total_quantities: QuantityItem[];
  summary: {
    total_items: number;
    divisions_covered: string[];
  };
  assumptions: string[];
}

// ─── Quantity estimation ratios (per sqm of gross floor area) ────────────────

// Structure types affect material quantities
type StructureType = "concrete_frame" | "steel_frame" | "wood_frame" | "masonry_bearing";
type BuildingType = "residential" | "commercial" | "industrial" | "institutional" | "healthcare";

interface MaterialRatios {
  // Concrete (m³ per sqm of floor)
  concrete_foundation: number;
  concrete_slab: number;
  concrete_columns: number;
  concrete_beams: number;
  // Reinforcing (kg per m³ of concrete)
  rebar_foundation: number;
  rebar_slab: number;
  rebar_columns: number;
  rebar_beams: number;
  // Steel (kg per sqm of floor)
  structural_steel: number;
  metal_deck: number;
  misc_metals: number;
  // Masonry (sqm of wall per sqm of floor)
  masonry_exterior: number;
  masonry_interior: number;
  // Wood (board feet per sqm of floor)
  framing_lumber: number;
  sheathing: number;
  // Envelope
  roofing_sqm_ratio: number; // roof area / footprint
  insulation_sqm_ratio: number;
  waterproofing_sqm_ratio: number;
  glazing_ratio: number; // window area / facade area
  // Interior
  drywall_sqm_ratio: number;
  ceiling_sqm_ratio: number;
  flooring_sqm_ratio: number;
  paint_sqm_ratio: number;
  doors_per_100sqm: number;
  // MEP
  ductwork_kg_per_sqm: number;
  piping_m_per_sqm: number;
  electrical_wire_m_per_sqm: number;
  light_fixtures_per_100sqm: number;
  sprinkler_heads_per_100sqm: number;
}

const BASE_RATIOS: Record<StructureType, MaterialRatios> = {
  concrete_frame: {
    concrete_foundation: 0.08,
    concrete_slab: 0.12,
    concrete_columns: 0.03,
    concrete_beams: 0.04,
    rebar_foundation: 80,
    rebar_slab: 100,
    rebar_columns: 150,
    rebar_beams: 120,
    structural_steel: 2,
    metal_deck: 0,
    misc_metals: 3,
    masonry_exterior: 0,
    masonry_interior: 0.1,
    framing_lumber: 0,
    sheathing: 0,
    roofing_sqm_ratio: 1.1,
    insulation_sqm_ratio: 1.3,
    waterproofing_sqm_ratio: 0.15,
    glazing_ratio: 0.35,
    drywall_sqm_ratio: 2.8,
    ceiling_sqm_ratio: 0.9,
    flooring_sqm_ratio: 0.95,
    paint_sqm_ratio: 3.5,
    doors_per_100sqm: 2.0,
    ductwork_kg_per_sqm: 3.5,
    piping_m_per_sqm: 0.8,
    electrical_wire_m_per_sqm: 8,
    light_fixtures_per_100sqm: 5,
    sprinkler_heads_per_100sqm: 1.2,
  },
  steel_frame: {
    concrete_foundation: 0.06,
    concrete_slab: 0.10,
    concrete_columns: 0,
    concrete_beams: 0,
    rebar_foundation: 80,
    rebar_slab: 80,
    rebar_columns: 0,
    rebar_beams: 0,
    structural_steel: 35,
    metal_deck: 12,
    misc_metals: 5,
    masonry_exterior: 0,
    masonry_interior: 0,
    framing_lumber: 0,
    sheathing: 0,
    roofing_sqm_ratio: 1.1,
    insulation_sqm_ratio: 1.3,
    waterproofing_sqm_ratio: 0.15,
    glazing_ratio: 0.4,
    drywall_sqm_ratio: 2.8,
    ceiling_sqm_ratio: 0.9,
    flooring_sqm_ratio: 0.95,
    paint_sqm_ratio: 3.5,
    doors_per_100sqm: 2.0,
    ductwork_kg_per_sqm: 3.5,
    piping_m_per_sqm: 0.8,
    electrical_wire_m_per_sqm: 8,
    light_fixtures_per_100sqm: 5,
    sprinkler_heads_per_100sqm: 1.2,
  },
  wood_frame: {
    concrete_foundation: 0.05,
    concrete_slab: 0.08,
    concrete_columns: 0,
    concrete_beams: 0,
    rebar_foundation: 60,
    rebar_slab: 60,
    rebar_columns: 0,
    rebar_beams: 0,
    structural_steel: 0,
    metal_deck: 0,
    misc_metals: 1.5,
    masonry_exterior: 0,
    masonry_interior: 0,
    framing_lumber: 22,
    sheathing: 1.2,
    roofing_sqm_ratio: 1.15,
    insulation_sqm_ratio: 1.5,
    waterproofing_sqm_ratio: 0.12,
    glazing_ratio: 0.2,
    drywall_sqm_ratio: 3.2,
    ceiling_sqm_ratio: 0.95,
    flooring_sqm_ratio: 0.95,
    paint_sqm_ratio: 4.0,
    doors_per_100sqm: 2.5,
    ductwork_kg_per_sqm: 2.5,
    piping_m_per_sqm: 0.7,
    electrical_wire_m_per_sqm: 6,
    light_fixtures_per_100sqm: 4,
    sprinkler_heads_per_100sqm: 1.0,
  },
  masonry_bearing: {
    concrete_foundation: 0.07,
    concrete_slab: 0.10,
    concrete_columns: 0.01,
    concrete_beams: 0.02,
    rebar_foundation: 75,
    rebar_slab: 80,
    rebar_columns: 100,
    rebar_beams: 100,
    structural_steel: 0,
    metal_deck: 0,
    misc_metals: 2,
    masonry_exterior: 0.5,
    masonry_interior: 0.3,
    framing_lumber: 0,
    sheathing: 0,
    roofing_sqm_ratio: 1.1,
    insulation_sqm_ratio: 1.3,
    waterproofing_sqm_ratio: 0.15,
    glazing_ratio: 0.2,
    drywall_sqm_ratio: 2.0,
    ceiling_sqm_ratio: 0.9,
    flooring_sqm_ratio: 0.95,
    paint_sqm_ratio: 3.0,
    doors_per_100sqm: 1.8,
    ductwork_kg_per_sqm: 3.0,
    piping_m_per_sqm: 0.7,
    electrical_wire_m_per_sqm: 7,
    light_fixtures_per_100sqm: 4.5,
    sprinkler_heads_per_100sqm: 1.1,
  },
};

// Building type adjustments for MEP intensity
const BUILDING_TYPE_MEP_FACTOR: Record<BuildingType, number> = {
  residential: 0.7,
  commercial: 1.0,
  industrial: 0.8,
  institutional: 1.1,
  healthcare: 1.5,
};

// ─── Quantity generation ────────────────────────────────────────────────────

function generateQuantities(params: {
  project_name: string;
  building_type: BuildingType;
  structure_type: StructureType;
  gross_area_sqm: number;
  stories: number;
  perimeter_m?: number;
  floor_to_floor_m?: number;
  window_wall_ratio?: number;
}): QuantityTakeoffResult {
  const {
    project_name,
    building_type,
    structure_type,
    gross_area_sqm,
    stories,
  } = params;

  const floorArea = gross_area_sqm;
  const footprint = floorArea / stories;
  const perimeter = params.perimeter_m ?? Math.sqrt(footprint) * 4; // Assume square
  const floorToFloor = params.floor_to_floor_m ?? 3.6; // Default 3.6m
  const totalHeight = floorToFloor * stories;
  const facadeArea = perimeter * totalHeight;
  const wwr = params.window_wall_ratio ?? BASE_RATIOS[structure_type].glazing_ratio;
  const mepFactor = BUILDING_TYPE_MEP_FACTOR[building_type];
  const r = BASE_RATIOS[structure_type];

  const items: QuantityItem[] = [];

  const add = (div: string, cat: string, item: string, qty: number, unit: string, notes: string) => {
    if (qty > 0) {
      items.push({
        csi_division: div,
        category: cat,
        item,
        quantity: Math.round(qty * 100) / 100,
        unit,
        notes,
      });
    }
  };

  // ── Division 02: Site Work ──
  add("02", "Earthwork", "Excavation (foundation)", footprint * 1.5 * 1.2, "m³",
    "Assumes 1.5m depth, 20% swell factor");
  add("02", "Earthwork", "Backfill", footprint * 1.5 * 0.5, "m³",
    "~50% of excavation returned as backfill");
  add("02", "Earthwork", "Gravel base (under slab)", footprint * 0.15, "m³",
    "150mm compacted gravel base");

  // ── Division 03: Concrete ──
  const concreteFdn = r.concrete_foundation * floorArea;
  const concreteSlab = r.concrete_slab * floorArea;
  const concreteCol = r.concrete_columns * floorArea;
  const concreteBeam = r.concrete_beams * floorArea;
  const concreteTotal = concreteFdn + concreteSlab + concreteCol + concreteBeam;

  add("03", "Concrete", "Foundation concrete", concreteFdn, "m³",
    `${r.concrete_foundation} m³/sqm × ${floorArea} sqm`);
  add("03", "Concrete", "Slab concrete (all floors)", concreteSlab, "m³",
    `${r.concrete_slab} m³/sqm × ${floorArea} sqm`);
  if (concreteCol > 0) {
    add("03", "Concrete", "Column concrete", concreteCol, "m³",
      `${r.concrete_columns} m³/sqm × ${floorArea} sqm`);
  }
  if (concreteBeam > 0) {
    add("03", "Concrete", "Beam concrete", concreteBeam, "m³",
      `${r.concrete_beams} m³/sqm × ${floorArea} sqm`);
  }

  // Rebar
  const rebarFdn = (concreteFdn * r.rebar_foundation) / 1000;
  const rebarSlab = (concreteSlab * r.rebar_slab) / 1000;
  const rebarCol = (concreteCol * r.rebar_columns) / 1000;
  const rebarBeam = (concreteBeam * r.rebar_beams) / 1000;

  add("03", "Reinforcing", "Foundation rebar", rebarFdn, "tonnes",
    `${r.rebar_foundation} kg/m³ × ${concreteFdn.toFixed(1)} m³`);
  add("03", "Reinforcing", "Slab rebar", rebarSlab, "tonnes",
    `${r.rebar_slab} kg/m³ × ${concreteSlab.toFixed(1)} m³`);
  if (rebarCol > 0) {
    add("03", "Reinforcing", "Column rebar", rebarCol, "tonnes",
      `${r.rebar_columns} kg/m³ × ${concreteCol.toFixed(1)} m³`);
  }
  if (rebarBeam > 0) {
    add("03", "Reinforcing", "Beam rebar", rebarBeam, "tonnes",
      `${r.rebar_beams} kg/m³ × ${concreteBeam.toFixed(1)} m³`);
  }

  // Formwork (approx 10 sqm of formwork per m³ of concrete)
  add("03", "Formwork", "Formwork (all elements)", concreteTotal * 10, "sqm",
    "~10 sqm formwork per m³ of concrete");

  // ── Division 04: Masonry ──
  if (r.masonry_exterior > 0) {
    add("04", "Masonry", "Exterior masonry walls", r.masonry_exterior * facadeArea, "sqm",
      `${r.masonry_exterior} ratio × ${facadeArea.toFixed(0)} sqm facade`);
  }
  if (r.masonry_interior > 0) {
    add("04", "Masonry", "Interior masonry walls", r.masonry_interior * floorArea, "sqm",
      `${r.masonry_interior} sqm/sqm × ${floorArea} sqm`);
  }

  // ── Division 05: Metals ──
  if (r.structural_steel > 0) {
    add("05", "Structural Steel", "Structural steel members", (r.structural_steel * floorArea) / 1000, "tonnes",
      `${r.structural_steel} kg/sqm × ${floorArea} sqm`);
  }
  if (r.metal_deck > 0) {
    add("05", "Metal Deck", "Composite floor deck", (r.metal_deck * floorArea) / 1000, "tonnes",
      `${r.metal_deck} kg/sqm × ${floorArea} sqm`);
  }
  if (r.misc_metals > 0) {
    add("05", "Miscellaneous Metals", "Misc. metals (stairs, railings, supports)", (r.misc_metals * floorArea) / 1000, "tonnes",
      `${r.misc_metals} kg/sqm × ${floorArea} sqm`);
  }

  // ── Division 06: Wood ──
  if (r.framing_lumber > 0) {
    add("06", "Wood Framing", "Framing lumber", r.framing_lumber * floorArea, "board-feet",
      `${r.framing_lumber} BF/sqm × ${floorArea} sqm`);
  }
  if (r.sheathing > 0) {
    add("06", "Wood Framing", "Sheathing (walls + roof)", r.sheathing * floorArea, "sqm",
      `${r.sheathing} sqm/sqm × ${floorArea} sqm`);
  }

  // ── Division 07: Thermal & Moisture ──
  const roofArea = footprint * r.roofing_sqm_ratio;
  add("07", "Roofing", "Roofing membrane/shingles", roofArea, "sqm",
    `${footprint.toFixed(0)} sqm footprint × ${r.roofing_sqm_ratio} slope factor`);
  add("07", "Insulation", "Thermal insulation (walls + roof)", r.insulation_sqm_ratio * floorArea, "sqm",
    `${r.insulation_sqm_ratio} sqm/sqm × ${floorArea} sqm`);
  add("07", "Waterproofing", "Below-grade waterproofing", r.waterproofing_sqm_ratio * floorArea, "sqm",
    `${r.waterproofing_sqm_ratio} sqm/sqm × ${floorArea} sqm`);
  add("07", "Sealants", "Joint sealants", perimeter * stories * 2, "linear-m",
    "~2 runs per floor perimeter");

  // ── Division 08: Openings ──
  const windowArea = facadeArea * wwr;
  const opaqueArea = facadeArea - windowArea;
  add("08", "Windows", "Window / glazing area", windowArea, "sqm",
    `${(wwr * 100).toFixed(0)}% WWR × ${facadeArea.toFixed(0)} sqm facade`);
  add("08", "Doors", "Exterior doors", Math.max(2, Math.ceil(perimeter / 30)), "each",
    "~1 per 30m of perimeter, min 2");
  add("08", "Doors", "Interior doors", Math.ceil((r.doors_per_100sqm / 100) * floorArea), "each",
    `${r.doors_per_100sqm} per 100 sqm`);

  // ── Division 09: Finishes ──
  add("09", "Drywall", "Gypsum board (all surfaces)", r.drywall_sqm_ratio * floorArea, "sqm",
    `${r.drywall_sqm_ratio} sqm/sqm (walls + partitions, both sides)`);
  add("09", "Ceilings", "Ceiling systems", r.ceiling_sqm_ratio * floorArea, "sqm",
    `${r.ceiling_sqm_ratio} × floor area`);
  add("09", "Flooring", "Floor finishes (all types)", r.flooring_sqm_ratio * floorArea, "sqm",
    `${r.flooring_sqm_ratio} × floor area`);
  add("09", "Painting", "Paint (walls + ceilings)", r.paint_sqm_ratio * floorArea, "sqm",
    `${r.paint_sqm_ratio} sqm/sqm (multiple coats)`);

  // ── Division 21: Fire Suppression ──
  add("21", "Sprinklers", "Sprinkler heads",
    Math.ceil((r.sprinkler_heads_per_100sqm / 100) * floorArea * mepFactor), "each",
    `${r.sprinkler_heads_per_100sqm}/100sqm × MEP factor ${mepFactor}`);
  add("21", "Sprinklers", "Sprinkler piping (estimated)", floorArea * 0.3 * mepFactor, "linear-m",
    "~0.3 m/sqm branch + main piping");

  // ── Division 22: Plumbing ──
  add("22", "Plumbing", "Plumbing piping", r.piping_m_per_sqm * floorArea * mepFactor, "linear-m",
    `${r.piping_m_per_sqm} m/sqm × MEP factor ${mepFactor}`);

  // ── Division 23: HVAC ──
  add("23", "HVAC", "Ductwork", r.ductwork_kg_per_sqm * floorArea * mepFactor, "kg",
    `${r.ductwork_kg_per_sqm} kg/sqm × MEP factor ${mepFactor}`);

  // ── Division 26: Electrical ──
  add("26", "Electrical", "Wire and cable", r.electrical_wire_m_per_sqm * floorArea * mepFactor, "linear-m",
    `${r.electrical_wire_m_per_sqm} m/sqm × MEP factor ${mepFactor}`);
  add("26", "Electrical", "Light fixtures",
    Math.ceil((r.light_fixtures_per_100sqm / 100) * floorArea * mepFactor), "each",
    `${r.light_fixtures_per_100sqm}/100sqm × MEP factor ${mepFactor}`);
  add("26", "Electrical", "Receptacles",
    Math.ceil(floorArea * 0.1 * mepFactor), "each",
    "~1 per 10 sqm adjusted for building type");

  // ── Division 31: Earthwork / Site ──
  add("31", "Site", "Topsoil (site restoration)", footprint * 0.3 * 0.15, "m³",
    "30% of footprint area at 150mm depth");

  const divisions = [...new Set(items.map((i) => i.csi_division))].sort();

  return {
    project_name,
    building_type,
    gross_area_sqm: floorArea,
    stories,
    perimeter_m: Math.round(perimeter * 100) / 100,
    floor_to_floor_m: floorToFloor,
    total_quantities: items,
    summary: {
      total_items: items.length,
      divisions_covered: divisions,
    },
    assumptions: [
      `Structure type: ${structure_type.replace(/_/g, " ")}`,
      `Building type: ${building_type} (MEP factor: ${mepFactor})`,
      `Perimeter: ${perimeter.toFixed(1)}m (${params.perimeter_m ? "provided" : "estimated from square footprint"})`,
      `Floor-to-floor height: ${floorToFloor}m`,
      `Window-to-wall ratio: ${(wwr * 100).toFixed(0)}%`,
      "Quantities are preliminary estimates based on industry ratios. Actual quantities require detailed takeoff from construction documents.",
      "All quantities rounded. Add 5-10% waste factor for ordering.",
    ],
  };
}

// ─── Text formatting ────────────────────────────────────────────────────────

function formatQuantityText(result: QuantityTakeoffResult): string {
  const lines: string[] = [
    "QUANTITY TAKEOFF ESTIMATE",
    `Project: ${result.project_name}`,
    `Building Type: ${result.building_type} | Structure: ${result.stories} stories`,
    `Gross Area: ${result.gross_area_sqm.toLocaleString()} sqm | Perimeter: ${result.perimeter_m}m | F-F Height: ${result.floor_to_floor_m}m`,
    "=".repeat(100),
    "",
  ];

  // Group by division
  const byDivision = new Map<string, QuantityItem[]>();
  for (const item of result.total_quantities) {
    const existing = byDivision.get(item.csi_division) ?? [];
    existing.push(item);
    byDivision.set(item.csi_division, existing);
  }

  const divNames: Record<string, string> = {
    "02": "Existing Conditions / Site Work",
    "03": "Concrete",
    "04": "Masonry",
    "05": "Metals",
    "06": "Wood, Plastics, Composites",
    "07": "Thermal & Moisture Protection",
    "08": "Openings",
    "09": "Finishes",
    "21": "Fire Suppression",
    "22": "Plumbing",
    "23": "HVAC",
    "26": "Electrical",
    "31": "Earthwork",
  };

  for (const [div, divItems] of byDivision) {
    lines.push(`── Division ${div}: ${divNames[div] ?? "Other"} ──`);
    lines.push(
      padR("  Item", 45) + padR("Quantity", 14) + padR("Unit", 14) + "Notes",
    );
    lines.push("  " + "-".repeat(96));

    for (const item of divItems) {
      const qtyStr = item.quantity >= 1000
        ? item.quantity.toLocaleString("en-US", { maximumFractionDigits: 1 })
        : String(item.quantity);
      lines.push(
        padR(`  ${item.item}`, 45) +
        padR(qtyStr, 14) +
        padR(item.unit, 14) +
        item.notes,
      );
    }
    lines.push("");
  }

  lines.push("ASSUMPTIONS:");
  for (const a of result.assumptions) {
    lines.push(`  - ${a}`);
  }

  return lines.join("\n");
}

function padR(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

// ─── Tool definition ────────────────────────────────────────────────────────

export function createQuantityTakeoffToolDefinition() {
  return {
    name: "quantity_takeoff",
    label: "Quantity Takeoff",
    description:
      "Generate material quantity estimates from building parameters. Covers concrete, steel, masonry, wood, envelope, finishes, and MEP quantities by CSI division.",
    parameters: {
      type: "object",
      properties: {
        project_name: {
          type: "string",
          description: "Name of the project.",
        },
        building_type: {
          type: "string",
          enum: ["residential", "commercial", "industrial", "institutional", "healthcare"],
          description:
            'Building type affects MEP intensity factors. Default: "commercial".',
          default: "commercial",
        },
        structure_type: {
          type: "string",
          enum: ["concrete_frame", "steel_frame", "wood_frame", "masonry_bearing"],
          description:
            'Structural system type affects material ratios. Default: "concrete_frame".',
          default: "concrete_frame",
        },
        gross_area_sqm: {
          type: "number",
          description: "Total gross building area in square meters.",
          minimum: 1,
        },
        stories: {
          type: "number",
          description: "Number of stories. Default: 1.",
          minimum: 1,
          default: 1,
        },
        perimeter_m: {
          type: "number",
          description:
            "Building perimeter in meters. If not provided, estimated from a square footprint.",
          minimum: 1,
        },
        floor_to_floor_m: {
          type: "number",
          description: "Floor-to-floor height in meters. Default: 3.6m.",
          minimum: 2.5,
          default: 3.6,
        },
        window_wall_ratio: {
          type: "number",
          description:
            "Window-to-wall ratio (0.0 to 1.0). If not provided, uses default for structure type.",
          minimum: 0,
          maximum: 1,
        },
        output_format: {
          type: "string",
          enum: ["text", "json"],
          description: 'Output format. Default: "text".',
          default: "text",
        },
      },
      required: ["project_name", "gross_area_sqm"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }> => {
      const params = (args ?? {}) as Record<string, unknown>;

      const projectName = String(params.project_name ?? "Untitled Project").trim();
      const grossArea = Number(params.gross_area_sqm);
      if (!grossArea || grossArea <= 0) {
        throw new Error("gross_area_sqm must be a positive number.");
      }

      const buildingType = (typeof params.building_type === "string"
        ? params.building_type.trim()
        : "commercial") as BuildingType;

      const structureType = (typeof params.structure_type === "string"
        ? params.structure_type.trim()
        : "concrete_frame") as StructureType;

      const stories = params.stories !== undefined
        ? Math.max(1, Math.round(Number(params.stories)))
        : 1;

      const perimeter = params.perimeter_m !== undefined
        ? Number(params.perimeter_m)
        : undefined;

      const floorToFloor = params.floor_to_floor_m !== undefined
        ? Number(params.floor_to_floor_m)
        : undefined;

      const windowWallRatio = params.window_wall_ratio !== undefined
        ? Number(params.window_wall_ratio)
        : undefined;

      const outputFormat = typeof params.output_format === "string" ? params.output_format : "text";

      const result = generateQuantities({
        project_name: projectName,
        building_type: buildingType,
        structure_type: structureType,
        gross_area_sqm: grossArea,
        stories,
        perimeter_m: perimeter,
        floor_to_floor_m: floorToFloor,
        window_wall_ratio: windowWallRatio,
      });

      const text = outputFormat === "json"
        ? JSON.stringify(result, null, 2)
        : formatQuantityText(result);

      return {
        content: [{ type: "text", text }],
        details: {
          project_name: result.project_name,
          total_items: result.summary.total_items,
          divisions: result.summary.divisions_covered,
        },
      };
    },
  };
}
