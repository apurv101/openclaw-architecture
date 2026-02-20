/**
 * Floor Plan Analyze tool for openclaw-mini.
 *
 * Analyzes a floor plan image (PNG/JPG/PDF) or vector file (SVG/DXF) using
 * AI vision to extract rooms, dimensions, walls, and produce a structured
 * JSON representation.
 *
 * For images: prepares base64 data + structured prompt for AI vision analysis.
 * For SVG: programmatically parses elements to extract rooms, walls, doors.
 * For DXF: recommends using the dxf_parse tool first.
 *
 * No external dependencies beyond Node.js `fs` and `path`.
 */
import fs from "node:fs";
import path from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

type OutputFormat = "json" | "room_list" | "adjacency_matrix";
type Units = "meters" | "feet" | "auto";

interface AnalyzeParams {
  file_path: string;
  extract_dimensions: boolean;
  output_format: OutputFormat;
  units: Units;
  output_path?: string;
}

interface SvgElement {
  tag: string;
  attrs: Record<string, string>;
  text?: string;
}

interface SvgRoom {
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  area: number;
}

interface SvgWall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  type: "exterior" | "interior";
  length: number;
}

interface SvgDoor {
  x: number;
  y: number;
  inferred: boolean;
}

interface DimensionAnnotation {
  value: number;
  unit: string;
  near_element: string;
  position: { x: number; y: number };
}

// ─── SVG Parsing Helpers ─────────────────────────────────────────────────────

/**
 * Simple regex-based SVG element extractor. Extracts self-closing and
 * paired elements for common geometric shapes and text.
 */
function extractSvgElements(svgContent: string): SvgElement[] {
  const elements: SvgElement[] = [];

  // Match self-closing tags: <rect .../>, <line .../>, <circle .../>, etc.
  const selfClosingRegex = /<(rect|line|polyline|polygon|circle|ellipse|path)\s+([^>]*?)\/>/gi;
  let match: RegExpExecArray | null;

  while ((match = selfClosingRegex.exec(svgContent)) !== null) {
    const tag = match[1]!.toLowerCase();
    const attrStr = match[2]!;
    const attrs = parseAttributes(attrStr);
    elements.push({ tag, attrs });
  }

  // Match text elements: <text ...>content</text>
  const textRegex = /<text\s+([^>]*?)>([\s\S]*?)<\/text>/gi;
  while ((match = textRegex.exec(svgContent)) !== null) {
    const attrStr = match[1]!;
    const textContent = match[2]!.replace(/<[^>]+>/g, "").trim();
    const attrs = parseAttributes(attrStr);
    elements.push({ tag: "text", attrs, text: textContent });
  }

  return elements;
}

/**
 * Parse HTML/SVG attribute string into key-value pairs.
 */
function parseAttributes(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /(\w[\w-]*)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(attrStr)) !== null) {
    attrs[m[1]!] = m[2]!;
  }
  return attrs;
}

/**
 * Parse a numeric attribute, returning 0 if not present or not parseable.
 */
function num(attrs: Record<string, string>, key: string): number {
  const v = attrs[key];
  if (v === undefined) return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compute distance between two points.
 */
function distance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

/**
 * Round to 2 decimal places.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── SVG Analysis ────────────────────────────────────────────────────────────

/**
 * Detect the pixel-to-meter scale from SVG viewBox and common conventions.
 * Falls back to 50px = 1m if undetermined.
 */
function detectScale(svgContent: string, units: Units): number {
  // Look for viewBox to estimate overall dimensions
  const viewBoxMatch = svgContent.match(/viewBox="([^"]*)"/);
  if (viewBoxMatch) {
    const parts = viewBoxMatch[1]!.split(/\s+/).map(Number);
    if (parts.length === 4) {
      const vbWidth = parts[2]!;
      const vbHeight = parts[3]!;
      // Heuristic: if viewBox is very large (> 5000), likely pixel-based at ~50px/m
      // If moderate (100-1000), could be mm or direct meter coords
      if (vbWidth > 5000 || vbHeight > 5000) {
        return 50; // 50px per meter
      }
      if (vbWidth < 100 && vbHeight < 100) {
        // Likely direct meter coordinates
        return 1;
      }
    }
  }

  // Default: assume architectural SVG at 50px/m
  return 50;
}

function analyzeSvg(
  svgContent: string,
  params: AnalyzeParams,
): Record<string, unknown> {
  const elements = extractSvgElements(svgContent);
  const scale = detectScale(svgContent, params.units);

  const rects = elements.filter((e) => e.tag === "rect");
  const lines = elements.filter((e) => e.tag === "line");
  const texts = elements.filter((e) => e.tag === "text");
  const polylines = elements.filter((e) => e.tag === "polyline");
  const polygons = elements.filter((e) => e.tag === "polygon");
  const paths = elements.filter((e) => e.tag === "path");

  // ── Identify rooms from rects ──────────────────────────────────────────
  // Filter out very small rects (decorations) and very large ones (background)
  const allRects = rects.map((r) => ({
    x: num(r.attrs, "x"),
    y: num(r.attrs, "y"),
    width: num(r.attrs, "width"),
    height: num(r.attrs, "height"),
    fill: r.attrs.fill ?? "",
    stroke: r.attrs.stroke ?? "",
    strokeWidth: num(r.attrs, "stroke-width"),
  }));

  // Sort by area descending; the largest rect is likely the building outline
  const sortedRects = [...allRects].sort(
    (a, b) => b.width * b.height - a.width * a.height,
  );

  const buildingRect = sortedRects[0];
  const minRoomArea = buildingRect
    ? buildingRect.width * buildingRect.height * 0.01
    : 100;

  // Rooms are rects that aren't the building outline and aren't tiny
  const roomRects = sortedRects.filter((r, i) => {
    if (i === 0 && sortedRects.length > 1) return false; // skip building outline
    const area = r.width * r.height;
    return area > minRoomArea && r.width > 5 && r.height > 5;
  });

  // ── Match text labels to rooms ─────────────────────────────────────────
  const rooms: SvgRoom[] = roomRects.map((rect, idx) => {
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;

    // Find the closest text element inside or near this rect
    let bestLabel = `Room ${idx + 1}`;
    let bestDist = Infinity;

    for (const t of texts) {
      if (!t.text) continue;
      const tx = num(t.attrs, "x");
      const ty = num(t.attrs, "y");

      // Check if text is inside the rect
      const inside =
        tx >= rect.x &&
        tx <= rect.x + rect.width &&
        ty >= rect.y &&
        ty <= rect.y + rect.height;

      if (inside) {
        const dist = distance(tx, ty, cx, cy);
        // Skip dimension-like text (numbers with units)
        const isDimension = /^\d+\.?\d*\s*(m|mm|ft|'|")?\s*$/.test(t.text);
        if (!isDimension && dist < bestDist) {
          bestDist = dist;
          bestLabel = t.text;
        }
      }
    }

    // Infer room type from label
    const lowerLabel = bestLabel.toLowerCase();
    let roomType = "room";
    if (/bed|master|guest/.test(lowerLabel)) roomType = "bedroom";
    else if (/bath|wc|toilet|powder/.test(lowerLabel)) roomType = "bathroom";
    else if (/kitchen|pantry/.test(lowerLabel)) roomType = "kitchen";
    else if (/living|lounge|family/.test(lowerLabel)) roomType = "living";
    else if (/dining/.test(lowerLabel)) roomType = "dining";
    else if (/office|study|den/.test(lowerLabel)) roomType = "office";
    else if (/garage|carport/.test(lowerLabel)) roomType = "garage";
    else if (/laundry|utility/.test(lowerLabel)) roomType = "laundry";
    else if (/corridor|hall|entry|foyer/.test(lowerLabel)) roomType = "corridor";
    else if (/stairs|stair/.test(lowerLabel)) roomType = "stairs";
    else if (/storage|closet/.test(lowerLabel)) roomType = "storage";

    const widthM = round2(rect.width / scale);
    const heightM = round2(rect.height / scale);

    return {
      name: bestLabel,
      type: roomType,
      x: round2(rect.x / scale),
      y: round2(rect.y / scale),
      width: widthM,
      height: heightM,
      area: round2(widthM * heightM),
    };
  });

  // ── Extract walls from lines ───────────────────────────────────────────
  const walls: SvgWall[] = [];

  for (const line of lines) {
    const x1 = num(line.attrs, "x1");
    const y1 = num(line.attrs, "y1");
    const x2 = num(line.attrs, "x2");
    const y2 = num(line.attrs, "y2");
    const sw = num(line.attrs, "stroke-width");
    const len = distance(x1, y1, x2, y2);

    // Skip very short lines (dimension ticks, markers)
    if (len < 10) continue;

    // Thicker lines are exterior walls, thinner are interior
    const wallType: "exterior" | "interior" = sw >= 2 ? "exterior" : "interior";

    walls.push({
      x1: round2(x1 / scale),
      y1: round2(y1 / scale),
      x2: round2(x2 / scale),
      y2: round2(y2 / scale),
      type: wallType,
      length: round2(len / scale),
    });
  }

  // Also extract walls from the building outline rect
  if (buildingRect && sortedRects.length > 1) {
    const bx = buildingRect.x;
    const by = buildingRect.y;
    const bw = buildingRect.width;
    const bh = buildingRect.height;

    const exteriorWalls: Array<{ x1: number; y1: number; x2: number; y2: number }> = [
      { x1: bx, y1: by, x2: bx + bw, y2: by },             // top
      { x1: bx + bw, y1: by, x2: bx + bw, y2: by + bh },   // right
      { x1: bx + bw, y1: by + bh, x2: bx, y2: by + bh },   // bottom
      { x1: bx, y1: by + bh, x2: bx, y2: by },              // left
    ];

    for (const w of exteriorWalls) {
      const len = distance(w.x1, w.y1, w.x2, w.y2);
      walls.push({
        x1: round2(w.x1 / scale),
        y1: round2(w.y1 / scale),
        x2: round2(w.x2 / scale),
        y2: round2(w.y2 / scale),
        type: "exterior",
        length: round2(len / scale),
      });
    }
  }

  // ── Extract dimension annotations ──────────────────────────────────────
  const dimensionsFound: DimensionAnnotation[] = [];

  if (params.extract_dimensions) {
    for (const t of texts) {
      if (!t.text) continue;
      // Match patterns like "3.50 m", "12.5", "10'-6\"", "3500 mm"
      const dimMatch = t.text.match(
        /^(\d+\.?\d*)\s*(m|mm|ft|meters|feet|'|")?\s*$/i,
      );
      if (dimMatch) {
        let value = parseFloat(dimMatch[1]!);
        let unit = (dimMatch[2] ?? "").toLowerCase();

        // Normalize units
        if (unit === "meters") unit = "m";
        if (unit === "feet" || unit === "'") unit = "ft";
        if (unit === "\"") unit = "in";

        // If no unit specified, use the params.units preference
        if (!unit) {
          if (params.units === "feet") unit = "ft";
          else if (params.units === "meters") unit = "m";
          else {
            // Auto: if value > 20, likely feet; otherwise meters
            unit = value > 20 ? "ft" : "m";
          }
        }

        // Convert mm to m
        if (unit === "mm") {
          value = value / 1000;
          unit = "m";
        }

        const tx = num(t.attrs, "x");
        const ty = num(t.attrs, "y");

        // Find what this dimension is near
        let nearElement = "unknown";
        let nearDist = Infinity;
        for (const room of rooms) {
          const rx = room.x * scale;
          const ry = room.y * scale;
          const rw = room.width * scale;
          const rh = room.height * scale;
          const dist = Math.min(
            distance(tx, ty, rx + rw / 2, ry),       // near top edge
            distance(tx, ty, rx + rw / 2, ry + rh),  // near bottom edge
            distance(tx, ty, rx, ry + rh / 2),        // near left edge
            distance(tx, ty, rx + rw, ry + rh / 2),   // near right edge
          );
          if (dist < nearDist) {
            nearDist = dist;
            nearElement = room.name;
          }
        }

        dimensionsFound.push({
          value: round2(value),
          unit,
          near_element: nearElement,
          position: { x: round2(tx / scale), y: round2(ty / scale) },
        });
      }
    }
  }

  // ── Detect doors (gaps in walls, arc paths) ────────────────────────────
  const doors: SvgDoor[] = [];

  // Look for arc paths that indicate door swings
  for (const p of paths) {
    const d = p.attrs.d ?? "";
    // Door arcs typically contain an 'A' (arc) command
    if (/[Aa]\s*[\d.]+/.test(d)) {
      // Extract the starting point of the arc
      const moveMatch = d.match(/[Mm]\s*([\d.]+)[,\s]+([\d.]+)/);
      if (moveMatch) {
        const px = parseFloat(moveMatch[1]!);
        const py = parseFloat(moveMatch[2]!);
        doors.push({
          x: round2(px / scale),
          y: round2(py / scale),
          inferred: false,
        });
      }
    }
  }

  // ── Build adjacency matrix ─────────────────────────────────────────────
  const eps = 0.05; // tolerance in meters for shared edges
  const adjacencyMatrix: Record<string, string[]> = {};

  for (const room of rooms) {
    adjacencyMatrix[room.name] = [];
  }

  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i]!;
      const b = rooms[j]!;

      // Check shared vertical edge
      const shareVert =
        (Math.abs(a.x + a.width - b.x) < eps ||
          Math.abs(b.x + b.width - a.x) < eps) &&
        a.y < b.y + b.height - eps &&
        b.y < a.y + a.height - eps;

      // Check shared horizontal edge
      const shareHoriz =
        (Math.abs(a.y + a.height - b.y) < eps ||
          Math.abs(b.y + b.height - a.y) < eps) &&
        a.x < b.x + b.width - eps &&
        b.x < a.x + a.width - eps;

      if (shareVert || shareHoriz) {
        adjacencyMatrix[a.name]!.push(b.name);
        adjacencyMatrix[b.name]!.push(a.name);
      }
    }
  }

  // ── Compose result based on output_format ──────────────────────────────
  const svgStats = {
    total_elements: elements.length,
    rects: rects.length,
    lines: lines.length,
    texts: texts.length,
    polylines: polylines.length,
    polygons: polygons.length,
    paths: paths.length,
  };

  if (params.output_format === "room_list") {
    return {
      analysis_type: "svg",
      file_path: params.file_path,
      detected_scale_px_per_m: scale,
      rooms: rooms.map((r) => ({
        name: r.name,
        type: r.type,
        width_m: r.width,
        height_m: r.height,
        area_sqm: r.area,
      })),
      total_area_sqm: round2(rooms.reduce((s, r) => s + r.area, 0)),
      room_count: rooms.length,
      dimensions_found: dimensionsFound,
      svg_element_counts: svgStats,
    };
  }

  if (params.output_format === "adjacency_matrix") {
    return {
      analysis_type: "svg",
      file_path: params.file_path,
      detected_scale_px_per_m: scale,
      rooms: rooms.map((r) => r.name),
      adjacency_matrix: adjacencyMatrix,
      room_count: rooms.length,
      svg_element_counts: svgStats,
    };
  }

  // Default: full JSON
  return {
    analysis_type: "svg",
    file_path: params.file_path,
    detected_scale_px_per_m: scale,
    rooms: rooms.map((r) => ({
      name: r.name,
      type: r.type,
      x_m: r.x,
      y_m: r.y,
      width_m: r.width,
      height_m: r.height,
      area_sqm: r.area,
    })),
    walls: walls,
    doors: doors,
    dimensions_found: dimensionsFound,
    adjacency_matrix: adjacencyMatrix,
    total_area_sqm: round2(rooms.reduce((s, r) => s + r.area, 0)),
    room_count: rooms.length,
    wall_count: walls.length,
    door_count: doors.length,
    svg_element_counts: svgStats,
  };
}

// ─── Image Analysis Preparation ──────────────────────────────────────────────

function prepareImageAnalysis(
  filePath: string,
  fileBuffer: Buffer,
  fileExt: string,
  params: AnalyzeParams,
): Record<string, unknown> {
  const fileSizeBytes = fileBuffer.length;
  const fileSizeMb = round2(fileSizeBytes / (1024 * 1024));

  const warnings: string[] = [];
  if (fileSizeMb > 10) {
    warnings.push(
      `File size is ${fileSizeMb} MB which is large. Analysis quality may be affected. Consider resizing the image to under 10 MB.`,
    );
  }

  // Determine MIME type
  let mimeType: string;
  switch (fileExt) {
    case ".png":
      mimeType = "image/png";
      break;
    case ".jpg":
    case ".jpeg":
      mimeType = "image/jpeg";
      break;
    case ".pdf":
      mimeType = "application/pdf";
      break;
    case ".gif":
      mimeType = "image/gif";
      break;
    case ".webp":
      mimeType = "image/webp";
      break;
    case ".bmp":
      mimeType = "image/bmp";
      break;
    case ".tiff":
    case ".tif":
      mimeType = "image/tiff";
      break;
    default:
      mimeType = "application/octet-stream";
  }

  // Encode as base64
  const base64Data = fileBuffer.toString("base64");

  // Build the analysis prompt
  const unitPreference =
    params.units === "auto"
      ? "Detect from annotations; default to meters"
      : params.units;

  const analysisPrompt = [
    "Analyze this floor plan image and extract the following structured information:",
    "",
    "1. ROOMS/SPACES: Identify all rooms and spaces visible in the plan.",
    "   For each room provide: name, type (bedroom/bathroom/kitchen/living/dining/office/storage/corridor/stairs/garage/laundry/other), estimated dimensions (width x depth), and estimated area.",
    "",
    params.extract_dimensions
      ? "2. DIMENSIONS: Read any dimension annotations or measurements visible in the plan. Note the unit system used."
      : "2. DIMENSIONS: Skipped (extract_dimensions=false).",
    "",
    "3. WALLS: Identify exterior walls vs interior walls/partitions.",
    "",
    "4. DOORS AND WINDOWS: Identify door locations and swing directions. Identify window locations.",
    "",
    "5. FIXTURES: Note any visible fixtures (toilets, sinks, bathtubs, kitchen counters, appliances, stairs, elevators).",
    "",
    "6. OVERALL FOOTPRINT: Estimate the total building footprint dimensions.",
    "",
    `Unit preference: ${unitPreference}`,
    `Output format: ${params.output_format}`,
    "",
    "Return the analysis as a structured JSON object matching the template provided.",
  ].join("\n");

  const template = {
    building_footprint: {
      width_m: 0,
      depth_m: 0,
      total_area_sqm: 0,
    },
    rooms: [
      {
        name: "",
        type: "",
        estimated_area_sqm: 0,
        width_m: 0,
        depth_m: 0,
        position: { x_m: 0, y_m: 0 },
        fixtures: [] as string[],
      },
    ],
    walls: [
      {
        type: "exterior|interior",
        start: { x_m: 0, y_m: 0 },
        end: { x_m: 0, y_m: 0 },
        length_m: 0,
      },
    ],
    doors: [
      {
        location: "",
        connects: ["room_a", "room_b"],
        width_m: 0,
        swing_direction: "",
      },
    ],
    windows: [
      {
        location: "",
        wall: "north|south|east|west",
        width_m: 0,
      },
    ],
    dimension_annotations: [
      {
        value: 0,
        unit: "m|ft",
        describes: "",
      },
    ],
    notes: "",
  };

  return {
    analysis_type: "image",
    file_path: filePath,
    file_size_bytes: fileSizeBytes,
    file_size_mb: fileSizeMb,
    mime_type: mimeType,
    image_data_included: true,
    image_base64: `data:${mimeType};base64,${base64Data}`,
    analysis_prompt: analysisPrompt,
    extraction_template: template,
    output_format: params.output_format,
    units: params.units,
    extract_dimensions: params.extract_dimensions,
    warnings,
  };
}

// ─── DXF Handling ────────────────────────────────────────────────────────────

function handleDxf(filePath: string): Record<string, unknown> {
  return {
    analysis_type: "dxf",
    file_path: filePath,
    recommendation:
      "DXF files require specialized parsing. Use the `dxf_parse` tool first to convert " +
      "the DXF file into structured JSON data (layers, entities, blocks). Then feed that " +
      "structured data back to `floorplan_analyze` or process it directly. " +
      "The dxf_parse tool will extract: layers, LINE/ARC/CIRCLE/POLYLINE entities, " +
      "TEXT/MTEXT annotations, INSERT (block references), and dimension entities.",
    suggested_workflow: [
      "1. Run dxf_parse on the DXF file to get structured entity data",
      "2. Review the extracted layers (e.g., 'A-WALL', 'A-DOOR', 'A-ROOM') to identify architectural elements",
      "3. Use the entity coordinates to reconstruct room boundaries",
      "4. Optionally, feed the extracted data into floorplan_generate_svg to produce a clean SVG",
    ],
  };
}

// ─── Supported Extensions ────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".webp",
  ".tiff",
  ".tif",
  ".pdf",
]);

const SVG_EXTENSIONS = new Set([".svg"]);
const DXF_EXTENSIONS = new Set([".dxf"]);

// ─── Main Execution ──────────────────────────────────────────────────────────

function analyzeFloorplan(params: AnalyzeParams): Record<string, unknown> {
  const resolvedPath = path.resolve(params.file_path);

  // Verify file exists
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`File not found: ${resolvedPath}`);
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${resolvedPath}`);
  }

  const ext = path.extname(resolvedPath).toLowerCase();

  let result: Record<string, unknown>;

  if (DXF_EXTENSIONS.has(ext)) {
    // DXF file
    result = handleDxf(resolvedPath);
  } else if (SVG_EXTENSIONS.has(ext)) {
    // SVG file - parse programmatically
    const svgContent = fs.readFileSync(resolvedPath, "utf-8");
    if (!svgContent.includes("<svg")) {
      throw new Error(
        `File does not appear to be a valid SVG: ${resolvedPath}`,
      );
    }
    result = analyzeSvg(svgContent, { ...params, file_path: resolvedPath });
  } else if (IMAGE_EXTENSIONS.has(ext)) {
    // Image file - prepare for AI vision analysis
    const fileBuffer = fs.readFileSync(resolvedPath);
    result = prepareImageAnalysis(resolvedPath, fileBuffer, ext, params);
  } else {
    throw new Error(
      `Unsupported file type: "${ext}". Supported formats: PNG, JPG, PDF, SVG, DXF`,
    );
  }

  // Write output to file if output_path is specified
  if (params.output_path) {
    const outputResolved = path.resolve(params.output_path);
    const outputDir = path.dirname(outputResolved);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // For image analysis, write everything except the base64 data to keep file size manageable
    let outputData: Record<string, unknown>;
    if (result.analysis_type === "image") {
      const { image_base64, ...rest } = result;
      outputData = {
        ...rest,
        image_data_included: false,
        note: "Base64 image data omitted from file output. The data is available in the tool response.",
      };
    } else {
      outputData = result;
    }

    fs.writeFileSync(
      outputResolved,
      JSON.stringify(outputData, null, 2),
      "utf-8",
    );
    result.output_file = outputResolved;
  }

  return result;
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

export function createFloorplanAnalyzeToolDefinition() {
  return {
    name: "floorplan_analyze",
    label: "Floor Plan Analyzer",
    description:
      "Analyze a floor plan image (PNG/JPG/PDF) or vector file (SVG/DXF) using AI vision " +
      "to extract rooms, dimensions, walls, and produce a structured JSON representation. " +
      "For images, prepares base64 data with a structured analysis prompt for AI processing. " +
      "For SVG files, programmatically parses elements to extract rooms, walls, doors, and " +
      "dimension annotations. For DXF files, recommends using the dxf_parse tool first.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            "Path to the floor plan file. Supports image formats (PNG, JPG, PDF), " +
            "vector formats (SVG), and CAD formats (DXF).",
        },
        extract_dimensions: {
          type: "boolean",
          description:
            "Whether to try reading dimension annotations from the plan. Default: true.",
          default: true,
        },
        output_format: {
          type: "string",
          enum: ["json", "room_list", "adjacency_matrix"],
          description:
            'Output format: "json" for full structured data, "room_list" for a concise ' +
            'list of rooms with areas, "adjacency_matrix" for room connectivity. Default: "json".',
          default: "json",
        },
        units: {
          type: "string",
          enum: ["meters", "feet", "auto"],
          description:
            'Expected dimension units: "meters", "feet", or "auto" to detect from annotations. Default: "auto".',
          default: "auto",
        },
        output_path: {
          type: "string",
          description:
            "Optional file path to save the analysis result as JSON. If omitted, results are returned but not saved to disk.",
        },
      },
      required: ["file_path"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }> => {
      const params = (args ?? {}) as Record<string, unknown>;

      // ── Validate file_path ──────────────────────────────────────────────
      const filePath = String(params.file_path ?? "").trim();
      if (!filePath) {
        throw new Error("file_path is required.");
      }

      // ── Validate extract_dimensions ─────────────────────────────────────
      const extractDimensions = params.extract_dimensions !== false;

      // ── Validate output_format ──────────────────────────────────────────
      const validFormats = new Set<string>(["json", "room_list", "adjacency_matrix"]);
      let outputFormat: OutputFormat = "json";
      if (typeof params.output_format === "string" && validFormats.has(params.output_format)) {
        outputFormat = params.output_format as OutputFormat;
      }

      // ── Validate units ──────────────────────────────────────────────────
      const validUnits = new Set<string>(["meters", "feet", "auto"]);
      let units: Units = "auto";
      if (typeof params.units === "string" && validUnits.has(params.units)) {
        units = params.units as Units;
      }

      // ── Validate output_path ────────────────────────────────────────────
      const outputPath =
        typeof params.output_path === "string" && params.output_path.trim()
          ? params.output_path.trim()
          : undefined;

      // ── Execute analysis ────────────────────────────────────────────────
      const analyzeParams: AnalyzeParams = {
        file_path: filePath,
        extract_dimensions: extractDimensions,
        output_format: outputFormat,
        units,
        output_path: outputPath,
      };

      const result = analyzeFloorplan(analyzeParams);

      // ── Format response ─────────────────────────────────────────────────
      const contentParts: Array<{ type: string; text: string }> = [];

      // For image analysis, provide the prompt and template as text, and
      // the base64 image separately for the AI to process
      if (result.analysis_type === "image") {
        contentParts.push({
          type: "text",
          text: [
            `=== Floor Plan Image Analysis ===`,
            `File: ${result.file_path}`,
            `Size: ${result.file_size_mb} MB`,
            `Format: ${result.mime_type}`,
            ``,
            `The image has been encoded and is ready for AI vision analysis.`,
            `Use the image data below along with the analysis prompt to extract`,
            `the floor plan structure.`,
            ...(Array.isArray(result.warnings) && result.warnings.length > 0
              ? ["", "Warnings:", ...(result.warnings as string[]).map((w: string) => `  - ${w}`)]
              : []),
          ].join("\n"),
        });

        // Include the full result (with base64) as JSON
        contentParts.push({
          type: "text",
          text: JSON.stringify(result, null, 2),
        });
      } else if (result.analysis_type === "dxf") {
        contentParts.push({
          type: "text",
          text: [
            `=== DXF Floor Plan Analysis ===`,
            `File: ${result.file_path}`,
            ``,
            result.recommendation as string,
            ``,
            `Suggested workflow:`,
            ...(result.suggested_workflow as string[]).map((s: string) => `  ${s}`),
          ].join("\n"),
        });

        contentParts.push({
          type: "text",
          text: JSON.stringify(result, null, 2),
        });
      } else {
        // SVG analysis - provide human-readable summary + full JSON
        const rooms = (result.rooms ?? []) as Array<Record<string, unknown>>;
        const roomCount = result.room_count as number;
        const wallCount = result.wall_count ?? 0;
        const doorCount = result.door_count ?? 0;
        const totalArea = result.total_area_sqm ?? 0;

        const lines: string[] = [
          `=== SVG Floor Plan Analysis ===`,
          `File: ${result.file_path}`,
          `Detected scale: ${result.detected_scale_px_per_m} px/m`,
          ``,
          `Rooms found: ${roomCount}`,
          `Total area: ${totalArea} sqm`,
          `Walls: ${wallCount}`,
          `Doors: ${doorCount}`,
          ``,
        ];

        if (rooms.length > 0) {
          lines.push("Rooms:");
          for (const room of rooms) {
            const name = room.name ?? room.name;
            const type = room.type;
            const area = room.area_sqm ?? room.area;
            const w = room.width_m ?? room.width;
            const h = room.height_m ?? room.height;
            lines.push(`  - ${name} (${type}): ${w}m x ${h}m = ${area} sqm`);
          }
        }

        const dimsFound = (result.dimensions_found ?? []) as DimensionAnnotation[];
        if (dimsFound.length > 0) {
          lines.push("");
          lines.push("Dimension annotations:");
          for (const dim of dimsFound) {
            lines.push(
              `  - ${dim.value} ${dim.unit} near "${dim.near_element}"`,
            );
          }
        }

        if (result.output_file) {
          lines.push("");
          lines.push(`Analysis saved to: ${result.output_file}`);
        }

        contentParts.push({ type: "text", text: lines.join("\n") });
        contentParts.push({
          type: "text",
          text: JSON.stringify(result, null, 2),
        });
      }

      return {
        content: contentParts,
        details: {
          analysis_type: result.analysis_type,
          file_path: result.file_path,
          room_count: result.room_count ?? 0,
          output_format: outputFormat,
          output_file: result.output_file ?? null,
        },
      };
    },
  };
}
