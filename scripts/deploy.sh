#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# Bay Capital — Client Deployment Script (Bash)
#
# Usage:
#   cp scripts/client.env.template scripts/client.env
#   # Fill in scripts/client.env
#   bash scripts/deploy.sh
#
# Requirements:
#   - Azure CLI (az)     https://docs.microsoft.com/en-us/cli/azure/install-azure-cli
#   - GitHub CLI (gh)    https://cli.github.com
#   - jq                 https://stedolan.github.io/jq/
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Load config ───────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${1:-$SCRIPT_DIR/client.env}"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "ERROR: Config file not found: $CONFIG_FILE"
  echo "Copy scripts/client.env.template to scripts/client.env and fill in the values."
  exit 1
fi

# shellcheck source=/dev/null
source "$CONFIG_FILE"

# ── Derived resource names ────────────────────────────────────────
RESOURCE_GROUP="${CLIENT_NAME}"
STORAGE_ACCOUNT="queue${CLIENT_NAME}"
FUNCTION_APP="${CLIENT_NAME}-webhook-processor"
STATIC_WEB_APP="${CLIENT_NAME}-encompass"
SWA_SECRET_NAME="AZURE_STATIC_WEB_APPS_API_TOKEN_$(echo "$CLIENT_NAME" | tr '[:lower:]' '[:upper:]')"

# ── Helpers ───────────────────────────────────────────────────────
log()     { echo -e "\n\033[1;36m▶ $*\033[0m"; }
success() { echo -e "\033[1;32m  ✓ $*\033[0m"; }
warn()    { echo -e "\033[1;33m  ⚠ $*\033[0m"; }
die()     { echo -e "\033[1;31m  ✗ $*\033[0m"; exit 1; }

# ── Validate requirements ─────────────────────────────────────────
log "Checking requirements"
command -v az  >/dev/null 2>&1 || die "Azure CLI not found. Install: https://docs.microsoft.com/en-us/cli/azure/install-azure-cli"
command -v gh  >/dev/null 2>&1 || die "GitHub CLI not found. Install: https://cli.github.com"
command -v jq  >/dev/null 2>&1 || die "jq not found. Install: https://stedolan.github.io/jq/"

[[ -z "${CLIENT_NAME:-}"           ]] && die "CLIENT_NAME is required"
[[ -z "${AZURE_SUBSCRIPTION_ID:-}" ]] && die "AZURE_SUBSCRIPTION_ID is required"
[[ -z "${GITHUB_TOKEN:-}"          ]] && die "GITHUB_TOKEN is required"
[[ -z "${GITHUB_REPO:-}"           ]] && die "GITHUB_REPO is required"
success "All requirements met"

# ── Azure login & subscription ────────────────────────────────────
log "Authenticating with Azure"
az account set --subscription "$AZURE_SUBSCRIPTION_ID"
success "Using subscription: $AZURE_SUBSCRIPTION_ID"

# ── Resource Group ────────────────────────────────────────────────
log "Resource Group: $RESOURCE_GROUP"
if az group show --name "$RESOURCE_GROUP" &>/dev/null; then
  warn "Resource group '$RESOURCE_GROUP' already exists — skipping"
else
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none
  success "Created resource group: $RESOURCE_GROUP"
fi

# ── Storage Account ───────────────────────────────────────────────
log "Storage Account: $STORAGE_ACCOUNT"
if az storage account show --name "$STORAGE_ACCOUNT" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
  warn "Storage account '$STORAGE_ACCOUNT' already exists — skipping"
else
  az storage account create \
    --name "$STORAGE_ACCOUNT" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --sku Standard_LRS \
    --kind StorageV2 \
    --output none
  success "Created storage account: $STORAGE_ACCOUNT"
fi

STORAGE_CONNECTION_STRING=$(az storage account show-connection-string \
  --name "$STORAGE_ACCOUNT" \
  --resource-group "$RESOURCE_GROUP" \
  --query connectionString -o tsv)

# ── Storage Queue ─────────────────────────────────────────────────
log "Storage Queue: elliemae-webhooks"
az storage queue create \
  --name "elliemae-webhooks" \
  --connection-string "$STORAGE_CONNECTION_STRING" \
  --output none 2>/dev/null || warn "Queue may already exist"

az storage queue create \
  --name "elliemae-webhooks-poison" \
  --connection-string "$STORAGE_CONNECTION_STRING" \
  --output none 2>/dev/null || warn "Poison queue may already exist"
success "Queues ready"

# ── Storage Table ─────────────────────────────────────────────────
log "Storage Table: webhookTrace"
az storage table create \
  --name "webhookTrace" \
  --connection-string "$STORAGE_CONNECTION_STRING" \
  --output none 2>/dev/null || warn "Table may already exist"
success "Table ready"

# ── Static Web App ────────────────────────────────────────────────
log "Static Web App: $STATIC_WEB_APP"
if az staticwebapp show --name "$STATIC_WEB_APP" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
  warn "Static Web App '$STATIC_WEB_APP' already exists — skipping creation"
else
  az staticwebapp create \
    --name "$STATIC_WEB_APP" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --sku Standard \
    --output none
  success "Created Static Web App: $STATIC_WEB_APP"
fi

SWA_TOKEN=$(az staticwebapp secrets list \
  --name "$STATIC_WEB_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --query "properties.apiKey" -o tsv)

log "Configuring Static Web App settings"
az staticwebapp appsettings set \
  --name "$STATIC_WEB_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --setting-names \
    AZURE_STORAGE_CONNECTION_STRING="$STORAGE_CONNECTION_STRING" \
    WEBHOOK_QUEUE_NAME="elliemae-webhooks" \
    ELLI_SUBSCRIPTION_ID="$ELLI_SUBSCRIPTION_ID" \
    ENCOMPASS_BASE_URL="https://api.elliemae.com" \
    ENCOMPASS_USERNAME="$ENCOMPASS_USERNAME" \
    ENCOMPASS_PASSWORD="$ENCOMPASS_PASSWORD" \
    ENCOMPASS_CLIENT_ID="$ENCOMPASS_CLIENT_ID" \
    ENCOMPASS_CLIENT_SECRET="$ENCOMPASS_CLIENT_SECRET" \
    ENCOMPASS_INSTANCE_ID="$ENCOMPASS_INSTANCE_ID" \
  --output none
success "Static Web App settings configured"

# ── Function App ──────────────────────────────────────────────────
log "Function App: $FUNCTION_APP"
if az functionapp show --name "$FUNCTION_APP" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
  warn "Function App '$FUNCTION_APP' already exists — skipping creation"
else
  az functionapp create \
    --name "$FUNCTION_APP" \
    --resource-group "$RESOURCE_GROUP" \
    --storage-account "$STORAGE_ACCOUNT" \
    --consumption-plan-location "$LOCATION" \
    --runtime node \
    --runtime-version "$NODE_VERSION" \
    --os-type Linux \
    --functions-version 4 \
    --output none
  success "Created Function App: $FUNCTION_APP"
fi

log "Configuring Function App settings"
az functionapp config appsettings set \
  --name "$FUNCTION_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --settings \
    AZURE_STORAGE_CONNECTION_STRING="$STORAGE_CONNECTION_STRING" \
    WEBHOOK_QUEUE_NAME="elliemae-webhooks" \
    ENCOMPASS_BASE_URL="https://api.elliemae.com" \
    ENCOMPASS_USERNAME="$ENCOMPASS_USERNAME" \
    ENCOMPASS_PASSWORD="$ENCOMPASS_PASSWORD" \
    ENCOMPASS_CLIENT_ID="$ENCOMPASS_CLIENT_ID" \
    ENCOMPASS_CLIENT_SECRET="$ENCOMPASS_CLIENT_SECRET" \
    ENCOMPASS_INSTANCE_ID="$ENCOMPASS_INSTANCE_ID" \
    GHL_BASE_URL="https://services.leadconnectorhq.com" \
    TRACE_RETAIN_DAYS="$TRACE_RETAIN_DAYS" \
  --output none
success "Function App settings configured"

# ── Azure Service Principal for GitHub Actions ────────────────────
log "Service Principal for GitHub Actions"
SP_NAME="${CLIENT_NAME}-github-deploy"
SUBSCRIPTION_SCOPE="/subscriptions/$AZURE_SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP"

EXISTING_SP=$(az ad sp list --display-name "$SP_NAME" --query "[0].appId" -o tsv 2>/dev/null || echo "")
if [[ -n "$EXISTING_SP" ]]; then
  warn "Service principal '$SP_NAME' already exists — reusing"
  AZURE_CREDENTIALS=$(az ad sp create-for-rbac \
    --name "$SP_NAME" \
    --role contributor \
    --scopes "$SUBSCRIPTION_SCOPE" \
    --sdk-auth 2>/dev/null || echo "")
else
  AZURE_CREDENTIALS=$(az ad sp create-for-rbac \
    --name "$SP_NAME" \
    --role contributor \
    --scopes "$SUBSCRIPTION_SCOPE" \
    --sdk-auth)
fi

[[ -z "$AZURE_CREDENTIALS" ]] && die "Failed to create service principal"
success "Service principal ready: $SP_NAME"

# ── GitHub Secrets ────────────────────────────────────────────────
log "Setting GitHub secrets on ${GITHUB_ORG}/${GITHUB_REPO}"

GH_REPO="${GITHUB_ORG}/${GITHUB_REPO}"

set_secret() {
  local name="$1"
  local value="$2"
  echo "$value" | gh secret set "$name" --repo "$GH_REPO"
  success "Secret set: $name"
}

export GH_TOKEN="$GITHUB_TOKEN"

set_secret "AZURE_CREDENTIALS"                    "$AZURE_CREDENTIALS"
set_secret "AZURE_STORAGE_CONNECTION_STRING"      "$STORAGE_CONNECTION_STRING"
set_secret "$SWA_SECRET_NAME"                     "$SWA_TOKEN"
set_secret "ENCOMPASS_USERNAME"                   "$ENCOMPASS_USERNAME"
set_secret "ENCOMPASS_PASSWORD"                   "$ENCOMPASS_PASSWORD"
set_secret "ENCOMPASS_CLIENT_ID"                  "$ENCOMPASS_CLIENT_ID"
set_secret "ENCOMPASS_CLIENT_SECRET"              "$ENCOMPASS_CLIENT_SECRET"
set_secret "ENCOMPASS_INSTANCE_ID"                "$ENCOMPASS_INSTANCE_ID"

# ── GitHub Variables ──────────────────────────────────────────────
log "Setting GitHub variables"
set_var() {
  local name="$1"
  local value="$2"
  gh variable set "$name" --body "$value" --repo "$GH_REPO"
  success "Variable set: $name"
}

set_var "FUNCTION_APP_NAME"  "$FUNCTION_APP"
set_var "RESOURCE_GROUP"     "$RESOURCE_GROUP"
set_var "STORAGE_ACCOUNT"    "$STORAGE_ACCOUNT"
set_var "LOCATION"           "$LOCATION"
set_var "NODE_VERSION"       "$NODE_VERSION"
set_var "TRACE_RETAIN_DAYS"  "$TRACE_RETAIN_DAYS"

# ── Update workflows to use this client's resource names ──────────
log "Patching GitHub Actions workflows for client: $CLIENT_NAME"
WORKFLOWS_DIR="$SCRIPT_DIR/../.github/workflows"

# Patch static web apps workflow — update SWA token secret name
sed -i.bak \
  "s|AZURE_STATIC_WEB_APPS_API_TOKEN_[A-Z0-9_]*|${SWA_SECRET_NAME}|g" \
  "$WORKFLOWS_DIR/azure-static-web-apps.yml"

# Patch processor workflow — update resource name env vars
sed -i.bak \
  -e "s|FUNCTION_APP_NAME:.*|FUNCTION_APP_NAME: ${FUNCTION_APP}|" \
  -e "s|RESOURCE_GROUP:.*|RESOURCE_GROUP: ${RESOURCE_GROUP}|" \
  -e "s|STORAGE_ACCOUNT:.*|STORAGE_ACCOUNT: ${STORAGE_ACCOUNT}|" \
  -e "s|LOCATION:.*|LOCATION: ${LOCATION}|" \
  -e "s|NODE_VERSION:.*|NODE_VERSION: '${NODE_VERSION}'|" \
  "$WORKFLOWS_DIR/azure-functions-processor.yml"

# Clean up sed backup files
rm -f "$WORKFLOWS_DIR"/*.bak
success "Workflows patched"

# ── Trigger deployment ────────────────────────────────────────────
log "Triggering GitHub Actions deployment"
gh workflow run "azure-static-web-apps.yml"       --repo "$GH_REPO" --ref main
gh workflow run "azure-functions-processor.yml"   --repo "$GH_REPO" --ref main
success "Workflows triggered — monitor at: https://github.com/${GH_REPO}/actions"

# ── Summary ───────────────────────────────────────────────────────
SWA_URL=$(az staticwebapp show \
  --name "$STATIC_WEB_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --query "defaultHostname" -o tsv 2>/dev/null || echo "pending")

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║           DEPLOYMENT COMPLETE: $CLIENT_NAME"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Resource Group  : $RESOURCE_GROUP"
echo "║  Storage Account : $STORAGE_ACCOUNT"
echo "║  Static Web App  : https://$SWA_URL"
echo "║  Function App    : $FUNCTION_APP"
echo "║  GitHub Repo     : https://github.com/$GH_REPO"
echo "║  GitHub Actions  : https://github.com/$GH_REPO/actions"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Set the Ellie Mae webhook URL to: https://$SWA_URL/api/webhook-receiver"
echo "  2. Set ELLI_SUBSCRIPTION_ID in the SWA app settings"
echo "  3. Set the GHL Location ID in the LO's Encompass user comments field"
