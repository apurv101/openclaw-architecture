/**
 * File content processor for the chat pipeline.
 *
 * Takes uploaded file metadata, reads their content from the FileStore,
 * and produces:
 *   - contextText: XML <file> blocks to prepend to the user's prompt
 *   - images: native ImageContent[] for vision models
 *   - warnings: any issues (oversized, unsupported, etc.)
 *
 * Matches openclaw's approach: inject content, let the LLM decide what to do.
 */
import path from "node:path";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { FileMetadata } from "./file-store.js";
import type { FileStore } from "./file-store.js";

// ─── Size limits ─────────────────────────────────────────────────────────────

const MAX_TEXT_CHARS = 100_000;
const MAX_PDF_TEXT_CHARS = 200_000;
const MAX_IMAGE_BYTES = 10_000_000; // 10 MB

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FileProcessingResult {
  /** Text to prepend to the user's message (file contents in <file> XML tags) */
  contextText: string;
  /** Image content blocks for PromptOptions.images */
  images: ImageContent[];
  /** Warnings for skipped/oversized files */
  warnings: string[];
}

type FileCategory = "image" | "text" | "pdf" | "other";

// ─── Classification ──────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif"]);
const TEXT_EXTS = new Set([
  ".txt", ".csv", ".json", ".xml", ".html", ".svg", ".md",
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".log",
]);

function classifyFile(file: FileMetadata): FileCategory {
  const ext = path.extname(file.filename).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if (TEXT_EXTS.has(ext)) return "text";
  // Fall back to MIME type checks
  if (file.mimeType.startsWith("image/")) return "image";
  if (file.mimeType.startsWith("text/") || file.mimeType === "application/json") return "text";
  return "other";
}

// ─── XML helpers ─────────────────────────────────────────────────────────────

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlContent(s: string): string {
  // Wrap in CDATA if it contains XML-like content, otherwise light escape
  if (s.includes("]]>")) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  }
  if (s.includes("<") || s.includes("&")) {
    return `<![CDATA[${s}]]>`;
  }
  return s;
}

// ─── Main processor ──────────────────────────────────────────────────────────

export async function processAttachedFiles(
  files: FileMetadata[],
  sessionId: string,
  fileStore: FileStore,
): Promise<FileProcessingResult> {
  const result: FileProcessingResult = { contextText: "", images: [], warnings: [] };
  if (files.length === 0) return result;

  const blocks: string[] = [];

  for (const file of files) {
    const category = classifyFile(file);

    switch (category) {
      case "image": {
        if (file.size > MAX_IMAGE_BYTES) {
          result.warnings.push(`${file.originalName}: too large for vision (${(file.size / 1e6).toFixed(1)} MB, max 10 MB)`);
          break;
        }
        try {
          const data = fileStore.readFile(sessionId, file.filename);
          result.images.push({
            type: "image",
            data: data.toString("base64"),
            mimeType: file.mimeType,
          });
          blocks.push(`<file name="${escapeXmlAttr(file.originalName)}" mime="${escapeXmlAttr(file.mimeType)}">[Image attached]</file>`);
        } catch {
          result.warnings.push(`${file.originalName}: could not read file`);
        }
        break;
      }

      case "text": {
        try {
          const data = fileStore.readFile(sessionId, file.filename);
          let text = data.toString("utf-8");
          if (text.length > MAX_TEXT_CHARS) {
            text = text.slice(0, MAX_TEXT_CHARS) + `\n\n[Truncated at ${MAX_TEXT_CHARS.toLocaleString()} characters]`;
            result.warnings.push(`${file.originalName}: truncated to ${MAX_TEXT_CHARS.toLocaleString()} chars`);
          }
          blocks.push(
            `<file name="${escapeXmlAttr(file.originalName)}" mime="${escapeXmlAttr(file.mimeType)}">\n${escapeXmlContent(text)}\n</file>`,
          );
        } catch {
          result.warnings.push(`${file.originalName}: could not read file`);
        }
        break;
      }

      case "pdf": {
        const extractedText = (file as any).extractedText as string | undefined;
        if (extractedText) {
          let text = extractedText;
          if (text.length > MAX_PDF_TEXT_CHARS) {
            text = text.slice(0, MAX_PDF_TEXT_CHARS) + `\n\n[Truncated at ${MAX_PDF_TEXT_CHARS.toLocaleString()} characters]`;
            result.warnings.push(`${file.originalName}: PDF text truncated`);
          }
          const pages = (file as any).extractedPages ?? "unknown";
          blocks.push(
            `<file name="${escapeXmlAttr(file.originalName)}" mime="application/pdf" pages="${pages}">\n${escapeXmlContent(text)}\n</file>`,
          );
        } else {
          // No extracted text — fall back to metadata-only reference
          const filePath = path.join(fileStore.workspaceDir(sessionId), file.filename);
          blocks.push(
            `<file name="${escapeXmlAttr(file.originalName)}" mime="application/pdf" size="${file.size}" path="${escapeXmlAttr(filePath)}"/>`,
          );
          result.warnings.push(`${file.originalName}: PDF text extraction not available, file path provided`);
        }
        break;
      }

      case "other": {
        // Domain/binary files: just metadata so the LLM knows it exists
        const filePath = path.join(fileStore.workspaceDir(sessionId), file.filename);
        blocks.push(
          `<file name="${escapeXmlAttr(file.originalName)}" mime="${escapeXmlAttr(file.mimeType)}" size="${file.size}" path="${escapeXmlAttr(filePath)}"/>`,
        );
        break;
      }
    }
  }

  if (blocks.length > 0) {
    result.contextText = blocks.join("\n\n");
  }

  return result;
}
