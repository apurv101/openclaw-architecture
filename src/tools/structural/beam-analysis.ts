/**
 * Structural beam analysis tool for civilclaw.
 *
 * Analyzes beams under various loading conditions. Calculates reactions, shear
 * force diagrams, bending moment diagrams, deflections, and checks against
 * allowable stress/deflection limits. Generates shear/moment diagrams as SVG.
 *
 * Pure TypeScript — only `fs` dependency.
 */
import fs from "node:fs";
import path from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

interface PointLoad {
  type: "point";
  magnitude: number; // kN
  position_m: number;
}

interface DistributedLoad {
  type: "distributed";
  magnitude: number; // kN/m
  start_m: number;
  end_m: number;
}

interface MomentLoad {
  type: "moment";
  magnitude: number; // kN·m
  position_m: number;
}

type Load = PointLoad | DistributedLoad | MomentLoad;

interface RectangularSection {
  type: "rectangular";
  width_mm: number;
  depth_mm: number;
}

interface CircularSection {
  type: "circular";
  diameter_mm: number;
}

interface IBeamSection {
  type: "i_beam";
  depth_mm: number;
  flange_width_mm: number;
  flange_thickness_mm: number;
  web_thickness_mm: number;
}

interface CustomSection {
  type: "custom";
  I_mm4: number;
  S_mm3: number;
  A_mm2: number;
}

type Section = RectangularSection | CircularSection | IBeamSection | CustomSection;

interface Material {
  E_mpa: number;
  fy_mpa: number;
  name?: string;
}

type BeamType = "simply_supported" | "cantilever" | "fixed_fixed" | "propped_cantilever";

interface BeamInput {
  beam_type: BeamType;
  span_m: number;
  loads: Load[];
  section: Section;
  material: Material;
  output_path?: string;
  num_points: number;
}

interface Reactions {
  left_kn: number;
  right_kn: number;
  left_moment_knm?: number;
  right_moment_knm?: number;
}

interface DiagramPoint {
  x_m: number;
  shear_kn: number;
  moment_knm: number;
  deflection_mm: number;
}

interface SectionProperties {
  I_mm4: number;
  S_mm3: number;
  A_mm2: number;
}

interface AnalysisResult {
  beam_type: BeamType;
  span_m: number;
  reactions: Reactions;
  max_shear_kn: number;
  max_moment_knm: number;
  max_deflection_mm: number;
  section_properties: SectionProperties;
  max_stress_mpa: number;
  allowable_stress_mpa: number;
  stress_utilization_ratio: number;
  deflection_limit_mm: number;
  deflection_utilization_ratio: number;
  status: "PASS" | "FAIL";
  output_path?: string;
  diagram_points: DiagramPoint[];
}

// ─── Section property calculations ───────────────────────────────────────────

function computeSectionProperties(section: Section): SectionProperties {
  switch (section.type) {
    case "rectangular": {
      const b = section.width_mm;
      const d = section.depth_mm;
      const I = (b * d * d * d) / 12;
      const S = (b * d * d) / 6;
      const A = b * d;
      return { I_mm4: I, S_mm3: S, A_mm2: A };
    }
    case "circular": {
      const d = section.diameter_mm;
      const r = d / 2;
      const I = (Math.PI * d * d * d * d) / 64;
      const S = (Math.PI * d * d * d) / 32;
      const A = Math.PI * r * r;
      return { I_mm4: I, S_mm3: S, A_mm2: A };
    }
    case "i_beam": {
      const H = section.depth_mm;
      const B = section.flange_width_mm;
      const tf = section.flange_thickness_mm;
      const tw = section.web_thickness_mm;
      // I-beam: outer rectangle minus inner rectangles (the voids beside the web)
      const b_void = B - tw; // total width of voids
      const h_void = H - 2 * tf; // height of voids
      // I = (B*H^3)/12 - (b_void * h_void^3)/12
      const I = (B * H * H * H) / 12 - (b_void * h_void * h_void * h_void) / 12;
      const S = (2 * I) / H;
      const A = B * H - b_void * h_void;
      return { I_mm4: I, S_mm3: S, A_mm2: A };
    }
    case "custom": {
      return { I_mm4: section.I_mm4, S_mm3: section.S_mm3, A_mm2: section.A_mm2 };
    }
  }
}

// ─── Normalize loads ─────────────────────────────────────────────────────────

function normalizeLoads(rawLoads: unknown[], span: number): Load[] {
  return rawLoads.map((raw: any) => {
    const t = String(raw.type);
    if (t === "point") {
      return {
        type: "point" as const,
        magnitude: Number(raw.magnitude),
        position_m: Number(raw.position_m ?? 0),
      };
    }
    if (t === "distributed") {
      return {
        type: "distributed" as const,
        magnitude: Number(raw.magnitude),
        start_m: Number(raw.start_m ?? 0),
        end_m: Number(raw.end_m ?? span),
      };
    }
    if (t === "moment") {
      return {
        type: "moment" as const,
        magnitude: Number(raw.magnitude),
        position_m: Number(raw.position_m ?? 0),
      };
    }
    throw new Error(`Unknown load type: ${t}`);
  });
}

// ─── Macaulay bracket ────────────────────────────────────────────────────────

/** <x - a>^n  — returns 0 if x < a */
function macaulay(x: number, a: number, n: number): number {
  if (x < a) return 0;
  return Math.pow(x - a, n);
}

// ─── Simply supported beam ───────────────────────────────────────────────────

function analyzeSimplySupported(
  loads: Load[],
  L: number,
  numPoints: number,
  EI: number,
): { reactions: Reactions; points: DiagramPoint[] } {
  // Compute reactions from equilibrium: sum Fy = 0, sum M about left = 0
  let totalForce = 0;
  let totalMomentAboutLeft = 0;

  for (const load of loads) {
    if (load.type === "point") {
      totalForce += load.magnitude;
      totalMomentAboutLeft += load.magnitude * load.position_m;
    } else if (load.type === "distributed") {
      const w = load.magnitude;
      const a = load.start_m;
      const b = load.end_m;
      const length = b - a;
      const totalLoad = w * length;
      const centroid = a + length / 2;
      totalForce += totalLoad;
      totalMomentAboutLeft += totalLoad * centroid;
    } else if (load.type === "moment") {
      // Applied moment doesn't contribute to vertical force sum
      // but contributes to moment sum (positive = CCW)
      totalMomentAboutLeft += load.magnitude;
    }
  }

  // Rb * L = totalMomentAboutLeft => Rb = totalMomentAboutLeft / L
  const Rb = totalMomentAboutLeft / L;
  const Ra = totalForce - Rb;

  const points: DiagramPoint[] = [];
  const dx = L / (numPoints - 1);

  for (let i = 0; i < numPoints; i++) {
    const x = i * dx;

    // Shear: V(x) = Ra - sum of loads left of x
    let V = Ra;
    let M = Ra * x;

    for (const load of loads) {
      if (load.type === "point") {
        if (x >= load.position_m) {
          V -= load.magnitude;
          M -= load.magnitude * (x - load.position_m);
        }
      } else if (load.type === "distributed") {
        const a = load.start_m;
        const b = load.end_m;
        const w = load.magnitude;
        if (x >= a) {
          const xEff = Math.min(x, b);
          const len = xEff - a;
          V -= w * len;
          M -= w * len * (x - a - len / 2);
        }
      } else if (load.type === "moment") {
        if (x >= load.position_m) {
          M -= load.magnitude;
        }
      }
    }

    points.push({ x_m: x, shear_kn: V, moment_knm: M, deflection_mm: 0 });
  }

  // Deflection by numerical double integration of M(x)/EI
  // EI in kN·m^2 (E in MPa = kN/m^2 * 1e-6, I in mm^4 = m^4 * 1e-12)
  // EI_si = E(kN/m^2) * I(m^4) = E_mpa * 1e3 * I_mm4 * 1e-12 = E_mpa * I_mm4 * 1e-9
  computeDeflectionsByIntegration(points, dx, EI, L);

  return {
    reactions: {
      left_kn: round4(Ra),
      right_kn: round4(Rb),
    },
    points,
  };
}

// ─── Cantilever beam (fixed at left, free at right) ─────────────────────────

function analyzeCantilever(
  loads: Load[],
  L: number,
  numPoints: number,
  EI: number,
): { reactions: Reactions; points: DiagramPoint[] } {
  // Fixed at left: Ra = sum of all vertical loads, Ma = sum of moments about left
  let Ra = 0;
  let Ma = 0; // Fixed-end moment (positive = CCW = resisting sagging)

  for (const load of loads) {
    if (load.type === "point") {
      Ra += load.magnitude;
      Ma += load.magnitude * load.position_m;
    } else if (load.type === "distributed") {
      const w = load.magnitude;
      const a = load.start_m;
      const b = load.end_m;
      const length = b - a;
      const totalLoad = w * length;
      const centroid = a + length / 2;
      Ra += totalLoad;
      Ma += totalLoad * centroid;
    } else if (load.type === "moment") {
      Ma += load.magnitude;
    }
  }

  const points: DiagramPoint[] = [];
  const dx = L / (numPoints - 1);

  for (let i = 0; i < numPoints; i++) {
    const x = i * dx;

    let V = Ra;
    // Fixed-end moment is -Ma (acts to restrain)
    let M = -Ma + Ra * x;

    for (const load of loads) {
      if (load.type === "point") {
        if (x >= load.position_m) {
          V -= load.magnitude;
          M -= load.magnitude * (x - load.position_m);
        }
      } else if (load.type === "distributed") {
        const a = load.start_m;
        const b = load.end_m;
        const w = load.magnitude;
        if (x >= a) {
          const xEff = Math.min(x, b);
          const len = xEff - a;
          V -= w * len;
          M -= w * len * (x - a - len / 2);
        }
      } else if (load.type === "moment") {
        if (x >= load.position_m) {
          M -= load.magnitude;
        }
      }
    }

    points.push({ x_m: x, shear_kn: V, moment_knm: M, deflection_mm: 0 });
  }

  // For cantilever: deflection = 0 at x=0, slope = 0 at x=0
  // Integrate from left (fixed end)
  computeDeflectionsCantilever(points, dx, EI);

  return {
    reactions: {
      left_kn: round4(Ra),
      right_kn: 0,
      left_moment_knm: round4(-Ma),
    },
    points,
  };
}

// ─── Fixed-Fixed beam ────────────────────────────────────────────────────────

function analyzeFixedFixed(
  loads: Load[],
  L: number,
  numPoints: number,
  EI: number,
): { reactions: Reactions; points: DiagramPoint[] } {
  // For fixed-fixed beams, use superposition of fixed-end moments
  // then compute reactions from equilibrium
  let Ma = 0; // Fixed-end moment at left (negative = hogging at support)
  let Mb = 0; // Fixed-end moment at right

  // Compute fixed-end moments by superposition
  for (const load of loads) {
    if (load.type === "point") {
      const P = load.magnitude;
      const a = load.position_m;
      const b = L - a;
      // Fixed-end moments for point load:
      // Ma = -P*a*b^2 / L^2 (hogging)
      // Mb = -P*a^2*b / L^2 (hogging)
      Ma += -P * a * b * b / (L * L);
      Mb += -P * a * a * b / (L * L);
    } else if (load.type === "distributed") {
      const w = load.magnitude;
      const a = load.start_m;
      const b = load.end_m;

      if (a === 0 && Math.abs(b - L) < 1e-9) {
        // Full-span UDL: Ma = Mb = -wL^2/12
        Ma += -w * L * L / 12;
        Mb += -w * L * L / 12;
      } else {
        // Partial UDL: use numerical integration approach
        // Break distributed load into small point loads
        const nSeg = 100;
        const segLen = (b - a) / nSeg;
        for (let j = 0; j < nSeg; j++) {
          const pos = a + (j + 0.5) * segLen;
          const dP = w * segLen;
          const ai = pos;
          const bi = L - pos;
          Ma += -dP * ai * bi * bi / (L * L);
          Mb += -dP * ai * ai * bi / (L * L);
        }
      }
    } else if (load.type === "moment") {
      const M0 = load.magnitude;
      const a = load.position_m;
      const b = L - a;
      // Fixed-end moments for applied moment M0 at distance a:
      // Ma = M0 * b * (2*a - b) / L^2  (or use standard formula)
      // Mb = M0 * a * (2*b - a) / L^2
      // Standard formulas for applied CW moment:
      Ma += M0 * b * (2 * a - b) / (L * L);
      Mb += -M0 * a * (2 * b - a) / (L * L);
    }
  }

  // Now compute reactions using equilibrium
  // ΣM about left = 0: Rb*L + Ma + Mb + ΣM_loads = 0
  // ΣFy = 0: Ra + Rb = total vertical load
  let totalForce = 0;
  let totalMomentAboutLeft = 0;

  for (const load of loads) {
    if (load.type === "point") {
      totalForce += load.magnitude;
      totalMomentAboutLeft += load.magnitude * load.position_m;
    } else if (load.type === "distributed") {
      const w = load.magnitude;
      const a = load.start_m;
      const b = load.end_m;
      const length = b - a;
      const totalLoad = w * length;
      const centroid = a + length / 2;
      totalForce += totalLoad;
      totalMomentAboutLeft += totalLoad * centroid;
    } else if (load.type === "moment") {
      totalMomentAboutLeft += load.magnitude;
    }
  }

  // Equilibrium including fixed-end moments:
  // Rb*L = totalMomentAboutLeft + Ma - Mb  (careful with sign convention)
  // Actually: ΣM_A = 0: Rb*L - totalMomentAboutLeft - Ma + Mb = 0 (moments from loads)
  // Fixed end moments resist: at A we have Ma (CCW = negative bending) and at B we have Mb
  // Using: Rb*L = totalMomentAboutLeft + Ma - Mb  ... let me be careful.
  //
  // Convention: Ma and Mb are the fixed-end moments applied to the beam (hogging = negative).
  // Free body: Ra acts up at x=0, Rb acts up at x=L, Ma at x=0, Mb at x=L.
  // ΣM about A = 0: Rb*L + Ma + Mb - (sum of load moments about A) = 0
  // Note: Ma here is the moment applied to beam at A (hogging, negative), Mb at B.
  // The sign: let's define positive moment as sagging.
  //
  // Actually let me define clearly:
  // FEM Ma and Mb are reactions (applied by the wall to the beam).
  // ΣM about A (taking CCW positive):
  // Rb * L - Ma_reaction + Mb_reaction = sum of external load moments about A
  // where Ma_reaction = -Ma (the negative of FEM), Mb_reaction = -Mb
  // This gets confusing; let's just use: with Ma and Mb as computed (negative = hogging),
  // ΣM about A: Rb*L - ΣMloads_about_A + Ma - Mb = 0
  // => Rb = (ΣMloads_about_A - Ma + Mb) / L
  const Rb = (totalMomentAboutLeft - Ma + Mb) / L;
  const Ra = totalForce - Rb;

  const points: DiagramPoint[] = [];
  const dx = L / (numPoints - 1);

  for (let i = 0; i < numPoints; i++) {
    const x = i * dx;

    let V = Ra;
    let M = Ma + Ra * x; // Start with fixed-end moment at left

    for (const load of loads) {
      if (load.type === "point") {
        if (x >= load.position_m) {
          V -= load.magnitude;
          M -= load.magnitude * (x - load.position_m);
        }
      } else if (load.type === "distributed") {
        const a = load.start_m;
        const b = load.end_m;
        const w = load.magnitude;
        if (x >= a) {
          const xEff = Math.min(x, b);
          const len = xEff - a;
          V -= w * len;
          M -= w * len * (x - a - len / 2);
        }
      } else if (load.type === "moment") {
        if (x >= load.position_m) {
          M -= load.magnitude;
        }
      }
    }

    points.push({ x_m: x, shear_kn: V, moment_knm: M, deflection_mm: 0 });
  }

  // Deflection: fixed-fixed => zero deflection and zero slope at both ends
  // Use numerical integration with boundary conditions: y(0)=0, y'(0)=0 for initial guess,
  // then adjust slope at x=0 so that y(L)=0.
  computeDeflectionsByIntegration(points, dx, EI, L);

  return {
    reactions: {
      left_kn: round4(Ra),
      right_kn: round4(Rb),
      left_moment_knm: round4(Ma),
      right_moment_knm: round4(Mb),
    },
    points,
  };
}

// ─── Propped cantilever (fixed at left, roller at right) ─────────────────────

function analyzeProppedCantilever(
  loads: Load[],
  L: number,
  numPoints: number,
  EI: number,
): { reactions: Reactions; points: DiagramPoint[] } {
  // Propped cantilever: fixed at left (x=0), pin/roller at right (x=L)
  // Redundant beam: use compatibility method.
  // Remove roller at B => cantilever. Compute deflection at B from loads (delta_B_loads).
  // Apply unit load at B => deflection delta_B_unit.
  // Rb = -delta_B_loads / delta_B_unit (so that net deflection at B = 0).

  // We'll compute deflections for a cantilever numerically.
  // Step 1: Analyze as pure cantilever with the applied loads
  const cantLoads = analyzeCantilever(loads, L, numPoints, EI);
  const deltaB_loads = cantLoads.points[cantLoads.points.length - 1]!.deflection_mm;

  // Step 2: Analyze as cantilever with unit upward load at free end (x = L)
  const unitLoad: Load[] = [{ type: "point", magnitude: 1, position_m: L }];
  const cantUnit = analyzeCantilever(unitLoad, L, numPoints, EI);
  const deltaB_unit = cantUnit.points[cantUnit.points.length - 1]!.deflection_mm;

  // Rb such that total deflection at B = 0
  // deltaB_loads + Rb * deltaB_unit = 0  (note: unit load is downward = positive)
  // We need upward reaction, so: deltaB_loads - Rb * |deltaB_unit| = 0
  // Actually the sign works out: if loads push tip down (positive deflection) and
  // unit downward load also pushes tip down, then Rb (upward) negates:
  const Rb = deltaB_unit !== 0 ? -deltaB_loads / deltaB_unit : 0;

  // Now recompute with original loads + Rb as upward point load at L
  // Actually, let's include Rb as a point load (upward = negative if our convention is downward positive)
  // Our convention: positive load = downward. Rb acts upward, so add as negative.
  const allLoads: Load[] = [
    ...loads,
    { type: "point" as const, magnitude: -Rb, position_m: L },
  ];

  const cantResult = analyzeCantilever(allLoads, L, numPoints, EI);

  // Extract Ra and Ma from the cantilever reactions
  const Ra = cantResult.reactions.left_kn;
  const Ma = cantResult.reactions.left_moment_knm ?? 0;

  return {
    reactions: {
      left_kn: round4(Ra),
      right_kn: round4(Rb),
      left_moment_knm: round4(Ma),
    },
    points: cantResult.points,
  };
}

// ─── Deflection computation helpers ──────────────────────────────────────────

/**
 * Compute deflections for a simply-supported or fixed-fixed beam using numerical
 * double integration of M(x)/EI.
 *
 * Boundary conditions: y(0) = 0, y(L) = 0.
 * We integrate twice:
 *   theta(x) = integral of M(x)/EI dx + C1
 *   y(x) = integral of theta(x) dx + C2
 * With y(0) = 0 => C2 = 0 (start integration from x=0).
 * With y(L) = 0 => adjust C1.
 *
 * EI is in kN·m^2. Moment is in kN·m. Deflection will be in m, then convert to mm.
 */
function computeDeflectionsByIntegration(
  points: DiagramPoint[],
  dx: number,
  EI: number,
  L: number,
): void {
  const n = points.length;
  if (n < 2 || EI === 0) return;

  // First integration: theta (slope)
  const theta = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const mAvg = (points[i - 1]!.moment_knm + points[i]!.moment_knm) / 2;
    theta[i] = theta[i - 1]! + (mAvg / EI) * dx;
  }

  // Second integration: y (deflection), assuming C1=0 initially
  const y = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const thetaAvg = (theta[i - 1]! + theta[i]!) / 2;
    y[i] = y[i - 1]! + thetaAvg * dx;
  }

  // Apply boundary condition y(L) = 0 => determine C1
  // y_corrected(x) = y(x) - (y(L)/L) * x  (linear correction)
  const yL = y[n - 1]!;
  for (let i = 0; i < n; i++) {
    const x = points[i]!.x_m;
    const yCorr = y[i]! - (yL / L) * x;
    // Convert m to mm
    points[i]!.deflection_mm = round4(yCorr * 1000);
  }
}

/**
 * Compute deflections for a cantilever (fixed at left, free at right).
 * Boundary conditions: y(0) = 0, y'(0) = 0.
 * Direct double integration from left.
 */
function computeDeflectionsCantilever(
  points: DiagramPoint[],
  dx: number,
  EI: number,
): void {
  const n = points.length;
  if (n < 2 || EI === 0) return;

  // theta(0) = 0, y(0) = 0
  const theta = new Array<number>(n).fill(0);
  const y = new Array<number>(n).fill(0);

  for (let i = 1; i < n; i++) {
    const mAvg = (points[i - 1]!.moment_knm + points[i]!.moment_knm) / 2;
    theta[i] = theta[i - 1]! + (mAvg / EI) * dx;
  }

  for (let i = 1; i < n; i++) {
    const thetaAvg = (theta[i - 1]! + theta[i]!) / 2;
    y[i] = y[i - 1]! + thetaAvg * dx;
  }

  for (let i = 0; i < n; i++) {
    points[i]!.deflection_mm = round4(y[i]! * 1000);
  }
}

// ─── SVG generation ──────────────────────────────────────────────────────────

function generateSVG(
  beamType: BeamType,
  L: number,
  loads: Load[],
  points: DiagramPoint[],
  reactions: Reactions,
  maxShear: number,
  maxMoment: number,
  maxDeflection: number,
  status: string,
): string {
  const width = 800;
  const height = 600;
  const margin = { top: 50, right: 60, bottom: 40, left: 70 };
  const diagramHeight = 200;
  const beamY = margin.top + 30;
  const shearTop = beamY + 50;
  const momentTop = shearTop + diagramHeight + 60;
  const plotWidth = width - margin.left - margin.right;

  // Scale functions
  const xScale = (x: number) => margin.left + (x / L) * plotWidth;

  // Find min/max for shear and moment
  let vMin = 0, vMax = 0, mMin = 0, mMax = 0;
  for (const p of points) {
    if (p.shear_kn < vMin) vMin = p.shear_kn;
    if (p.shear_kn > vMax) vMax = p.shear_kn;
    if (p.moment_knm < mMin) mMin = p.moment_knm;
    if (p.moment_knm > mMax) mMax = p.moment_knm;
  }

  // Add padding to ranges
  const vRange = Math.max(Math.abs(vMin), Math.abs(vMax)) * 1.15 || 1;
  const mRange = Math.max(Math.abs(mMin), Math.abs(mMax)) * 1.15 || 1;

  const shearMid = shearTop + diagramHeight / 2;
  const momentMid = momentTop + diagramHeight / 2;

  const vScale = (v: number) => shearMid - (v / vRange) * (diagramHeight / 2);
  const mScale = (m: number) => momentMid - (m / mRange) * (diagramHeight / 2);

  // Build SVG
  const lines: string[] = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Arial, sans-serif" font-size="11">`);

  // Background
  lines.push(`<rect width="${width}" height="${height}" fill="#fafafa" rx="4"/>`);

  // Title
  const beamLabel = beamType.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  lines.push(`<text x="${width / 2}" y="20" text-anchor="middle" font-size="14" font-weight="bold">${beamLabel} Beam - L = ${L.toFixed(2)} m - ${status}</text>`);

  // ── Beam representation ──
  const beamLeft = xScale(0);
  const beamRight = xScale(L);
  lines.push(`<line x1="${beamLeft}" y1="${beamY}" x2="${beamRight}" y2="${beamY}" stroke="#333" stroke-width="3"/>`);

  // Support symbols
  const supportSize = 12;
  if (beamType === "simply_supported") {
    // Triangle (pin) at left
    lines.push(`<polygon points="${beamLeft},${beamY} ${beamLeft - supportSize},${beamY + supportSize * 1.5} ${beamLeft + supportSize},${beamY + supportSize * 1.5}" fill="none" stroke="#333" stroke-width="1.5"/>`);
    // Circle (roller) at right
    lines.push(`<circle cx="${beamRight}" cy="${beamY + supportSize + 4}" r="${supportSize / 2}" fill="none" stroke="#333" stroke-width="1.5"/>`);
    lines.push(`<line x1="${beamRight - supportSize}" y1="${beamY + supportSize * 1.5 + 2}" x2="${beamRight + supportSize}" y2="${beamY + supportSize * 1.5 + 2}" stroke="#333" stroke-width="1.5"/>`);
  } else if (beamType === "cantilever") {
    // Fixed wall at left
    lines.push(`<line x1="${beamLeft}" y1="${beamY - 15}" x2="${beamLeft}" y2="${beamY + 15}" stroke="#333" stroke-width="3"/>`);
    for (let i = 0; i < 5; i++) {
      const yy = beamY - 15 + i * 7.5;
      lines.push(`<line x1="${beamLeft - 8}" y1="${yy + 5}" x2="${beamLeft}" y2="${yy}" stroke="#333" stroke-width="1"/>`);
    }
  } else if (beamType === "fixed_fixed") {
    // Fixed walls at both ends
    for (const xPos of [beamLeft, beamRight]) {
      lines.push(`<line x1="${xPos}" y1="${beamY - 15}" x2="${xPos}" y2="${beamY + 15}" stroke="#333" stroke-width="3"/>`);
      const dir = xPos === beamLeft ? -1 : 1;
      for (let i = 0; i < 5; i++) {
        const yy = beamY - 15 + i * 7.5;
        lines.push(`<line x1="${xPos + dir * 8}" y1="${yy + 5}" x2="${xPos}" y2="${yy}" stroke="#333" stroke-width="1"/>`);
      }
    }
  } else if (beamType === "propped_cantilever") {
    // Fixed wall at left
    lines.push(`<line x1="${beamLeft}" y1="${beamY - 15}" x2="${beamLeft}" y2="${beamY + 15}" stroke="#333" stroke-width="3"/>`);
    for (let i = 0; i < 5; i++) {
      const yy = beamY - 15 + i * 7.5;
      lines.push(`<line x1="${beamLeft - 8}" y1="${yy + 5}" x2="${beamLeft}" y2="${yy}" stroke="#333" stroke-width="1"/>`);
    }
    // Roller at right
    lines.push(`<circle cx="${beamRight}" cy="${beamY + supportSize + 4}" r="${supportSize / 2}" fill="none" stroke="#333" stroke-width="1.5"/>`);
    lines.push(`<line x1="${beamRight - supportSize}" y1="${beamY + supportSize * 1.5 + 2}" x2="${beamRight + supportSize}" y2="${beamY + supportSize * 1.5 + 2}" stroke="#333" stroke-width="1.5"/>`);
  }

  // Load arrows
  for (const load of loads) {
    if (load.type === "point") {
      const px = xScale(load.position_m);
      const arrowLen = 25;
      lines.push(`<line x1="${px}" y1="${beamY - arrowLen - 5}" x2="${px}" y2="${beamY - 3}" stroke="#d32f2f" stroke-width="2" marker-end="url(#arrowDown)"/>`);
      lines.push(`<text x="${px}" y="${beamY - arrowLen - 8}" text-anchor="middle" fill="#d32f2f" font-size="10">${load.magnitude} kN</text>`);
    } else if (load.type === "distributed") {
      const x1 = xScale(load.start_m);
      const x2 = xScale(load.end_m);
      const nArrows = Math.max(3, Math.round((x2 - x1) / 20));
      const arrowLen = 20;
      // Top line
      lines.push(`<line x1="${x1}" y1="${beamY - arrowLen - 5}" x2="${x2}" y2="${beamY - arrowLen - 5}" stroke="#1565c0" stroke-width="1.5"/>`);
      for (let j = 0; j <= nArrows; j++) {
        const ax = x1 + (j / nArrows) * (x2 - x1);
        lines.push(`<line x1="${ax}" y1="${beamY - arrowLen - 5}" x2="${ax}" y2="${beamY - 3}" stroke="#1565c0" stroke-width="1" marker-end="url(#arrowDownBlue)"/>`);
      }
      lines.push(`<text x="${(x1 + x2) / 2}" y="${beamY - arrowLen - 9}" text-anchor="middle" fill="#1565c0" font-size="10">${load.magnitude} kN/m</text>`);
    } else if (load.type === "moment") {
      const px = xScale(load.position_m);
      // Draw a curved arrow for moment
      const r = 12;
      lines.push(`<path d="M ${px - r} ${beamY - 5} A ${r} ${r} 0 1 1 ${px + r} ${beamY - 5}" fill="none" stroke="#7b1fa2" stroke-width="1.5" marker-end="url(#arrowMoment)"/>`);
      lines.push(`<text x="${px}" y="${beamY - 22}" text-anchor="middle" fill="#7b1fa2" font-size="10">${load.magnitude} kN\u00b7m</text>`);
    }
  }

  // Arrow markers
  lines.push(`<defs>`);
  lines.push(`<marker id="arrowDown" markerWidth="8" markerHeight="8" refX="4" refY="8" orient="auto"><path d="M0,0 L4,8 L8,0" fill="#d32f2f"/></marker>`);
  lines.push(`<marker id="arrowDownBlue" markerWidth="6" markerHeight="6" refX="3" refY="6" orient="auto"><path d="M0,0 L3,6 L6,0" fill="#1565c0"/></marker>`);
  lines.push(`<marker id="arrowMoment" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="#7b1fa2"/></marker>`);
  lines.push(`</defs>`);

  // ── Shear Force Diagram ──
  lines.push(`<text x="${margin.left - 5}" y="${shearTop - 5}" text-anchor="end" font-size="12" font-weight="bold">Shear (kN)</text>`);

  // Grid lines for shear
  drawGrid(lines, margin.left, shearTop, plotWidth, diagramHeight, shearMid, vRange, "kN");

  // Shear diagram path (filled)
  let shearPath = `M ${xScale(points[0]!.x_m)} ${vScale(0)}`;
  for (const p of points) {
    shearPath += ` L ${xScale(p.x_m)} ${vScale(p.shear_kn)}`;
  }
  shearPath += ` L ${xScale(points[points.length - 1]!.x_m)} ${vScale(0)} Z`;

  // Split into positive (blue) and negative (red) by drawing full path with clip
  lines.push(`<path d="${shearPath}" fill="#1565c0" fill-opacity="0.3" stroke="#1565c0" stroke-width="1.5"/>`);
  // Overlay negative region in red
  let negShearPath = "";
  let inNeg = false;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const px = xScale(p.x_m);
    const py = vScale(Math.min(0, p.shear_kn));
    if (p.shear_kn < -1e-9) {
      if (!inNeg) {
        negShearPath += `M ${px} ${vScale(0)} L ${px} ${py}`;
        inNeg = true;
      } else {
        negShearPath += ` L ${px} ${py}`;
      }
    } else if (inNeg) {
      negShearPath += ` L ${px} ${vScale(0)} Z `;
      inNeg = false;
    }
  }
  if (inNeg) {
    negShearPath += ` L ${xScale(points[points.length - 1]!.x_m)} ${vScale(0)} Z`;
  }
  if (negShearPath) {
    lines.push(`<path d="${negShearPath}" fill="#d32f2f" fill-opacity="0.3" stroke="#d32f2f" stroke-width="1.5"/>`);
  }

  // Annotate max/min shear
  const maxShearPt = points.reduce((a, b) => Math.abs(b.shear_kn) > Math.abs(a.shear_kn) ? b : a);
  lines.push(`<circle cx="${xScale(maxShearPt.x_m)}" cy="${vScale(maxShearPt.shear_kn)}" r="3" fill="#d32f2f"/>`);
  lines.push(`<text x="${xScale(maxShearPt.x_m) + 5}" y="${vScale(maxShearPt.shear_kn) - 5}" fill="#d32f2f" font-size="10">${maxShearPt.shear_kn.toFixed(2)} kN</text>`);

  // ── Bending Moment Diagram ──
  lines.push(`<text x="${margin.left - 5}" y="${momentTop - 5}" text-anchor="end" font-size="12" font-weight="bold">Moment (kN\u00b7m)</text>`);

  // Grid lines for moment
  drawGrid(lines, margin.left, momentTop, plotWidth, diagramHeight, momentMid, mRange, "kN\u00b7m");

  // Moment diagram path
  let momentPath = `M ${xScale(points[0]!.x_m)} ${mScale(0)}`;
  for (const p of points) {
    momentPath += ` L ${xScale(p.x_m)} ${mScale(p.moment_knm)}`;
  }
  momentPath += ` L ${xScale(points[points.length - 1]!.x_m)} ${mScale(0)} Z`;

  lines.push(`<path d="${momentPath}" fill="#1565c0" fill-opacity="0.3" stroke="#1565c0" stroke-width="1.5"/>`);

  // Overlay negative moment in red
  let negMomentPath = "";
  let inNegM = false;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const px = xScale(p.x_m);
    const py = mScale(Math.min(0, p.moment_knm));
    if (p.moment_knm < -1e-9) {
      if (!inNegM) {
        negMomentPath += `M ${px} ${mScale(0)} L ${px} ${py}`;
        inNegM = true;
      } else {
        negMomentPath += ` L ${px} ${py}`;
      }
    } else if (inNegM) {
      negMomentPath += ` L ${px} ${mScale(0)} Z `;
      inNegM = false;
    }
  }
  if (inNegM) {
    negMomentPath += ` L ${xScale(points[points.length - 1]!.x_m)} ${mScale(0)} Z`;
  }
  if (negMomentPath) {
    lines.push(`<path d="${negMomentPath}" fill="#d32f2f" fill-opacity="0.3" stroke="#d32f2f" stroke-width="1.5"/>`);
  }

  // Annotate max/min moment
  const maxMomentPt = points.reduce((a, b) => Math.abs(b.moment_knm) > Math.abs(a.moment_knm) ? b : a);
  lines.push(`<circle cx="${xScale(maxMomentPt.x_m)}" cy="${mScale(maxMomentPt.moment_knm)}" r="3" fill="#d32f2f"/>`);
  lines.push(`<text x="${xScale(maxMomentPt.x_m) + 5}" y="${mScale(maxMomentPt.moment_knm) - 5}" fill="#d32f2f" font-size="10">${maxMomentPt.moment_knm.toFixed(2)} kN\u00b7m</text>`);

  // Summary line at bottom
  const summaryY = height - 10;
  lines.push(`<text x="${width / 2}" y="${summaryY}" text-anchor="middle" font-size="10" fill="#555">V_max = ${maxShear.toFixed(2)} kN | M_max = ${maxMoment.toFixed(2)} kN\u00b7m | \u03b4_max = ${maxDeflection.toFixed(3)} mm</text>`);

  lines.push(`</svg>`);
  return lines.join("\n");
}

function drawGrid(
  lines: string[],
  left: number,
  top: number,
  plotWidth: number,
  diagramHeight: number,
  midY: number,
  range: number,
  unit: string,
): void {
  const right = left + plotWidth;
  const bottom = top + diagramHeight;

  // Border
  lines.push(`<rect x="${left}" y="${top}" width="${plotWidth}" height="${diagramHeight}" fill="white" stroke="#ddd" stroke-width="0.5"/>`);

  // Zero axis
  lines.push(`<line x1="${left}" y1="${midY}" x2="${right}" y2="${midY}" stroke="#999" stroke-width="0.5" stroke-dasharray="4,3"/>`);

  // Horizontal grid lines (3 above, 3 below zero)
  for (let i = 1; i <= 3; i++) {
    const frac = i / 3;
    const yUp = midY - frac * (diagramHeight / 2);
    const yDown = midY + frac * (diagramHeight / 2);
    const val = (frac * range).toFixed(1);
    lines.push(`<line x1="${left}" y1="${yUp}" x2="${right}" y2="${yUp}" stroke="#eee" stroke-width="0.5"/>`);
    lines.push(`<line x1="${left}" y1="${yDown}" x2="${right}" y2="${yDown}" stroke="#eee" stroke-width="0.5"/>`);
    lines.push(`<text x="${left - 4}" y="${yUp + 3}" text-anchor="end" font-size="9" fill="#888">${val}</text>`);
    lines.push(`<text x="${left - 4}" y="${yDown + 3}" text-anchor="end" font-size="9" fill="#888">-${val}</text>`);
  }
  lines.push(`<text x="${left - 4}" y="${midY + 3}" text-anchor="end" font-size="9" fill="#888">0</text>`);
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ─── Main analysis function ──────────────────────────────────────────────────

function analyzeBeam(input: BeamInput): AnalysisResult {
  const { beam_type, span_m: L, loads, section, material, output_path, num_points } = input;

  // Compute section properties
  const secProps = computeSectionProperties(section);

  // EI in kN*m^2: E [MPa = N/mm^2 = kN/(1000*mm^2)] and I [mm^4]
  // E [kN/m^2] = E_mpa * 1000
  // I [m^4] = I_mm4 * 1e-12
  // EI [kN*m^2] = E_mpa * 1000 * I_mm4 * 1e-12 = E_mpa * I_mm4 * 1e-9
  const EI = material.E_mpa * secProps.I_mm4 * 1e-9;

  let result: { reactions: Reactions; points: DiagramPoint[] };

  switch (beam_type) {
    case "simply_supported":
      result = analyzeSimplySupported(loads, L, num_points, EI);
      break;
    case "cantilever":
      result = analyzeCantilever(loads, L, num_points, EI);
      break;
    case "fixed_fixed":
      result = analyzeFixedFixed(loads, L, num_points, EI);
      break;
    case "propped_cantilever":
      result = analyzeProppedCantilever(loads, L, num_points, EI);
      break;
    default:
      throw new Error(`Unsupported beam type: ${beam_type}`);
  }

  const { reactions, points } = result;

  // Find extremes
  let maxShear = 0;
  let maxMoment = 0;
  let maxDeflection = 0;

  for (const p of points) {
    if (Math.abs(p.shear_kn) > Math.abs(maxShear)) maxShear = p.shear_kn;
    if (Math.abs(p.moment_knm) > Math.abs(maxMoment)) maxMoment = p.moment_knm;
    if (Math.abs(p.deflection_mm) > Math.abs(maxDeflection)) maxDeflection = p.deflection_mm;
  }

  // Stress check
  // M is in kN·m, S is in mm^3
  // sigma = M / S  =>  M [kN·m] * 1e6 [mm/m * N/kN... wait]
  // M [kN·m] = M * 1e6 [N·mm]  (1 kN = 1000 N, 1 m = 1000 mm => 1 kN·m = 1e6 N·mm)
  // sigma [MPa = N/mm^2] = M [N·mm] / S [mm^3]
  const maxStress = Math.abs(maxMoment) * 1e6 / secProps.S_mm3;
  const allowableStress = material.fy_mpa;
  const stressUtil = maxStress / allowableStress;

  // Deflection check: L/360
  const deflectionLimit = (L * 1000) / 360; // mm
  const deflUtil = Math.abs(maxDeflection) / deflectionLimit;

  const status: "PASS" | "FAIL" = stressUtil <= 1.0 && deflUtil <= 1.0 ? "PASS" : "FAIL";

  // Generate SVG if output path provided
  let savedPath: string | undefined;
  if (output_path) {
    const svg = generateSVG(
      beam_type, L, loads, points, reactions,
      Math.abs(maxShear), Math.abs(maxMoment), Math.abs(maxDeflection), status,
    );
    const resolvedPath = path.resolve(output_path);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, svg, "utf-8");
    savedPath = resolvedPath;
  }

  // Round diagram points for output
  const roundedPoints = points.map(p => ({
    x_m: round4(p.x_m),
    shear_kn: round4(p.shear_kn),
    moment_knm: round4(p.moment_knm),
    deflection_mm: round4(p.deflection_mm),
  }));

  return {
    beam_type,
    span_m: L,
    reactions,
    max_shear_kn: round4(maxShear),
    max_moment_knm: round4(maxMoment),
    max_deflection_mm: round4(maxDeflection),
    section_properties: {
      I_mm4: round4(secProps.I_mm4),
      S_mm3: round4(secProps.S_mm3),
      A_mm2: round4(secProps.A_mm2),
    },
    max_stress_mpa: round4(maxStress),
    allowable_stress_mpa: allowableStress,
    stress_utilization_ratio: round4(stressUtil),
    deflection_limit_mm: round4(deflectionLimit),
    deflection_utilization_ratio: round4(deflUtil),
    status,
    output_path: savedPath,
    diagram_points: roundedPoints,
  };
}

// ─── Tool definition ─────────────────────────────────────────────────────────

export function createBeamAnalysisToolDefinition() {
  return {
    name: "structural_beam",
    label: "Beam Analysis",
    description:
      "Analyze a beam under various loading conditions (point loads, distributed loads, moments). " +
      "Supports simply supported, cantilever, fixed-fixed, and propped cantilever beams. " +
      "Calculates reactions, shear force, bending moment, deflections, and checks against " +
      "allowable stress/deflection limits. Can generate shear/moment diagram SVG.",
    parameters: {
      type: "object",
      properties: {
        beam_type: {
          type: "string",
          enum: ["simply_supported", "cantilever", "fixed_fixed", "propped_cantilever"],
          description:
            "Support conditions for the beam. 'simply_supported' = pin at left, roller at right. " +
            "'cantilever' = fixed at left, free at right. 'fixed_fixed' = fixed at both ends. " +
            "'propped_cantilever' = fixed at left, roller at right.",
        },
        span_m: {
          type: "number",
          description: "Beam span in meters.",
          exclusiveMinimum: 0,
        },
        loads: {
          type: "array",
          description: "Array of applied loads on the beam.",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["point", "distributed", "moment"],
                description:
                  "'point' = concentrated force (kN), 'distributed' = uniform load (kN/m), 'moment' = applied moment (kN\u00b7m).",
              },
              magnitude: {
                type: "number",
                description:
                  "Load magnitude. kN for point loads, kN/m for distributed loads, kN\u00b7m for moments. Positive = downward/clockwise.",
              },
              position_m: {
                type: "number",
                description: "Position from left support in meters (for point loads and moments).",
              },
              start_m: {
                type: "number",
                description: "Start position in meters for distributed loads (default: 0).",
              },
              end_m: {
                type: "number",
                description: "End position in meters for distributed loads (default: span_m for full UDL).",
              },
            },
            required: ["type", "magnitude"],
          },
        },
        section: {
          type: "object",
          description:
            "Cross-section properties. Specify 'type' as 'rectangular', 'circular', 'i_beam', or 'custom'. " +
            "Rectangular: width_mm, depth_mm. Circular: diameter_mm. " +
            "I-beam: depth_mm, flange_width_mm, flange_thickness_mm, web_thickness_mm. " +
            "Custom: I_mm4, S_mm3, A_mm2.",
          properties: {
            type: {
              type: "string",
              enum: ["rectangular", "circular", "i_beam", "custom"],
            },
            width_mm: { type: "number", description: "Width in mm (rectangular)." },
            depth_mm: { type: "number", description: "Depth in mm (rectangular, I-beam)." },
            diameter_mm: { type: "number", description: "Diameter in mm (circular)." },
            flange_width_mm: { type: "number", description: "Flange width in mm (I-beam)." },
            flange_thickness_mm: { type: "number", description: "Flange thickness in mm (I-beam)." },
            web_thickness_mm: { type: "number", description: "Web thickness in mm (I-beam)." },
            I_mm4: { type: "number", description: "Moment of inertia in mm^4 (custom)." },
            S_mm3: { type: "number", description: "Section modulus in mm^3 (custom)." },
            A_mm2: { type: "number", description: "Cross-section area in mm^2 (custom)." },
          },
          required: ["type"],
        },
        material: {
          type: "object",
          description:
            "Material properties. Defaults to structural steel (E = 200000 MPa, fy = 250 MPa).",
          properties: {
            E_mpa: {
              type: "number",
              description: "Modulus of elasticity in MPa (default: 200000 for steel).",
            },
            fy_mpa: {
              type: "number",
              description: "Yield strength in MPa (default: 250 for A36 steel).",
            },
            name: {
              type: "string",
              description: "Material name (e.g. 'A36 Steel', 'Concrete C30').",
            },
          },
        },
        output_path: {
          type: "string",
          description:
            "File path to save the shear/moment diagram as SVG. If not provided, no SVG is generated.",
        },
        num_points: {
          type: "number",
          description: "Number of points for diagram calculation (default: 100).",
          minimum: 10,
          maximum: 1000,
        },
      },
      required: ["beam_type", "span_m", "loads", "section"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }> => {
      const params = (args ?? {}) as Record<string, unknown>;

      // ── Validate and parse beam_type ──
      const beamType = String(params.beam_type ?? "simply_supported") as BeamType;
      const validBeamTypes: BeamType[] = [
        "simply_supported",
        "cantilever",
        "fixed_fixed",
        "propped_cantilever",
      ];
      if (!validBeamTypes.includes(beamType)) {
        throw new Error(
          `Invalid beam_type '${beamType}'. Must be one of: ${validBeamTypes.join(", ")}`,
        );
      }

      // ── Validate span ──
      const spanM = Number(params.span_m);
      if (!Number.isFinite(spanM) || spanM <= 0) {
        throw new Error("span_m must be a positive number.");
      }

      // ── Validate loads ──
      if (!Array.isArray(params.loads) || params.loads.length === 0) {
        throw new Error("loads must be a non-empty array.");
      }
      const loads = normalizeLoads(params.loads, spanM);

      // ── Validate section ──
      const rawSection = params.section as Record<string, unknown> | undefined;
      if (!rawSection || typeof rawSection !== "object") {
        throw new Error("section is required and must be an object with a 'type' field.");
      }
      const section = parseSection(rawSection);

      // ── Material (with defaults) ──
      const rawMat = (params.material ?? {}) as Record<string, unknown>;
      const material: Material = {
        E_mpa: typeof rawMat.E_mpa === "number" ? rawMat.E_mpa : 200000,
        fy_mpa: typeof rawMat.fy_mpa === "number" ? rawMat.fy_mpa : 250,
        name: typeof rawMat.name === "string" ? rawMat.name : "Structural Steel (A36)",
      };

      // ── Optional parameters ──
      const outputPath =
        typeof params.output_path === "string" ? params.output_path.trim() || undefined : undefined;
      const numPoints =
        typeof params.num_points === "number" && Number.isFinite(params.num_points)
          ? Math.max(10, Math.min(1000, Math.round(params.num_points)))
          : 100;

      // ── Run analysis ──
      const result = analyzeBeam({
        beam_type: beamType,
        span_m: spanM,
        loads,
        section,
        material,
        output_path: outputPath,
        num_points: numPoints,
      });

      // ── Build response text ──
      const summary = [
        `Beam Analysis: ${beamType.replace(/_/g, " ")} | Span: ${spanM} m`,
        `Material: ${material.name} (E=${material.E_mpa} MPa, fy=${material.fy_mpa} MPa)`,
        ``,
        `Reactions:`,
        `  Left: ${result.reactions.left_kn} kN${result.reactions.left_moment_knm != null ? `, M = ${result.reactions.left_moment_knm} kN\u00b7m` : ""}`,
        `  Right: ${result.reactions.right_kn} kN${result.reactions.right_moment_knm != null ? `, M = ${result.reactions.right_moment_knm} kN\u00b7m` : ""}`,
        ``,
        `Extremes:`,
        `  Max Shear: ${result.max_shear_kn} kN`,
        `  Max Moment: ${result.max_moment_knm} kN\u00b7m`,
        `  Max Deflection: ${result.max_deflection_mm} mm`,
        ``,
        `Section: I = ${result.section_properties.I_mm4.toExponential(3)} mm\u2074, S = ${result.section_properties.S_mm3.toExponential(3)} mm\u00b3`,
        ``,
        `Checks:`,
        `  Stress: ${result.max_stress_mpa.toFixed(2)} / ${result.allowable_stress_mpa} MPa (ratio: ${result.stress_utilization_ratio.toFixed(3)})`,
        `  Deflection: ${Math.abs(result.max_deflection_mm).toFixed(3)} / ${result.deflection_limit_mm.toFixed(3)} mm [L/360] (ratio: ${result.deflection_utilization_ratio.toFixed(3)})`,
        ``,
        `Status: ${result.status}`,
      ];

      if (result.output_path) {
        summary.push(`Diagram saved to: ${result.output_path}`);
      }

      return {
        content: [
          { type: "text", text: summary.join("\n") },
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
        details: {
          beam_type: beamType,
          span_m: spanM,
          status: result.status,
          max_shear_kn: result.max_shear_kn,
          max_moment_knm: result.max_moment_knm,
          max_deflection_mm: result.max_deflection_mm,
          stress_utilization: result.stress_utilization_ratio,
          deflection_utilization: result.deflection_utilization_ratio,
        },
      };
    },
  };
}

// ─── Section parser ──────────────────────────────────────────────────────────

function parseSection(raw: Record<string, unknown>): Section {
  const t = String(raw.type);
  switch (t) {
    case "rectangular": {
      const w = Number(raw.width_mm);
      const d = Number(raw.depth_mm);
      if (!Number.isFinite(w) || w <= 0) throw new Error("section.width_mm must be a positive number.");
      if (!Number.isFinite(d) || d <= 0) throw new Error("section.depth_mm must be a positive number.");
      return { type: "rectangular", width_mm: w, depth_mm: d };
    }
    case "circular": {
      const d = Number(raw.diameter_mm);
      if (!Number.isFinite(d) || d <= 0) throw new Error("section.diameter_mm must be a positive number.");
      return { type: "circular", diameter_mm: d };
    }
    case "i_beam": {
      const depth = Number(raw.depth_mm);
      const fw = Number(raw.flange_width_mm);
      const ft = Number(raw.flange_thickness_mm);
      const tw = Number(raw.web_thickness_mm);
      if (!Number.isFinite(depth) || depth <= 0) throw new Error("section.depth_mm must be positive.");
      if (!Number.isFinite(fw) || fw <= 0) throw new Error("section.flange_width_mm must be positive.");
      if (!Number.isFinite(ft) || ft <= 0) throw new Error("section.flange_thickness_mm must be positive.");
      if (!Number.isFinite(tw) || tw <= 0) throw new Error("section.web_thickness_mm must be positive.");
      if (2 * ft >= depth) throw new Error("2 * flange_thickness_mm must be less than depth_mm.");
      if (tw >= fw) throw new Error("web_thickness_mm must be less than flange_width_mm.");
      return { type: "i_beam", depth_mm: depth, flange_width_mm: fw, flange_thickness_mm: ft, web_thickness_mm: tw };
    }
    case "custom": {
      const I = Number(raw.I_mm4);
      const S = Number(raw.S_mm3);
      const A = Number(raw.A_mm2);
      if (!Number.isFinite(I) || I <= 0) throw new Error("section.I_mm4 must be positive.");
      if (!Number.isFinite(S) || S <= 0) throw new Error("section.S_mm3 must be positive.");
      if (!Number.isFinite(A) || A <= 0) throw new Error("section.A_mm2 must be positive.");
      return { type: "custom", I_mm4: I, S_mm3: S, A_mm2: A };
    }
    default:
      throw new Error(
        `Invalid section type '${t}'. Must be one of: rectangular, circular, i_beam, custom.`,
      );
  }
}
