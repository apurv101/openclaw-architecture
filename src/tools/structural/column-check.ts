/**
 * Structural Column Check tool for openclaw-mini.
 *
 * Checks a column for axial capacity, buckling, and combined axial+bending
 * interaction per AISC 360 (steel) or ACI 318 (concrete).
 *
 * Supports steel wide-flange, HSS rectangular, HSS round, concrete rectangular,
 * and concrete circular columns.
 *
 * No external dependencies beyond Node.js built-ins.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

type ColumnType =
  | "steel_wide_flange"
  | "steel_hss_rectangular"
  | "steel_hss_round"
  | "concrete_rectangular"
  | "concrete_circular";

interface SteelWFSection {
  depth_mm: number;
  flange_width_mm: number;
  flange_thickness_mm: number;
  web_thickness_mm: number;
}

interface SteelHSSRectSection {
  width_mm: number;
  depth_mm: number;
  thickness_mm: number;
}

interface SteelHSSRoundSection {
  diameter_mm: number;
  thickness_mm: number;
}

interface ConcreteRectSection {
  width_mm: number;
  depth_mm: number;
  rebar_count: number;
  rebar_diameter_mm: number;
  cover_mm: number;
}

interface ConcreteCircSection {
  diameter_mm: number;
  rebar_count: number;
  rebar_diameter_mm: number;
  cover_mm: number;
}

type SectionInput =
  | SteelWFSection
  | SteelHSSRectSection
  | SteelHSSRoundSection
  | ConcreteRectSection
  | ConcreteCircSection;

interface SteelMaterial {
  E_mpa: number;
  fy_mpa: number;
}

interface ConcreteMaterial {
  fc_mpa: number;
  fy_mpa: number;
  Es_mpa: number;
}

interface ColumnParams {
  column_type: ColumnType;
  height_m: number;
  axial_load_kn: number;
  moment_x_knm?: number;
  moment_y_knm?: number;
  section: SectionInput;
  effective_length_factor?: number;
  material?: SteelMaterial | ConcreteMaterial;
}

// ─── Section property calculators ────────────────────────────────────────────

interface SectionProperties {
  A_mm2: number;
  Ix_mm4: number;
  Iy_mm4: number;
  rx_mm: number;
  ry_mm: number;
  Sx_mm3: number;
  Sy_mm3: number;
  Zx_mm3: number;
  Zy_mm3: number;
}

/**
 * Calculate section properties for a steel wide-flange section.
 * Uses the idealized I-shape: two flanges + web.
 */
function calcWFProperties(s: SteelWFSection): SectionProperties {
  const d = s.depth_mm;
  const bf = s.flange_width_mm;
  const tf = s.flange_thickness_mm;
  const tw = s.web_thickness_mm;
  const hw = d - 2 * tf; // web clear height

  // Area = 2 flanges + web
  const A = 2 * bf * tf + hw * tw;

  // Strong-axis moment of inertia (Ix) about centroid
  // Ix = (bf * d^3 - (bf - tw) * hw^3) / 12
  const Ix = (bf * Math.pow(d, 3) - (bf - tw) * Math.pow(hw, 3)) / 12;

  // Weak-axis moment of inertia (Iy)
  // Iy = 2 * (tf * bf^3 / 12) + hw * tw^3 / 12
  const Iy = (2 * tf * Math.pow(bf, 3) + hw * Math.pow(tw, 3)) / 12;

  const rx = Math.sqrt(Ix / A);
  const ry = Math.sqrt(Iy / A);

  // Elastic section moduli
  const Sx = (2 * Ix) / d;
  const Sy = (2 * Iy) / bf;

  // Plastic section moduli (approximate for I-shape)
  // Zx = bf*tf*(d-tf) + tw*hw^2/4
  const Zx = bf * tf * (d - tf) + tw * Math.pow(hw, 2) / 4;
  // Zy = 2*(tf*bf^2/4) + hw*tw^2/4
  const Zy = tf * Math.pow(bf, 2) / 2 + hw * Math.pow(tw, 2) / 4;

  return { A_mm2: A, Ix_mm4: Ix, Iy_mm4: Iy, rx_mm: rx, ry_mm: ry, Sx_mm3: Sx, Sy_mm3: Sy, Zx_mm3: Zx, Zy_mm3: Zy };
}

/**
 * Calculate section properties for a rectangular HSS (hollow structural section).
 */
function calcHSSRectProperties(s: SteelHSSRectSection): SectionProperties {
  const B = s.width_mm;
  const H = s.depth_mm;
  const t = s.thickness_mm;

  // Outer and inner dimensions
  const Bi = B - 2 * t;
  const Hi = H - 2 * t;

  const A = B * H - Bi * Hi;

  // Strong axis (about depth)
  const Ix = (B * Math.pow(H, 3) - Bi * Math.pow(Hi, 3)) / 12;
  // Weak axis (about width)
  const Iy = (H * Math.pow(B, 3) - Hi * Math.pow(Bi, 3)) / 12;

  const rx = Math.sqrt(Ix / A);
  const ry = Math.sqrt(Iy / A);

  const Sx = (2 * Ix) / H;
  const Sy = (2 * Iy) / B;

  // Plastic section moduli for rectangular hollow section
  const Zx = B * Math.pow(H, 2) / 4 - Bi * Math.pow(Hi, 2) / 4;
  const Zy = H * Math.pow(B, 2) / 4 - Hi * Math.pow(Bi, 2) / 4;

  return { A_mm2: A, Ix_mm4: Ix, Iy_mm4: Iy, rx_mm: rx, ry_mm: ry, Sx_mm3: Sx, Sy_mm3: Sy, Zx_mm3: Zx, Zy_mm3: Zy };
}

/**
 * Calculate section properties for a circular HSS (hollow round tube).
 */
function calcHSSRoundProperties(s: SteelHSSRoundSection): SectionProperties {
  const D = s.diameter_mm;
  const t = s.thickness_mm;
  const Di = D - 2 * t;

  // Area of annulus
  const A = (Math.PI / 4) * (Math.pow(D, 2) - Math.pow(Di, 2));

  // Moment of inertia (same about both axes by symmetry)
  const I = (Math.PI / 64) * (Math.pow(D, 4) - Math.pow(Di, 4));

  const r = Math.sqrt(I / A);

  // Elastic section modulus
  const S = (2 * I) / D;

  // Plastic section modulus for hollow circular section
  const Z = (1 / 6) * (Math.pow(D, 3) - Math.pow(Di, 3));

  return { A_mm2: A, Ix_mm4: I, Iy_mm4: I, rx_mm: r, ry_mm: r, Sx_mm3: S, Sy_mm3: S, Zx_mm3: Z, Zy_mm3: Z };
}

// ─── Steel column check (AISC 360) ──────────────────────────────────────────

interface SteelColumnResult {
  column_type: ColumnType;
  section_properties: {
    A_mm2: number;
    Ix_mm4: number;
    Iy_mm4: number;
    rx_mm: number;
    ry_mm: number;
  };
  slenderness_ratio: { KLr_x: number; KLr_y: number; governing: number };
  euler_load_kn: number;
  Fcr_mpa: number;
  nominal_capacity_kn: number;
  design_capacity_kn: number;
  applied_load_kn: number;
  utilization_ratio: number;
  interaction_check?: {
    equation_used: string;
    Mux_knm: number;
    Muy_knm: number;
    phi_Mnx_knm: number;
    phi_Mny_knm: number;
    interaction_value: number;
    status: "PASS" | "FAIL";
  };
  status: "PASS" | "FAIL";
}

function checkSteelColumn(params: ColumnParams, props: SectionProperties, mat: SteelMaterial): SteelColumnResult {
  const K = params.effective_length_factor ?? 1.0;
  const L_mm = params.height_m * 1000; // convert m to mm
  const Pu = params.axial_load_kn; // kN (compression positive)
  const Mux = params.moment_x_knm ?? 0;
  const Muy = params.moment_y_knm ?? 0;

  const E = mat.E_mpa;
  const Fy = mat.fy_mpa;

  // Slenderness ratios
  const KLr_x = (K * L_mm) / props.rx_mm;
  const KLr_y = (K * L_mm) / props.ry_mm;
  const KLr_gov = Math.max(KLr_x, KLr_y);

  // Euler critical stress: Fe = pi^2 * E / (KL/r)^2
  const Fe = (Math.pow(Math.PI, 2) * E) / Math.pow(KLr_gov, 2);

  // Euler buckling load (kN)
  const Pe_kn = (Fe * props.A_mm2) / 1000;

  // AISC critical stress Fcr
  // Transition slenderness: 4.71 * sqrt(E / Fy)
  const transitionKLr = 4.71 * Math.sqrt(E / Fy);
  let Fcr: number;

  if (KLr_gov <= transitionKLr) {
    // Inelastic buckling: Fcr = 0.658^(Fy/Fe) * Fy
    Fcr = Math.pow(0.658, Fy / Fe) * Fy;
  } else {
    // Elastic buckling: Fcr = 0.877 * Fe
    Fcr = 0.877 * Fe;
  }

  // Nominal compressive strength: Pn = Fcr * A
  const Pn_kn = (Fcr * props.A_mm2) / 1000;

  // Design compressive strength: phi * Pn (phi_c = 0.90 per AISC)
  const phi_c = 0.90;
  const phiPn_kn = phi_c * Pn_kn;

  // Utilization for pure axial
  const utilization = Pu / phiPn_kn;

  // Interaction check if moments are present (AISC H1-1)
  let interaction: SteelColumnResult["interaction_check"] = undefined;
  const hasMoments = Math.abs(Mux) > 1e-6 || Math.abs(Muy) > 1e-6;

  if (hasMoments) {
    // Nominal flexural strengths (assume compact sections, Mp = Fy * Z)
    const phi_b = 0.90;
    const Mnx_knm = (Fy * props.Zx_mm3) / 1e6; // N*mm -> kN*m
    const Mny_knm = (Fy * props.Zy_mm3) / 1e6;
    const phiMnx = phi_b * Mnx_knm;
    const phiMny = phi_b * Mny_knm;

    let interactionValue: number;
    let eqUsed: string;

    const ratio_axial = Pu / phiPn_kn;

    if (ratio_axial >= 0.2) {
      // AISC H1-1a: Pu/(phi*Pn) + 8/9 * (Mux/(phi*Mnx) + Muy/(phi*Mny)) <= 1.0
      interactionValue =
        ratio_axial + (8 / 9) * (Math.abs(Mux) / phiMnx + Math.abs(Muy) / phiMny);
      eqUsed = "H1-1a: Pu/(φPn) + 8/9·(Mux/(φMnx) + Muy/(φMny)) ≤ 1.0";
    } else {
      // AISC H1-1b: Pu/(2*phi*Pn) + (Mux/(phi*Mnx) + Muy/(phi*Mny)) <= 1.0
      interactionValue =
        ratio_axial / 2 + (Math.abs(Mux) / phiMnx + Math.abs(Muy) / phiMny);
      eqUsed = "H1-1b: Pu/(2φPn) + (Mux/(φMnx) + Muy/(φMny)) ≤ 1.0";
    }

    interaction = {
      equation_used: eqUsed,
      Mux_knm: Mux,
      Muy_knm: Muy,
      phi_Mnx_knm: round(phiMnx, 2),
      phi_Mny_knm: round(phiMny, 2),
      interaction_value: round(interactionValue, 4),
      status: interactionValue <= 1.0 ? "PASS" : "FAIL",
    };
  }

  // Overall status
  const axialPass = utilization <= 1.0;
  const interactionPass = interaction ? interaction.status === "PASS" : true;
  const overallStatus = axialPass && interactionPass ? "PASS" : "FAIL";

  return {
    column_type: params.column_type,
    section_properties: {
      A_mm2: round(props.A_mm2, 1),
      Ix_mm4: round(props.Ix_mm4, 0),
      Iy_mm4: round(props.Iy_mm4, 0),
      rx_mm: round(props.rx_mm, 2),
      ry_mm: round(props.ry_mm, 2),
    },
    slenderness_ratio: {
      KLr_x: round(KLr_x, 2),
      KLr_y: round(KLr_y, 2),
      governing: round(KLr_gov, 2),
    },
    euler_load_kn: round(Pe_kn, 2),
    Fcr_mpa: round(Fcr, 2),
    nominal_capacity_kn: round(Pn_kn, 2),
    design_capacity_kn: round(phiPn_kn, 2),
    applied_load_kn: round(Pu, 2),
    utilization_ratio: round(utilization, 4),
    interaction_check: interaction,
    status: overallStatus,
  };
}

// ─── Concrete column check (ACI 318) ────────────────────────────────────────

interface ConcreteColumnResult {
  column_type: ColumnType;
  section_properties: {
    Ag_mm2: number;
    Ast_mm2: number;
    reinforcement_ratio: number;
  };
  axial_capacity: {
    Pn_max_kn: number;
    phi_Pn_max_kn: number;
  };
  applied_load_kn: number;
  utilization_ratio: number;
  interaction_check?: {
    eccentricity_mm: number;
    min_eccentricity_mm: number;
    governing_eccentricity_mm: number;
    interaction_value: number;
    status: "PASS" | "FAIL";
  };
  slenderness_check: {
    KLr: number;
    slender: boolean;
    note: string;
  };
  status: "PASS" | "FAIL";
}

function checkConcreteColumn(params: ColumnParams, mat: ConcreteMaterial): ConcreteColumnResult {
  const K = params.effective_length_factor ?? 1.0;
  const L_mm = params.height_m * 1000;
  const Pu = params.axial_load_kn;
  const Mux = params.moment_x_knm ?? 0;
  const Muy = params.moment_y_knm ?? 0;

  const fc = mat.fc_mpa;
  const fy = mat.fy_mpa;

  let Ag: number; // gross area (mm^2)
  let r_mm: number; // radius of gyration (mm)
  let h_mm: number; // overall depth for eccentricity check (mm)

  const sect = params.section as unknown as Record<string, number>;

  if (params.column_type === "concrete_rectangular") {
    const b = sect.width_mm;
    const h = sect.depth_mm;
    Ag = b * h;
    // Radius of gyration for rectangular section: r = h / sqrt(12) for the weaker axis
    const rx = h / Math.sqrt(12);
    const ry = b / Math.sqrt(12);
    r_mm = Math.min(rx, ry);
    h_mm = Math.min(b, h);
  } else {
    // concrete_circular
    const D = sect.diameter_mm;
    Ag = (Math.PI / 4) * Math.pow(D, 2);
    // Radius of gyration for circular section: r = D / 4
    r_mm = D / 4;
    h_mm = D;
  }

  // Steel reinforcement area
  const n_bars = sect.rebar_count;
  const db = sect.rebar_diameter_mm;
  const Ast = n_bars * (Math.PI / 4) * Math.pow(db, 2);
  const rho = Ast / Ag; // reinforcement ratio

  // Slenderness check
  const KLr = (K * L_mm) / r_mm;
  const isSlender = KLr > 22; // simplified threshold per ACI 318

  // Maximum nominal axial capacity (ACI 318-19, Section 22.4.2)
  // For tied columns: phi*Pn(max) = 0.80 * phi * [0.85*fc'*(Ag - Ast) + fy*Ast]
  const phi_axial = 0.65; // phi for tied columns
  const Pn_max = 0.85 * fc * (Ag - Ast) + fy * Ast; // nominal (no 0.80 factor yet)
  const phi_Pn_max = 0.80 * phi_axial * Pn_max / 1000; // convert N to kN, with 0.80 factor
  const Pn_max_kn = Pn_max / 1000;

  // Utilization for pure axial
  const utilization = Pu / phi_Pn_max;

  // Interaction check for combined loading
  let interaction: ConcreteColumnResult["interaction_check"] = undefined;
  const Mu_total = Math.sqrt(Math.pow(Mux, 2) + Math.pow(Muy, 2));
  const hasMoments = Mu_total > 1e-6;

  if (hasMoments || Pu > 0) {
    // Actual eccentricity: e = M / P
    const e_actual = Pu > 1e-6 ? (Mu_total * 1000) / Pu : 0; // mm (M in kN*m, P in kN -> M*1000/P gives mm)

    // ACI minimum eccentricity: 0.1*h for tied columns
    const e_min = 0.10 * h_mm;
    const e_gov = Math.max(e_actual, e_min);

    // Simplified interaction check using load contour method
    // Approximate balanced point moment capacity for the section
    // Mn_approx ~ 0.85*fc*a*b*(d-a/2) + As'*fy*(d-d') for a simplified approach
    // Here we use a simplified parabolic interaction: (Pu/phi_Pn)^alpha + (Mu/phi_Mn)^alpha <= 1.0
    // where alpha ~= 1.15-1.4 for rectangular, we use 1.2

    // Approximate pure bending capacity of the section (simplified)
    const cover = sect.cover_mm ?? 40;
    const d_eff = h_mm - cover - db / 2; // effective depth
    // Approximate moment capacity assuming tension-controlled
    // As_tension ~ Ast / 2 (half bars in tension)
    const As_tension = Ast / 2;
    const a = (As_tension * fy) / (0.85 * fc * (params.column_type === "concrete_rectangular" ? sect.width_mm : h_mm));
    const Mn_approx = As_tension * fy * (d_eff - a / 2) / 1e6; // kN*m
    const phi_Mn = 0.90 * Mn_approx; // phi for flexure

    let interactionValue: number;
    if (phi_Mn > 1e-6) {
      // Simplified Bresler reciprocal load method for biaxial bending:
      // Use resultant moment approach
      const alpha = 1.2; // interaction exponent
      const axial_ratio = Math.min(Pu / phi_Pn_max, 1.0);
      const moment_ratio = Math.min(Mu_total / phi_Mn, 10.0);
      interactionValue = Math.pow(axial_ratio, alpha) + Math.pow(moment_ratio, alpha);
    } else {
      interactionValue = utilization;
    }

    interaction = {
      eccentricity_mm: round(e_actual, 1),
      min_eccentricity_mm: round(e_min, 1),
      governing_eccentricity_mm: round(e_gov, 1),
      interaction_value: round(interactionValue, 4),
      status: interactionValue <= 1.0 ? "PASS" : "FAIL",
    };
  }

  const axialPass = utilization <= 1.0;
  const interactionPass = interaction ? interaction.status === "PASS" : true;
  const overallStatus = axialPass && interactionPass ? "PASS" : "FAIL";

  return {
    column_type: params.column_type,
    section_properties: {
      Ag_mm2: round(Ag, 1),
      Ast_mm2: round(Ast, 1),
      reinforcement_ratio: round(rho, 4),
    },
    axial_capacity: {
      Pn_max_kn: round(Pn_max_kn, 2),
      phi_Pn_max_kn: round(phi_Pn_max, 2),
    },
    applied_load_kn: round(Pu, 2),
    utilization_ratio: round(utilization, 4),
    interaction_check: interaction,
    slenderness_check: {
      KLr: round(KLr, 2),
      slender: isSlender,
      note: isSlender
        ? "Column is slender (KL/r > 22). Moment magnification may be required per ACI 318."
        : "Column is short. No slenderness effects.",
    },
    status: overallStatus,
  };
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function isSteelType(type: ColumnType): boolean {
  return type === "steel_wide_flange" || type === "steel_hss_rectangular" || type === "steel_hss_round";
}

// ─── Tool definition ─────────────────────────────────────────────────────────

export function createColumnCheckToolDefinition() {
  return {
    name: "structural_column",
    label: "Structural Column Check",
    description:
      "Check a column for axial capacity, buckling, and combined axial+bending interaction. " +
      "Supports steel wide-flange, HSS rectangular, HSS round, concrete rectangular, and " +
      "concrete circular columns. Steel checks per AISC 360 (Chapter E compression, Chapter H " +
      "combined forces). Concrete checks per ACI 318 (tied column provisions).",
    parameters: {
      type: "object",
      properties: {
        column_type: {
          type: "string",
          enum: [
            "steel_wide_flange",
            "steel_hss_rectangular",
            "steel_hss_round",
            "concrete_rectangular",
            "concrete_circular",
          ],
          description: "Type of column cross-section.",
        },
        height_m: {
          type: "number",
          description: "Unbraced length of the column in meters.",
        },
        axial_load_kn: {
          type: "number",
          description: "Factored axial load in kN (compression positive).",
        },
        moment_x_knm: {
          type: "number",
          description: "Factored moment about the strong axis in kN*m (optional).",
        },
        moment_y_knm: {
          type: "number",
          description: "Factored moment about the weak axis in kN*m (optional).",
        },
        section: {
          type: "object",
          description:
            "Cross-section dimensions. Contents depend on column_type:\n" +
            "  Steel WF: { depth_mm, flange_width_mm, flange_thickness_mm, web_thickness_mm }\n" +
            "  Steel HSS rect: { width_mm, depth_mm, thickness_mm }\n" +
            "  Steel HSS round: { diameter_mm, thickness_mm }\n" +
            "  Concrete rect: { width_mm, depth_mm, rebar_count, rebar_diameter_mm, cover_mm }\n" +
            "  Concrete circ: { diameter_mm, rebar_count, rebar_diameter_mm, cover_mm }",
        },
        effective_length_factor: {
          type: "number",
          description: "Effective length factor K (default 1.0). Use 0.65-2.1 depending on end conditions.",
        },
        material: {
          type: "object",
          description:
            "Material properties (optional).\n" +
            "  For steel: { E_mpa (default 200000), fy_mpa (default 345) }\n" +
            "  For concrete: { fc_mpa (default 30), fy_mpa (default 420 for rebar), Es_mpa (default 200000) }",
        },
      },
      required: ["column_type", "height_m", "axial_load_kn", "section"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }> => {
      const params = (args ?? {}) as Record<string, unknown>;

      // ── Validate column_type ────────────────────────────────────────────
      const validColumnTypes: ColumnType[] = [
        "steel_wide_flange",
        "steel_hss_rectangular",
        "steel_hss_round",
        "concrete_rectangular",
        "concrete_circular",
      ];
      const columnType = String(params.column_type ?? "") as ColumnType;
      if (!validColumnTypes.includes(columnType)) {
        throw new Error(
          `column_type must be one of: ${validColumnTypes.join(", ")}. Got "${params.column_type}".`,
        );
      }

      // ── Validate numeric parameters ─────────────────────────────────────
      const height_m = Number(params.height_m);
      if (!Number.isFinite(height_m) || height_m <= 0) {
        throw new Error("height_m must be a positive number.");
      }

      const axial_load_kn = Number(params.axial_load_kn);
      if (!Number.isFinite(axial_load_kn)) {
        throw new Error("axial_load_kn must be a finite number.");
      }

      const moment_x_knm =
        params.moment_x_knm !== undefined && params.moment_x_knm !== null
          ? Number(params.moment_x_knm)
          : undefined;
      if (moment_x_knm !== undefined && !Number.isFinite(moment_x_knm)) {
        throw new Error("moment_x_knm must be a finite number if provided.");
      }

      const moment_y_knm =
        params.moment_y_knm !== undefined && params.moment_y_knm !== null
          ? Number(params.moment_y_knm)
          : undefined;
      if (moment_y_knm !== undefined && !Number.isFinite(moment_y_knm)) {
        throw new Error("moment_y_knm must be a finite number if provided.");
      }

      // ── Validate section ────────────────────────────────────────────────
      if (!params.section || typeof params.section !== "object") {
        throw new Error("section is required and must be an object.");
      }
      const section = params.section as Record<string, unknown>;

      // ── Validate effective_length_factor ─────────────────────────────────
      let effective_length_factor = 1.0;
      if (params.effective_length_factor !== undefined && params.effective_length_factor !== null) {
        effective_length_factor = Number(params.effective_length_factor);
        if (!Number.isFinite(effective_length_factor) || effective_length_factor <= 0) {
          throw new Error("effective_length_factor must be a positive number.");
        }
      }

      // ── Parse material defaults ─────────────────────────────────────────
      const rawMat = (params.material ?? {}) as Record<string, unknown>;

      const columnParams: ColumnParams = {
        column_type: columnType,
        height_m,
        axial_load_kn,
        moment_x_knm,
        moment_y_knm,
        section: section as unknown as SectionInput,
        effective_length_factor,
      };

      let result: SteelColumnResult | ConcreteColumnResult;

      if (isSteelType(columnType)) {
        // Build steel material with defaults
        const steelMat: SteelMaterial = {
          E_mpa: typeof rawMat.E_mpa === "number" && Number.isFinite(rawMat.E_mpa) ? rawMat.E_mpa : 200000,
          fy_mpa: typeof rawMat.fy_mpa === "number" && Number.isFinite(rawMat.fy_mpa) ? rawMat.fy_mpa : 345,
        };

        // Calculate section properties based on type
        let props: SectionProperties;
        if (columnType === "steel_wide_flange") {
          const s = section as unknown as SteelWFSection;
          if (!s.depth_mm || !s.flange_width_mm || !s.flange_thickness_mm || !s.web_thickness_mm) {
            throw new Error(
              "Steel wide-flange section requires: depth_mm, flange_width_mm, flange_thickness_mm, web_thickness_mm.",
            );
          }
          props = calcWFProperties(s);
        } else if (columnType === "steel_hss_rectangular") {
          const s = section as unknown as SteelHSSRectSection;
          if (!s.width_mm || !s.depth_mm || !s.thickness_mm) {
            throw new Error("Steel HSS rectangular section requires: width_mm, depth_mm, thickness_mm.");
          }
          props = calcHSSRectProperties(s);
        } else {
          // steel_hss_round
          const s = section as unknown as SteelHSSRoundSection;
          if (!s.diameter_mm || !s.thickness_mm) {
            throw new Error("Steel HSS round section requires: diameter_mm, thickness_mm.");
          }
          props = calcHSSRoundProperties(s);
        }

        result = checkSteelColumn(columnParams, props, steelMat);
      } else {
        // Concrete column
        const concreteMat: ConcreteMaterial = {
          fc_mpa: typeof rawMat.fc_mpa === "number" && Number.isFinite(rawMat.fc_mpa) ? rawMat.fc_mpa : 30,
          fy_mpa: typeof rawMat.fy_mpa === "number" && Number.isFinite(rawMat.fy_mpa) ? rawMat.fy_mpa : 420,
          Es_mpa: typeof rawMat.Es_mpa === "number" && Number.isFinite(rawMat.Es_mpa) ? rawMat.Es_mpa : 200000,
        };

        // Validate concrete section
        if (columnType === "concrete_rectangular") {
          const s = section as unknown as ConcreteRectSection;
          if (!s.width_mm || !s.depth_mm || !s.rebar_count || !s.rebar_diameter_mm) {
            throw new Error(
              "Concrete rectangular section requires: width_mm, depth_mm, rebar_count, rebar_diameter_mm.",
            );
          }
        } else {
          const s = section as unknown as ConcreteCircSection;
          if (!s.diameter_mm || !s.rebar_count || !s.rebar_diameter_mm) {
            throw new Error(
              "Concrete circular section requires: diameter_mm, rebar_count, rebar_diameter_mm.",
            );
          }
        }

        result = checkConcreteColumn(columnParams, concreteMat);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {
          column_type: columnType,
          status: result.status,
        },
      };
    },
  };
}
