import React from "react";
import { createRoot } from "react-dom/client";
import { RecordPanel } from "./RecordPanel";
import { createRecordPanelClient } from "./RecordPanelClient";

// webviewHtml.ts's inline script sets this global before this bundle loads.
declare global {
  interface Window {
    mEditBackendPort: number;
  }
}

// The panel HTML injects the backend port (CSP connect-src allows localhost:port); the client is
// built once here and injected, mirroring how extension.ts constructs the host-side ApiClient.
const port = window.mEditBackendPort;
const client = createRecordPanelClient(port);

const root = document.getElementById("root");
if (!root) throw new Error("webviewHtml.ts's template dropped the #root element");
createRoot(root).render(<RecordPanel client={client} />);
