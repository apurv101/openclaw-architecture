/**
 * DXF Generate tool for civilclaw.
 *
 * Creates new DXF (Drawing Exchange Format) files from a specification object
 * using ezdxf (via Python).  Supports lines, polylines, circles, arcs, text,
 * mtext, dimensions, and hatches with configurable layers, units, and templates.
 *
 * Delegates to scripts/dxf_generate.py for the actual ezdxf work.
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
    timeout: 120_000,
  });
  return result;
}

// ---- Tool definition ----

export function createDxfGenerateToolDefinition() {
  return {
    name: "dxf_generate",
    label: "DXF Generate",
    description:
      "Generate a new DXF (Drawing Exchange Format) file from a specification describing layers and entities. " +
      "Supports LINE, LWPOLYLINE, CIRCLE, ARC, TEXT, MTEXT, DIMENSION, and HATCH entities. " +
      "Provides template options for standard paper sizes with title blocks. " +
      "Requires Python 3 with the ezdxf package.",
    parameters: {
      type: "object",
      properties: {
        specification: {
          type: "object",
          description:
            "Specification object containing layers and entities to create in the DXF.",
          properties: {
            layers: {
              type: "array",
              description: "Layer definitions for the drawing.",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Layer name." },
                  color: {
                    type: "number",
                    description: "ACI color index (1-255). Default: 7 (white/black).",
                  },
                  linetype: {
                    type: "string",
                    description: "Linetype name (e.g. 'CONTINUOUS', 'DASHED', 'CENTER'). Default: 'CONTINUOUS'.",
                  },
                  lineweight: {
                    type: "number",
                    description: "Line weight in hundredths of mm (e.g. 25 = 0.25mm). Default: -1 (default).",
                  },
                },
                required: ["name"],
              },
            },
            entities: {
              type: "array",
              description: "Entity definitions to add to modelspace.",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["LINE", "LWPOLYLINE", "CIRCLE", "ARC", "TEXT", "MTEXT", "DIMENSION", "HATCH"],
                    description: "The DXF entity type to create.",
                  },
                  layer: { type: "string", description: "Target layer name." },
                  color: { type: "number", description: "Override ACI color index." },
                  // LINE
                  start: {
                    type: "array", items: { type: "number" },
                    description: "Start point [x, y] or [x, y, z] for LINE.",
                  },
                  end: {
                    type: "array", items: { type: "number" },
                    description: "End point [x, y] or [x, y, z] for LINE.",
                  },
                  // LWPOLYLINE
                  vertices: {
                    type: "array",
                    items: { type: "array", items: { type: "number" } },
                    description: "Array of [x, y] points for LWPOLYLINE or HATCH boundary.",
                  },
                  closed: { type: "boolean", description: "Whether polyline is closed. Default: false." },
                  // CIRCLE / ARC
                  center: {
                    type: "array", items: { type: "number" },
                    description: "Center point [x, y] or [x, y, z] for CIRCLE or ARC.",
                  },
                  radius: { type: "number", description: "Radius for CIRCLE or ARC." },
                  start_angle: { type: "number", description: "Start angle in degrees for ARC." },
                  end_angle: { type: "number", description: "End angle in degrees for ARC." },
                  // TEXT / MTEXT
                  position: {
                    type: "array", items: { type: "number" },
                    description: "Insert position [x, y] or [x, y, z] for TEXT or MTEXT.",
                  },
                  text: { type: "string", description: "Text content for TEXT or MTEXT." },
                  height: { type: "number", description: "Text height for TEXT." },
                  rotation: { type: "number", description: "Rotation angle in degrees for TEXT." },
                  width: { type: "number", description: "Column width for MTEXT." },
                  // DIMENSION
                  base: {
                    type: "array", items: { type: "number" },
                    description: "Base/definition point [x, y] for DIMENSION.",
                  },
                  p1: {
                    type: "array", items: { type: "number" },
                    description: "First extension line origin [x, y] for DIMENSION.",
                  },
                  p2: {
                    type: "array", items: { type: "number" },
                    description: "Second extension line origin [x, y] for DIMENSION.",
                  },
                  // HATCH
                  pattern: {
                    type: "string",
                    description: "Hatch pattern name (e.g. 'ANSI31', 'SOLID'). Default: 'ANSI31'.",
                  },
                  scale: { type: "number", description: "Hatch pattern scale. Default: 1.0." },
                },
                required: ["type"],
              },
            },
          },
          required: ["entities"],
        },
        output_path: {
          type: "string",
          description: "File path where the DXF will be saved.",
        },
        units: {
          type: "string",
          enum: ["mm", "cm", "m", "ft", "in"],
          description: "Drawing units. Default: 'mm'.",
        },
        template: {
          type: "string",
          enum: ["blank", "a1_landscape", "a3_landscape", "arch_d"],
          description:
            "Drawing template. 'blank' = empty drawing. " +
            "'a1_landscape' = A1 (841x594mm) with title block. " +
            "'a3_landscape' = A3 (420x297mm) with title block. " +
            "'arch_d' = Arch D (914x610mm) with title block. Default: 'blank'.",
        },
      },
      required: ["specification", "output_path"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }> => {
      // 1. Check Python + ezdxf availability
      if (!checkPythonDep("ezdxf")) {
        return {
          content: [
            {
              type: "text",
              text:
                "This tool requires Python 3 with ezdxf installed.\n" +
                "Install with: pip install ezdxf\n\n" +
                "ezdxf is a Python library for creating and modifying DXF drawings.",
            },
          ],
        };
      }

      // 2. Validate args
      const params = (args ?? {}) as Record<string, unknown>;
      const specification = params.specification as Record<string, unknown> | undefined;
      if (!specification || typeof specification !== "object") {
        return {
          content: [{ type: "text", text: "Error: specification is required and must be an object with an entities array." }],
        };
      }

      const outputPath = String(params.output_path ?? "").trim();
      if (!outputPath) {
        return {
          content: [{ type: "text", text: "Error: output_path is required." }],
        };
      }

      const units = String(params.units ?? "mm");
      if (!["mm", "cm", "m", "ft", "in"].includes(units)) {
        return {
          content: [{ type: "text", text: "Error: units must be one of: mm, cm, m, ft, in." }],
        };
      }

      const template = String(params.template ?? "blank");
      if (!["blank", "a1_landscape", "a3_landscape", "arch_d"].includes(template)) {
        return {
          content: [{ type: "text", text: "Error: template must be one of: blank, a1_landscape, a3_landscape, arch_d." }],
        };
      }

      // 3. Run Python script
      try {
        const raw = runPythonScript("dxf_generate.py", {
          specification,
          output_path: outputPath,
          units,
          template,
        });

        const result = JSON.parse(raw.trim());

        if (result.error) {
          return {
            content: [{ type: "text", text: `DXF Generate error: ${result.error}` }],
          };
        }

        // Build summary
        const lines: string[] = [];
        lines.push(`DXF Generated: ${result.output_path}`);
        lines.push(`Units: ${units}`);
        lines.push(`Template: ${template}`);
        if (result.layers_created !== undefined) {
          lines.push(`Layers Created: ${result.layers_created}`);
        }
        if (result.entities_created !== undefined) {
          lines.push(`Entities Created: ${result.entities_created}`);
        }
        if (result.entity_summary) {
          lines.push("");
          lines.push("Entity Summary:");
          for (const [type, count] of Object.entries(result.entity_summary)) {
            lines.push(`  ${type}: ${count}`);
          }
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
          content: [{ type: "text", text: `DXF Generate failed: ${msg}` }],
        };
      }
    },
  };
}
