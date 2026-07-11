import type { PresetGroup } from "../renderer/types";

declare global {
  interface Window {
    replyTool: {
      getPresets: () => Promise<PresetGroup[]>;
      onPopupData: (callback: (payload: { presets: PresetGroup[] }) => void) => () => void;
      selectPreset: (groupIndex: number, itemIndex: number) => void;
      reportPresetLayout: (
        rects: Array<{
          groupIndex: number;
          itemIndex: number;
          left: number;
          top: number;
          right: number;
          bottom: number;
        }>
      ) => void;
      closePopup: () => void;
    };
  }
}

export {};
