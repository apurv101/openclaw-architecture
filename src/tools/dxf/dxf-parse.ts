/**
 * DXF Parse tool for civilclaw.
 *
 * Parses DXF (Drawing Exchange Format) files using ezdxf (via Python) to
 * extract layers, entity data, block references, and geometric properties.
 *
 * Delegates to scripts/dxf_parse.py for the actual ezdxf work.
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

export function createDxfParseToolDefinition() {
  return {
    name: "dxf_parse",
    label: "DXF Parse",
    description:
      "Parse a DXF (Drawing Exchange Format) file and extract layers, entity data, block definitions, " +
      "and geometric properties. Supports filtering by layer name and entity type. " +
      "Returns structured JSON with layer list, entity counts, and detailed entity properties " +
      "(coordinates, vertices, colors, etc.). Requires Python 3 with the ezdxf package.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute or relative path to the DXF file to parse.",
        },
        layers: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of layer names to include. If omitted, all layers are included.",
        },
        entity_types: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of DXF entity types to include (e.g. ['LINE', 'LWPOLYLINE', 'INSERT', 'CIRCLE', 'ARC', 'TEXT', 'MTEXT', 'DIMENSION', 'HATCH']). " +
            "If omitted, all entity types are included.",
        },
        include_blocks: {
          type: "boolean",
          description:
            "Whether to include block definition details in the output. Default: true.",
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
      const filePath = String(params.file_path ?? "");
      if (!filePath) {
        return {
          content: [{ type: "text", text: "Error: file_path is required." }],
        };
      }

      const layers = Array.isArray(params.layers)
        ? (params.layers as string[])
        : undefined;
      const entityTypes = Array.isArray(params.entity_types)
        ? (params.entity_types as string[])
        : undefined;
      const includeBlocks = params.include_blocks !== false;

      // 3. Run Python script
      try {
        const raw = runPythonScript("dxf_parse.py", {
          file_path: filePath,
          layers: layers ?? null,
          entity_types: entityTypes ?? null,
          include_blocks: includeBlocks,
        });

        const result = JSON.parse(raw.trim());

        if (result.error) {
          return {
            content: [{ type: "text", text: `DXF Parse error: ${result.error}` }],
          };
        }

        // Build human-readable summary
        const lines: string[] = [];
        lines.push(`DXF File: ${filePath}`);

        if (result.dxf_version) {
          lines.push(`DXF Version: ${result.dxf_version}`);
        }
        if (result.encoding) {
          lines.push(`Encoding: ${result.encoding}`);
        }
        if (result.units) {
          lines.push(`Units: ${result.units}`);
        }

        if (result.layers && Array.isArray(result.layers)) {
          lines.push("");
          lines.push(`Layers (${result.layers.length}):`);
          for (const layer of result.layers) {
            lines.push(`  ${layer.name} - color: ${layer.color}, linetype: ${layer.linetype}`);
          }
        }

        if (result.entity_counts) {
          lines.push("");
          lines.push("Entity Counts:");
          for (const [type, count] of Object.entries(result.entity_counts)) {
            lines.push(`  ${type}: ${count}`);
          }
        }

        if (result.total_entities !== undefined) {
          lines.push(`Total Entities: ${result.total_entities}`);
        }

        if (result.blocks && Array.isArray(result.blocks) && result.blocks.length > 0) {
          lines.push("");
          lines.push(`Block Definitions (${result.blocks.length}):`);
          for (const block of result.blocks) {
            lines.push(`  ${block.name} - ${block.entity_count} entities`);
          }
        }

        if (result.extents) {
          lines.push("");
          lines.push(`Extents: min=(${result.extents.min_x}, ${result.extents.min_y}) max=(${result.extents.max_x}, ${result.extents.max_y})`);
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
          content: [{ type: "text", text: `DXF Parse failed: ${msg}` }],
        };
      }
    },
  };
}
