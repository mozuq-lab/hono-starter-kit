output "alb_arn" {
  description = "ARN of the internal application load balancer."
  value       = aws_lb.api.arn
}

output "alb_dns_name" {
  description = "Private DNS name of the internal application load balancer."
  value       = aws_lb.api.dns_name
}

output "listener_arn" {
  description = "ARN of the internal HTTP listener."
  value       = aws_lb_listener.http.arn
}

output "target_group_arn" {
  description = "ARN of the application IP target group."
  value       = aws_lb_target_group.api.arn
}
