output "vpc_id" {
  value = aws_vpc.this.id
}

output "subnet_ids" {
  value = [for s in aws_subnet.this : s.id]
}

output "security_group_id" {
  value = aws_security_group.this.id
}
