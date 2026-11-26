// MSAL v5 "redirect bridge": Microsoft sends the sign-in response here; this hands it back to the app page.
import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";
broadcastResponseToMainFrame().catch((e) => {
  document.body.textContent = "Sign-in hand-off failed: " + (e?.errorCode ?? e);
});
