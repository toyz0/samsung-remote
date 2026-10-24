<#
.SYNOPSIS
    Find TVs / cast devices on the local subnet and report brand + model.

.DESCRIPTION
    ARP-sweep the /24, TCP-probe the TV service ports, then ask each hit for its
    device info: Samsung Tizen via http://IP:8001/api/v2/, Google Cast via
    http://IP:8008/setup/eureka_info.

.EXAMPLE
    .\scan-tv.ps1
    .\scan-tv.ps1 -Subnet 192.168.1
    .\scan-tv.ps1 -SelfTest
#>
[CmdletBinding()]
param(
    # First three octets, e.g. 192.168.1. Defaults to the subnet of the active adapter.
    [string]$Subnet,
    [int]$ProbeTimeoutMs = 400,
    [int]$HttpTimeoutSec = 6,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

# 8001/8002 Samsung remote API, 9197 Samsung DLNA, 8008/8009 Google Cast,
# 6466 Android TV remote v2, 8060 Roku, 3000/3001/9741 LG webOS, 1925 Philips, 55000 Samsung legacy.
$TvPorts = 8001, 8002, 9197, 8008, 8009, 6466, 8060, 3000, 3001, 9741, 1925, 55000

function Get-LocalSubnet {
    $a = Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
        Sort-Object -Property SkipAsSource, InterfaceMetric |
        Select-Object -First 1
    if (-not $a) { throw 'No routable IPv4 address found; pass -Subnet.' }
    ($a.IPAddress -split '\.')[0..2] -join '.'
}

function Invoke-PingSweep {
    param([string]$Subnet)
    # Fire all 254 pings at once; we only care that ARP gets populated.
    $jobs = 1..254 | ForEach-Object {
        Start-Process -FilePath ping.exe -ArgumentList "-n 1 -w 300 $Subnet.$_" `
            -WindowStyle Hidden -PassThru
    }
    $jobs | Wait-Process -Timeout 20 -ErrorAction SilentlyContinue
    $jobs | Where-Object { -not $_.HasExited } | Stop-Process -Force -ErrorAction SilentlyContinue
}

function Get-ArpHosts {
    param([string]$Subnet)
    arp.exe -a | Select-String -Pattern "^\s+($([regex]::Escape($Subnet))\.\d+)\s+([0-9a-f-]{17})\s+dynamic" |
        ForEach-Object {
            [pscustomobject]@{
                IP  = $_.Matches[0].Groups[1].Value
                MAC = $_.Matches[0].Groups[2].Value
            }
        } | Sort-Object { [int]($_.IP -split '\.')[3] }
}

function Test-TvPorts {
    param([string]$IP, [int]$TimeoutMs)
    $open = foreach ($p in $TvPorts) {
        $c = New-Object Net.Sockets.TcpClient
        try { if ($c.ConnectAsync($IP, $p).Wait($TimeoutMs)) { $p } } catch { }
        finally { $c.Dispose() }
    }
    @($open)
}

function Get-Json {
    param([string]$Url, [int]$TimeoutSec)
    try {
        (Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSec -UseBasicParsing).Content | ConvertFrom-Json
    } catch { $null }
}

# Turn open ports + device-info JSON into a brand/model verdict.
# Kept free of I/O so -SelfTest can exercise it.
function Resolve-Device {
    param([string]$IP, [int[]]$OpenPorts, $Samsung, $Cast)

    if ($Samsung -and $Samsung.device) {
        $d = $Samsung.device
        return [pscustomobject]@{
            IP    = $IP
            Brand = 'Samsung'
            Model = $d.modelName
            Name  = [System.Net.WebUtility]::HtmlDecode([string]$d.name)
            OS    = "$($d.OS) / $($d.model)"
            Ports = $OpenPorts -join ','
        }
    }
    if ($Cast -and $Cast.cast_build_revision) {
        return [pscustomobject]@{
            IP    = $IP
            Brand = 'Google Cast'
            Model = if ($Cast.model_name) { $Cast.model_name } else { '(not reported)' }
            Name  = [string]$Cast.name
            OS    = "cast $($Cast.cast_build_revision -replace '^(\d+\.\d+).*', '$1')"
            Ports = $OpenPorts -join ','
        }
    }
    if ($OpenPorts -contains 8060) { $brand = 'Roku' }
    elseif ($OpenPorts | Where-Object { $_ -in 3000, 3001, 9741 }) { $brand = 'LG webOS' }
    elseif ($OpenPorts -contains 1925) { $brand = 'Philips' }
    elseif ($OpenPorts -contains 6466) { $brand = 'Android TV' }
    else { return $null }

    [pscustomobject]@{
        IP = $IP; Brand = $brand; Model = '(unidentified)'; Name = ''
        OS = ''; Ports = $OpenPorts -join ','
    }
}

function Invoke-SelfTest {
    $samsung = @{ device = @{ modelName = 'UA43UE800HKXXT'; name = '43&quot; Crystal UHD'
                              OS = 'Tizen'; model = '26_X22U_UHD' } }
    $r = Resolve-Device -IP '10.0.0.1' -OpenPorts 8001, 8002, 8008 -Samsung $samsung -Cast $null
    if ($r.Brand -ne 'Samsung') { throw "SelfTest: expected Samsung, got $($r.Brand)" }
    if ($r.Name -ne '43" Crystal UHD') { throw "SelfTest: HTML entity not decoded: $($r.Name)" }

    $cast = @{ cast_build_revision = '3.72.446070'; name = 'Bear True' }
    $r = Resolve-Device -IP '10.0.0.2' -OpenPorts 8008, 8009, 6466 -Samsung $null -Cast $cast
    if ($r.Brand -ne 'Google Cast') { throw "SelfTest: expected Google Cast, got $($r.Brand)" }
    if ($r.OS -ne 'cast 3.72') { throw "SelfTest: bad cast version: $($r.OS)" }

    $r = Resolve-Device -IP '10.0.0.3' -OpenPorts 8060 -Samsung $null -Cast $null
    if ($r.Brand -ne 'Roku') { throw "SelfTest: expected Roku, got $($r.Brand)" }

    # A router answering 80/443 is not a TV.
    $r = Resolve-Device -IP '10.0.0.4' -OpenPorts @() -Samsung $null -Cast $null
    if ($null -ne $r) { throw 'SelfTest: non-TV host should be skipped' }

    'SelfTest OK'
}

if ($SelfTest) { Invoke-SelfTest; return }

if (-not $Subnet) { $Subnet = Get-LocalSubnet }
Write-Host "Sweeping $Subnet.0/24 ..." -ForegroundColor Cyan
Invoke-PingSweep -Subnet $Subnet

$arp = Get-ArpHosts -Subnet $Subnet
Write-Host "$($arp.Count) hosts in ARP; probing TV ports ..." -ForegroundColor Cyan

$found = foreach ($h in $arp) {
    $open = Test-TvPorts -IP $h.IP -TimeoutMs $ProbeTimeoutMs
    if (-not $open) { continue }

    $samsung = if ($open -contains 8001) { Get-Json "http://$($h.IP):8001/api/v2/" $HttpTimeoutSec }
    $cast    = if ($open -contains 8008) { Get-Json "http://$($h.IP):8008/setup/eureka_info" $HttpTimeoutSec }

    $dev = Resolve-Device -IP $h.IP -OpenPorts $open -Samsung $samsung -Cast $cast
    if ($dev) { $dev | Add-Member -NotePropertyName MAC -NotePropertyValue $h.MAC -PassThru }
}

if (-not $found) { Write-Host 'No TVs found.' -ForegroundColor Yellow; return }
$found | Format-Table IP, Brand, Model, Name, OS, Ports, MAC -AutoSize
Write-Host "$(@($found).Count) TV(s) found." -ForegroundColor Green
