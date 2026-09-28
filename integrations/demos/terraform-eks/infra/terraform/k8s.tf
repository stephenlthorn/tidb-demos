locals {
  tidb_host = var.connection_mode == "private" ? tidbcloud_dedicated_private_endpoint_connection.this[0].host : tidbcloud_dedicated_cluster.this.tidb_node_setting.endpoints[0].host
  tidb_port = var.connection_mode == "private" ? tidbcloud_dedicated_private_endpoint_connection.this[0].port : tidbcloud_dedicated_cluster.this.tidb_node_setting.endpoints[0].port
}

resource "kubernetes_secret_v1" "tidb_dsn" {
  metadata {
    name = "tidb-dsn"
  }
  data = {
    TIDB_HOST     = local.tidb_host
    TIDB_PORT     = tostring(local.tidb_port)
    TIDB_USER     = "root"
    TIDB_PASSWORD = var.tidb_root_password
    TIDB_TLS      = "true"
  }
}

resource "kubernetes_deployment_v1" "app" {
  metadata {
    name   = "lab-app"
    labels = { app = "lab-app" }
  }
  spec {
    replicas = 2
    selector {
      match_labels = { app = "lab-app" }
    }
    template {
      metadata {
        labels = { app = "lab-app" }
      }
      spec {
        container {
          name  = "app"
          image = var.app_image
          port {
            container_port = 8080
          }
          env_from {
            secret_ref {
              name = kubernetes_secret_v1.tidb_dsn.metadata[0].name
            }
          }
        }
      }
    }
  }
}

resource "kubernetes_service_v1" "app" {
  metadata {
    name = "lab-app"
  }
  spec {
    selector = { app = "lab-app" }
    port {
      port        = 80
      target_port = 8080
    }
    # ClusterIP, not LoadBalancer: a LoadBalancer Service's ELB and its ENIs
    # are provisioned by the AWS cloud-controller-manager, not by
    # Terraform, so they never show up in terraform state and can block
    # `terraform destroy` from deleting the VPC's subnets/security groups
    # (the classic "DependencyViolation" failure). The runner reaches this
    # Service with `kubectl port-forward` instead (see
    # runner/src/port-forward.ts), which needs no AWS-side resource at all.
    type = "ClusterIP"
  }
}
