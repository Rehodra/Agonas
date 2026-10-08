Add-Type -AssemblyName System.Drawing

$sizes = @(16, 32, 48, 128)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# When this file lives inside extension/, the icons/ folder is right next to it
$outDir = Join-Path $scriptDir "icons"

if (-not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

$rawPoints = @(
    @(72.0, 8.0),
    @(36.0, 72.0),
    @(60.0, 72.0),
    @(56.0, 120.0),
    @(92.0, 56.0),
    @(68.0, 56.0)
)

$bgColor = [System.Drawing.Color]::FromArgb(255, 13, 17, 23)
$boltColor = [System.Drawing.Color]::FromArgb(255, 88, 166, 255)

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear($bgColor)

    $points = New-Object "System.Drawing.PointF[]" ($rawPoints.Count)
    for ($i = 0; $i -lt $rawPoints.Count; $i++) {
        $pt = $rawPoints[$i]
        $x = [float](($pt[0] / 128.0) * $size)
        $y = [float](($pt[1] / 128.0) * $size)
        $points[$i] = New-Object System.Drawing.PointF($x, $y)
    }

    $brush = New-Object System.Drawing.SolidBrush($boltColor)
    $g.FillPolygon($brush, $points)

    $outPath = Join-Path $outDir "icon$size.png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)

    $brush.Dispose()
    $g.Dispose()
    $bmp.Dispose()
    Write-Host "Created: $outPath ($size x $size)"
}
