import { useSyncExternalStore } from "react";

const subscribe = (changed: () => void) => {
  window.addEventListener("online", changed);
  window.addEventListener("offline", changed);
  return () => {
    window.removeEventListener("online", changed);
    window.removeEventListener("offline", changed);
  };
};

/** Whether the Mac is online, as the webview sees it: features that need the internet say so when it isn't. */
export const useOnline = () => useSyncExternalStore(subscribe, () => navigator.onLine);
