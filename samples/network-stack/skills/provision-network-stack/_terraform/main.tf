# Networks-only root: one VPC, its subnets, one security group. Deliberately tiny — this sample
# teaches the PROVISIONING SHAPE (background terraform + watch loop + on-demand plan/apply), not AWS
# networking. Credentials come from the scope the platform lands in the ticket cwd
# (.aws/credentials via AWS_SHARED_CREDENTIALS_FILE — see reference/07-scope-credentials.md).

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
  # State stays LOCAL in the writable per-ticket workdir (.tf-work/), which persists across runs of the
  # resource's long-lived ticket. A production extension points this at a remote backend (S3 + lock).
}

provider "aws" {
  region = var.region
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = var.enable_dns_hostnames
  tags                 = merge(var.tags, { Name = var.name })
}

resource "aws_subnet" "this" {
  for_each = { for s in var.subnets : s.name => s }

  vpc_id     = aws_vpc.this.id
  cidr_block = each.value.cidr
  # Explicit AZ suffix when given (e.g. "a" -> "<region>a"); otherwise spread across available AZs.
  availability_zone = each.value.az != null && each.value.az != "" ? "${var.region}${each.value.az}" : data.aws_availability_zones.available.names[index(keys({ for s in var.subnets : s.name => s }), each.key) % length(data.aws_availability_zones.available.names)]
  tags              = merge(var.tags, { Name = "${var.name}-${each.key}" })
}

resource "aws_security_group" "this" {
  name        = "${var.name}-default"
  description = "Default security group for ${var.name} (egress-only)"
  vpc_id      = aws_vpc.this.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${var.name}-default" })
}
