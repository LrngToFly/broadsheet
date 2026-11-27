// The OneDrive App Folder ("Apps/The Broadsheet"), the only part of OneDrive this app can reach.
import type { Graph } from "./graph.ts";

const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export class AppFolder {
  private readonly graph: Graph;
  constructor(graph: Graph) {
    this.graph = graph;
  }

  /** Where the App Folder is, for messages. */
  async info(): Promise<{ name: string; webUrl: string }> {
    return this.graph.call("/me/drive/special/approot?$select=name,webUrl");
  }

  /** Upload a small file (under 4 MB) to a path inside the App Folder, replacing any existing one. */
  async put(path: string, body: string | Uint8Array, contentType: string): Promise<{ id: string; size: number }> {
    return this.graph.call(`/me/drive/special/approot:/${enc(path)}:/content`, {
      method: "PUT",
      body,
      headers: { "Content-Type": contentType },
    });
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
