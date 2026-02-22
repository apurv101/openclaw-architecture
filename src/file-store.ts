/**
 * File storage service for CivilClaw.
 *
 * Manages per-session file workspaces on local disk. Each session gets its own
 * directory where uploaded and tool-generated files live. The server serves
 * these files over HTTP so the browser can download them via links.
 *
 * S3 sync can be layered on top later without changing this interface.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FileMetadata {
  filename: string;
  originalName: string;
  size: number;
  mimeType: string;
  createdAt: string;
  source: "upload" | "generated";
  /** Pre-extracted text content (for PDFs) */
  extractedText?: string;
  /** Number of pages (for PDFs) */
  extractedPages?: number;
}

interface FileManifest {
  sessionId: string;
  files: Record<string, FileMetadata>;
  createdAt: string;
  updatedAt: string;
}

interface FileStoreConfig {
  localBaseDir: string;
}

// ─── FileStore ──────────────────────────────────────────────────────────────

export class FileStore {
  private config: FileStoreConfig;

  constructor(config: FileStoreConfig) {
    this.config = config;
  }

  /** Returns the local workspace directory for a session */
  workspaceDir(sessionId: string): string {
    return path.join(this.config.localBaseDir, sessionId);
  }

  private manifestPath(sessionId: string): string {
    return path.join(this.workspaceDir(sessionId), "_manifest.json");
  }

  /** Ensure the workspace directory exists for a session */
  ensureWorkspace(sessionId: string): string {
    const dir = this.workspaceDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ─── Manifest ───────────────────────────────────────────────────────────

  private getManifest(sessionId: string): FileManifest {
    const manifestFile = this.manifestPath(sessionId);
    try {
      const raw = fs.readFileSync(manifestFile, "utf-8");
      return JSON.parse(raw) as FileManifest;
    } catch {
      return {
        sessionId,
        files: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  }

  private saveManifest(manifest: FileManifest): void {
    this.ensureWorkspace(manifest.sessionId);
    manifest.updatedAt = new Date().toISOString();
    fs.writeFileSync(
      this.manifestPath(manifest.sessionId),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );
  }

  // ─── File operations ────────────────────────────────────────────────────

  /**
   * Save a file to the workspace.
   * Used for both uploads and registering tool-generated files.
   */
  saveFile(params: {
    sessionId: string;
    filename: string;
    data: Buffer;
    mimeType?: string;
    source: "upload" | "generated";
  }): FileMetadata {
    const { sessionId, data, source } = params;
    const filename = sanitizeFilename(params.filename);
    const mimeType = params.mimeType ?? guessMimeType(filename);

    this.ensureWorkspace(sessionId);

    const localPath = path.join(this.workspaceDir(sessionId), filename);
    fs.writeFileSync(localPath, data);

    const now = new Date().toISOString();
    const metadata: FileMetadata = {
      filename,
      originalName: params.filename,
      size: data.length,
      mimeType,
      createdAt: now,
      source,
    };

    const manifest = this.getManifest(sessionId);
    manifest.files[filename] = metadata;
    this.saveManifest(manifest);

    return metadata;
  }

  /** List all files for a session */
  listFiles(sessionId: string): FileMetadata[] {
    const manifest = this.getManifest(sessionId);
    return Object.values(manifest.files);
  }

  /** Get a single file's metadata */
  getFileMetadata(sessionId: string, filename: string): FileMetadata | null {
    const manifest = this.getManifest(sessionId);
    return manifest.files[filename] ?? null;
  }

  /** Read a file's contents from local disk */
  readFile(sessionId: string, filename: string): Buffer {
    const localPath = path.join(this.workspaceDir(sessionId), filename);
    return fs.readFileSync(localPath);
  }

  /** Delete a file */
  deleteFile(sessionId: string, filename: string): boolean {
    const manifest = this.getManifest(sessionId);
    if (!manifest.files[filename]) return false;

    const localPath = path.join(this.workspaceDir(sessionId), filename);
    try {
      fs.unlinkSync(localPath);
    } catch {
      // File may already be gone
    }

    delete manifest.files[filename];
    this.saveManifest(manifest);
    return true;
  }

  /** Update metadata fields for an existing file */
  updateFileMetadata(sessionId: string, filename: string, updates: Partial<FileMetadata>): void {
    const manifest = this.getManifest(sessionId);
    if (manifest.files[filename]) {
      manifest.files[filename] = { ...manifest.files[filename]!, ...updates };
      this.saveManifest(manifest);
    }
  }

  /**
   * Scan the workspace directory for files not in the manifest.
   * These are files created by tools (via bash, write, exec) that bypassed
   * the FileStore API. Registers them in the manifest.
   */
  syncNewFiles(sessionId: string): FileMetadata[] {
    const dir = this.workspaceDir(sessionId);
    if (!fs.existsSync(dir)) return [];

    const manifest = this.getManifest(sessionId);
    const entries = fs.readdirSync(dir);
    const newFiles: FileMetadata[] = [];

    for (const entry of entries) {
      // Skip manifest and hidden files
      if (entry === "_manifest.json" || entry.startsWith(".")) continue;

      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;

      if (manifest.files[entry]) {
        // Check if file was modified (size changed)
        if (manifest.files[entry]!.size !== stat.size) {
          const data = fs.readFileSync(fullPath);
          const now = new Date().toISOString();
          const meta: FileMetadata = {
            filename: entry,
            originalName: entry,
            size: data.length,
            mimeType: guessMimeType(entry),
            createdAt: now,
            source: "generated",
          };
          manifest.files[entry] = meta;
          newFiles.push(meta);
        }
        continue;
      }

      // New untracked file
      const now = new Date().toISOString();
      const meta: FileMetadata = {
        filename: entry,
        originalName: entry,
        size: stat.size,
        mimeType: guessMimeType(entry),
        createdAt: now,
        source: "generated",
      };
      manifest.files[entry] = meta;
      newFiles.push(meta);
    }

    if (newFiles.length > 0) {
      this.saveManifest(manifest);
    }

    return newFiles;
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

/** Sanitize a filename: remove path separators, prevent traversal */
function sanitizeFilename(name: string): string {
  let clean = path.basename(name);
  clean = clean.replace(/^\.+/, "");
  clean = clean.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  if (!clean) clean = "unnamed_file";
  return clean;
}

/** Guess MIME type from file extension */
function guessMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".ifc": "application/x-step",
    ".dxf": "application/dxf",
    ".dwg": "application/acad",
    ".pdf": "application/pdf",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".json": "application/json",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".xml": "application/xml",
    ".html": "text/html",
    ".zip": "application/zip",
    ".stl": "model/stl",
    ".obj": "model/obj",
    ".gltf": "model/gltf+json",
    ".glb": "model/gltf-binary",
    ".las": "application/vnd.las",
    ".laz": "application/vnd.laszip",
    ".ply": "application/x-ply",
    ".e57": "application/x-e57",
    ".gbxml": "application/xml",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Resolve the workspace base directory from environment */
export function resolveWorkspaceBaseDir(): string {
  if (process.env.CIVILCLAW_WORKSPACE_DIR) {
    return process.env.CIVILCLAW_WORKSPACE_DIR;
  }
  if (fs.existsSync("/workspace") && process.env.NODE_ENV === "production") {
    return "/workspace";
  }
  return path.join(os.homedir(), ".civilclaw", "workspaces");
}

/** Create a FileStore from environment variables */
export function createFileStore(): FileStore {
  return new FileStore({
    localBaseDir: resolveWorkspaceBaseDir(),
  });
}
