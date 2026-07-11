using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Automation;

namespace InputWatcher;

internal static class Program
{
    private const int WH_MOUSE_LL = 14;
    private const int WM_LBUTTONUP = 0x0202;
    private const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    private const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    private const int SW_RESTORE = 9;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_SHOWWINDOW = 0x0040;
    private const uint INPUT_KEYBOARD = 1;
    private const ushort VK_CONTROL = 0x11;
    private const ushort VK_V = 0x56;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };
    private static readonly AutomationPattern? LegacyPattern = AutomationPattern.LookupById(10018);

    private static LowLevelMouseProc? mouseProc;
    private static WinEventDelegate? foregroundProc;
    private static nint mouseHook;
    private static nint foregroundHook;
    private static volatile bool paused;
    private static long lastClickTicks;

    private static int Main()
    {
        Console.OutputEncoding = Encoding.UTF8;
        Console.InputEncoding = Encoding.UTF8;

        mouseProc = MouseHookCallback;
        foregroundProc = ForegroundChangedCallback;
        mouseHook = SetMouseHook(mouseProc);
        foregroundHook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            nint.Zero,
            foregroundProc,
            0,
            0,
            WINEVENT_OUTOFCONTEXT
        );

        if (mouseHook == nint.Zero)
        {
            EmitLog("error", "Failed to install low-level mouse hook.");
            return 1;
        }

        _ = Task.Run(ReadCommands);
        EmitLog("info", "InputWatcher started.");

        while (GetMessage(out var message, nint.Zero, 0, 0))
        {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }

        if (mouseHook != nint.Zero)
        {
            UnhookWindowsHookEx(mouseHook);
        }

        if (foregroundHook != nint.Zero)
        {
            UnhookWinEvent(foregroundHook);
        }

        return 0;
    }

    private static nint SetMouseHook(LowLevelMouseProc proc)
    {
        using var currentProcess = Process.GetCurrentProcess();
        var currentModule = currentProcess.MainModule;
        return SetWindowsHookEx(WH_MOUSE_LL, proc, GetModuleHandle(currentModule?.ModuleName), 0);
    }

    private static nint MouseHookCallback(int nCode, nint wParam, nint lParam)
    {
        if (nCode >= 0 && wParam == WM_LBUTTONUP && !paused)
        {
            var nowTicks = Stopwatch.GetTimestamp();
            var elapsedMs = (nowTicks - Interlocked.Read(ref lastClickTicks)) * 1000.0 / Stopwatch.Frequency;
            if (elapsedMs > 35)
            {
                Interlocked.Exchange(ref lastClickTicks, nowTicks);
                var hookStruct = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
                _ = Task.Run(async () =>
                {
                    await Task.Delay(70).ConfigureAwait(false);
                    HandleMouseClick(hookStruct.pt.x, hookStruct.pt.y);
                });
            }
        }

        return CallNextHookEx(mouseHook, nCode, wParam, lParam);
    }

    private static void HandleMouseClick(int x, int y)
    {
        try
        {
            var foregroundWindow = GetForegroundWindow();
            var windowInfo = GetWindowInfo(foregroundWindow);

            Emit(new
            {
                type = "mouse-clicked",
                x,
                y,
                processName = windowInfo.ProcessName,
                windowTitle = windowInfo.WindowTitle,
                windowHandle = foregroundWindow.ToString()
            });

            var editableElement = FindEditableElementAtPoint(x, y);
            var win32Editable = editableElement is null ? FindWin32EditableAtClick(foregroundWindow, x, y) : null;
            if (editableElement is null && win32Editable is null)
            {
                return;
            }

            Emit(new
            {
                type = "input-clicked",
                x,
                y,
                processName = windowInfo.ProcessName,
                windowTitle = windowInfo.WindowTitle,
                windowHandle = foregroundWindow.ToString(),
                controlType = editableElement is null ? win32Editable : SafeControlTypeName(editableElement)
            });
        }
        catch (Exception ex)
        {
            EmitLog("warn", $"Click handling failed: {ex.Message}");
        }
    }

    private static AutomationElement? FindEditableElementAtPoint(int x, int y)
    {
        AutomationElement? element;
        try
        {
            element = AutomationElement.FromPoint(new System.Windows.Point(x, y));
        }
        catch
        {
            return null;
        }

        for (var depth = 0; element is not null && depth < 6; depth++)
        {
            if (IsEditable(element))
            {
                return element;
            }

            try
            {
                element = TreeWalker.ControlViewWalker.GetParent(element);
            }
            catch
            {
                return null;
            }
        }

        try
        {
            var focused = AutomationElement.FocusedElement;
            if (focused is not null && IsEditable(focused))
            {
                return focused;
            }
        }
        catch
        {
            // FocusedElement can fail for elevated or protected windows.
        }

        return null;
    }

    private static string? FindWin32EditableAtClick(nint foregroundWindow, int x, int y)
    {
        if (foregroundWindow == nint.Zero)
        {
            return null;
        }

        try
        {
            var threadId = GetWindowThreadProcessId(foregroundWindow, out _);
            var info = new GUITHREADINFO
            {
                cbSize = Marshal.SizeOf<GUITHREADINFO>()
            };

            if (!GetGUIThreadInfo(threadId, ref info))
            {
                return null;
            }

            if (info.hwndCaret != nint.Zero && IsPointInsideWindow(info.hwndCaret, x, y))
            {
                return "win32-caret";
            }

            if (info.hwndFocus != nint.Zero && IsPointInsideWindow(info.hwndFocus, x, y))
            {
                var className = GetClassNameSafe(info.hwndFocus);
                if (ClassLooksEditable(className))
                {
                    return $"win32-focus:{className}";
                }
            }
        }
        catch
        {
            return null;
        }

        return null;
    }

    private static bool IsPointInsideWindow(nint hwnd, int x, int y)
    {
        return GetWindowRect(hwnd, out var rect) &&
               x >= rect.left &&
               x <= rect.right &&
               y >= rect.top &&
               y <= rect.bottom;
    }

    private static string GetClassNameSafe(nint hwnd)
    {
        var builder = new StringBuilder(256);
        return GetClassName(hwnd, builder, builder.Capacity) > 0 ? builder.ToString() : "";
    }

    private static bool ClassLooksEditable(string className)
    {
        var normalized = className.ToLowerInvariant();
        return normalized.Contains("edit") ||
               normalized.Contains("richedit") ||
               normalized.Contains("textbox") ||
               normalized.Contains("textinput") ||
               normalized.Contains("scintilla");
    }

    private static bool IsEditable(AutomationElement element)
    {
        try
        {
            if (!element.Current.IsEnabled)
            {
                return false;
            }

            var controlType = element.Current.ControlType;
            var className = (element.Current.ClassName ?? "").ToLowerInvariant();
            var isKnownEditableType =
                controlType == ControlType.Edit ||
                controlType == ControlType.Document ||
                controlType == ControlType.ComboBox;
            var isExcludedControl =
                controlType == ControlType.Button ||
                controlType == ControlType.Group ||
                controlType == ControlType.CheckBox ||
                controlType == ControlType.RadioButton ||
                controlType == ControlType.Hyperlink ||
                controlType == ControlType.MenuItem ||
                controlType == ControlType.ListItem ||
                controlType == ControlType.TabItem ||
                controlType == ControlType.ScrollBar ||
                controlType == ControlType.Slider;
            var classLooksEditable =
                className.Contains("edit") ||
                className.Contains("input") ||
                className.Contains("text") ||
                className.Contains("rich") ||
                className.Contains("textarea");
            var focusedEditable =
                element.Current.HasKeyboardFocus &&
                element.Current.IsKeyboardFocusable &&
                !isExcludedControl &&
                (isKnownEditableType || classLooksEditable);

            var hasEditableValuePattern =
                element.TryGetCurrentPattern(ValuePattern.Pattern, out var valuePattern) &&
                valuePattern is ValuePattern value &&
                !value.Current.IsReadOnly;

            var hasTextPattern = element.TryGetCurrentPattern(TextPattern.Pattern, out _);
            var legacyEditable = HasLegacyEditableRole(element);

            return (hasEditableValuePattern && (isKnownEditableType || classLooksEditable)) ||
                   legacyEditable ||
                   focusedEditable ||
                   (isKnownEditableType && (hasTextPattern || element.Current.IsKeyboardFocusable));
        }
        catch
        {
            return false;
        }
    }

    private static bool IsLegacyEditableRole(int role)
    {
        const int ROLE_SYSTEM_TEXT = 0x2A;
        const int ROLE_SYSTEM_COMBOBOX = 0x2E;
        return role is ROLE_SYSTEM_TEXT or ROLE_SYSTEM_COMBOBOX;
    }

    private static bool HasLegacyEditableRole(AutomationElement element)
    {
        if (LegacyPattern is null || !element.TryGetCurrentPattern(LegacyPattern, out var legacyPattern))
        {
            return false;
        }

        try
        {
            var current = legacyPattern.GetType().GetProperty("Current")?.GetValue(legacyPattern);
            var role = current?.GetType().GetProperty("Role")?.GetValue(current);
            return role is int intRole && IsLegacyEditableRole(intRole);
        }
        catch
        {
            return false;
        }
    }

    private static string SafeControlTypeName(AutomationElement element)
    {
        try
        {
            return element.Current.ControlType.ProgrammaticName;
        }
        catch
        {
            return "";
        }
    }

    private static void ForegroundChangedCallback(
        nint hWinEventHook,
        uint eventType,
        nint hwnd,
        int idObject,
        int idChild,
        uint idEventThread,
        uint dwmsEventTime
    )
    {
        if (paused || hwnd == nint.Zero)
        {
            return;
        }

        try
        {
            var windowInfo = GetWindowInfo(hwnd);
            Emit(new
            {
                type = "foreground-changed",
                processName = windowInfo.ProcessName,
                windowTitle = windowInfo.WindowTitle,
                windowHandle = hwnd.ToString()
            });
        }
        catch
        {
            // Ignore noisy foreground events.
        }
    }

    private static WindowInfo GetWindowInfo(nint hwnd)
    {
        var titleBuilder = new StringBuilder(512);
        _ = GetWindowText(hwnd, titleBuilder, titleBuilder.Capacity);
        _ = GetWindowThreadProcessId(hwnd, out var processId);

        var processName = "";
        try
        {
            using var process = Process.GetProcessById((int)processId);
            processName = process.ProcessName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                ? process.ProcessName
                : $"{process.ProcessName}.exe";
        }
        catch
        {
            // Process may have exited.
        }

        return new WindowInfo(processName, titleBuilder.ToString());
    }

    private static void ReadCommands()
    {
        string? line;
        while ((line = Console.ReadLine()) is not null)
        {
            try
            {
                using var document = JsonDocument.Parse(line);
                if (!document.RootElement.TryGetProperty("type", out var typeElement))
                {
                    continue;
                }

                var type = typeElement.GetString();
                switch (type)
                {
                    case "pause":
                        paused = true;
                        EmitLog("info", "Paused.");
                        break;
                    case "resume":
                        paused = false;
                        EmitLog("info", "Resumed.");
                        break;
                    case "reload-config":
                        EmitLog("info", "Reload config command received.");
                        break;
                    case "paste":
                        var hwnd = nint.Zero;
                        if (
                            document.RootElement.TryGetProperty("windowHandle", out var hwndElement) &&
                            long.TryParse(hwndElement.GetString(), out var parsedHwnd)
                        )
                        {
                            hwnd = new nint(parsedHwnd);
                        }
                        PasteToWindow(hwnd);
                        break;
                    case "get-foreground":
                        var requestId = "";
                        if (document.RootElement.TryGetProperty("requestId", out var requestIdElement))
                        {
                            requestId = requestIdElement.GetString() ?? "";
                        }
                        EmitForegroundSnapshot(requestId);
                        break;
                }
            }
            catch (Exception ex)
            {
                EmitLog("warn", $"Command failed: {ex.Message}");
            }
        }
    }

    private static void PasteToWindow(nint hwnd)
    {
        try
        {
            if (hwnd != nint.Zero)
            {
                FocusWindow(hwnd);
                Thread.Sleep(180);
            }

            if (!SendCtrlV())
            {
                Thread.Sleep(60);
                SendCtrlVLegacy();
            }
        }
        catch (Exception ex)
        {
            EmitLog("warn", $"Paste failed: {ex.Message}");
        }
    }

    private static void EmitForegroundSnapshot(string requestId)
    {
        var hwnd = GetForegroundWindow();
        var windowInfo = GetWindowInfo(hwnd);
        Emit(new
        {
            type = "foreground-snapshot",
            requestId,
            processName = windowInfo.ProcessName,
            windowTitle = windowInfo.WindowTitle,
            windowHandle = hwnd.ToString()
        });
    }

    private static void FocusWindow(nint hwnd)
    {
        if (IsIconic(hwnd))
        {
            ShowWindow(hwnd, SW_RESTORE);
        }

        var foreground = GetForegroundWindow();
        var currentThreadId = GetCurrentThreadId();
        var targetThreadId = GetWindowThreadProcessId(hwnd, out _);
        var foregroundThreadId = foreground == nint.Zero ? 0 : GetWindowThreadProcessId(foreground, out _);

        if (targetThreadId != currentThreadId)
        {
            AttachThreadInput(currentThreadId, targetThreadId, true);
        }

        if (foregroundThreadId != 0 && foregroundThreadId != currentThreadId)
        {
            AttachThreadInput(currentThreadId, foregroundThreadId, true);
        }

        BringWindowToTop(hwnd);
        SetWindowPos(hwnd, nint.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        SwitchToThisWindow(hwnd, true);
        SetForegroundWindow(hwnd);
        SetActiveWindow(hwnd);
        SetFocus(hwnd);

        if (targetThreadId != currentThreadId)
        {
            AttachThreadInput(currentThreadId, targetThreadId, false);
        }

        if (foregroundThreadId != 0 && foregroundThreadId != currentThreadId)
        {
            AttachThreadInput(currentThreadId, foregroundThreadId, false);
        }
    }

    private static bool SendCtrlV()
    {
        var inputs = new[]
        {
            KeyboardInput(VK_CONTROL, 0),
            KeyboardInput(VK_V, 0),
            KeyboardInput(VK_V, KEYEVENTF_KEYUP),
            KeyboardInput(VK_CONTROL, KEYEVENTF_KEYUP)
        };

        var sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
        if (sent != inputs.Length)
        {
            EmitLog(
                "warn",
                $"SendInput sent {sent}/{inputs.Length} events. error={Marshal.GetLastWin32Error()} size={Marshal.SizeOf<INPUT>()}"
            );
            return false;
        }

        return true;
    }

    private static void SendCtrlVLegacy()
    {
        keybd_event((byte)VK_CONTROL, 0, 0, nint.Zero);
        keybd_event((byte)VK_V, 0, 0, nint.Zero);
        keybd_event((byte)VK_V, 0, KEYEVENTF_KEYUP, nint.Zero);
        keybd_event((byte)VK_CONTROL, 0, KEYEVENTF_KEYUP, nint.Zero);
    }

    private static INPUT KeyboardInput(ushort keyCode, uint flags)
    {
        return new INPUT
        {
            type = INPUT_KEYBOARD,
            U = new InputUnion
            {
                ki = new KEYBDINPUT
                {
                    wVk = keyCode,
                    wScan = 0,
                    dwFlags = flags,
                    time = 0,
                    dwExtraInfo = nint.Zero
                }
            }
        };
    }

    private static void EmitLog(string level, string message)
    {
        Emit(new
        {
            type = "log",
            level,
            message
        });
    }

    private static void Emit<T>(T payload)
    {
        lock (JsonOptions)
        {
            Console.WriteLine(JsonSerializer.Serialize(payload, JsonOptions));
            Console.Out.Flush();
        }
    }

    private readonly record struct WindowInfo(string ProcessName, string WindowTitle);

    private delegate nint LowLevelMouseProc(int nCode, nint wParam, nint lParam);

    private delegate void WinEventDelegate(
        nint hWinEventHook,
        uint eventType,
        nint hwnd,
        int idObject,
        int idChild,
        uint idEventThread,
        uint dwmsEventTime
    );

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int left;
        public int top;
        public int right;
        public int bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct GUITHREADINFO
    {
        public int cbSize;
        public uint flags;
        public nint hwndActive;
        public nint hwndFocus;
        public nint hwndCapture;
        public nint hwndMenuOwner;
        public nint hwndMoveSize;
        public nint hwndCaret;
        public RECT rcCaret;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public nint dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public nint hwnd;
        public uint message;
        public nuint wParam;
        public nint lParam;
        public uint time;
        public POINT pt;
        public uint lPrivate;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)]
        public MOUSEINPUT mi;

        [FieldOffset(0)]
        public KEYBDINPUT ki;

        [FieldOffset(0)]
        public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public nint dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public nint dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, nint hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(nint hhk);

    [DllImport("user32.dll")]
    private static extern nint CallNextHookEx(nint hhk, int nCode, nint wParam, nint lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern nint GetModuleHandle(string? lpModuleName);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMessage(out MSG lpMsg, nint hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage([In] ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern nint DispatchMessage([In] ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(nint hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(nint hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(nint hWnd, out RECT lpRect);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(nint hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern nint SetWinEventHook(
        uint eventMin,
        uint eventMax,
        nint hmodWinEventProc,
        WinEventDelegate lpfnWinEventProc,
        uint idProcess,
        uint idThread,
        uint dwFlags
    );

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWinEvent(nint hWinEventHook);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(nint hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool BringWindowToTop(nint hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(
        nint hWnd,
        nint hWndInsertAfter,
        int x,
        int y,
        int cx,
        int cy,
        uint uFlags
    );

    [DllImport("user32.dll")]
    private static extern void SwitchToThisWindow(nint hWnd, bool fAltTab);

    [DllImport("user32.dll")]
    private static extern nint SetActiveWindow(nint hWnd);

    [DllImport("user32.dll")]
    private static extern nint SetFocus(nint hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(nint hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(nint hWnd, int nCmdShow);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, nint dwExtraInfo);
}
