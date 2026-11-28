// The OneDrive App Folder ("Apps/The Broadsheet"), the only part of OneDrive this app can reach.
import type { Graph } from "./graph.ts";

const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Larger files go up in pieces through an upload session (Graph's single upload takes up to 4 MB). */
export const SIMPLE_UPLOAD_BYTES = 4 * 1000 * 1000;
/** Each piece: a multiple of 320 KiB, as Graph requires; 5 MiB. */
export const UPLOAD_CHUNK_BYTES = 16 * 320 * 1024;

export class AppFolder {
  private readonly graph: Graph;
  constructor(graph: Graph) {
    this.graph = graph;
  }

  /** Where the App Folder is, for messages. */
  async info(): Promise<{ name: string; webUrl: string }> {
    return this.graph.call("/me/drive/special/approot?$select=name,webUrl");
  }

  /** Upload a file to a path inside the App Folder, replacing any existing one. Over 4 MB it goes up in pieces. */
  async put(path: string, body: string | Uint8Array, contentType: string): Promise<{ id: string; size: number }> {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    if (bytes.byteLength > SIMPLE_UPLOAD_BYTES) return this.putLarge(path, bytes);
    return this.graph.call(`/me/drive/special/approot:/${enc(path)}:/content`, {
      method: "PUT",
      body,
      headers: { "Content-Type": contentType },
    });
  }

  private async putLarge(path: string, bytes: Uint8Array): Promise<{ id: string; size: number }> {
    const session = await this.graph.call<{ uploadUrl: string }>(`/me/drive/special/approot:/${enc(path)}:/createUploadSession`, {
      method: "POST",
      body: { item: { "@microsoft.graph.conflictBehavior": "replace" } },
    });
    let last: { id: string; size: number } | undefined;
    for (let start = 0; start < bytes.byteLength; start += UPLOAD_CHUNK_BYTES) {
      const piece = bytes.subarray(start, Math.min(start + UPLOAD_CHUNK_BYTES, bytes.byteLength));
      last = await this.graph.call(session.uploadUrl, {
        method: "PUT",
        body: piece,
        headers: { "Content-Range": `bytes ${start}-${start + piece.byteLength - 1}/${bytes.byteLength}` },
        noAuth: true,
      });
    }
    return last!;
  }

  async putJson(path: string, value: unknown) {
    return this.put(path, JSON.stringify(value), "application/json");
  }

  /** Names of the files in a folder of the App Folder ([] if the folder doesn't exist). */
  async list(folder: string): Promise<string[]> {
    try {
      const items = await this.graph.all<{ name: string }>(`/me/drive/special/approot:/${enc(folder)}:/children?$select=name&$top=500`);
      return items.map((i) => i.name);
    } catch (e) {
      if ((e as { status?: number }).status === 404) return [];
      throw e;
    }
  }

  /** Delete a file in the App Folder (it goes to the OneDrive recycle bin). Missing files are fine. */
  async delete(path: string): Promise<void> {
    try {
      await this.graph.call(`/me/drive/special/approot:/${enc(path)}`, { method: "DELETE" });
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
    }
  }

  async getJson<T = unknown>(path: string): Promise<T> {
    const res = await this.graph.call<Response>(`/me/drive/special/approot:/${enc(path)}:/content`, { raw: true });
    return JSON.parse(await res.text()) as T;
  }
}
