import React from "react";
import { createRoot } from "react-dom/client";
import { RecordPanel } from "./RecordPanel";
import { createRecordPanelClient } from "./RecordPanelClient";

const client = createRecordPanelClient();

const root = document.getElementById("root");
if (!root) throw new Error("webviewHtml.ts's template dropped the #root element");
createRoot(root).render(<RecordPanel client={client} />);
