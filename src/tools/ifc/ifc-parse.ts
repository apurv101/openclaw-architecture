/**
 * IFC Parse tool for openclaw-mini.
 *
 * Parses IFC/BIM files using ifcopenshell (via Python) to extract spatial
 * hierarchy, element data, property sets, and optional geometry information.
 *
 * Delegates to scripts/ifc_parse.py for the actual ifcopenshell work.
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---- Python bridge helpers (self-contained per tool to avoid import issues) ----

function checkPythonDep(packageName: string): boolean {
  try {
    execSync(`python3 -c "import ${packageName}"`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function resolveScriptsDir(): string {
  // Works for both ESM (__dirname equivalent) and CJS
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
    maxBuffer: 50 * 1024 * 1024, // 50 MB
    timeout: 120_000, // 2 minutes
  });
  return result;
}

// ---- Tool definition ----

export function createIfcParseToolDefinition() {
  return {
    name: "ifc_parse",
    label: "IFC Parse",
    description:
      "Parse an IFC (Industry Foundation Classes) BIM file and extract its spatial hierarchy, " +
      "element data, property sets, and optional bounding-box geometry. " +
      "Supports summary, full, and elements_only detail levels. " +
      "Requires Python 3 with the ifcopenshell package.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute or relative path to the IFC file to parse.",
        },
        detail_level: {
          type: "string",
          enum: ["summary", "full", "elements_only"],
          description:
            "Level of detail for the output. " +
            "'summary' = counts by type, building info, story names. " +
            "'full' = all elements with property sets. " +
            "'elements_only' = element list with basic properties only. " +
            "Default: 'summary'.",
        },
        element_types: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of IFC entity types to include (e.g. ['IfcWall', 'IfcDoor']). " +
            "If omitted, all element types are included.",
        },
        include_geometry: {
          type: "boolean",
          description:
            "Whether to extract bounding box geometry from element placements. Default: false.",
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
      // 1. Check Python + ifcopenshell availability
      if (!checkPythonDep("ifcopenshell")) {
        return {
          content: [
            {
              type: "text",
              text:
                "This tool requires Python 3 with ifcopenshell installed.\n" +
                "Install with: pip install ifcopenshell\n\n" +
                "If you are using conda: conda install -c ifcopenshell ifcopenshell",
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

      const detailLevel = String(params.detail_level ?? "summary");
      if (!["summary", "full", "elements_only"].includes(detailLevel)) {
        return {
          content: [
            {
              type: "text",
              text: "Error: detail_level must be one of: summary, full, elements_only.",
            },
          ],
        };
      }

      const elementTypes = Array.isArray(params.element_types)
        ? (params.element_types as string[])
        : undefined;
      const includeGeometry = Boolean(params.include_geometry ?? false);

      // 3. Run Python script
      try {
        const raw = runPythonScript("ifc_parse.py", {
          file_path: filePath,
          detail_level: detailLevel,
          element_types: elementTypes ?? null,
          include_geometry: includeGeometry,
        });

        const result = JSON.parse(raw.trim());

        if (result.error) {
          return {
            content: [{ type: "text", text: `IFC Parse error: ${result.error}` }],
          };
        }

        // Build a human-readable summary
        const lines: string[] = [];
        lines.push(`IFC File: ${filePath}`);
        lines.push(`Detail Level: ${detailLevel}`);

        if (result.schema) {
          lines.push(`Schema: ${result.schema}`);
        }
        if (result.project_name) {
          lines.push(`Project: ${result.project_name}`);
        }
        if (result.site_name) {
          lines.push(`Site: ${result.site_name}`);
        }
        if (result.building_name) {
          lines.push(`Building: ${result.building_name}`);
        }
        if (result.stories && Array.isArray(result.stories)) {
          lines.push(`Stories: ${result.stories.join(", ")}`);
        }
        if (result.element_counts) {
          lines.push("");
          lines.push("Element Counts:");
          for (const [type, count] of Object.entries(result.element_counts)) {
            lines.push(`  ${type}: ${count}`);
          }
        }
        if (result.total_elements !== undefined) {
          lines.push(`Total Elements: ${result.total_elements}`);
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
          content: [{ type: "text", text: `IFC Parse failed: ${msg}` }],
        };
      }
    },
  };
}
