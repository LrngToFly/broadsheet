// Reading and moving newsletter email through Microsoft Graph.
// Every call asks for immutable ids, so a message keeps the same id after it's moved to another folder.
import type { Graph } from "./graph.ts";

const IMMUTABLE = { Prefer: 'IdType="ImmutableId"' };

export type MessageSummary = {
  id: string;
  internetMessageId: string;
  subject: string;
  receivedDateTime: string;
  isRead: boolean;
  from?: { emailAddress?: { name?: string; address?: string } };
};

const SELECT = "id,internetMessageId,subject,receivedDateTime,isRead,from";

export class Mail {
  private readonly graph: Graph;
  constructor(graph: Graph) {
    this.graph = graph;
  }

  /** Messages in a folder ("inbox" or a folder id), newest first, optionally only those received since a time. */
  async list(folder: string, since?: Date): Promise<MessageSummary[]> {
    const filter = since ? `&$filter=receivedDateTime ge ${since.toISOString()}` : "";
    return this.graph.all<MessageSummary>(`/me/mailFolders/${folder}/messages?$select=${SELECT}&$orderby=receivedDateTime desc&$top=50${filter}`, IMMUTABLE);
  }

  /** The full raw email (MIME). */
  async mime(id: string): Promise<string> {
    return this.graph.call<string>(`/me/messages/${id}/$value`, { headers: IMMUTABLE });
  }

  /** Move to a folder id, or "deleteditems". Returns the message's id afterwards. */
  async move(id: string, destinationId: string): Promise<string> {
    const moved = await this.graph.call<{ id: string }>(`/me/messages/${id}/move`, { method: "POST", body: { destinationId }, headers: IMMUTABLE });
    return moved.id;
  }

  async markRead(id: string): Promise<void> {
    await this.graph.call(`/me/messages/${id}`, { method: "PATCH", body: { isRead: true }, headers: IMMUTABLE });
  }
}
