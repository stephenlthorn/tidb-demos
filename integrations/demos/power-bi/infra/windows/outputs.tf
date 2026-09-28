output "instance_id" {
  value = aws_instance.power_bi_desktop.id
}

output "public_ip" {
  value = aws_instance.power_bi_desktop.public_ip
}

output "private_key_path" {
  description = "Local, gitignored path to the PEM used to decrypt the Windows Administrator password."
  value       = local_file.windows_private_key.filename
}

output "get_password_data_command" {
  description = "Run this once the instance has been up for a few minutes (Windows needs time to generate the password); it prints the decrypted Administrator password."
  value       = "aws ec2 get-password-data --instance-id ${aws_instance.power_bi_desktop.id} --priv-launch-key ${local_file.windows_private_key.filename} --region ${var.aws_region} --profile ${var.aws_profile}"
}

output "rdp_target" {
  description = "Connect an RDP client (e.g. Microsoft Remote Desktop) to this address as user Administrator."
  value       = "${aws_instance.power_bi_desktop.public_ip}:3389"
}
