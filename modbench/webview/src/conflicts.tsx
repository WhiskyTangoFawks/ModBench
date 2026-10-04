import React from "react";
import "@vscode/codicons/dist/codicon.css";
import { createRoot } from "react-dom/client";
import { ConflictTableView } from "./ConflictTable";

const root = document.getElementById("root");
if (!root) throw new Error("webviewPage.ts's template dropped the #root element");
createRoot(root).render(<ConflictTableView />);
