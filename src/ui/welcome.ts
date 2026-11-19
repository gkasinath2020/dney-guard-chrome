// Welcome tab entry (SCRUM-396) — see welcome-view.ts.
import { renderWelcome } from "./welcome-view";

renderWelcome(document.getElementById("root")!, { send: (msg) => chrome.runtime.sendMessage(msg) });
