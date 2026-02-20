/**
 * Construction submittal log generator tool for openclaw-mini.
 *
 * Generates a submittal log based on CSI divisions and specification sections,
 * tracking required submittals (shop drawings, product data, samples, etc.)
 * with status tracking fields.
 *
 * Pure TypeScript — no external dependencies.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

type SubmittalType = "shop_drawing" | "product_data" | "sample" | "test_report" | "certificate" | "closeout";
type SubmittalStatus = "not_started" | "in_preparation" | "submitted" | "approved" | "revise_resubmit" | "rejected";

interface SubmittalItem {
  number: string;
  spec_section: string;
  description: string;
  submittal_type: SubmittalType;
  status: SubmittalStatus;
  required_by_date: string;
  notes: string;
}

interface SubmittalLogResult {
  project_name: string;
  generated_date: string;
  total_submittals: number;
  by_type: Record<string, number>;
  by_division: Record<string, number>;
  items: SubmittalItem[];
}

// ─── Submittal templates by CSI section ─────────────────────────────────────

interface SubmittalTemplate {
  spec_section: string;
  section_title: string;
  submittals: {
    description: string;
    type: SubmittalType;
    lead_time_days: number; // days before installation needed
  }[];
}

const SUBMITTAL_TEMPLATES: SubmittalTemplate[] = [
  // Division 03 - Concrete
  {
    spec_section: "03 20 00",
    section_title: "Concrete Reinforcing",
    submittals: [
      { description: "Reinforcing steel shop drawings", type: "shop_drawing", lead_time_days: 28 },
      { description: "Mill certificates for reinforcing steel", type: "certificate", lead_time_days: 21 },
    ],
  },
  {
    spec_section: "03 30 00",
    section_title: "Cast-in-Place Concrete",
    submittals: [
      { description: "Concrete mix design submittals", type: "product_data", lead_time_days: 42 },
      { description: "Concrete cylinder test reports", type: "test_report", lead_time_days: 14 },
      { description: "Formwork shop drawings", type: "shop_drawing", lead_time_days: 28 },
    ],
  },
  // Division 04 - Masonry
  {
    spec_section: "04 20 00",
    section_title: "Unit Masonry",
    submittals: [
      { description: "Masonry unit samples", type: "sample", lead_time_days: 42 },
      { description: "Mortar mix design", type: "product_data", lead_time_days: 28 },
      { description: "Masonry prism test reports", type: "test_report", lead_time_days: 28 },
    ],
  },
  // Division 05 - Metals
  {
    spec_section: "05 12 00",
    section_title: "Structural Steel Framing",
    submittals: [
      { description: "Structural steel shop drawings", type: "shop_drawing", lead_time_days: 42 },
      { description: "Mill certificates for structural steel", type: "certificate", lead_time_days: 35 },
      { description: "Welding procedure specifications (WPS)", type: "product_data", lead_time_days: 35 },
      { description: "Welder qualification records", type: "certificate", lead_time_days: 35 },
    ],
  },
  {
    spec_section: "05 50 00",
    section_title: "Metal Fabrications",
    submittals: [
      { description: "Miscellaneous metals shop drawings", type: "shop_drawing", lead_time_days: 28 },
      { description: "Finish samples for exposed metals", type: "sample", lead_time_days: 28 },
    ],
  },
  // Division 07 - Thermal & Moisture Protection
  {
    spec_section: "07 21 00",
    section_title: "Thermal Insulation",
    submittals: [
      { description: "Insulation product data", type: "product_data", lead_time_days: 21 },
      { description: "Insulation R-value test reports", type: "test_report", lead_time_days: 21 },
    ],
  },
  {
    spec_section: "07 52 00",
    section_title: "Modified Bituminous Membrane Roofing",
    submittals: [
      { description: "Roofing system product data", type: "product_data", lead_time_days: 35 },
      { description: "Roofing shop drawings and details", type: "shop_drawing", lead_time_days: 28 },
      { description: "Roofing membrane samples", type: "sample", lead_time_days: 28 },
      { description: "Installer qualification documentation", type: "certificate", lead_time_days: 28 },
      { description: "Roofing warranty documentation", type: "closeout", lead_time_days: 0 },
    ],
  },
  {
    spec_section: "07 84 00",
    section_title: "Firestopping",
    submittals: [
      { description: "Firestopping product data and UL listings", type: "product_data", lead_time_days: 21 },
      { description: "Firestopping installation details", type: "shop_drawing", lead_time_days: 21 },
    ],
  },
  // Division 08 - Openings
  {
    spec_section: "08 11 00",
    section_title: "Metal Doors and Frames",
    submittals: [
      { description: "Metal door and frame schedule shop drawings", type: "shop_drawing", lead_time_days: 42 },
      { description: "Door finish samples", type: "sample", lead_time_days: 35 },
      { description: "Fire-rated door labels/certifications", type: "certificate", lead_time_days: 35 },
    ],
  },
  {
    spec_section: "08 41 00",
    section_title: "Entrances and Storefronts",
    submittals: [
      { description: "Storefront system shop drawings", type: "shop_drawing", lead_time_days: 42 },
      { description: "Aluminum finish samples", type: "sample", lead_time_days: 35 },
      { description: "Structural calculations for wind loads", type: "product_data", lead_time_days: 35 },
    ],
  },
  {
    spec_section: "08 51 00",
    section_title: "Windows",
    submittals: [
      { description: "Window shop drawings and schedules", type: "shop_drawing", lead_time_days: 56 },
      { description: "Window performance test reports", type: "test_report", lead_time_days: 42 },
      { description: "Window finish and glass samples", type: "sample", lead_time_days: 42 },
    ],
  },
  {
    spec_section: "08 71 00",
    section_title: "Door Hardware",
    submittals: [
      { description: "Hardware schedule and cut sheets", type: "shop_drawing", lead_time_days: 42 },
      { description: "Keying schedule", type: "product_data", lead_time_days: 35 },
    ],
  },
  // Division 09 - Finishes
  {
    spec_section: "09 21 00",
    section_title: "Plaster and Gypsum Board",
    submittals: [
      { description: "Gypsum board product data", type: "product_data", lead_time_days: 14 },
      { description: "Fire-rated assembly documentation", type: "certificate", lead_time_days: 21 },
    ],
  },
  {
    spec_section: "09 30 00",
    section_title: "Tiling",
    submittals: [
      { description: "Tile product data and layout drawings", type: "shop_drawing", lead_time_days: 42 },
      { description: "Tile samples and grout color samples", type: "sample", lead_time_days: 35 },
    ],
  },
  {
    spec_section: "09 65 00",
    section_title: "Resilient Flooring",
    submittals: [
      { description: "Resilient flooring product data", type: "product_data", lead_time_days: 28 },
      { description: "Flooring samples", type: "sample", lead_time_days: 28 },
      { description: "Floor preparation test reports", type: "test_report", lead_time_days: 14 },
    ],
  },
  {
    spec_section: "09 91 00",
    section_title: "Painting",
    submittals: [
      { description: "Paint product data and color schedule", type: "product_data", lead_time_days: 21 },
      { description: "Paint color samples on substrate", type: "sample", lead_time_days: 21 },
    ],
  },
  // Division 21 - Fire Suppression
  {
    spec_section: "21 10 00",
    section_title: "Water-Based Fire-Suppression Systems",
    submittals: [
      { description: "Sprinkler system shop drawings", type: "shop_drawing", lead_time_days: 42 },
      { description: "Sprinkler head product data", type: "product_data", lead_time_days: 35 },
      { description: "Hydraulic calculations", type: "product_data", lead_time_days: 35 },
    ],
  },
  // Division 22 - Plumbing
  {
    spec_section: "22 10 00",
    section_title: "Plumbing Piping and Pumps",
    submittals: [
      { description: "Plumbing piping shop drawings", type: "shop_drawing", lead_time_days: 28 },
      { description: "Pipe and fitting product data", type: "product_data", lead_time_days: 21 },
    ],
  },
  {
    spec_section: "22 40 00",
    section_title: "Plumbing Fixtures",
    submittals: [
      { description: "Plumbing fixture product data", type: "product_data", lead_time_days: 56 },
      { description: "Fixture rough-in dimensions", type: "shop_drawing", lead_time_days: 28 },
    ],
  },
  // Division 23 - HVAC
  {
    spec_section: "23 05 00",
    section_title: "Common Work Results for HVAC",
    submittals: [
      { description: "HVAC equipment schedules", type: "shop_drawing", lead_time_days: 42 },
      { description: "HVAC piping and duct product data", type: "product_data", lead_time_days: 35 },
    ],
  },
  {
    spec_section: "23 73 00",
    section_title: "Indoor Central-Station Air-Handling Units",
    submittals: [
      { description: "AHU shop drawings and performance data", type: "shop_drawing", lead_time_days: 56 },
      { description: "AHU sound and vibration data", type: "test_report", lead_time_days: 42 },
    ],
  },
  // Division 26 - Electrical
  {
    spec_section: "26 05 00",
    section_title: "Common Work Results for Electrical",
    submittals: [
      { description: "Electrical riser diagrams", type: "shop_drawing", lead_time_days: 28 },
      { description: "Wire and cable product data", type: "product_data", lead_time_days: 21 },
    ],
  },
  {
    spec_section: "26 24 00",
    section_title: "Switchboards and Panelboards",
    submittals: [
      { description: "Switchboard/panelboard shop drawings", type: "shop_drawing", lead_time_days: 56 },
      { description: "Short circuit and coordination study", type: "test_report", lead_time_days: 42 },
    ],
  },
  {
    spec_section: "26 50 00",
    section_title: "Lighting",
    submittals: [
      { description: "Lighting fixture product data and cut sheets", type: "product_data", lead_time_days: 42 },
      { description: "Lighting fixture samples", type: "sample", lead_time_days: 35 },
      { description: "Lighting control system shop drawings", type: "shop_drawing", lead_time_days: 42 },
    ],
  },
  // Division 28 - Electronic Safety and Security
  {
    spec_section: "28 31 00",
    section_title: "Fire Detection and Alarm",
    submittals: [
      { description: "Fire alarm system shop drawings", type: "shop_drawing", lead_time_days: 42 },
      { description: "Fire alarm device product data", type: "product_data", lead_time_days: 35 },
      { description: "Fire alarm system programming and sequences", type: "product_data", lead_time_days: 28 },
    ],
  },
];

// Building type to relevant division prefixes
const BUILDING_TYPE_DIVISIONS: Record<string, string[]> = {
  residential: ["03", "04", "06", "07", "08", "09", "22", "23", "26"],
  commercial: ["03", "04", "05", "07", "08", "09", "21", "22", "23", "26", "28"],
  industrial: ["03", "05", "07", "08", "09", "21", "22", "23", "26"],
  institutional: ["03", "04", "05", "07", "08", "09", "21", "22", "23", "26", "28"],
  healthcare: ["03", "05", "07", "08", "09", "21", "22", "23", "26", "28"],
};

// ─── Submittal log generation ───────────────────────────────────────────────

function generateSubmittalLog(params: {
  project_name: string;
  building_type?: string;
  divisions?: string[];
  construction_start_date?: string;
}): SubmittalLogResult {
  const projectName = params.project_name;
  const buildingType = params.building_type ?? "commercial";
  const startDateStr = params.construction_start_date ?? new Date().toISOString().split("T")[0]!;
  const startDate = new Date(startDateStr);

  // Determine relevant divisions
  let divisionPrefixes: string[];
  if (params.divisions && params.divisions.length > 0) {
    divisionPrefixes = params.divisions;
  } else {
    const typeKey = Object.keys(BUILDING_TYPE_DIVISIONS).find((k) =>
      buildingType.toLowerCase().includes(k),
    ) ?? "commercial";
    divisionPrefixes = BUILDING_TYPE_DIVISIONS[typeKey]!;
  }

  const divisionSet = new Set(divisionPrefixes);

  // Filter templates to relevant divisions
  const relevantTemplates = SUBMITTAL_TEMPLATES.filter((tmpl) => {
    const divPrefix = tmpl.spec_section.slice(0, 2);
    return divisionSet.has(divPrefix);
  });

  // Generate submittal items
  const items: SubmittalItem[] = [];
  let submittalNum = 1;

  const byType: Record<string, number> = {};
  const byDivision: Record<string, number> = {};

  for (const tmpl of relevantTemplates) {
    const divPrefix = tmpl.spec_section.slice(0, 2);

    for (const sub of tmpl.submittals) {
      const numberStr = String(submittalNum).padStart(3, "0");
      const requiredByDate = new Date(startDate);
      requiredByDate.setDate(requiredByDate.getDate() - sub.lead_time_days);

      items.push({
        number: `SUB-${numberStr}`,
        spec_section: tmpl.spec_section,
        description: sub.description,
        submittal_type: sub.type,
        status: "not_started",
        required_by_date: requiredByDate.toISOString().split("T")[0]!,
        notes: `${tmpl.section_title} — ${sub.lead_time_days} day lead time`,
      });

      byType[sub.type] = (byType[sub.type] ?? 0) + 1;
      byDivision[divPrefix] = (byDivision[divPrefix] ?? 0) + 1;
      submittalNum++;
    }
  }

  return {
    project_name: projectName,
    generated_date: new Date().toISOString().split("T")[0]!,
    total_submittals: items.length,
    by_type: byType,
    by_division: byDivision,
    items,
  };
}

// ─── Text formatting ────────────────────────────────────────────────────────

function formatSubmittalLogText(result: SubmittalLogResult): string {
  const lines: string[] = [
    "SUBMITTAL LOG",
    `Project: ${result.project_name}`,
    `Generated: ${result.generated_date}`,
    `Total Submittals: ${result.total_submittals}`,
    "=".repeat(110),
    "",
    "SUMMARY BY TYPE:",
  ];

  const typeLabels: Record<string, string> = {
    shop_drawing: "Shop Drawings",
    product_data: "Product Data",
    sample: "Samples",
    test_report: "Test Reports",
    certificate: "Certificates",
    closeout: "Closeout Documents",
  };

  for (const [type, count] of Object.entries(result.by_type)) {
    lines.push(`  ${typeLabels[type] ?? type}: ${count}`);
  }

  lines.push("");
  lines.push("-".repeat(110));
  lines.push(
    padR("No.", 10) +
    padR("Spec Section", 14) +
    padR("Description", 48) +
    padR("Type", 16) +
    padR("Required By", 14) +
    "Status",
  );
  lines.push("-".repeat(110));

  for (const item of result.items) {
    lines.push(
      padR(item.number, 10) +
      padR(item.spec_section, 14) +
      padR(truncate(item.description, 46), 48) +
      padR(typeLabels[item.submittal_type] ?? item.submittal_type, 16) +
      padR(item.required_by_date, 14) +
      item.status.replace(/_/g, " "),
    );
  }

  lines.push("");
  lines.push("NOTES:");
  lines.push("- Required By dates are calculated from construction start date minus lead time.");
  lines.push("- Update status as submittals progress through review cycle.");
  lines.push("- Closeout submittals are due at project completion (no lead time).");

  return lines.join("\n");
}

function padR(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

function truncate(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max - 3) + "...";
}

// ─── Tool definition ────────────────────────────────────────────────────────

export function createSubmittalLogToolDefinition() {
  return {
    name: "submittal_log",
    label: "Submittal Log",
    description:
      "Generate a construction submittal log with required submittals (shop drawings, product data, samples, test reports) organized by CSI specification section.",
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
            'Building type determines which CSI divisions are included. Default: "commercial".',
          default: "commercial",
        },
        divisions: {
          type: "array",
          items: { type: "string" },
          description:
            'Specific CSI division numbers to include (e.g. ["03", "05", "26"]). Overrides building_type defaults.',
        },
        construction_start_date: {
          type: "string",
          description:
            "Planned construction start date (YYYY-MM-DD). Used to calculate required-by dates. Default: today.",
        },
        output_format: {
          type: "string",
          enum: ["text", "json"],
          description: 'Output format. Default: "text".',
          default: "text",
        },
      },
      required: ["project_name"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }> => {
      const params = (args ?? {}) as Record<string, unknown>;

      const projectName = String(params.project_name ?? "Untitled Project").trim();
      const buildingType = typeof params.building_type === "string" ? params.building_type.trim() : undefined;
      const divisions = Array.isArray(params.divisions)
        ? (params.divisions as string[]).map((d) => String(d).trim().padStart(2, "0"))
        : undefined;
      const constructionStartDate = typeof params.construction_start_date === "string"
        ? params.construction_start_date.trim()
        : undefined;
      const outputFormat = typeof params.output_format === "string" ? params.output_format : "text";

      const result = generateSubmittalLog({
        project_name: projectName,
        building_type: buildingType,
        divisions,
        construction_start_date: constructionStartDate,
      });

      const text = outputFormat === "json"
        ? JSON.stringify(result, null, 2)
        : formatSubmittalLogText(result);

      return {
        content: [{ type: "text", text }],
        details: {
          project_name: result.project_name,
          total_submittals: result.total_submittals,
          by_type: result.by_type,
        },
      };
    },
  };
}
