/**
 * IFC Validate tool for openclaw-mini.
 *
 * Validates an IFC/BIM file at different check levels: syntax (file structure),
 * schema (IFC schema conformance), and rules (custom validation rules).
 *
 * Delegates to scripts/ifc_validate.py for the actual ifcopenshell work.
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

export function createIfcValidateToolDefinition() {
  return {
    name: "ifc_validate",
    label: "IFC Validate",
    description:
      "Validate an IFC (Industry Foundation Classes) BIM file for correctness. " +
      "Supports three check levels: " +
      "'syntax' = verify the file can be parsed as valid STEP/IFC. " +
      "'schema' = verify all entities conform to the IFC schema (type checking, required attributes). " +
      "'rules' = apply custom validation rules (naming conventions, required properties, spatial structure). " +
      "Returns a list of issues with severity, location, and description. " +
      "Requires Python 3 with the ifcopenshell package.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the IFC file to validate.",
        },
        check_level: {
          type: "string",
          enum: ["syntax", "schema", "rules"],
          description:
            "Depth of validation to perform. " +
            "'syntax' = basic file parsing check. " +
            "'schema' = IFC schema conformance (includes syntax). " +
            "'rules' = custom rule checking (includes syntax + schema). " +
            "Default: 'schema'.",
        },
        rules: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of specific rule identifiers to apply when check_level is 'rules'. " +
            "Available rules: " +
            "'naming' = check element naming conventions (non-empty, no default names). " +
            "'properties' = check that required property sets exist on elements. " +
            "'spatial' = verify spatial hierarchy is complete (Project > Site > Building > Storey). " +
            "'materials' = check that load-bearing elements have materials assigned. " +
            "'geometry' = check elements have geometric representations. " +
            "'duplicates' = check for duplicate GlobalIds. " +
            "If omitted when check_level='rules', all rules are applied.",
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

      const checkLevel = String(params.check_level ?? "schema");
      if (!["syntax", "schema", "rules"].includes(checkLevel)) {
        return {
          content: [
            {
              type: "text",
              text: "Error: check_level must be one of: syntax, schema, rules.",
            },
          ],
        };
      }

      const rules = Array.isArray(params.rules)
        ? (params.rules as string[])
        : null;

      try {
        const raw = runPythonScript("ifc_validate.py", {
          file_path: filePath,
          check_level: checkLevel,
          rules,
        });

        const result = JSON.parse(raw.trim());

        if (result.error) {
          return {
            content: [
              { type: "text", text: `IFC Validate error: ${result.error}` },
            ],
          };
        }

        const lines: string[] = [];
        lines.push(`IFC Validation: ${filePath}`);
        lines.push(`Check Level: ${checkLevel}`);
        lines.push(`Valid: ${result.valid ? "YES" : "NO"}`);
        if (result.schema) {
          lines.push(`Schema: ${result.schema}`);
        }

        const issues = result.issues ?? [];
        const errorCount = issues.filter(
          (i: any) => i.severity === "error",
        ).length;
        const warningCount = issues.filter(
          (i: any) => i.severity === "warning",
        ).length;
        const infoCount = issues.filter(
          (i: any) => i.severity === "info",
        ).length;

        lines.push(
          `Issues: ${issues.length} (${errorCount} errors, ${warningCount} warnings, ${infoCount} info)`,
        );

        if (issues.length > 0) {
          lines.push("");
          const shownIssues = issues.slice(0, 50);
          for (const issue of shownIssues) {
            const severity = (issue.severity ?? "info").toUpperCase();
            const location = issue.location ? ` [${issue.location}]` : "";
            const rule = issue.rule ? ` (${issue.rule})` : "";
            lines.push(`  [${severity}]${location}${rule} ${issue.message}`);
          }
          if (issues.length > 50) {
            lines.push(`  ... and ${issues.length - 50} more issues`);
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
          content: [{ type: "text", text: `IFC Validate failed: ${msg}` }],
        };
      }
    },
  };
}
