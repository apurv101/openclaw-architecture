/**
 * Model Section tool for civilclaw.
 *
 * Generates 2D section cuts (horizontal or vertical) through 3D IFC or OBJ
 * models, producing SVG or DXF output of the resulting contour lines.
 *
 * Delegates to scripts/model_section.py which uses ifcopenshell and/or
 * trimesh for geometry intersection.
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---- Python bridge helpers ----

function checkPythonDep(packageName: string): boolean {
  try {
    execSync(`python3 -c "import ${packageName}"`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function resolveScriptsDir(): string {
  try {
    const currentFile = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(currentFile), "../../../scripts");
  } catch {
    return path.resolve(__dirname, "../../scripts");
  }
}

function runPythonScript(scriptName: string, args: unknown): string {
  const scriptPath = path.join(resolveScriptsDir(), scriptName);
  const input = JSON.stringify(args);
  const result = execSync(`python3 "${scriptPath}"`, {
    input,
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: 300_000,
  });
  return result;
}

// ---- Tool definition ----

export function createModelSectionToolDefinition() {
  return {
    name: "model_section",
    label: "Model Section",
    description:
      "Generate a 2D section cut through a 3D model (IFC or OBJ). " +
      "Supports horizontal sections (plan cuts at a given height) and vertical sections " +
      "(elevation cuts at a given position and direction). Outputs SVG or DXF with the " +
      "resulting contour lines. For IFC files uses ifcopenshell; for OBJ files uses trimesh. " +
      "Requires Python 3 with trimesh (and ifcopenshell for IFC files).",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the input 3D model file (IFC or OBJ).",
        },
        cut_plane: {
          type: "object",
          description: "Definition of the section cut plane.",
          properties: {
            type: {
              type: "string",
              enum: ["horizontal", "vertical"],
              description:
                "'horizontal' = plan cut at a given Z height. " +
                "'vertical' = elevation/section cut at a given position.",
            },
            height_m: {
              type: "number",
              description:
                "Cut height in meters for horizontal sections (default: 1.2m for typical plan cut).",
            },
            position_m: {
              type: "number",
              description:
                "Position along the cut direction in meters for vertical sections.",
            },
            direction_deg: {
              type: "number",
              description:
                "Direction angle in degrees for vertical sections (0 = along X axis, 90 = along Y axis). Default: 0.",
            },
          },
          required: ["type"],
        },
        output_path: {
          type: "string",
          description: "File path where the section output will be saved.",
        },
        output_format: {
          type: "string",
          enum: ["dxf", "svg"],
          description: "Output format for the section. Default: 'svg'.",
        },
        include_below: {
          type: "boolean",
          description:
            "For horizontal sections, whether to include projection of elements below the cut plane. Default: true.",
        },
      },
      required: ["file_path", "cut_plane", "output_path"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }> => {
      const params = (args ?? {}) as Record<string, unknown>;
      const filePath = String(params.file_path ?? "").trim();
      if (!filePath) {
        return { content: [{ type: "text", text: "Error: file_path is required." }] };
      }

      const cutPlane = params.cut_plane as Record<string, unknown> | undefined;
      if (!cutPlane || typeof cutPlane !== "object") {
        return { content: [{ type: "text", text: "Error: cut_plane is required." }] };
      }

      const outputPath = String(params.output_path ?? "").trim();
      if (!outputPath) {
        return { content: [{ type: "text", text: "Error: output_path is required." }] };
      }

      const outputFormat = String(params.output_format ?? "svg").toLowerCase();
      if (!["dxf", "svg"].includes(outputFormat)) {
        return { content: [{ type: "text", text: "Error: output_format must be 'dxf' or 'svg'." }] };
      }

      const includeBelow = params.include_below !== false;

      // Detect input format
      const ext = path.extname(filePath).toLowerCase();
      const isIfc = ext === ".ifc";
      const isObj = ext === ".obj";

      if (!isIfc && !isObj) {
        return {
          content: [{ type: "text", text: "Error: file_path must be an IFC or OBJ file." }],
        };
      }

      // Check dependencies
      const missingDeps: string[] = [];
      if (!checkPythonDep("trimesh")) {
        missingDeps.push("trimesh");
      }
      if (!checkPythonDep("numpy")) {
        missingDeps.push("numpy");
      }
      if (isIfc && !checkPythonDep("ifcopenshell")) {
        missingDeps.push("ifcopenshell");
      }
      if (outputFormat === "dxf" && !checkPythonDep("ezdxf")) {
        missingDeps.push("ezdxf");
      }

      if (missingDeps.length > 0) {
        const installCmds = missingDeps.map((d) => `pip install ${d}`).join("\n");
        return {
          content: [
            {
              type: "text",
              text:
                `This tool requires the following Python packages:\n` +
                missingDeps.join(", ") +
                "\n\nInstall with:\n" +
                installCmds,
            },
          ],
        };
      }

      // Run section script
      try {
        const raw = runPythonScript("model_section.py", {
          file_path: filePath,
          cut_plane: cutPlane,
          output_path: outputPath,
          output_format: outputFormat,
          include_below: includeBelow,
        });

        const result = JSON.parse(raw.trim());

        if (result.error) {
          return {
            content: [{ type: "text", text: `Model Section error: ${result.error}` }],
          };
        }

        // Build summary
        const lines: string[] = [];
        lines.push(`Model Section Complete`);
        lines.push(`Input: ${filePath}`);
        lines.push(`Output: ${result.output_path || outputPath}`);
        lines.push(`Format: ${outputFormat.toUpperCase()}`);
        lines.push(`Cut Type: ${cutPlane.type}`);
        if (cutPlane.type === "horizontal") {
          lines.push(`Cut Height: ${cutPlane.height_m ?? 1.2}m`);
        } else {
          lines.push(`Position: ${cutPlane.position_m ?? 0}m, Direction: ${cutPlane.direction_deg ?? 0} deg`);
        }
        if (result.contour_segments !== undefined) {
          lines.push(`Contour Segments: ${result.contour_segments}`);
        }
        if (result.bounding_box) {
          const bb = result.bounding_box;
          lines.push(`Section Bounds: (${bb.min_x?.toFixed(2)}, ${bb.min_y?.toFixed(2)}) to (${bb.max_x?.toFixed(2)}, ${bb.max_y?.toFixed(2)})`);
        }
        if (result.file_size_bytes !== undefined) {
          const sizeKb = (result.file_size_bytes / 1024).toFixed(1);
          lines.push(`File Size: ${sizeKb} KB`);
        }

        return {
          content: [
            { type: "text", text: lines.join("\n") },
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
          details: result,
        };
      } catch (err: any) {
        const msg = err.stderr
          ? String(err.stderr).trim()
          : err.message ?? "Unknown error";
        return {
          content: [{ type: "text", text: `Model Section failed: ${msg}` }],
        };
      }
    },
  };
}
