# 话术弹窗工具

Windows 桌面小工具。点击输入框后，会在鼠标附近弹出预设话术列表；选择话术后自动粘贴到原输入框。也可以按 `Ctrl+Alt+R` 手动弹出话术列表。

## 开发运行

```powershell
npm install
npm run dev
```

默认配置包含记事本、微信、钉钉、QQ、TIM。可以先用记事本验证。

## 配置

主配置文件是 `config/app-config.json`。

- `apps`：允许弹窗的应用规则，支持 `processName` 和 `titleContains`；空数组表示允许所有应用。
- `presets`：话术分组和话术内容。
- `hotkeys`：预留字段，第一版默认不启用。
- `behavior.showOnAnyClickInMatchedApp`：指定应用内输入框识别失败时，是否用任意点击兜底弹出话术列表，默认关闭。

示例：

```json
{
  "apps": [
    { "processName": "notepad.exe" },
    { "processName": "WeChat.exe", "titleContains": "微信" }
  ],
  "presets": [
    {
      "group": "常用回复",
      "items": [
        { "label": "稍等", "text": "好的，请稍等，我马上帮您确认。" }
      ]
    }
  ],
  "hotkeys": {}
}
```

规则说明：

- `processName` 大小写不敏感，`WeChat` 和 `WeChat.exe` 都可匹配。
- 同一条规则同时配置 `processName` 和 `titleContains` 时，两者都必须匹配。
- `apps` 为空数组时允许所有应用，方便临时调试。
- 默认关闭 `showOnAnyClickInMatchedApp`，避免点击非输入区域也弹窗。微信/钉钉等软件如果无法识别输入框，可用 `Ctrl+Alt+R` 手动弹出。
- 手动弹出快捷键：`Ctrl+Alt+R`。

## 打包

```powershell
npm run dist
```

构建产物输出到 `release/`。打包时会把 .NET 输入监听辅助进程作为自包含程序放进 Electron 资源目录，不需要用户运行 `dotnet` 命令。

## 验证清单

- 打开工具后，托盘出现“话术弹窗工具”图标。
- 打开记事本，点击文本输入区域，会出现话术弹窗；如果目标应用输入框识别失败，按 `Ctrl+Alt+R` 可手动弹出。
- 点击记事本菜单栏或未配置应用，不应出现话术弹窗。
- 点击某条话术后，文本应粘贴到记事本光标位置。
- 托盘菜单可暂停、恢复、重新加载配置、打开配置文件。
