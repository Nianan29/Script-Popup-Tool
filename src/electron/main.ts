import {
  Menu,
  Tray,
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  nativeImage,
  Notification,
  screen,
  shell
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { AppConfig, loadConfig, matchesAppRule, resolveConfigPath } from "./config";
import {
  ForegroundSnapshotEvent,
  HelperEvent,
  InputClickedEvent,
  InputWatcherClient,
  MouseClickedEvent
} from "./helper";

let popupWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let config: AppConfig;
let configPath: string;
let helper: InputWatcherClient;
let paused = false;
let activeTarget: InputClickedEvent | undefined;
let lastClipboardText: string | undefined;
let restoreClipboardTimer: NodeJS.Timeout | undefined;
let logPath: string;
let manualShortcutLabel = "托盘菜单";
let lastInputClickAt = 0;
let pendingFallbackClickId = 0;
let suppressMouseUntil = 0;
let pasteInProgress = false;
let presetLayout: PresetLayoutRect[] = [];
let lastFakeClickAt = 0;
let pendingManualOpen:
  | {
      requestId: string;
      x: number;
      y: number;
      ignoreAppRules: boolean;
    }
  | undefined;

const popupWidth = 150;
const popupMaxHeight = 300;

interface PresetLayoutRect {
  groupIndex: number;
  itemIndex: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface PresetHit {
  groupIndex: number;
  itemIndex: number;
}

app.setName("话术弹窗工具");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on("second-instance", () => {
  popupWindow?.show();
});

app.whenReady().then(async () => {
  configPath = resolveConfigPath();
  logPath = path.join(app.getPath("userData"), "logs", "main.log");
  config = loadConfig(configPath);
  logInfo(`App starting. configPath=${configPath}`);

  await createPopupWindow();
  createTray();
  startHelper();
  registerShortcuts();
  showStartupHint();

  app.on("activate", () => {
    if (!popupWindow) {
      void createPopupWindow();
    }
  });
});

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
  helper?.stop();
});

ipcMain.handle("get-presets", () => config.presets);

ipcMain.on("select-preset", (_event, payload: { groupIndex: number; itemIndex: number }) => {
  selectPreset(payload.groupIndex, payload.itemIndex, "renderer");
});

ipcMain.on("preset-layout", (_event, rects: PresetLayoutRect[]) => {
  presetLayout = Array.isArray(rects) ? rects.filter(isValidPresetLayoutRect) : [];
});

function selectPreset(groupIndex: number, itemIndex: number, source: string): void {
  if (pasteInProgress) {
    return;
  }

  const preset = config.presets[groupIndex]?.items[itemIndex];
  const target = activeTarget;

  if (!preset || !target) {
    hidePopup();
    return;
  }

  logInfo(`Preset selected. source=${source} groupIndex=${groupIndex} itemIndex=${itemIndex}`);
  pastePresetText(preset.text, target);
}

function isValidPresetLayoutRect(rect: PresetLayoutRect): boolean {
  return (
    Number.isFinite(rect.groupIndex) &&
    Number.isFinite(rect.itemIndex) &&
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.right) &&
    Number.isFinite(rect.bottom)
  );
}

ipcMain.on("close-popup", () => {
  hidePopup();
});

async function createPopupWindow(): Promise<void> {
  popupWindow = new BrowserWindow({
    width: popupWidth,
    height: popupMaxHeight,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    backgroundColor: "#141413",
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  popupWindow.setAlwaysOnTop(true, "screen-saver");
  popupWindow.on("blur", () => {
    hidePopup();
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await popupWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await popupWindow.loadFile(path.join(__dirname, "..", "dist-renderer", "index.html"));
  }
}

function createTray(): void {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("话术弹窗工具");
  rebuildTrayMenu();
}

function rebuildTrayMenu(): void {
  if (!tray) {
    return;
  }

  const menu = Menu.buildFromTemplate([
    {
      label: "显示话术列表",
      click: () => {
        showManualPalette(true);
      }
    },
    {
      label: paused ? "恢复弹窗" : "暂停弹窗",
      click: () => {
        paused = !paused;
        if (paused) {
          helper.pause();
          hidePopup();
        } else {
          helper.resume();
        }
        rebuildTrayMenu();
      }
    },
    {
      label: "重新加载配置",
      click: () => {
        reloadConfig();
      }
    },
    {
      label: "打开配置文件",
      click: () => {
        void shell.openPath(configPath);
      }
    },
    {
      label: "打开配置目录",
      click: () => {
        void shell.openPath(path.dirname(configPath));
      }
    },
    {
      label: "打开日志目录",
      click: () => {
        void shell.openPath(path.dirname(logPath));
      }
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        helper.stop();
        app.exit(0);
      }
    }
  ]);

  tray.setContextMenu(menu);
}

function createTrayIcon(): Electron.NativeImage {
  const svg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#18f2b2"/>
          <stop offset="100%" stop-color="#0d6efd"/>
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="#111"/>
      <path d="M8 9.5C8 7.6 9.6 6 11.5 6h9C22.4 6 24 7.6 24 9.5v6c0 1.9-1.6 3.5-3.5 3.5H16l-5.2 4.2c-.7.6-1.8.1-1.8-.8V19h-.5C8.2 19 8 18.8 8 18.5v-9Z" fill="url(#g)"/>
      <circle cx="12.5" cy="12.5" r="1.3" fill="#08111f"/>
      <circle cx="16" cy="12.5" r="1.3" fill="#08111f"/>
      <circle cx="19.5" cy="12.5" r="1.3" fill="#08111f"/>
    </svg>
  `);
  return nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${svg}`);
}

function startHelper(): void {
  helper = new InputWatcherClient();
  helper.onEvent(handleHelperEvent);
  helper.start();
}

function registerShortcuts(): void {
  const shortcuts = ["Control+Alt+R", "CommandOrControl+Alt+R", "Control+Shift+Space", "F8"];
  const registeredShortcut = shortcuts.find((shortcut) =>
    globalShortcut.register(shortcut, () => {
      showManualPalette(true);
    })
  );

  manualShortcutLabel = registeredShortcut ?? "托盘菜单";
  logInfo(`Manual shortcut registered=${registeredShortcut ?? "none"}`);
}

function showStartupHint(): void {
  const title = "话术弹窗工具已启动";
  const content = `点击输入框自动弹出；如果没有反应，用 ${manualShortcutLabel} 手动弹出。`;

  if (Notification.isSupported()) {
    new Notification({ title, body: content }).show();
  }

  tray?.displayBalloon({
    title,
    content,
    iconType: "info"
  });
}

function handleHelperEvent(event: HelperEvent): void {
  if (event.type === "log") {
    logInfo(`[InputWatcher:${event.level}] ${event.message}`);
    console[event.level === "error" ? "error" : event.level === "warn" ? "warn" : "log"](
      `[InputWatcher] ${event.message}`
    );
    return;
  }

  if (event.type === "foreground-changed") {
    return;
  }

  if (event.type === "foreground-snapshot") {
    handleForegroundSnapshot(event);
    return;
  }

  if (event.type === "mouse-clicked") {
    handleMouseClicked(event);
    return;
  }

  if (event.type === "input-clicked") {
    handleInputClicked(event);
  }
}

function handleMouseClicked(event: MouseClickedEvent): void {
  if (Date.now() < suppressMouseUntil) {
    return;
  }

  if (popupWindow?.isVisible()) {
    const bounds = popupWindow.getBounds();
    const point = toDipPoint(event.x, event.y);
    const inside =
      point.x >= bounds.x &&
      point.x <= bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y <= bounds.y + bounds.height;

    if (inside) {
      const localX = point.x - bounds.x;
      const localY = point.y - bounds.y;
      const hit = findPresetHit(localX, localY);
      if (hit) {
        selectPreset(hit.groupIndex, hit.itemIndex, "native-hit-test");
      } else {
        void selectPresetAtLocalPoint(localX, localY).then((handled) => {
          if (!handled && popupWindow?.isVisible()) {
            fakeSecondClick(event.x, event.y);
          }
        });
      }
      return;
    }

    hidePopup();
    return;
  }

  if (
    paused ||
    !config.behavior.showOnAnyClickInMatchedApp ||
    !matchesAppRule(config.apps, event.processName, event.windowTitle)
  ) {
    return;
  }

  const clickId = ++pendingFallbackClickId;
  setTimeout(() => {
    const inputWasAccepted = Date.now() - lastInputClickAt < 250;
    if (pendingFallbackClickId !== clickId || inputWasAccepted || popupWindow?.isVisible()) {
      return;
    }

    activeTarget = {
      type: "input-clicked",
      x: event.x,
      y: event.y,
      processName: event.processName,
      windowTitle: event.windowTitle,
      windowHandle: event.windowHandle,
      controlType: "fallback-mouse"
    };

    logInfo(
      `Fallback mouse click opened palette. process=${event.processName} title=${event.windowTitle} x=${event.x} y=${event.y}`
    );
    showPopupNear(event.x, event.y);
  }, 120);
}

function handleInputClicked(event: InputClickedEvent): void {
  if (Date.now() < suppressMouseUntil) {
    return;
  }

  if (!isLikelyInputClick(event)) {
    logInfo(
      `Input click rejected by input-area filter. process=${event.processName} title=${event.windowTitle} control=${event.controlType ?? ""} x=${event.x} y=${event.y} ${describeClickGeometry(event)}`
    );
    return;
  }

  if (paused || !matchesAppRule(config.apps, event.processName, event.windowTitle)) {
    logInfo(
      `Input click ignored. paused=${paused} process=${event.processName} title=${event.windowTitle} control=${event.controlType ?? ""}`
    );
    return;
  }

  logInfo(
    `Input click accepted. process=${event.processName} title=${event.windowTitle} control=${event.controlType ?? ""} x=${event.x} y=${event.y} ${describeClickGeometry(event)}`
  );
  lastInputClickAt = Date.now();
  pendingFallbackClickId++;
  activeTarget = event;
  showPopupNear(event.x, event.y);
}

function isLikelyInputClick(event: InputClickedEvent): boolean {
  const processName = event.processName.toLocaleLowerCase();
  const controlType = (event.controlType ?? "").toLocaleLowerCase();
  const isChatShell = processName === "dingtalk.exe" || processName === "tim.exe";

  if (!isChatShell) {
    return true;
  }

  if (
    controlType.startsWith("win32-caret") ||
    controlType.startsWith("win32-focus")
  ) {
    return isLowerWindowArea(event, 0.68);
  }

  if (controlType.includes("controltype.edit") || controlType.includes("legacy")) {
    return isChatInputElementRect(event) || isLowerWindowArea(event, 0.68);
  }

  if (!controlType.includes("controltype.document")) {
    return false;
  }

  return isChatInputElementRect(event) || isLowerWindowArea(event, 0.72);
}

function isLowerWindowArea(event: InputClickedEvent, ratio: number): boolean {
  if (
    typeof event.windowTop !== "number" ||
    typeof event.windowBottom !== "number" ||
    event.windowBottom <= event.windowTop
  ) {
    return false;
  }

  const windowHeight = event.windowBottom - event.windowTop;
  const relativeY = event.y - event.windowTop;
  return relativeY >= windowHeight * ratio;
}

function isChatInputElementRect(event: InputClickedEvent): boolean {
  const windowTop = event.windowTop;
  const windowBottom = event.windowBottom;
  const elementTop = event.elementTop;
  const elementBottom = event.elementBottom;

  if (
    typeof windowTop !== "number" ||
    typeof windowBottom !== "number" ||
    typeof elementTop !== "number" ||
    typeof elementBottom !== "number" ||
    windowBottom <= windowTop ||
    elementBottom <= elementTop
  ) {
    return false;
  }

  const windowHeight = windowBottom - windowTop;
  const elementHeight = elementBottom - elementTop;
  const elementTopRatio = (elementTop - windowTop) / windowHeight;
  const elementBottomRatio = (elementBottom - windowTop) / windowHeight;

  return elementTopRatio >= 0.52 && elementBottomRatio >= 0.72 && elementHeight <= windowHeight * 0.38;
}

function describeClickGeometry(event: InputClickedEvent): string {
  const windowRect =
    typeof event.windowTop === "number" && typeof event.windowBottom === "number"
      ? `windowY=${event.windowTop}-${event.windowBottom}`
      : "windowY=unknown";
  const elementRect =
    typeof event.elementTop === "number" && typeof event.elementBottom === "number"
      ? `elementY=${event.elementTop}-${event.elementBottom}`
      : "elementY=unknown";

  return `${windowRect} ${elementRect}`;
}

function handleForegroundSnapshot(event: ForegroundSnapshotEvent): void {
  if (!pendingManualOpen || pendingManualOpen.requestId !== event.requestId) {
    return;
  }

  const request = pendingManualOpen;
  pendingManualOpen = undefined;

  if (!request.ignoreAppRules && !matchesAppRule(config.apps, event.processName, event.windowTitle)) {
    logInfo(
      `Manual palette blocked by app rules. process=${event.processName} title=${event.windowTitle}`
    );
    return;
  }

  activeTarget = {
    type: "input-clicked",
    x: request.x,
    y: request.y,
    processName: event.processName,
    windowTitle: event.windowTitle,
    windowHandle: event.windowHandle,
    controlType: "manual"
  };

  logInfo(
    `Manual palette opened. process=${event.processName} title=${event.windowTitle} x=${request.x} y=${request.y}`
  );
  showPopupNear(request.x, request.y);
}

function showManualPalette(ignoreAppRules: boolean): void {
  if (paused) {
    paused = false;
    helper.resume();
    rebuildTrayMenu();
  }

  const cursor = screen.getCursorScreenPoint();
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  pendingManualOpen = {
    requestId,
    x: cursor.x,
    y: cursor.y,
    ignoreAppRules
  };
  helper.getForeground(requestId);

  setTimeout(() => {
    if (pendingManualOpen?.requestId === requestId) {
      logInfo("Manual foreground snapshot timed out; opening palette without active target.");
      pendingManualOpen = undefined;
      activeTarget = undefined;
      showPopupNear(cursor.x, cursor.y);
    }
  }, 350);
}

function showPopupNear(x: number, y: number): void {
  if (!popupWindow) {
    return;
  }

  const dipPoint = toDipPoint(x, y);
  const display = screen.getDisplayNearestPoint(dipPoint);
  const workArea = display.workArea;
  const height = calculatePopupHeight(config);
  const point = keepInsideWorkArea(dipPoint.x + 12, dipPoint.y + 12, popupWidth, height, workArea);

  popupWindow.setOpacity(1);
  popupWindow.setBounds({
    x: point.x,
    y: point.y,
    width: popupWidth,
    height
  });

  presetLayout = [];
  popupWindow.webContents.send("popup-data", {
    presets: config.presets,
    target: activeTarget
  });

  popupWindow.showInactive();
}

function keepInsideWorkArea(
  x: number,
  y: number,
  width: number,
  height: number,
  workArea: Electron.Rectangle
): { x: number; y: number } {
  const nextX = Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width);
  const nextY = Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height);
  return { x: nextX, y: nextY };
}

function calculatePopupHeight(nextConfig: AppConfig): number {
  return popupMaxHeight;
}

function hidePopup(): void {
  if (popupWindow?.isVisible()) {
    popupWindow.hide();
  }
  presetLayout = [];
}

function reloadConfig(): void {
  config = loadConfig(configPath);
  logInfo(`Config reloaded. apps=${config.apps.length} presetGroups=${config.presets.length}`);
  helper.reloadConfig();
  popupWindow?.webContents.send("popup-data", {
    presets: config.presets,
    target: activeTarget
  });
}

function pastePresetText(text: string, target: InputClickedEvent): void {
  if (pasteInProgress) {
    return;
  }

  pasteInProgress = true;
  suppressMouseUntil = Date.now() + 2200;
  helper.pause();
  hidePopup();

  if (restoreClipboardTimer) {
    clearTimeout(restoreClipboardTimer);
    restoreClipboardTimer = undefined;
  }

  lastClipboardText = clipboard.readText();
  clipboard.writeText(text);
  const windowHandle = target.windowHandle;
  if (windowHandle) {
    const targetX = target.x;
    const targetY = target.y;
    setTimeout(() => {
      helper.paste(windowHandle, targetX, targetY);
      logInfo(`Pasted preset. targetWindow=${windowHandle} textLength=${text.length}`);
    }, 80);
  } else {
    logInfo(`Copied preset only because no target window was available. textLength=${text.length}`);
  }

  restoreClipboardTimer = setTimeout(() => {
    if (typeof lastClipboardText === "string" && clipboard.readText() === text) {
      clipboard.writeText(lastClipboardText);
    }
    restoreClipboardTimer = undefined;
  }, 1500);

  setTimeout(() => {
    pasteInProgress = false;
    helper.resume();
  }, 650);
}

function findPresetHit(localX: number, localY: number): PresetLayoutRect | undefined {
  return presetLayout.find(
    (rect) =>
      localX >= rect.left &&
      localX <= rect.right &&
      localY >= rect.top &&
      localY <= rect.bottom
  );
}

async function selectPresetAtLocalPoint(localX: number, localY: number): Promise<boolean> {
  if (!popupWindow || pasteInProgress) {
    return false;
  }

  try {
    const hit = (await popupWindow.webContents.executeJavaScript(
      `
(() => {
  const element = document.elementFromPoint(${Math.round(localX)}, ${Math.round(localY)});
  const button = element && element.closest ? element.closest(".preset") : null;
  if (!button) {
    return null;
  }

  return {
    groupIndex: Number(button.dataset.groupIndex),
    itemIndex: Number(button.dataset.itemIndex)
  };
})()
      `,
      true
    )) as PresetHit | null;

    if (!hit || !Number.isFinite(hit.groupIndex) || !Number.isFinite(hit.itemIndex)) {
      return false;
    }

    selectPreset(hit.groupIndex, hit.itemIndex, "dom-hit-test");
    return true;
  } catch (error) {
    logInfo(`Popup DOM hit-test failed. error=${String(error)}`);
    return false;
  }
}

function fakeSecondClick(x: number, y: number): void {
  const now = Date.now();
  if (now - lastFakeClickAt < 500 || pasteInProgress) {
    return;
  }

  lastFakeClickAt = now;
  logInfo(`Fake second click scheduled. x=${x} y=${y} layoutCount=${presetLayout.length}`);
  helper.fakeClick(x, y, 90);
}

function toDipPoint(x: number, y: number): { x: number; y: number } {
  const display = screen.getDisplayNearestPoint({ x, y });
  const scaleFactor = display.scaleFactor || 1;
  return {
    x: Math.round(x / scaleFactor),
    y: Math.round(y / scaleFactor)
  };
}

function logInfo(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(message);

  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line, "utf8");
  } catch {
    // Logging must not break the app.
  }
}
