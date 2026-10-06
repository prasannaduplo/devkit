# No credentials are configured here. This account (805863115079) is not yet attached to any
# DuploCloud workspace scope, so authenticate however you already do for standalone AWS work against it
# (e.g. `duplo-jit`-minted temp creds exported as AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN, or an AWS SSO
# profile passed via `-var=aws_profile=...` / TF_VAR_aws_profile). The provider just uses the default
# credential chain plus an optional named profile.
provider "aws" {
  region  = var.region
  profile = var.aws_profile

  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      Purpose   = "rdsupgrade-test-fixture"
      ManagedBy = "terraform"
    }
  }
}
