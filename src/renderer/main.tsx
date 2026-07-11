import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PresetGroup, PresetItem } from "./types";
import "./styles.css";

interface FilteredGroup {
  group: string;
  groupIndex: number;
  items: Array<PresetItem & { itemIndex: number }>;
}

function App(): JSX.Element {
  const [groups, setGroups] = useState<PresetGroup[]>([]);
  const [query, setQuery] = useState("");
  const selectingRef = useRef(false);

  useEffect(() => {
    void window.replyTool.getPresets().then(setGroups);
    return window.replyTool.onPopupData((payload) => {
      selectingRef.current = false;
      setGroups(payload.presets ?? []);
      setQuery("");
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        window.replyTool.closePopup();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const filteredGroups = useMemo<FilteredGroup[]>(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();

    return groups
      .map((group, groupIndex) => ({
        group: group.group,
        groupIndex,
        items: group.items
          .map((item, itemIndex) => ({ ...item, itemIndex }))
          .filter(
            (item) =>
              !normalizedQuery ||
            item.label.toLocaleLowerCase().includes(normalizedQuery) ||
            item.text.toLocaleLowerCase().includes(normalizedQuery)
          )
      }))
      .filter((group) => group.items.length > 0);
  }, [groups, query]);

  const totalCount = groups.reduce((count, group) => count + group.items.length, 0);

  const selectPreset = (groupIndex: number, itemIndex: number): void => {
    if (selectingRef.current) {
      return;
    }

    selectingRef.current = true;
    window.replyTool.selectPreset(groupIndex, itemIndex);
  };

  return (
    <main className="shell">
      <header className="toolbar">
        <div>
          <h1>话术</h1>
          <p>{totalCount} 条预设回复</p>
        </div>
        <button className="close" type="button" onClick={() => window.replyTool.closePopup()} aria-label="关闭">
          ×
        </button>
      </header>

      <label className="search">
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索话术"
        />
      </label>

      <section className="groups">
        {filteredGroups.length > 0 ? (
          filteredGroups.map((group) => (
            <article className="group" key={group.group}>
              <h2>
                <span>{group.group}</span>
                <em>{group.items.length}</em>
              </h2>
              <div className="items">
                {group.items.map((item) => (
                  <button
                    type="button"
                    className="preset"
                    key={`${group.groupIndex}-${item.itemIndex}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      selectPreset(group.groupIndex, item.itemIndex);
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      selectPreset(group.groupIndex, item.itemIndex);
                    }}
                  >
                    <span className="preset-title">{item.label}</span>
                    <span className="preset-text">{item.text}</span>
                  </button>
                ))}
              </div>
            </article>
          ))
        ) : (
          <div className="empty">没有匹配的话术</div>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
