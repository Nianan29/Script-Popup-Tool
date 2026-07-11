import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("replyTool", {
  getPresets: () => ipcRenderer.invoke("get-presets"),
  onPopupData: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("popup-data", listener);
    return () => ipcRenderer.removeListener("popup-data", listener);
  },
  selectPreset: (groupIndex: number, itemIndex: number) => {
    ipcRenderer.send("select-preset", { groupIndex, itemIndex });
  },
  reportPresetLayout: (
    rects: Array<{
      groupIndex: number;
      itemIndex: number;
      left: number;
      top: number;
      right: number;
      bottom: number;
    }>
  ) => {
    ipcRenderer.send("preset-layout", rects);
  },
  closePopup: () => {
    ipcRenderer.send("close-popup");
  }
});
