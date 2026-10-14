variable "name" {
  type        = string
  description = "Resource name — prefixes every AWS object's Name tag."
}

variable "region" {
  type        = string
  description = "AWS region (e.g. us-east-1)."
}

variable "vpc_cidr" {
  type        = string
  description = "The VPC's CIDR block (e.g. 10.20.0.0/16)."
}

variable "enable_dns_hostnames" {
  type        = bool
  default     = true
  description = "Give instances public DNS hostnames inside the VPC."
}

variable "subnets" {
  type = list(object({
    name = string
    cidr = string
    az   = optional(string)
  }))
  description = "Subnets to carve out of the VPC."
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Extra tags applied to every object."
}
