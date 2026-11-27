// The AI the agent talks to (PLAN.md §5, "Room to grow"). Only Ollama exists today; another provider
// (a bigger local model, Apple's on-device model, the Claude API) would be one more class like OllamaProvider.

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatResult = {
  text: string;
  promptTokens: number;
  outputTokens: number;
  seconds: number;
};

export interface LlmProvider {
  /** e.g. "ollama:gemma4:12b", recorded on each item. */
  readonly id: string;
  chat(messages: ChatMessage[], opts?: { numCtx?: number }): Promise<ChatResult>;
  /** Is the model already in memory (someone else is using it)? */
  isLoaded(): Promise<boolean>;
  /** Free the model's memory now. */
  unload(): Promise<void>;
}
