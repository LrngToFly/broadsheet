import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";

broadcastResponseToMainFrame().catch((e: unknown) => {
  document.body.textContent = `Sign-in couldn't finish: ${e instanceof Error ? e.message : String(e)}`;
});
