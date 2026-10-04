import React from "react";
import "@vscode/codicons/dist/codicon.css";
import { createRoot } from "react-dom/client";
import { RecordPanel } from "./RecordPanel";
import { createRecordPanelClient } from "./RecordPanelClient";

const client = createRecordPanelClient();

const root = document.getElementById("root");
if (!root) throw new Error("webviewPage.ts's template dropped the #root element");
createRoot(root).render(<RecordPanel client={client} />);
