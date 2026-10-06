variable "account_id" {
  description = "AWS account this fixture is allowed to run against — a guardrail against applying to the wrong account."
  type        = string
  default     = "805863115079"
}

variable "region" {
  description = "AWS region for the throwaway instance."
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "Named AWS CLI profile to use, if you're not relying on plain env-var credentials (e.g. from duplo-jit)."
  type        = string
  default     = null
}

variable "identifier" {
  description = "RDS instance identifier. Kept short and clearly disposable on purpose."
  type        = string
  default     = "rdsupgrade-fixture-mysql"
}

# MySQL major-version note: 8.0.3 (and most early 8.0.x minors) are no longer creatable — AWS retires old
# minor versions from NEW-instance creation on a rolling basis, even though existing instances keep
# running. Before applying, confirm what's actually creatable right now:
#   aws rds describe-db-engine-versions --engine mysql --region <region> \
#     --query 'DBEngineVersions[].EngineVersion' --output table
# Pick the OLDEST version that command still lists if the goal is "oldest currently-creatable major/minor"
# rather than a specific historical version. The default below is a reasonable starting guess, not a
# guarantee — override with -var=engine_version=... once you've checked.
variable "engine_version" {
  description = "MySQL engine version to create — verify it's still creatable in this region first (see comment above)."
  type        = string
  default     = "8.0.28"
}

variable "instance_class" {
  description = "Cheapest reasonable class for a throwaway test fixture."
  type        = string
  default     = "db.t3.micro"
}

variable "allocated_storage" {
  description = "Storage in GB — minimal, this instance never holds real data."
  type        = number
  default     = 20
}

variable "db_name" {
  description = "Initial database name created on the instance."
  type        = string
  default     = "fixture"
}

variable "master_username" {
  description = "Master username. The password is NOT set here — see main.tf's manage_master_user_password."
  type        = string
  default     = "fixtureadmin"
}

variable "allowed_cidr_blocks" {
  description = <<-EOT
    CIDR blocks allowed to reach port 3306 (e.g. your VPN range, or the CIDR of whatever will run the
    rdsupgrade extension against this instance). Required — no open-to-the-world default, even for a
    throwaway fixture in a sandbox account.
  EOT
  type        = list(string)
}
