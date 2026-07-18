import React from "react";
import { createRoot } from "react-dom/client";
import { RecordPanel } from "./RecordPanel";
import { createRecordSessionClient } from "./RecordSessionClient";

// The panel HTML injects the backend port (CSP connect-src allows localhost:port); the client is
// built once here and injected, mirroring how extension.ts constructs the host-side ApiClient.
const port = (window as unknown as { mEditBackendPort: number }).mEditBackendPort;
const client = createRecordSessionClient(port);

const root = document.getElementById("root")!;
createRoot(root).render(<RecordPanel client={client} />);
