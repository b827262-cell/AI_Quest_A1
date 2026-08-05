import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installAdminFetchInterceptor } from "./adminAuth";
import "./styles.css";

installAdminFetchInterceptor();
createRoot(document.getElementById("root")!).render(<App />);
