// dsh-taskbar-helper.exe — DSH 任务栏提醒助手（常驻）
//
// 为什么需要它：DSH 桌面端的插件宿主进程以 ELECTRON_RUN_AS_NODE=1 跑在 Electron 主进程
// 的子进程里，拿不到 BrowserWindow，因此 flashFrame() / setOverlayIcon() 都用不了。
// 唯一可行的办法是在进程外对 Electron 的顶层窗口直接调 Win32:
//   - 闪烁: user32!FlashWindowEx(FLASHW_ALL | FLASHW_TIMERNOFG)
//   - 角标: ITaskbarList3::SetOverlayIcon
// 角标的 HICON 必须由「仍然存活」的进程持有，一次性进程退出后角标会消失，
// 所以这个助手是常驻的，通过 stdin 收命令。
//
// 用法: dsh-taskbar-helper.exe <pid> [<pid> ...]
// stdin 命令（一行一条）:
//   flash            开始闪烁（由看护线程每 900ms 重新上发条，持续到窗口进入前台）
//   stopflash        停止闪烁
//   badge <ico路径>   设置任务栏角标（持续到窗口进入前台）
//   badgeclear       清除角标
//   badgemin <ms>    角标最短展示时长
//   ping             回复 PONG
//   quit             退出
// stdout 事件（一行一条）:
//   READY <hwnd> / WINDOW <hwnd> / FLASHING / FLASHSTOPPED / BADGED / BADGECLEARED
//   FOCUS <hwnd>（窗口回到前台，角标已清）/ PONG / ERR <文本>
//
// 编译: csc.exe /target:winexe /optimize+ /out:dsh-taskbar-helper.exe TaskbarNotify.cs

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class TaskbarNotify
{
    // ---------------------------------------------------------------- Win32
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadImageW(IntPtr hinst, string lpszName, uint uType,
                                            int cxDesired, int cyDesired, uint fuLoad);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr hIcon);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetSystemMetrics(int nIndex);

    [StructLayout(LayoutKind.Sequential)]
    private struct FLASHWINFO
    {
        public uint cbSize;
        public IntPtr hwnd;
        public uint dwFlags;
        public uint uCount;
        public uint dwTimeout;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

    private const uint GW_OWNER = 4;
    private const uint IMAGE_ICON = 1;
    private const uint LR_LOADFROMFILE = 0x0010;
    private const uint SM_CXSMICON = 49;

    private const uint FLASHW_STOP = 0;
    private const uint FLASHW_CAPTION = 1;
    private const uint FLASHW_TRAY = 2;
    private const uint FLASHW_ALL = 3;
    private const uint FLASHW_TIMERNOFG = 12;

    // ------------------------------------------------------- ITaskbarList3
    [ComImport, Guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ITaskbarList3
    {
        void HrInit();
        void AddTab(IntPtr hwnd);
        void DeleteTab(IntPtr hwnd);
        void ActivateTab(IntPtr hwnd);
        void SetActiveAlt(IntPtr hwnd);
        void MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool fFullscreen);
        void SetProgressValue(IntPtr hwnd, ulong ullCompleted, ulong ullTotal);
        void SetProgressState(IntPtr hwnd, int tbpFlags);
        void RegisterTab(IntPtr hwndTab, IntPtr hwndMDI);
        void UnregisterTab(IntPtr hwndTab);
        void SetTabOrder(IntPtr hwndTab, IntPtr hwndInsertBefore);
        void SetTabActive(IntPtr hwndTab, IntPtr hwndMDI, uint dwReserved);
        void ThumbBarAddButtons(IntPtr hwnd, uint cButtons, IntPtr pButton);
        void ThumbBarUpdateButtons(IntPtr hwnd, uint cButtons, IntPtr pButton);
        void ThumbBarSetImageList(IntPtr hwnd, IntPtr himl);
        void SetOverlayIcon(IntPtr hwnd, IntPtr hIcon,
                            [MarshalAs(UnmanagedType.LPWStr)] string pszDescription);
        void SetThumbnailTooltip(IntPtr hwnd, [MarshalAs(UnmanagedType.LPWStr)] string pszTip);
        void SetThumbnailClip(IntPtr hwnd, IntPtr prcClip);
    }

    [ComImport, Guid("56FDF344-FD6D-11D0-958A-006097C9A090"),
     ClassInterface(ClassInterfaceType.None)]
    private class TaskbarListClass { }

    // ------------------------------------------------------------- state
    private static readonly HashSet<uint> Pids = new HashSet<uint>();
    private static ITaskbarList3 _tbl;
    private static IntPtr _hwnd = IntPtr.Zero;
    private static IntPtr _icon = IntPtr.Zero;
    private static volatile bool _badged;
    // 「希望一直闪」的意图位：不靠 FlashWindowEx 自己维持，而是由看护线程每 900ms 重新上发条，
    // 这样即使系统把闪烁停掉（Win11 有时会在若干次后停），也会一直闪到窗口进前台为止。
    private static volatile bool _flashing;
    // 角标至少"露脸"这么久再允许自动清除：通知发出时用户本来就盯着窗口的话，
    // 否则角标会在 400ms 内一闪而过，等于没提示。
    private static volatile int _badgeMinMs = 1200;
    private static long _badgedAtTicks;
    private static long _lastArmTicks;
    // 发通知的瞬间窗口是否已经是前台。是的话角标要等满 _badgeMinMs 再清；
    // 不是的话（用户离开了）一回到前台就立刻清。
    private static volatile bool _wasForegroundAtNotify;
    private static readonly object Gate = new object();

    private static void Say(string s)
    {
        try
        {
            Console.Out.WriteLine(s);
            Console.Out.Flush();
        }
        catch { }
    }

    private static string ClassOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassNameW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    private static string TitleOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(512);
        GetWindowTextW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    private static bool MatchPids(IntPtr h)
    {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        return Pids.Contains(pid);
    }

    /// 找到 DSH 的顶层窗口。优先 PID 精确匹配；找不到时按
    /// 「可见 + 无 owner + Chrome_WidgetWin_1 + 有标题 + 进程名是 DeepSeek Harness」兜底。
    private static IntPtr FindWindow()
    {
        IntPtr best = IntPtr.Zero;

        // pass 1: pid + class
        EnumWindows(delegate(IntPtr h, IntPtr lp)
        {
            if (best != IntPtr.Zero) return true;
            if (!IsWindowVisible(h)) return true;
            if (GetWindow(h, GW_OWNER) != IntPtr.Zero) return true;
            if (!MatchPids(h)) return true;
            if (ClassOf(h) != "Chrome_WidgetWin_1") return true;
            if (TitleOf(h).Length == 0) return true;
            best = h;
            return false;
        }, IntPtr.Zero);
        if (best != IntPtr.Zero) return best;

        // pass 2: pid only
        EnumWindows(delegate(IntPtr h, IntPtr lp)
        {
            if (best != IntPtr.Zero) return true;
            if (!IsWindowVisible(h)) return true;
            if (GetWindow(h, GW_OWNER) != IntPtr.Zero) return true;
            if (!MatchPids(h)) return true;
            if (TitleOf(h).Length == 0) return true;
            best = h;
            return false;
        }, IntPtr.Zero);
        if (best != IntPtr.Zero) return best;

        // pass 3: 进程名兜底（宿主进程的 ppid 可能不是 Electron 主进程）
        EnumWindows(delegate(IntPtr h, IntPtr lp)
        {
            if (best != IntPtr.Zero) return true;
            if (!IsWindowVisible(h)) return true;
            if (GetWindow(h, GW_OWNER) != IntPtr.Zero) return true;
            if (ClassOf(h) != "Chrome_WidgetWin_1") return true;
            if (TitleOf(h).Length == 0) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            try
            {
                Process p = Process.GetProcessById((int)pid);
                string n = p.ProcessName;
                if (n == "DeepSeek Harness" || n == "DeepSeek")
                {
                    best = h;
                    return false;
                }
            }
            catch { }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    private static IntPtr Hwnd()
    {
        if (_hwnd != IntPtr.Zero && IsWindow(_hwnd)) return _hwnd;
        _hwnd = FindWindow();
        if (_hwnd != IntPtr.Zero) Say("WINDOW " + _hwnd.ToInt64());
        return _hwnd;
    }

    private static ITaskbarList3 Tbl()
    {
        if (_tbl == null)
        {
            try
            {
                _tbl = (ITaskbarList3)new TaskbarListClass();
                _tbl.HrInit();
            }
            catch (Exception e)
            {
                Say("ERR itaskbarlist3 " + e.Message);
                _tbl = null;
            }
        }
        return _tbl;
    }

    private static void DoFlash(uint flags, uint count)
    {
        IntPtr h = Hwnd();
        if (h == IntPtr.Zero) { Say("ERR no-window"); return; }
        FLASHWINFO fi = new FLASHWINFO();
        fi.cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO));
        fi.hwnd = h;
        fi.dwFlags = flags;
        fi.uCount = count;
        fi.dwTimeout = 0;
        FlashWindowEx(ref fi);
    }

    private static void DoBadge(string icoPath)
    {
        IntPtr h = Hwnd();
        if (h == IntPtr.Zero) { Say("ERR no-window"); return; }
        ITaskbarList3 t = Tbl();
        if (t == null) return;

        IntPtr old = _icon;
        IntPtr ico = IntPtr.Zero;
        if (icoPath != null && icoPath.Length > 0)
        {
            int cx = GetSystemMetrics((int)SM_CXSMICON);
            ico = LoadImageW(IntPtr.Zero, icoPath, IMAGE_ICON, cx, cx, LR_LOADFROMFILE);
            if (ico == IntPtr.Zero)
            {
                Say("ERR loadicon " + Marshal.GetLastWin32Error() + " " + icoPath);
                return;
            }
        }
        try
        {
            t.SetOverlayIcon(h, ico, ico != IntPtr.Zero ? "DSH 任务完成" : "");
        }
        catch (Exception e)
        {
            Say("ERR overlay " + e.Message);
            if (ico != IntPtr.Zero) DestroyIcon(ico);
            return;
        }
        _icon = ico;
        if (old != IntPtr.Zero) DestroyIcon(old);
        _badged = ico != IntPtr.Zero;
        if (_badged)
        {
            _badgedAtTicks = DateTime.UtcNow.Ticks;
            _wasForegroundAtNotify = IsForeground(Hwnd());
        }
        Say(_badged ? "BADGED" : "BADGECLEARED");
    }

    private static bool IsForeground(IntPtr h)
    {
        return h != IntPtr.Zero && GetForegroundWindow() == h;
    }

    private static void ClearAll()
    {
        if (_flashing) { DoFlash(FLASHW_STOP, 0); _flashing = false; }
        if (_badged) { DoBadge(null); }
        lock (Gate) { }
    }

    /// 看护线程：①每 900ms 重新给闪烁上发条，保证「一直闪」；
    /// ②窗口**持续**回到前台 → 停闪 + 清除角标（用户已经回来看窗口了）。
    /// 之所以要求「持续」（连续 4 次 × 400ms），是因为焦点会瞬时抖一下
    /// （切窗口动画、后台进程抢焦点），一抖就把提醒抹掉等于没提醒。
    private static void WatchForeground()
    {
        int fgStreak = 0;
        while (true)
        {
            Thread.Sleep(400);
            try
            {
                if (!_badged && !_flashing) { fgStreak = 0; continue; }
                IntPtr h = _hwnd;
                if (h == IntPtr.Zero || !IsWindow(h)) { fgStreak = 0; continue; }

                if (GetForegroundWindow() == h) fgStreak++;
                else fgStreak = 0;
                bool back = fgStreak >= 4;

                if (_flashing)
                {
                    if (back)
                    {
                        DoFlash(FLASHW_STOP, 0);
                        _flashing = false;
                        Say("FLASHSTOPPED");
                    }
                    else
                    {
                        long since = (DateTime.UtcNow.Ticks - _lastArmTicks) / TimeSpan.TicksPerMillisecond;
                        if (since >= 900)
                        {
                            _lastArmTicks = DateTime.UtcNow.Ticks;
                            DoFlash(FLASHW_ALL | FLASHW_TIMERNOFG, 0);
                        }
                    }
                }

                if (_badged && back)
                {
                    long age = (DateTime.UtcNow.Ticks - _badgedAtTicks) / TimeSpan.TicksPerMillisecond;
                    if (_wasForegroundAtNotify || age >= _badgeMinMs)
                    {
                        Say("FOCUS " + h.ToInt64());
                        DoBadge(null);
                        fgStreak = 0;
                    }
                }
            }
            catch { }
        }
    }

    private static int Main(string[] args)
    {
        foreach (string a in args)
        {
            uint pid;
            if (uint.TryParse(a, out pid)) Pids.Add(pid);
        }
        Say("START pids=" + Pids.Count);

        IntPtr h = Hwnd();
        Say("READY " + (h == IntPtr.Zero ? 0 : h.ToInt64()));

        Thread watcher = new Thread(WatchForeground);
        watcher.IsBackground = true;
        watcher.Start();

        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            int sp = line.IndexOf(' ');
            string cmd = sp < 0 ? line : line.Substring(0, sp);
            string arg = sp < 0 ? "" : line.Substring(sp + 1).Trim();

            switch (cmd.ToLowerInvariant())
            {
                case "ping":
                    Say("PONG");
                    break;
                case "flash":
                    _flashing = true;
                    _lastArmTicks = 0;
                    DoFlash(FLASHW_ALL | FLASHW_TIMERNOFG, 0);
                    _lastArmTicks = DateTime.UtcNow.Ticks;
                    Say("FLASHING");
                    break;
                case "stopflash":
                    DoFlash(FLASHW_STOP, 0);
                    _flashing = false;
                    Say("FLASHSTOPPED");
                    break;
                case "badge":
                    DoBadge(arg);
                    break;
                case "badgeclear":
                    DoBadge(null);
                    break;
                case "badgemin":
                    {
                        int ms;
                        if (int.TryParse(arg, out ms)) _badgeMinMs = Math.Max(0, ms);
                        Say("BADGEMIN " + _badgeMinMs);
                    }
                    break;
                case "focus":
                    // 由渲染端脚本（window.focus / visibilitychange）显式报告的「用户回到窗口」，
                    // 这是最可靠的信号，立刻清干净。
                    Say("FOCUS explicit");
                    ClearAll();
                    break;
                case "hwnd":
                    Say("HWND " + Hwnd().ToInt64());
                    break;
                case "quit":
                    ClearAll();
                    Say("BYE");
                    return 0;
                default:
                    Say("ERR unknown-cmd " + cmd);
                    break;
            }
        }
        ClearAll();
        return 0;
    }
}