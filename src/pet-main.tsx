import React from "react";
import ReactDOM from "react-dom/client";
import { PetOverlay } from "./PetOverlay";

ReactDOM.createRoot(document.getElementById("pet-root") as HTMLElement).render(
  <React.StrictMode>
    <PetOverlay />
  </React.StrictMode>,
);
