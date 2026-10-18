param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$Icon
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# This script runs only while packaging. The application does not load Win32 FFI.
$executablePath = (Resolve-Path -LiteralPath $Executable).ProviderPath
$iconPath = (Resolve-Path -LiteralPath $Icon).ProviderPath
$executableFile = Get-Item -LiteralPath $executablePath
if ($executableFile.PSIsContainer -or $executableFile.Extension -ine '.exe' -or
    ($executableFile.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'The icon target must be a regular packaged .exe file.'
}

$iconBytes = [System.IO.File]::ReadAllBytes($iconPath)
if ($iconBytes.Length -lt 22 -or $iconBytes.Length -gt 67108864 -or
    [BitConverter]::ToUInt16($iconBytes, 0) -ne 0 -or
    [BitConverter]::ToUInt16($iconBytes, 2) -ne 1) {
    throw 'Invalid ICO header.'
}
$count = [BitConverter]::ToUInt16($iconBytes, 4)
$directoryLength = 6 + 16 * $count
if ($count -lt 1 -or $count -gt 256 -or $directoryLength -gt $iconBytes.Length) {
    throw 'Invalid ICO image directory.'
}
$images = [System.Collections.Generic.List[byte[]]]::new()
$ranges = [System.Collections.Generic.List[object]]::new()
$group = [byte[]]::new(6 + 14 * $count)
[Array]::Copy($iconBytes, 0, $group, 0, 6)
for ($index = 0; $index -lt $count; $index++) {
    $entry = 6 + 16 * $index
    $imageLength = [BitConverter]::ToUInt32($iconBytes, $entry + 8)
    $imageOffset = [BitConverter]::ToUInt32($iconBytes, $entry + 12)
    $imageEnd = [uint64]$imageOffset + [uint64]$imageLength
    if ($iconBytes[$entry + 3] -ne 0 -or $imageLength -lt 12 -or
        $imageOffset -lt $directoryLength -or $imageEnd -gt $iconBytes.Length) {
        throw "Invalid ICO image bounds at entry $index."
    }
    foreach ($range in $ranges) {
        if ($imageOffset -lt $range.End -and $imageEnd -gt $range.Start) {
            throw 'Overlapping ICO images are not supported.'
        }
    }
    $ranges.Add(@{ Start = $imageOffset; End = $imageEnd })
    $width = if ($iconBytes[$entry] -eq 0) { 256 } else { $iconBytes[$entry] }
    $height = if ($iconBytes[$entry + 1] -eq 0) { 256 } else { $iconBytes[$entry + 1] }
    $imageBytes = [byte[]]::new($imageLength)
    [Array]::Copy($iconBytes, $imageOffset, $imageBytes, 0, $imageLength)
    $isPng = [BitConverter]::ToString($imageBytes, 0, 8) -eq '89-50-4E-47-0D-0A-1A-0A'
    if ($isPng) {
        if ($imageLength -lt 33 -or
            [BitConverter]::ToString($imageBytes, 8, 8) -ne '00-00-00-0D-49-48-44-52') {
            throw 'Invalid ICO PNG header.'
        }
        $pngWidth = [uint32]$imageBytes[16] * 16777216 +
            [uint32]$imageBytes[17] * 65536 + [uint32]$imageBytes[18] * 256 + $imageBytes[19]
        $pngHeight = [uint32]$imageBytes[20] * 16777216 +
            [uint32]$imageBytes[21] * 65536 + [uint32]$imageBytes[22] * 256 + $imageBytes[23]
        if ($pngWidth -ne $width -or $pngHeight -ne $height) {
            throw 'ICO PNG dimensions do not match the image directory.'
        }
    } else {
        $dibHeader = [BitConverter]::ToUInt32($imageBytes, 0)
        if ($dibHeader -lt 40 -or $dibHeader -gt $imageLength -or
            [BitConverter]::ToInt32($imageBytes, 4) -ne $width -or
            [Math]::Abs([int64][BitConverter]::ToInt32($imageBytes, 8)) -ne 2 * $height) {
            throw 'Unsupported or invalid ICO bitmap header.'
        }
    }
    $images.Add($imageBytes)
    $groupEntry = 6 + 14 * $index
    [Array]::Copy($iconBytes, $entry, $group, $groupEntry, 12)
    [Array]::Copy([BitConverter]::GetBytes([uint16]($index + 1)), 0, $group, $groupEntry + 12, 2)
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class HeimdallIconResources {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr BeginUpdateResourceW(string file, bool deleteExisting);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool UpdateResourceW(IntPtr update, IntPtr type, IntPtr name,
        ushort language, byte[] bytes, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool EndUpdateResourceW(IntPtr update, bool discard);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr LoadLibraryExW(string file, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr FindResourceExW(IntPtr module, IntPtr type, IntPtr name, ushort language);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SizeofResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr LockResource(IntPtr resource);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeLibrary(IntPtr module);
}
'@

function Assert-ResourceBytes([IntPtr]$Module, [int]$Type, [int]$Id, [byte[]]$Expected) {
    $resource = [HeimdallIconResources]::FindResourceExW($Module, [IntPtr]$Type, [IntPtr]$Id, 0)
    if ($resource -eq [IntPtr]::Zero -or
        [HeimdallIconResources]::SizeofResource($Module, $resource) -ne $Expected.Length) {
        throw "Icon resource $Type/$Id failed verification."
    }
    $loaded = [HeimdallIconResources]::LoadResource($Module, $resource)
    $pointer = [HeimdallIconResources]::LockResource($loaded)
    if ($pointer -eq [IntPtr]::Zero) { throw 'Cannot read the updated icon resource.' }
    $actual = [byte[]]::new($Expected.Length)
    [System.Runtime.InteropServices.Marshal]::Copy($pointer, $actual, 0, $actual.Length)
    if ([Convert]::ToBase64String($actual) -cne [Convert]::ToBase64String($Expected)) {
        throw "Icon resource $Type/$Id differs from the source artwork."
    }
}

$artifactDirectory = [System.IO.Path]::GetDirectoryName($executablePath)
$temporaryPath = [System.IO.Path]::Combine($artifactDirectory, '.heimdall-icon-' + [Guid]::NewGuid().ToString('N') + '.exe')
if ([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($temporaryPath)) -cne $artifactDirectory) {
    throw 'The icon staging file must stay in the executable directory.'
}
$update = [IntPtr]::Zero
$module = [IntPtr]::Zero
try {
    [System.IO.File]::Copy($executablePath, $temporaryPath, $false)
    $update = [HeimdallIconResources]::BeginUpdateResourceW($temporaryPath, $false)
    if ($update -eq [IntPtr]::Zero) {
        throw [System.ComponentModel.Win32Exception]::new([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
    for ($index = 0; $index -lt $images.Count; $index++) {
        if (-not [HeimdallIconResources]::UpdateResourceW($update, [IntPtr]3,
                [IntPtr]($index + 1), 0, $images[$index], $images[$index].Length)) {
            throw [System.ComponentModel.Win32Exception]::new([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
        }
    }
    # Group 1 is the first numbered icon extracted by the Windows Shell. The
    # laufey launcher has no application-specific group ID or HWND icon loader.
    if (-not [HeimdallIconResources]::UpdateResourceW($update, [IntPtr]14,
            [IntPtr]1, 0, $group, $group.Length)) {
        throw [System.ComponentModel.Win32Exception]::new([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
    $committing = $update
    $update = [IntPtr]::Zero
    if (-not [HeimdallIconResources]::EndUpdateResourceW($committing, $false)) {
        throw [System.ComponentModel.Win32Exception]::new([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
    # DATAFILE | IMAGE_RESOURCE reads PE resources without running the executable.
    $module = [HeimdallIconResources]::LoadLibraryExW($temporaryPath, [IntPtr]::Zero, 0x22)
    if ($module -eq [IntPtr]::Zero) { throw 'Cannot inspect the updated executable resources.' }
    Assert-ResourceBytes $module 14 1 $group
    for ($index = 0; $index -lt $images.Count; $index++) {
        Assert-ResourceBytes $module 3 ($index + 1) $images[$index]
    }
    [void][HeimdallIconResources]::FreeLibrary($module)
    $module = [IntPtr]::Zero
    # Both paths were resolved above and share the explicitly selected artifact
    # directory. Replace only the completed launcher after all checks pass.
    [System.IO.File]::Replace($temporaryPath, $executablePath, [NullString]::Value)
    Write-Output "Embedded and verified $count application icon image(s): $executablePath"
} finally {
    if ($module -ne [IntPtr]::Zero) { [void][HeimdallIconResources]::FreeLibrary($module) }
    if ($update -ne [IntPtr]::Zero) { [void][HeimdallIconResources]::EndUpdateResourceW($update, $true) }
    if (Test-Path -LiteralPath $temporaryPath) {
        Remove-Item -LiteralPath $temporaryPath -Force
    }
}
