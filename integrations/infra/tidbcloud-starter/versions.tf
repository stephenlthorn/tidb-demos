terraform {
  required_version = ">= 1.5"

  required_providers {
    tidbcloud = {
      source  = "tidbcloud/tidbcloud"
      version = "~> 0.4.11"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# Auth comes from the TIDBCLOUD_PUBLIC_KEY / TIDBCLOUD_PRIVATE_KEY env vars
# (read at run time from ~/.config/tidb-lab/secrets.env by up.sh/down.sh).
provider "tidbcloud" {}
