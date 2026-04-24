# ─────────────────────────────────────────────────────────────────
# Bay Capital — Client Deployment Script (PowerShell)
#
# Usage:
#   Copy-Item scripts\client.env.template scripts\client.env
#   # Fill in scripts\client.env
#   .\scripts\deploy.ps1
#   .\scripts\deploy.ps1 -ConfigFile "scripts\myclient.env"
#
# Requirements:
#   - Azure CLI (az)     https://docs.microsoft.com/en-us/cli/azure/install-azure-cli
#   - GitHub CLI (gh)    https://cli.github.com
# ─────────────────────────────────────────────────────────────────

param(
    [string]$ConfigFile = "$PSScriptRoot\client.env"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Helpers ───────────────────────────────────────────────────────
function Log($msg)     { Write-Host "`n▶ $msg" -ForegroundColor Cyan }
function Success($msg) { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Warn($msg)    { Write-Host "  ⚠ $msg" -ForegroundColor Yellow }
function Die($msg)     { Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }

function Invoke-AzSilent($cmd) {
    $output = Invoke-Expression "$cmd 2>&1"
    return $output
}

# ── Load config ───────────────────────────────────────────────────
if (-not (Test-Path $ConfigFile)) {
    Die "Config file not found: $ConfigFile`nCopy scripts\client.env.template to scripts\client.env and fill in the values."
}

$config = @{}
Get-Content $ConfigFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    if ($_ -match '^([^=]+)=(.*)$') {
        $key   = $Matches[1].Trim()
        $value = $Matches[2].Trim().Trim('"').Trim("'")
        $config[$key] = $value
    }
}

# Required fields
foreach ($key in @("CLIENT_NAME","AZURE_SUBSCRIPTION_ID","GITHUB_TOKEN","GITHUB_REPO","GITHUB_ORG")) {
    if (-not $config.ContainsKey($key) -or [string]::IsNullOrEmpty($config[$key])) {
        Die "$key is required in $ConfigFile"
    }
}

# ── Derived names ─────────────────────────────────────────────────
$clientName      = $config["CLIENT_NAME"].ToLower()
$location        = $config["LOCATION"]
$resourceGroup   = $clientName
$storageAccount  = "queue$clientName"
$functionApp     = "$clientName-webhook-processor"
$staticWebApp    = "$clientName-encompass"
$swsSecretName   = "AZURE_STATIC_WEB_APPS_API_TOKEN_$($clientName.ToUpper())"
$ghRepo          = "$($config["GITHUB_ORG"])/$($config["GITHUB_REPO"])"
$nodeVersion     = $config.ContainsKey("NODE_VERSION") ? $config["NODE_VERSION"] : "22"
$traceRetainDays = $config.ContainsKey("TRACE_RETAIN_DAYS") ? $config["TRACE_RETAIN_DAYS"] : "30"

# ── Validate requirements ─────────────────────────────────────────
Log "Checking requirements"
if (-not (Get-Command az  -ErrorAction SilentlyContinue)) { Die "Azure CLI not found. Install: https://docs.microsoft.com/en-us/cli/azure/install-azure-cli" }
if (-not (Get-Command gh  -ErrorAction SilentlyContinue)) { Die "GitHub CLI not found. Install: https://cli.github.com" }
Success "All requirements met"

# ── Azure login ───────────────────────────────────────────────────
Log "Authenticating with Azure"
az account set --subscription $config["AZURE_SUBSCRIPTION_ID"]
Success "Using subscription: $($config["AZURE_SUBSCRIPTION_ID"])"

# ── Resource Group ────────────────────────────────────────────────
Log "Resource Group: $resourceGroup"
$rgExists = az group show --name $resourceGroup 2>$null
if ($rgExists) {
    Warn "Resource group '$resourceGroup' already exists — skipping"
} else {
    az group create --name $resourceGroup --location $location --output none
    Success "Created resource group: $resourceGroup"
}

# ── Storage Account ───────────────────────────────────────────────
Log "Storage Account: $storageAccount"
$saExists = az storage account show --name $storageAccount --resource-group $resourceGroup 2>$null
if ($saExists) {
    Warn "Storage account '$storageAccount' already exists — skipping"
} else {
    az storage account create `
        --name $storageAccount `
        --resource-group $resourceGroup `
        --location $location `
        --sku Standard_LRS `
        --kind StorageV2 `
        --output none
    Success "Created storage account: $storageAccount"
}

$storageConnStr = az storage account show-connection-string `
    --name $storageAccount `
    --resource-group $resourceGroup `
    --query connectionString -o tsv

# ── Storage Queue & Table ─────────────────────────────────────────
Log "Storage Queue & Table"
az storage queue create --name "elliemae-webhooks"        --connection-string $storageConnStr --output none 2>$null
az storage queue create --name "elliemae-webhooks-poison" --connection-string $storageConnStr --output none 2>$null
az storage table create --name "webhookTrace"             --connection-string $storageConnStr --output none 2>$null
Success "Queues and table ready"

# ── Static Web App ────────────────────────────────────────────────
Log "Static Web App: $staticWebApp"
$swaExists = az staticwebapp show --name $staticWebApp --resource-group $resourceGroup 2>$null
if ($swaExists) {
    Warn "Static Web App '$staticWebApp' already exists — skipping creation"
} else {
    az staticwebapp create `
        --name $staticWebApp `
        --resource-group $resourceGroup `
        --location $location `
        --sku Standard `
        --output none
    Success "Created Static Web App: $staticWebApp"
}

$swaToken = az staticwebapp secrets list `
    --name $staticWebApp `
    --resource-group $resourceGroup `
    --query "properties.apiKey" -o tsv

Log "Configuring Static Web App settings"
az staticwebapp appsettings set `
    --name $staticWebApp `
    --resource-group $resourceGroup `
    --setting-names `
        "AZURE_STORAGE_CONNECTION_STRING=$storageConnStr" `
        "WEBHOOK_QUEUE_NAME=elliemae-webhooks" `
        "ELLI_SUBSCRIPTION_ID=$($config["ELLI_SUBSCRIPTION_ID"])" `
        "ENCOMPASS_BASE_URL=https://api.elliemae.com" `
        "ENCOMPASS_USERNAME=$($config["ENCOMPASS_USERNAME"])" `
        "ENCOMPASS_PASSWORD=$($config["ENCOMPASS_PASSWORD"])" `
        "ENCOMPASS_CLIENT_ID=$($config["ENCOMPASS_CLIENT_ID"])" `
        "ENCOMPASS_CLIENT_SECRET=$($config["ENCOMPASS_CLIENT_SECRET"])" `
        "ENCOMPASS_INSTANCE_ID=$($config["ENCOMPASS_INSTANCE_ID"])" `
    --output none
Success "Static Web App settings configured"

# ── Function App ──────────────────────────────────────────────────
Log "Function App: $functionApp"
$faExists = az functionapp show --name $functionApp --resource-group $resourceGroup 2>$null
if ($faExists) {
    Warn "Function App '$functionApp' already exists — skipping creation"
} else {
    az functionapp create `
        --name $functionApp `
        --resource-group $resourceGroup `
        --storage-account $storageAccount `
        --consumption-plan-location $location `
        --runtime node `
        --runtime-version $nodeVersion `
        --os-type Linux `
        --functions-version 4 `
        --output none
    Success "Created Function App: $functionApp"
}

Log "Configuring Function App settings"
az functionapp config appsettings set `
    --name $functionApp `
    --resource-group $resourceGroup `
    --settings `
        "AZURE_STORAGE_CONNECTION_STRING=$storageConnStr" `
        "WEBHOOK_QUEUE_NAME=elliemae-webhooks" `
        "ENCOMPASS_BASE_URL=https://api.elliemae.com" `
        "ENCOMPASS_USERNAME=$($config["ENCOMPASS_USERNAME"])" `
        "ENCOMPASS_PASSWORD=$($config["ENCOMPASS_PASSWORD"])" `
        "ENCOMPASS_CLIENT_ID=$($config["ENCOMPASS_CLIENT_ID"])" `
        "ENCOMPASS_CLIENT_SECRET=$($config["ENCOMPASS_CLIENT_SECRET"])" `
        "ENCOMPASS_INSTANCE_ID=$($config["ENCOMPASS_INSTANCE_ID"])" `
        "GHL_BASE_URL=https://services.leadconnectorhq.com" `
        "TRACE_RETAIN_DAYS=$traceRetainDays" `
    --output none
Success "Function App settings configured"

# ── Service Principal for GitHub Actions ──────────────────────────
Log "Service Principal for GitHub Actions"
$spName = "$clientName-github-deploy"
$scope  = "/subscriptions/$($config["AZURE_SUBSCRIPTION_ID"])/resourceGroups/$resourceGroup"

$azureCreds = az ad sp create-for-rbac `
    --name $spName `
    --role contributor `
    --scopes $scope `
    --sdk-auth 2>$null

if (-not $azureCreds) {
    Die "Failed to create service principal"
}
Success "Service principal ready: $spName"

# ── GitHub Secrets ────────────────────────────────────────────────
Log "Setting GitHub secrets on $ghRepo"
$env:GH_TOKEN = $config["GITHUB_TOKEN"]

function Set-Secret($name, $value) {
    $value | gh secret set $name --repo $ghRepo
    Success "Secret set: $name"
}

function Set-Var($name, $value) {
    gh variable set $name --body $value --repo $ghRepo
    Success "Variable set: $name"
}

Set-Secret "AZURE_CREDENTIALS"                $azureCreds
Set-Secret "AZURE_STORAGE_CONNECTION_STRING"  $storageConnStr
Set-Secret $swsSecretName                     $swaToken
Set-Secret "ENCOMPASS_USERNAME"               $config["ENCOMPASS_USERNAME"]
Set-Secret "ENCOMPASS_PASSWORD"               $config["ENCOMPASS_PASSWORD"]
Set-Secret "ENCOMPASS_CLIENT_ID"              $config["ENCOMPASS_CLIENT_ID"]
Set-Secret "ENCOMPASS_CLIENT_SECRET"          $config["ENCOMPASS_CLIENT_SECRET"]
Set-Secret "ENCOMPASS_INSTANCE_ID"            $config["ENCOMPASS_INSTANCE_ID"]

# ── GitHub Variables ──────────────────────────────────────────────
Log "Setting GitHub variables"
Set-Var "FUNCTION_APP_NAME"  $functionApp
Set-Var "RESOURCE_GROUP"     $resourceGroup
Set-Var "STORAGE_ACCOUNT"    $storageAccount
Set-Var "LOCATION"           $location
Set-Var "NODE_VERSION"       $nodeVersion
Set-Var "TRACE_RETAIN_DAYS"  $traceRetainDays

# ── Patch workflows ───────────────────────────────────────────────
Log "Patching GitHub Actions workflows for client: $clientName"
$workflowsDir = "$PSScriptRoot\..\github\workflows"

# SWA workflow - update token secret name
(Get-Content "$workflowsDir\azure-static-web-apps.yml") `
    -replace 'AZURE_STATIC_WEB_APPS_API_TOKEN_[A-Z0-9_]+', $swsSecretName |
    Set-Content "$workflowsDir\azure-static-web-apps.yml"

# Processor workflow - update resource env vars
(Get-Content "$workflowsDir\azure-functions-processor.yml") `
    -replace 'FUNCTION_APP_NAME:.*',  "FUNCTION_APP_NAME: $functionApp" `
    -replace 'RESOURCE_GROUP:.*',     "RESOURCE_GROUP: $resourceGroup" `
    -replace 'STORAGE_ACCOUNT:.*',    "STORAGE_ACCOUNT: $storageAccount" `
    -replace 'LOCATION:.*',           "LOCATION: $location" `
    -replace "NODE_VERSION:.*",       "NODE_VERSION: '$nodeVersion'" |
    Set-Content "$workflowsDir\azure-functions-processor.yml"

Success "Workflows patched"

# ── Trigger deployments ───────────────────────────────────────────
Log "Triggering GitHub Actions deployments"
gh workflow run "azure-static-web-apps.yml"      --repo $ghRepo --ref main
gh workflow run "azure-functions-processor.yml"  --repo $ghRepo --ref main
Success "Workflows triggered"

# ── Summary ───────────────────────────────────────────────────────
$swaUrl = az staticwebapp show `
    --name $staticWebApp `
    --resource-group $resourceGroup `
    --query "defaultHostname" -o tsv 2>$null

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║  DEPLOYMENT COMPLETE: $clientName" -ForegroundColor Green
Write-Host "╠══════════════════════════════════════════════════════════╣" -ForegroundColor Green
Write-Host "║  Resource Group  : $resourceGroup" -ForegroundColor Green
Write-Host "║  Storage Account : $storageAccount" -ForegroundColor Green
Write-Host "║  Static Web App  : https://$swaUrl" -ForegroundColor Green
Write-Host "║  Function App    : $functionApp" -ForegroundColor Green
Write-Host "║  GitHub Repo     : https://github.com/$ghRepo" -ForegroundColor Green
Write-Host "║  GitHub Actions  : https://github.com/$ghRepo/actions" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Set the Ellie Mae webhook URL to: https://$swaUrl/api/webhook-receiver"
Write-Host "  2. Set ELLI_SUBSCRIPTION_ID in the SWA app settings"
Write-Host "  3. Set the GHL Location ID in the LO's Encompass user comments field"
