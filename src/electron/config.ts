import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export interface AppRule {
  processName?: string;
  titleContains?: string;
}

export interface PresetItem {
  label: string;
  text: string;
}

export interface PresetGroup {
  group: string;
  items: PresetItem[];
}

export interface AppConfig {
  apps: AppRule[];
  presets: PresetGroup[];
  hotkeys?: Record<string, string>;
  behavior: {
    showOnAnyClickInMatchedApp: boolean;
  };
}

const fallbackConfig: AppConfig = {
  apps: [{ processName: "notepad.exe" }],
  presets: [
    {
      group: "常用回复",
      items: [{ label: "稍等", text: "好的，请稍等，我马上帮您确认。" }]
    }
  ],
  hotkeys: {},
  behavior: {
    showOnAnyClickInMatchedApp: false
  }
};

export function resolveConfigPath(): string {
  if (process.env.APP_CONFIG_PATH) {
    return path.resolve(process.env.APP_CONFIG_PATH);
  }

  const devPath = path.resolve(process.cwd(), "config", "app-config.json");
  if (!app.isPackaged || fs.existsSync(devPath)) {
    return devPath;
  }

  const externalPath = path.join(path.dirname(process.execPath), "config", "app-config.json");
  if (fs.existsSync(externalPath)) {
    return externalPath;
  }

  return path.join(process.resourcesPath, "config", "app-config.json");
}

export function loadConfig(configPath = resolveConfigPath()): AppConfig {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return normalizeConfig(parsed);
  } catch (error) {
    console.error(`Failed to read config from ${configPath}`, error);
    return fallbackConfig;
  }
}

export function matchesAppRule(
  rules: AppRule[],
  processName: string | undefined,
  windowTitle: string | undefined
): boolean {
  if (rules.length === 0) {
    return true;
  }

  const normalizedProcess = normalizeProcessName(processName ?? "");
  const normalizedTitle = (windowTitle ?? "").toLocaleLowerCase();

  return rules.some((rule) => {
    const expectedProcess = normalizeProcessName(rule.processName ?? "");
    const processMatches =
      !expectedProcess ||
      normalizedProcess === expectedProcess ||
      normalizedProcess.replace(/\.exe$/i, "") === expectedProcess.replace(/\.exe$/i, "");

    const titleMatches =
      !rule.titleContains ||
      normalizedTitle.includes(rule.titleContains.toLocaleLowerCase());

    return processMatches && titleMatches;
  });
}

function normalizeConfig(config: Partial<AppConfig>): AppConfig {
  return {
    apps: Array.isArray(config.apps)
      ? config.apps
          .filter((rule) => rule && (rule.processName || rule.titleContains))
          .map((rule) => ({
            processName: stringOrUndefined(rule.processName),
            titleContains: stringOrUndefined(rule.titleContains)
          }))
      : fallbackConfig.apps,
    presets: normalizePresetGroups(config.presets),
    hotkeys: config.hotkeys && typeof config.hotkeys === "object" ? config.hotkeys : {},
    behavior: {
      showOnAnyClickInMatchedApp:
        typeof config.behavior?.showOnAnyClickInMatchedApp === "boolean"
          ? config.behavior.showOnAnyClickInMatchedApp
          : fallbackConfig.behavior.showOnAnyClickInMatchedApp
    }
  };
}

function normalizePresetGroups(groups: unknown): PresetGroup[] {
  if (!Array.isArray(groups)) {
    return fallbackConfig.presets;
  }

  const normalized = groups
    .map((group) => {
      if (!group || typeof group !== "object") {
        return undefined;
      }

      const candidate = group as Partial<PresetGroup>;
      const items = Array.isArray(candidate.items)
        ? candidate.items
            .filter(
              (item) =>
                item &&
                typeof item === "object" &&
                typeof (item as Partial<PresetItem>).label === "string" &&
                typeof (item as Partial<PresetItem>).text === "string"
            )
            .map((item) => ({
              label: (item as PresetItem).label,
              text: (item as PresetItem).text
            }))
        : [];

      if (items.length === 0) {
        return undefined;
      }

      return {
        group: typeof candidate.group === "string" && candidate.group.trim() ? candidate.group : "未分组",
        items
      };
    })
    .filter(Boolean) as PresetGroup[];

  return normalized.length > 0 ? normalized : fallbackConfig.presets;
}

function normalizeProcessName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
