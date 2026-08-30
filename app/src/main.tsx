// D-093: FIRST, and the order is load-bearing. ES modules evaluate in import order, so this
// attaches the boot-error listeners before `./App` is evaluated — the window in which an
// engine-specific module-evaluation failure (WKWebView, WebView2) would otherwise vanish.
import { scheduleSmokeReport } from "./smoke";

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Before `render`, not after: if the first render throws, the frame callback inside still
// runs and the shell learns that the app did NOT mount and why, rather than nothing at all.
scheduleSmokeReport();

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
