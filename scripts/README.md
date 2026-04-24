# Client Deployment Scripts

Deploys all Bay Capital Azure resources and GitHub configuration for a new client in a single command.

## Prerequisites

| Tool | Install |
|---|---|
| Azure CLI | https://docs.microsoft.com/en-us/cli/azure/install-azure-cli |
| GitHub CLI | https://cli.github.com |
| jq (Bash only) | https://stedolan.github.io/jq/ |

Log in to both CLIs before running:
```bash
az login
gh auth login
```

## Setup

**1. Copy the config template**
```bash
cp scripts/client.env.template scripts/client.env
```

**2. Fill in `client.env`**

| Variable | Description |
|---|---|
| `CLIENT_NAME` | Lowercase, no spaces — used in all resource names (e.g. `acmemortgage`) |
| `LOCATION` | Azure region (e.g. `westus2`) |
| `AZURE_SUBSCRIPTION_ID` | Client's Azure subscription ID |
| `GITHUB_ORG` | GitHub org or username that owns the repo |
| `GITHUB_REPO` | Repo name (must already exist) |
| `GITHUB_TOKEN` | PAT with `repo` + `secrets` scopes |
| `ENCOMPASS_*` | Encompass API credentials |
| `ELLI_SUBSCRIPTION_ID` | Ellie Mae webhook subscription ID |
| `GHL_API_KEY` | GoHighLevel API key |
| `GHL_LOCATION_ID` | GHL fallback location ID |
| `TRACE_RETAIN_DAYS` | Days to retain trace records (default: 30) |

**3. Run the script**

Bash (Mac/Linux/WSL):
```bash
chmod +x scripts/deploy.sh
bash scripts/deploy.sh
# Or with a custom config file:
bash scripts/deploy.sh scripts/acmemortgage.env
```

PowerShell (Windows):
```powershell
.\scripts\deploy.ps1
# Or with a custom config file:
.\scripts\deploy.ps1 -ConfigFile "scripts\acmemortgage.env"
```

## What the script does

1. **Azure Resource Group** — creates `{CLIENT_NAME}`
2. **Storage Account** — creates `queue{CLIENT_NAME}` with:
   - Queue: `elliemae-webhooks`
   - Queue: `elliemae-webhooks-poison`
   - Table: `webhookTrace`
3. **Static Web App** — creates `{CLIENT_NAME}-encompass` (Standard tier) and configures app settings
4. **Function App** — creates `{CLIENT_NAME}-webhook-processor` (Linux, Node, Consumption) and configures app settings
5. **Service Principal** — creates `{CLIENT_NAME}-github-deploy` with Contributor role on the resource group
6. **GitHub Secrets** — sets all required secrets on the repo
7. **GitHub Variables** — sets resource name variables on the repo
8. **Patches workflows** — updates `.github/workflows/*.yml` with the client's resource names
9. **Triggers deployments** — fires both GitHub Actions workflows

## After deployment

1. Set the Ellie Mae webhook subscription URL to:
   ```
   https://{CLIENT_NAME}-encompass.azurestaticapps.net/api/webhook-receiver
   ```
2. Update `ELLI_SUBSCRIPTION_ID` in the SWA app settings with the ID from Ellie Mae
3. Set each LO's GHL Location ID in their Encompass user `comments` field

## Multiple clients

You can maintain separate config files per client:
```
scripts/
  client.env.template   ← source of truth, committed to repo
  acmemortgage.env      ← gitignored, per-client
  firstnational.env     ← gitignored, per-client
```

Add to `.gitignore`:
```
scripts/*.env
!scripts/*.env.template
```
