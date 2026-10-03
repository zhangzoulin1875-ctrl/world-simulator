import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initAdminTokenAuth } from "./lib/admin-token";

initAdminTokenAuth();

createRoot(document.getElementById("root")!).render(<App />);
