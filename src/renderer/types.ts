export interface PresetItem {
  label: string;
  text: string;
}

export interface PresetGroup {
  group: string;
  items: PresetItem[];
}
