param(
    [Parameter(Mandatory = $true)]
    [string]$DatabaseUrl
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Error $Message
    exit 1
}

function Invoke-NpmChecked([string[]]$Arguments) {
    & npm @Arguments
    if ($LASTEXITCODE -ne 0) {
        $failedExitCode = $LASTEXITCODE
        [Console]::Error.WriteLine("npm command failed with exit code $failedExitCode.")
        exit $failedExitCode
    }
}

$uri = $null
try {
    $uri = [Uri]$DatabaseUrl
} catch {
    Fail 'DATABASE_URL must be a valid PostgreSQL connection URL.'
}

if ($uri.Scheme -notin @('postgresql', 'postgres')) {
    Fail 'DATABASE_URL must use the postgresql or postgres scheme.'
}

$databaseName = $uri.AbsolutePath.TrimStart('/')
if ([string]::IsNullOrWhiteSpace($databaseName)) {
    Fail 'DATABASE_URL must include a database name.'
}

$databaseName = [Uri]::UnescapeDataString($databaseName)
if ($databaseName -ne 'ghl_bulk_stage_test') {
    Fail 'The setup database must be exactly ghl_bulk_stage_test.'
}

Write-Host 'The setup script will write only to ghl_bulk_stage_test after the URL and current database both match.' -ForegroundColor Yellow
$env:DATABASE_URL = $DatabaseUrl

Invoke-NpmChecked -Arguments @('install')
Invoke-NpmChecked -Arguments @('run', 'db:generate')
Invoke-NpmChecked -Arguments @('run', 'db:check:test')
Invoke-NpmChecked -Arguments @('run', 'db:migrate:deploy')
Invoke-NpmChecked -Arguments @('run', 'db:seed:assignment', '--', '--small', '--confirm-disposable-database', 'ghl_bulk_stage_test')
Invoke-NpmChecked -Arguments @('test', '--', '--runInBand')

exit 0
