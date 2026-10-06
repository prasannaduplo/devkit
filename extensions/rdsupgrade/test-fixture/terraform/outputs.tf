output "db_instance_identifier" {
  description = "Feed this into rdsupgrade's DbInstanceIdentifier spec field."
  value       = aws_db_instance.fixture.identifier
}

output "engine_version" {
  value = aws_db_instance.fixture.engine_version
}

output "endpoint" {
  value = aws_db_instance.fixture.endpoint
}

output "master_user_secret_arn" {
  description = "Secrets Manager ARN holding the auto-managed master password (manage_master_user_password)."
  value       = aws_db_instance.fixture.master_user_secret[0].secret_arn
}

output "security_group_id" {
  value = aws_security_group.fixture.id
}
