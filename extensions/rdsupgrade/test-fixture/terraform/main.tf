# Throwaway RDS MySQL instance, pinned to an old engine version, for repeatedly testing the `rdsupgrade`
# extension's Blue/Green upgrade path: create this fixture -> point rdsupgrade at it -> let it upgrade ->
# `terraform destroy` -> repeat. Not meant to hold real data and not meant to survive between test runs.
#
# Uses the account's default VPC so this has no dependency on pre-existing Duplo-managed infrastructure —
# this account isn't attached to a workspace scope yet. Point `allowed_cidr_blocks` at wherever the
# extension/test runner actually connects from.

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_db_subnet_group" "fixture" {
  name       = "${var.identifier}-subnets"
  subnet_ids = data.aws_subnets.default.ids
}

resource "aws_security_group" "fixture" {
  name        = "${var.identifier}-sg"
  description = "Allows MySQL access to the rdsupgrade test fixture"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "MySQL"
    from_port   = 3306
    to_port     = 3306
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_instance" "fixture" {
  identifier     = var.identifier
  engine         = "mysql"
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage = var.allocated_storage
  storage_type      = "gp3"

  db_name  = var.db_name
  username = var.master_username
  # AWS-managed master password in Secrets Manager — Terraform state never holds a plaintext credential.
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.fixture.name
  vpc_security_group_ids = [aws_security_group.fixture.id]
  publicly_accessible    = false
  multi_az               = false

  # This instance is disposable by design — no deletion protection, no final snapshot on destroy, and
  # a manual snapshot isn't taken here because there's nothing worth keeping (rdsupgrade takes its own
  # pre-upgrade snapshot as part of its Snapshotting phase).
  deletion_protection = false
  skip_final_snapshot = true

  apply_immediately = true
}
