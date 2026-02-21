/**
 * Project specification writer tool for civilclaw.
 *
 * Generates structured construction specification outlines following
 * CSI MasterFormat organization. Produces spec sections with standard
 * three-part format (General / Products / Execution).
 *
 * Pure TypeScript — no external dependencies.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

interface SpecSection {
  number: string;
  title: string;
  part1_general: string[];
  part2_products: string[];
  part3_execution: string[];
}

interface SpecResult {
  project_name: string;
  spec_date: string;
  sections: SpecSection[];
  notes: string[];
}

// ─── CSI Division / Section Templates ───────────────────────────────────────

const DIVISION_TEMPLATES: Record<string, { title: string; sections: { number: string; title: string }[] }> = {
  "01": {
    title: "General Requirements",
    sections: [
      { number: "01 10 00", title: "Summary" },
      { number: "01 25 00", title: "Substitution Procedures" },
      { number: "01 30 00", title: "Administrative Requirements" },
      { number: "01 40 00", title: "Quality Requirements" },
      { number: "01 50 00", title: "Temporary Facilities and Controls" },
      { number: "01 60 00", title: "Product Requirements" },
      { number: "01 70 00", title: "Execution and Closeout Requirements" },
      { number: "01 78 00", title: "Closeout Submittals" },
    ],
  },
  "03": {
    title: "Concrete",
    sections: [
      { number: "03 10 00", title: "Concrete Forming and Accessories" },
      { number: "03 20 00", title: "Concrete Reinforcing" },
      { number: "03 30 00", title: "Cast-in-Place Concrete" },
      { number: "03 35 00", title: "Concrete Finishing" },
    ],
  },
  "04": {
    title: "Masonry",
    sections: [
      { number: "04 20 00", title: "Unit Masonry" },
      { number: "04 70 00", title: "Manufactured Masonry" },
    ],
  },
  "05": {
    title: "Metals",
    sections: [
      { number: "05 12 00", title: "Structural Steel Framing" },
      { number: "05 21 00", title: "Steel Joist Framing" },
      { number: "05 31 00", title: "Steel Decking" },
      { number: "05 50 00", title: "Metal Fabrications" },
      { number: "05 51 00", title: "Metal Stairs" },
    ],
  },
  "06": {
    title: "Wood, Plastics, and Composites",
    sections: [
      { number: "06 10 00", title: "Rough Carpentry" },
      { number: "06 20 00", title: "Finish Carpentry" },
      { number: "06 40 00", title: "Architectural Woodwork" },
    ],
  },
  "07": {
    title: "Thermal and Moisture Protection",
    sections: [
      { number: "07 10 00", title: "Dampproofing and Waterproofing" },
      { number: "07 21 00", title: "Thermal Insulation" },
      { number: "07 26 00", title: "Vapor Retarders" },
      { number: "07 41 00", title: "Roof Panels" },
      { number: "07 52 00", title: "Modified Bituminous Membrane Roofing" },
      { number: "07 62 00", title: "Sheet Metal Flashing and Trim" },
      { number: "07 84 00", title: "Firestopping" },
      { number: "07 92 00", title: "Joint Sealants" },
    ],
  },
  "08": {
    title: "Openings",
    sections: [
      { number: "08 11 00", title: "Metal Doors and Frames" },
      { number: "08 14 00", title: "Wood Doors" },
      { number: "08 33 00", title: "Coiling Doors and Grilles" },
      { number: "08 41 00", title: "Entrances and Storefronts" },
      { number: "08 51 00", title: "Windows" },
      { number: "08 71 00", title: "Door Hardware" },
      { number: "08 80 00", title: "Glazing" },
    ],
  },
  "09": {
    title: "Finishes",
    sections: [
      { number: "09 21 00", title: "Plaster and Gypsum Board Assemblies" },
      { number: "09 30 00", title: "Tiling" },
      { number: "09 51 00", title: "Acoustical Ceilings" },
      { number: "09 65 00", title: "Resilient Flooring" },
      { number: "09 68 00", title: "Carpeting" },
      { number: "09 91 00", title: "Painting" },
    ],
  },
  "10": {
    title: "Specialties",
    sections: [
      { number: "10 14 00", title: "Signage" },
      { number: "10 21 00", title: "Compartments and Cubicles" },
      { number: "10 28 00", title: "Toilet, Bath, and Laundry Accessories" },
      { number: "10 44 00", title: "Fire Protection Specialties" },
    ],
  },
  "21": {
    title: "Fire Suppression",
    sections: [
      { number: "21 10 00", title: "Water-Based Fire-Suppression Systems" },
      { number: "21 30 00", title: "Fire Pumps" },
    ],
  },
  "22": {
    title: "Plumbing",
    sections: [
      { number: "22 05 00", title: "Common Work Results for Plumbing" },
      { number: "22 10 00", title: "Plumbing Piping and Pumps" },
      { number: "22 40 00", title: "Plumbing Fixtures" },
    ],
  },
  "23": {
    title: "Heating, Ventilating, and Air Conditioning (HVAC)",
    sections: [
      { number: "23 05 00", title: "Common Work Results for HVAC" },
      { number: "23 09 00", title: "Instrumentation and Control for HVAC" },
      { number: "23 21 00", title: "Hydronic Piping and Pumps" },
      { number: "23 31 00", title: "HVAC Ducts and Casings" },
      { number: "23 73 00", title: "Indoor Central-Station Air-Handling Units" },
      { number: "23 81 00", title: "Decentralized Unitary HVAC Equipment" },
    ],
  },
  "26": {
    title: "Electrical",
    sections: [
      { number: "26 05 00", title: "Common Work Results for Electrical" },
      { number: "26 24 00", title: "Switchboards and Panelboards" },
      { number: "26 27 00", title: "Low-Voltage Distribution Equipment" },
      { number: "26 28 00", title: "Low-Voltage Circuit Protective Devices" },
      { number: "26 50 00", title: "Lighting" },
    ],
  },
  "27": {
    title: "Communications",
    sections: [
      { number: "27 10 00", title: "Structured Cabling" },
      { number: "27 51 00", title: "Distributed Audio-Video Communications Systems" },
    ],
  },
  "28": {
    title: "Electronic Safety and Security",
    sections: [
      { number: "28 10 00", title: "Electronic Access Control and Intrusion Detection" },
      { number: "28 31 00", title: "Fire Detection and Alarm" },
    ],
  },
  "31": {
    title: "Earthwork",
    sections: [
      { number: "31 10 00", title: "Site Clearing" },
      { number: "31 20 00", title: "Earth Moving" },
      { number: "31 23 00", title: "Excavation and Fill" },
      { number: "31 60 00", title: "Special Foundations and Load-Bearing Elements" },
    ],
  },
  "32": {
    title: "Exterior Improvements",
    sections: [
      { number: "32 10 00", title: "Bases, Ballasts, and Paving" },
      { number: "32 31 00", title: "Fences and Gates" },
      { number: "32 90 00", title: "Planting" },
    ],
  },
  "33": {
    title: "Utilities",
    sections: [
      { number: "33 10 00", title: "Water Utilities" },
      { number: "33 30 00", title: "Sanitary Sewerage Utilities" },
      { number: "33 40 00", title: "Storm Drainage Utilities" },
    ],
  },
};

// Building-type to relevant divisions mapping
const BUILDING_TYPE_DIVISIONS: Record<string, string[]> = {
  residential: ["01", "03", "06", "07", "08", "09", "10", "22", "23", "26", "27", "31", "32"],
  commercial: ["01", "03", "05", "07", "08", "09", "10", "21", "22", "23", "26", "27", "28", "31", "32", "33"],
  industrial: ["01", "03", "04", "05", "07", "08", "09", "21", "22", "23", "26", "31", "33"],
  institutional: ["01", "03", "04", "05", "07", "08", "09", "10", "21", "22", "23", "26", "27", "28", "31", "32"],
  healthcare: ["01", "03", "05", "07", "08", "09", "10", "21", "22", "23", "26", "27", "28", "31", "32", "33"],
};

// ─── Three-part section content templates ───────────────────────────────────

function generatePart1General(sectionNumber: string, sectionTitle: string): string[] {
  const items = [
    "1.01 SUMMARY",
    `  A. Section includes: ${sectionTitle}.`,
    `  B. Related sections: Refer to drawings and other specification sections for related requirements.`,
    "",
    "1.02 REFERENCES",
    "  A. Comply with applicable codes, standards, and industry references.",
    "",
    "1.03 SUBMITTALS",
    "  A. Product data: Submit manufacturer's product data for each product.",
    "  B. Shop drawings: Submit shop drawings showing layout, profiles, and connections.",
    "  C. Samples: Submit samples of exposed finishes as applicable.",
    "",
    "1.04 QUALITY ASSURANCE",
    "  A. Installer qualifications: Engage an experienced installer with a minimum of 3 years documented experience.",
    "  B. Regulatory requirements: Comply with applicable building code requirements.",
    "",
    "1.05 DELIVERY, STORAGE, AND HANDLING",
    "  A. Deliver products in manufacturer's original, unopened, undamaged containers.",
    "  B. Store products in dry, ventilated areas protected from damage.",
    "",
    "1.06 WARRANTY",
    "  A. Provide manufacturer's standard warranty.",
  ];
  return items;
}

function generatePart2Products(sectionNumber: string, sectionTitle: string): string[] {
  const items = [
    "2.01 MATERIALS",
    `  A. ${sectionTitle}: As indicated on drawings and specified herein.`,
    "  B. Comply with referenced standards for material properties and performance.",
    "",
    "2.02 MANUFACTURERS",
    "  A. Basis of design: As indicated on drawings.",
    "  B. Substitutions: Submit in accordance with Section 01 25 00.",
    "",
    "2.03 FABRICATION",
    "  A. Fabricate items to sizes, shapes, and profiles indicated.",
    "  B. Factory-finish items where indicated.",
  ];
  return items;
}

function generatePart3Execution(sectionNumber: string, sectionTitle: string): string[] {
  const items = [
    "3.01 EXAMINATION",
    "  A. Verify site conditions and substrates are acceptable before beginning work.",
    "  B. Report unsatisfactory conditions to Architect; do not proceed until corrected.",
    "",
    "3.02 PREPARATION",
    "  A. Prepare substrates in accordance with manufacturer's recommendations.",
    "  B. Protect adjacent work from damage during installation.",
    "",
    "3.03 INSTALLATION",
    `  A. Install ${sectionTitle.toLowerCase()} in accordance with manufacturer's instructions and referenced standards.`,
    "  B. Coordinate with other trades as required.",
    "  C. Maintain clearances, tolerances, and alignment as indicated.",
    "",
    "3.04 CLEANING",
    "  A. Clean installed work upon completion.",
    "  B. Remove construction debris from site.",
    "",
    "3.05 PROTECTION",
    "  A. Protect installed work from damage until Substantial Completion.",
  ];
  return items;
}

// ─── Spec generation ────────────────────────────────────────────────────────

function generateSpec(params: {
  project_name: string;
  building_type?: string;
  divisions?: string[];
  sections?: string[];
}): SpecResult {
  const projectName = params.project_name;
  const buildingType = params.building_type ?? "commercial";

  // Determine which divisions to include
  let divisionKeys: string[];
  if (params.divisions && params.divisions.length > 0) {
    divisionKeys = params.divisions;
  } else {
    const typeKey = Object.keys(BUILDING_TYPE_DIVISIONS).find((k) =>
      buildingType.toLowerCase().includes(k),
    ) ?? "commercial";
    divisionKeys = BUILDING_TYPE_DIVISIONS[typeKey]!;
  }

  // Filter to specific sections if requested
  const requestedSections = params.sections
    ? new Set(params.sections.map((s) => s.replace(/\s/g, "")))
    : null;

  const specSections: SpecSection[] = [];

  for (const divKey of divisionKeys) {
    const divTemplate = DIVISION_TEMPLATES[divKey];
    if (!divTemplate) continue;

    for (const sec of divTemplate.sections) {
      // If specific sections were requested, filter
      if (requestedSections) {
        const normalized = sec.number.replace(/\s/g, "");
        if (!requestedSections.has(normalized)) continue;
      }

      specSections.push({
        number: sec.number,
        title: sec.title,
        part1_general: generatePart1General(sec.number, sec.title),
        part2_products: generatePart2Products(sec.number, sec.title),
        part3_execution: generatePart3Execution(sec.number, sec.title),
      });
    }
  }

  return {
    project_name: projectName,
    spec_date: new Date().toISOString().split("T")[0]!,
    sections: specSections,
    notes: [
      "This is an outline specification. Project-specific requirements, products, and details must be added by the specifier.",
      "Coordinate with project drawings and other contract documents.",
      "Verify applicable code edition and local amendments.",
    ],
  };
}

// ─── Format as text ─────────────────────────────────────────────────────────

function formatSpecText(result: SpecResult): string {
  const lines: string[] = [
    `PROJECT SPECIFICATIONS`,
    `Project: ${result.project_name}`,
    `Date: ${result.spec_date}`,
    `${"=".repeat(72)}`,
    "",
  ];

  for (const section of result.sections) {
    lines.push(`SECTION ${section.number} — ${section.title.toUpperCase()}`);
    lines.push("-".repeat(72));
    lines.push("");
    lines.push("PART 1 — GENERAL");
    lines.push(...section.part1_general);
    lines.push("");
    lines.push("PART 2 — PRODUCTS");
    lines.push(...section.part2_products);
    lines.push("");
    lines.push("PART 3 — EXECUTION");
    lines.push(...section.part3_execution);
    lines.push("");
    lines.push("END OF SECTION");
    lines.push("");
    lines.push("");
  }

  if (result.notes.length > 0) {
    lines.push("NOTES:");
    for (const note of result.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n");
}

// ─── Tool definition ────────────────────────────────────────────────────────

export function createSpecWriterToolDefinition() {
  return {
    name: "spec_writer",
    label: "Specification Writer",
    description:
      "Generate construction specification outlines following CSI MasterFormat with standard three-part section format (General / Products / Execution).",
    parameters: {
      type: "object",
      properties: {
        project_name: {
          type: "string",
          description: "Name of the project for the specification header.",
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
            'Specific CSI division numbers to include (e.g. ["03", "05", "09"]). Overrides building_type defaults.',
        },
        sections: {
          type: "array",
          items: { type: "string" },
          description:
            'Specific section numbers to include (e.g. ["03 30 00", "05 12 00"]). When provided, only these sections are generated.',
        },
        output_format: {
          type: "string",
          enum: ["text", "json"],
          description: 'Output format. "text" returns formatted spec text, "json" returns structured data. Default: "text".',
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
      const sections = Array.isArray(params.sections)
        ? (params.sections as string[]).map((s) => String(s).trim())
        : undefined;
      const outputFormat = typeof params.output_format === "string" ? params.output_format : "text";

      const result = generateSpec({
        project_name: projectName,
        building_type: buildingType,
        divisions,
        sections,
      });

      const text = outputFormat === "json"
        ? JSON.stringify(result, null, 2)
        : formatSpecText(result);

      return {
        content: [{ type: "text", text }],
        details: {
          project_name: result.project_name,
          section_count: result.sections.length,
          sections: result.sections.map((s) => `${s.number} ${s.title}`),
        },
      };
    },
  };
}
