# Inspect native top-level windows belonging to one known desktop test process.
# This script never activates, closes, resizes, or clicks a window.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int] $ProcessId
)

$ErrorActionPreference = 'Stop'
$desktopProcess = Get-Process -Id $ProcessId -ErrorAction Stop

if (-not ('HeimdallDesktopWindowProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class HeimdallDesktopWindowProbe
{
    private const int GWL_STYLE = -16;
    private const int GWL_EXSTYLE = -20;
    private const uint GW_OWNER = 4;
    private const uint WM_GETICON = 0x007F;
    private const uint SMTO_ABORTIFHUNG = 0x0002;
    private const uint WS_CAPTION = 0x00C00000;
    private const uint WS_THICKFRAME = 0x00040000;
    private const uint WS_SYSMENU = 0x00080000;
    private const uint WS_MINIMIZEBOX = 0x00020000;
    private const uint WS_MAXIMIZEBOX = 0x00010000;
    private const uint WS_CHILD = 0x40000000;
    private const uint WS_EX_TOOLWINDOW = 0x00000080;
    private const uint WS_EX_APPWINDOW = 0x00040000;
    private const uint WS_EX_NOACTIVATE = 0x08000000;

    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X, Y; }

    public sealed class Insets
    {
        public int Left, Top, Right, Bottom;
    }

    public sealed class Window
    {
        public string Handle, Title, ClassName, OwnerHandle;
        public uint ProcessId, ThreadId;
        public bool Visible, Minimized, Maximized;
        public string Style, ExtendedStyle;
        public bool Caption, ThickFrame, SystemMenu, MinimizeBox, MaximizeBox;
        public bool ToolWindow, AppWindow, NoActivate;
        public int? Cloaked;
        public bool TaskbarEligibleByStyle;
        public Rect WindowRect, ClientRect, ClientScreenRect;
        public Rect? ExtendedFrameRect;
        public Insets NonClientInsets;
        public uint? Dpi;
        public string SmallIcon, LargeIcon, Small2Icon, ClassSmallIcon, ClassLargeIcon;
    }

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr state);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    private static extern int GetWindowLong32(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLong64(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "GetClassLongW")]
    private static extern uint GetClassLong32(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "GetClassLongPtrW")]
    private static extern IntPtr GetClassLong64(IntPtr hwnd, int index);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")]
    private static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll")]
    private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message,
        IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    private static extern int GetCloaked(IntPtr hwnd, int attribute, out int value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    private static extern int GetFrameRect(IntPtr hwnd, int attribute, out Rect value, int size);

    private static string Handle(IntPtr value)
    {
        return value == IntPtr.Zero ? null : "0x" + value.ToInt64().ToString("X");
    }

    private static uint Style(IntPtr hwnd, int index)
    {
        return IntPtr.Size == 8
            ? unchecked((uint)GetWindowLong64(hwnd, index).ToInt64())
            : unchecked((uint)GetWindowLong32(hwnd, index));
    }

    private static string ClassIcon(IntPtr hwnd, int index)
    {
        return IntPtr.Size == 8 ? Handle(GetClassLong64(hwnd, index))
            : Handle(new IntPtr(unchecked((long)GetClassLong32(hwnd, index))));
    }

    private static string Icon(IntPtr hwnd, int size)
    {
        UIntPtr result;
        if (SendMessageTimeout(hwnd, WM_GETICON, new IntPtr(size), IntPtr.Zero,
            SMTO_ABORTIFHUNG, 100, out result) == IntPtr.Zero) return null;
        return result == UIntPtr.Zero ? null : "0x" + result.ToUInt64().ToString("X");
    }

    public static Window[] Inspect(uint expectedProcessId)
    {
        List<Window> windows = new List<Window>();
        IntPtr previousDpi = IntPtr.Zero;
        try
        {
            // Change only the probe thread, so coordinates are physical pixels.
            try { previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4)); }
            catch (EntryPointNotFoundException) { }
            EnumWindowsProc callback = delegate(IntPtr hwnd, IntPtr state)
            {
                uint processId;
                uint threadId = GetWindowThreadProcessId(hwnd, out processId);
                // Never fetch titles, styles, or icons of another process.
                if (processId != expectedProcessId) return true;

                StringBuilder title = new StringBuilder(4096);
                StringBuilder className = new StringBuilder(256);
                GetWindowText(hwnd, title, title.Capacity);
                GetClassName(hwnd, className, className.Capacity);
                uint style = Style(hwnd, GWL_STYLE);
                uint extendedStyle = Style(hwnd, GWL_EXSTYLE);
                IntPtr owner = GetWindow(hwnd, GW_OWNER);
                Rect windowRect, clientRect;
                if (!GetWindowRect(hwnd, out windowRect) || !GetClientRect(hwnd, out clientRect))
                    return true; // The process may destroy a window during inspection.
                Point clientStart = new Point { X = clientRect.Left, Y = clientRect.Top };
                Point clientEnd = new Point { X = clientRect.Right, Y = clientRect.Bottom };
                if (!ClientToScreen(hwnd, ref clientStart) || !ClientToScreen(hwnd, ref clientEnd))
                    return true;
                int cloaked;
                int? cloakedValue = GetCloaked(hwnd, 14, out cloaked, sizeof(int)) == 0
                    ? (int?)cloaked : null;
                Rect frameRect;
                Rect? frameValue = GetFrameRect(hwnd, 9, out frameRect,
                    Marshal.SizeOf(typeof(Rect))) == 0 ? (Rect?)frameRect : null;
                uint? dpi = null;
                try { dpi = GetDpiForWindow(hwnd); }
                catch (EntryPointNotFoundException) { }
                bool visible = IsWindowVisible(hwnd);
                bool toolWindow = (extendedStyle & WS_EX_TOOLWINDOW) != 0;
                bool appWindow = (extendedStyle & WS_EX_APPWINDOW) != 0;
                bool noActivate = (extendedStyle & WS_EX_NOACTIVATE) != 0;
                windows.Add(new Window {
                    Handle = Handle(hwnd), Title = title.ToString(), ClassName = className.ToString(),
                    OwnerHandle = Handle(owner), ProcessId = processId, ThreadId = threadId,
                    Visible = visible, Minimized = IsIconic(hwnd), Maximized = IsZoomed(hwnd),
                    Style = "0x" + style.ToString("X8"),
                    ExtendedStyle = "0x" + extendedStyle.ToString("X8"),
                    Caption = (style & WS_CAPTION) == WS_CAPTION,
                    ThickFrame = (style & WS_THICKFRAME) != 0,
                    SystemMenu = (style & WS_SYSMENU) != 0,
                    MinimizeBox = (style & WS_MINIMIZEBOX) != 0,
                    MaximizeBox = (style & WS_MAXIMIZEBOX) != 0,
                    ToolWindow = toolWindow, AppWindow = appWindow, NoActivate = noActivate,
                    Cloaked = cloakedValue,
                    // A useful heuristic; Explorer also keeps independent taskbar state.
                    TaskbarEligibleByStyle = visible && (style & WS_CHILD) == 0 &&
                        cloakedValue.GetValueOrDefault() == 0 && !toolWindow &&
                        (appWindow || (owner == IntPtr.Zero && !noActivate)),
                    WindowRect = windowRect, ClientRect = clientRect,
                    ClientScreenRect = new Rect { Left = clientStart.X, Top = clientStart.Y,
                        Right = clientEnd.X, Bottom = clientEnd.Y },
                    ExtendedFrameRect = frameValue,
                    NonClientInsets = new Insets {
                        Left = clientStart.X - windowRect.Left,
                        Top = clientStart.Y - windowRect.Top,
                        Right = windowRect.Right - clientEnd.X,
                        Bottom = windowRect.Bottom - clientEnd.Y },
                    Dpi = dpi, SmallIcon = Icon(hwnd, 0), LargeIcon = Icon(hwnd, 1),
                    Small2Icon = Icon(hwnd, 2), ClassSmallIcon = ClassIcon(hwnd, -34),
                    ClassLargeIcon = ClassIcon(hwnd, -14)
                });
                return true;
            };
            if (!EnumWindows(callback, IntPtr.Zero))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            GC.KeepAlive(callback);
        }
        finally
        {
            if (previousDpi != IntPtr.Zero) SetThreadDpiAwarenessContext(previousDpi);
        }
        return windows.ToArray();
    }
}
'@
}

$desktopWindows = @([HeimdallDesktopWindowProbe]::Inspect([uint32] $ProcessId))
[ordered]@{
    CheckedAt = [DateTime]::UtcNow.ToString('o')
    ProcessId = $ProcessId
    ProcessName = $desktopProcess.ProcessName
    WindowCount = $desktopWindows.Count
    VisibleWindowCount = @($desktopWindows | Where-Object { $_.Visible }).Count
    TaskbarEligibleWindowCount = @($desktopWindows | Where-Object { $_.TaskbarEligibleByStyle }).Count
    TaskbarEligibilityNote = 'Inferred from visibility, ownership, styles, and DWM cloaking; Explorer may keep separate state.'
    Windows = $desktopWindows
} | ConvertTo-Json -Depth 6
