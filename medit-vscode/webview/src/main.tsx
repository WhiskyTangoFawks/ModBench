import React from "react";
import { createRoot } from "react-dom/client";
import { RecordPanel } from "./RecordPanel";

const root = document.getElementById("root")!;
createRoot(root).render(<RecordPanel />);
