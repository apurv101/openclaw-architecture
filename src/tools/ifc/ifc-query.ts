/**
 * IFC Query tool for openclaw-mini.
 *
 * Queries elements within an IFC/BIM file by type, material, property value,
 * spatial containment (space), or classification reference.
 *
 * Delegates to scripts/ifc_query.py for the actual ifcopenshell work.
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

export function createIfcQueryToolDefinition() {
  return {
    name: "ifc_query",
    label: "IFC Query",
    description:
      "Query and filter elements in an IFC (Industry Foundation Classes) BIM file. " +
      "Supports filtering by IFC entity type, material, property value, " +
      "spatial containment (IfcSpace), or classification system reference. " +
      "Returns matching elements with their GlobalId, Name, type, and relevant properties. " +
      "Requires Python 3 with the ifcopenshell package.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute or relative path to the IFC file to query.",
        },
        query_type: {
          type: "string",
          enum: [
            "by_type",
            "by_material",
            "by_property",
            "by_space",
            "by_classification",
          ],
          description:
            "Type of query to perform. " +
            "'by_type' = filter by IFC entity type (e.g. IfcWall, IfcDoor). " +
            "'by_material' = filter by material name. " +
            "'by_property' = filter by property set value. " +
            "'by_space' = filter by spatial containment (IfcSpace name). " +
            "'by_classification' = filter by classification reference.",
        },
        value: {
          type: "string",
          description:
            "The value to search for, depending on query_type: " +
            "by_type: IFC entity name (e.g. 'IfcWall'). " +
            "by_material: material name substring. " +
            "by_property: 'PropertySetName.PropertyName=Value' or 'PropertyName=Value'. " +
            "by_space: space name substring. " +
            "by_classification: classification reference substring.",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return. Default: 50.",
        },
      },
      required: ["file_path", "query_type", "value"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }> => {
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

      const params = (args ?? {}) as Record<string, unknown>;
      const filePath = String(params.file_path ?? "");
      if (!filePath) {
        return {
          content: [{ type: "text", text: "Error: file_path is required." }],
        };
      }

      const queryType = String(params.query_type ?? "");
      const validQueryTypes = [
        "by_type",
        "by_material",
        "by_property",
        "by_space",
        "by_classification",
      ];
      if (!validQueryTypes.includes(queryType)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: query_type must be one of: ${validQueryTypes.join(", ")}.`,
            },
          ],
        };
      }

      const value = String(params.value ?? "");
      if (!value) {
        return {
          content: [{ type: "text", text: "Error: value is required." }],
        };
      }

      const maxResults =
        typeof params.max_results === "number" && Number.isFinite(params.max_results)
          ? Math.max(1, Math.round(params.max_results))
          : 50;

      try {
        const raw = runPythonScript("ifc_query.py", {
          file_path: filePath,
          query_type: queryType,
          value,
          max_results: maxResults,
        });

        const result = JSON.parse(raw.trim());

        if (result.error) {
          return {
            content: [{ type: "text", text: `IFC Query error: ${result.error}` }],
          };
        }

        const matchCount = result.match_count ?? (result.elements?.length ?? 0);
        const totalScanned = result.total_scanned ?? "?";

        const lines: string[] = [];
        lines.push(`IFC Query: ${queryType} = "${value}"`);
        lines.push(`File: ${filePath}`);
        lines.push(`Matches: ${matchCount} (scanned ${totalScanned} elements)`);
        if (result.truncated) {
          lines.push(`(Results truncated to ${maxResults})`);
        }
        lines.push("");

        if (result.elements && Array.isArray(result.elements)) {
          for (const el of result.elements.slice(0, 20)) {
            lines.push(
              `  [${el.ifc_type}] ${el.name ?? "(unnamed)"} (${el.global_id})`,
            );
          }
          if (result.elements.length > 20) {
            lines.push(`  ... and ${result.elements.length - 20} more`);
          }
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
          content: [{ type: "text", text: `IFC Query failed: ${msg}` }],
        };
      }
    },
  };
}
