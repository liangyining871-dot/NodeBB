param(
    [Parameter(Mandatory=$true)][int]$TargetProcessId,
    [Parameter(Mandatory=$true)][string]$StopFile,
    [Parameter(Mandatory=$true)][string]$ReportFile
)
$samples = @()
$started = Get-Date
while (((Get-Date) - $started).TotalSeconds -lt 300) {
    try {
        $process = Get-Process -Id $TargetProcessId -ErrorAction Stop
        $samples += [pscustomobject]@{
            at = [DateTime]::UtcNow.ToString('o')
            cpuSeconds = $process.CPU
            workingSetMB = [Math]::Round($process.WorkingSet64 / 1MB, 2)
            privateMB = [Math]::Round($process.PrivateMemorySize64 / 1MB, 2)
        }
    } catch { break }
    if (Test-Path -LiteralPath $StopFile) { break }
    Start-Sleep -Seconds 5
}
$intervals = @()
for ($index = 1; $index -lt $samples.Count; $index++) {
    $seconds = ([DateTime]$samples[$index].at - [DateTime]$samples[$index - 1].at).TotalSeconds
    if ($seconds -gt 0) {
        $intervals += 100 * ($samples[$index].cpuSeconds - $samples[$index - 1].cpuSeconds) / $seconds
    }
}
$summary = [ordered]@{
    processId = $TargetProcessId
    scope = 'NodeBB listener process only; includes login preparation; excludes PostgreSQL and load generator'
    sampleCount = $samples.Count
    averageSingleCoreCpuPercent = [Math]::Round(($intervals | Measure-Object -Average).Average, 2)
    maximumSampledSingleCoreCpuPercent = [Math]::Round(($intervals | Measure-Object -Maximum).Maximum, 2)
    maximumSampledWorkingSetMB = ($samples | Measure-Object -Property workingSetMB -Maximum).Maximum
    maximumSampledPrivateMB = ($samples | Measure-Object -Property privateMB -Maximum).Maximum
}
@{ summary = $summary; samples = $samples } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReportFile -Encoding UTF8
$summary | ConvertTo-Json
