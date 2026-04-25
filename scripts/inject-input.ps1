#requires -Version 5.1
<#
.SYNOPSIS
  Inject keystrokes into another console process via AttachConsole + WriteConsoleInputW.

.DESCRIPTION
  Detaches from current console, attaches to target PID's console, writes a sequence of
  KEY_EVENT INPUT_RECORDs (one keydown + one keyup per char), then detaches.

  No focus dependency, no SendInput, no UI. Works only when the target owns a real
  console (conhost/Windows Terminal). May not work for ConPTY-only hosted children.

.PARAMETER TargetPid
  PID of the target console process.

.PARAMETER Text
  Text to inject. Literal "\r" or actual CR (0x0D) is treated as Enter.

.PARAMETER UseVk
  Diagnostic: also fill VirtualKeyCode/ScanCode via VkKeyScan + MapVirtualKey.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][int]$TargetPid,
    [Parameter(Mandatory=$true)][string]$Text,
    [switch]$UseVk
)

$ErrorActionPreference = 'Stop'

# Normalize: literal "\r" -> CR. Also collapse \r\n / lone \n to CR (Windows console Enter).
$normalized = $Text -replace '\\r', "`r"
$normalized = $normalized -replace "`r`n", "`r"
$normalized = $normalized -replace "`n", "`r"

$typeDef = @'
using System;
using System.Runtime.InteropServices;

public static class ConIO {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool AttachConsole(uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern IntPtr GetConsoleWindow();

    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode, EntryPoint="CreateFileW")]
    public static extern IntPtr CreateFileW(
        [MarshalAs(UnmanagedType.LPWStr)] string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode, EntryPoint="WriteConsoleInputW")]
    public static extern bool WriteConsoleInputW(
        IntPtr hConsoleInput,
        [MarshalAs(UnmanagedType.LPArray), In] INPUT_RECORD[] lpBuffer,
        uint nLength,
        out uint lpNumberOfEventsWritten);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern short VkKeyScanW(char ch);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern uint MapVirtualKeyW(uint uCode, uint uMapType);

    public const int STD_INPUT_HANDLE = -10;
    public const ushort KEY_EVENT = 0x0001;
    public const uint MAPVK_VK_TO_VSC = 0;
    public const uint GENERIC_READ  = 0x80000000;
    public const uint GENERIC_WRITE = 0x40000000;
    public const uint FILE_SHARE_READ  = 0x1;
    public const uint FILE_SHARE_WRITE = 0x2;
    public const uint OPEN_EXISTING = 3;
    public static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    public struct KEY_EVENT_RECORD {
        [MarshalAs(UnmanagedType.Bool)] public bool bKeyDown;
        public ushort wRepeatCount;
        public ushort wVirtualKeyCode;
        public ushort wVirtualScanCode;
        public ushort UnicodeChar;
        public uint dwControlKeyState;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUT_RECORD {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
    }
}
'@

if (-not ('ConIO' -as [type])) {
    Add-Type -TypeDefinition $typeDef -Language CSharp
}

function Write-Err([string]$msg) {
    [Console]::Error.WriteLine($msg)
}

# Detach from any current console first (safe even if none attached).
[void][ConIO]::FreeConsole()

if (-not [ConIO]::AttachConsole([uint32]$TargetPid)) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Err "AttachConsole($TargetPid) failed. Win32 error=$err"
    exit 1
}

$hStdIn = [IntPtr]::Zero
try {
    # AttachConsole does NOT refresh the cached std handles. Open CONIN$ explicitly.
    $access = [uint32]([ConIO]::GENERIC_READ -bor [ConIO]::GENERIC_WRITE)
    $share  = [uint32]([ConIO]::FILE_SHARE_READ -bor [ConIO]::FILE_SHARE_WRITE)
    $hStdIn = [ConIO]::CreateFileW('CONIN$', $access, $share, [IntPtr]::Zero, [ConIO]::OPEN_EXISTING, 0, [IntPtr]::Zero)
    if ($hStdIn -eq [ConIO]::INVALID_HANDLE_VALUE -or $hStdIn -eq [IntPtr]::Zero) {
        $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Err "CreateFileW(CONIN$) returned invalid handle. Win32 error=$err"
        exit 1
    }

    $chars = $normalized.ToCharArray()
    if ($chars.Length -eq 0) {
        Write-Err "Empty text after normalization."
        exit 1
    }

    $records = New-Object 'ConIO+INPUT_RECORD[]' ($chars.Length * 2)
    for ($i = 0; $i -lt $chars.Length; $i++) {
        $vk = [uint16]0
        $sc = [uint16]0
        if ($UseVk) {
            $scan = [ConIO]::VkKeyScanW($chars[$i])
            if ($scan -ne -1) {
                $vk = [uint16]($scan -band 0xFF)
                $sc = [uint16]([ConIO]::MapVirtualKeyW([uint32]$vk, [ConIO]::MAPVK_VK_TO_VSC) -band 0xFFFF)
            }
            # Special-case CR -> VK_RETURN
            if ([int]$chars[$i] -eq 0x0D) {
                $vk = [uint16]0x0D
                $sc = [uint16]([ConIO]::MapVirtualKeyW([uint32]$vk, [ConIO]::MAPVK_VK_TO_VSC) -band 0xFFFF)
            }
        }

        $down = New-Object 'ConIO+INPUT_RECORD'
        $down.EventType = [ConIO]::KEY_EVENT
        $kd = New-Object 'ConIO+KEY_EVENT_RECORD'
        $kd.bKeyDown = $true
        $kd.wRepeatCount = 1
        $kd.wVirtualKeyCode = $vk
        $kd.wVirtualScanCode = $sc
        $kd.UnicodeChar = [uint16][int]$chars[$i]
        $kd.dwControlKeyState = 0
        $down.KeyEvent = $kd

        $up = New-Object 'ConIO+INPUT_RECORD'
        $up.EventType = [ConIO]::KEY_EVENT
        $ku = New-Object 'ConIO+KEY_EVENT_RECORD'
        $ku.bKeyDown = $false
        $ku.wRepeatCount = 1
        $ku.wVirtualKeyCode = $vk
        $ku.wVirtualScanCode = $sc
        $ku.UnicodeChar = [uint16][int]$chars[$i]
        $ku.dwControlKeyState = 0
        $up.KeyEvent = $ku

        $records[$i*2]   = $down
        $records[$i*2+1] = $up
    }

    [uint32]$written = 0
    $ok = [ConIO]::WriteConsoleInputW($hStdIn, $records, [uint32]$records.Length, [ref]$written)
    if (-not $ok) {
        $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Err "WriteConsoleInputW failed. Win32 error=$err written=$written expected=$($records.Length)"
        exit 1
    }
    if ($written -ne [uint32]$records.Length) {
        Write-Err "WriteConsoleInputW partial write: written=$written expected=$($records.Length)"
        exit 1
    }
}
finally {
    if ($hStdIn -ne [IntPtr]::Zero -and $hStdIn -ne [ConIO]::INVALID_HANDLE_VALUE) {
        [void][ConIO]::CloseHandle($hStdIn)
    }
    [void][ConIO]::FreeConsole()
}

exit 0
