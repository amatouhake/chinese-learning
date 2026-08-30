import { mount } from "svelte";

import App from "./App.svelte";
import "./app.css";
import { registerProductionServiceWorker } from "./service-worker-registration";

const target = document.getElementById("app");

if (!target) {
  throw new Error("Missing #app mount target");
}

mount(App, { target });

registerProductionServiceWorker(import.meta.env.PROD);
