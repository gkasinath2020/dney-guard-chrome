// Toolbar popup entry: picks the view (status / signup) — see popup-view.ts.
import { loadConfigState, readLocal } from "../lib/config";
import { mountPopup } from "./popup-view";

void mountPopup(document.getElementById("root")!, {
  loadState: loadConfigState,
  readLocal,
  removeLocal: (keys) => chrome.storage.local.remove(keys),
  removeSync: (keys) => chrome.storage.sync.remove(keys),
  send: (msg) => chrome.runtime.sendMessage(msg),
  openOptions: () => void chrome.runtime.openOptionsPage(),
  download: (json) => {
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "dney-guard-audit.json";
    a.click();
    URL.revokeObjectURL(a.href);
  },
});
