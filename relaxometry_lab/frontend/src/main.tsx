import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { LandingPage } from "./pages/LandingPage.tsx";

// Two "pages" sharing one bundle — not worth pulling in a router for this.
// /tool and /tool-next (wizard) and / and /next (landing) all serve the same
// built index.html; this just decides which React tree to mount based on
// the URL path.
const WIZARD_PATHS = ["/tool", "/tool-next"];
const isWizard = WIZARD_PATHS.includes(window.location.pathname.replace(/\/$/, "")) || WIZARD_PATHS.some((p) => window.location.pathname.startsWith(p + "/"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isWizard ? <App /> : <LandingPage />}</StrictMode>
);
