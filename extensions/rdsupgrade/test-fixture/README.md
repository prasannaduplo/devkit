# rdsupgrade test fixture

Standalone Terraform (not routed through DuploCloud — AWS account `805863115079` isn't attached to a
workspace scope yet) that creates a throwaway RDS MySQL instance on an old engine version, so the
`rdsupgrade` extension can be tested repeatedly against something with a real major-version upgrade to do.

## 1. Credentials

Authenticate however you already do for standalone AWS work against this account (e.g. `duplo-jit`
against a Duplo-managed alias, or an AWS SSO profile). This Terraform doesn't configure any credentials
itself — it just uses whatever's in your environment, optionally via `-var=aws_profile=<name>`. The
provider has `allowed_account_ids = [var.account_id]` as a guardrail against accidentally applying to the
wrong account.

## 2. Check what engine version is actually creatable

`8.0.3` (or most early 8.0.x minors) are almost certainly retired from new-instance creation by now — AWS
does this on a rolling basis even though existing instances keep running. Check first:

```bash
aws rds describe-db-engine-versions --engine mysql --region us-east-1 \
  --query 'DBEngineVersions[].EngineVersion' --output table
```

Pick the oldest one listed if the goal is "as old as AWS still allows," and pass it via
`-var=engine_version=...` (default in `variables.tf` is a guess, not a guarantee).

## 3. Create

```bash
cd terraform
terraform init
terraform plan  -var='allowed_cidr_blocks=["<your CIDR>"]' -var=engine_version=<verified version>
terraform apply -var='allowed_cidr_blocks=["<your CIDR>"]' -var=engine_version=<verified version>
```

`allowed_cidr_blocks` is required (no open-to-the-world default) — point it at wherever the extension or
your test runner actually connects from.

Outputs include `db_instance_identifier` (feed this into `rdsupgrade`'s `DbInstanceIdentifier` spec field)
and `engine_version` (feed into `TargetEngineVersion` — pick something newer, obviously).

## 4. Test the extension

Point `rdsupgrade` at `db_instance_identifier` with a `TargetEngineVersion` newer than what got created
here, run the upgrade, watch it through.

## 5. Destroy and repeat

```bash
terraform destroy -var='allowed_cidr_blocks=["<your CIDR>"]' -var=engine_version=<verified version>
```

No deletion protection, no final snapshot — this instance is disposable by design. If `rdsupgrade` itself
already ran a full upgrade+cleanup cycle, the instance under this identifier may already be at the new
version (or gone, if something failed mid-run) — `terraform plan` first if unsure what state it's in
before destroying.
