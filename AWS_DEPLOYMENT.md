# CivilClaw — AWS Deployment Reference

## Live URL

**http://civilclaw-alb-1249569867.us-east-1.elb.amazonaws.com**

---

## Stack Overview

| Component | Service | Details |
|-----------|---------|---------|
| **Compute** | ECS Fargate | 1 vCPU, 4 GB RAM |
| **Container Registry** | ECR | `324037324697.dkr.ecr.us-east-1.amazonaws.com/civilclaw` |
| **Load Balancer** | ALB | `civilclaw-alb` — HTTP on port 80 → container port 3001 |
| **Secrets** | Secrets Manager | `civilclaw/openai-api-key`, `civilclaw/anthropic-api-key` |
| **Logs** | CloudWatch | Log group `/ecs/civilclaw` (30-day retention) |
| **CI/CD** | GitHub Actions | Auto-deploy on push to `main` |
| **Region** | us-east-1 | |
| **Account** | 324037324697 | |

### Docker Image

Multi-stage build (3 stages):
1. **python-deps** — Python 3.11 + pip packages (ifcopenshell, ezdxf, trimesh, open3d, laspy, numpy)
2. **builder** — Node.js 22 + pnpm, builds TypeScript backend + React frontend
3. **runtime** — Python 3.11 base + Node.js 22, production deps only, serves on port 3001

**Important:** Must build with `--platform linux/amd64` on Apple Silicon Macs (Fargate runs x86_64).

---

## AWS Resource IDs

```
Account ID:         324037324697
ECR Repository:     324037324697.dkr.ecr.us-east-1.amazonaws.com/civilclaw
ECS Cluster:        civilclaw
ECS Service:        civilclaw-api
Task Definition:    civilclaw:2
ALB:                civilclaw-alb (arn:aws:elasticloadbalancing:us-east-1:324037324697:loadbalancer/app/civilclaw-alb/58476e834dcfb8e0)
ALB DNS:            civilclaw-alb-1249569867.us-east-1.elb.amazonaws.com
Target Group:       civilclaw-tg (arn:aws:elasticloadbalancing:us-east-1:324037324697:targetgroup/civilclaw-tg/bfe85dc6477e2c5c)
ALB Security Group: sg-000ee20c26b3a446a (civilclaw-alb-sg — ports 80, 443 from 0.0.0.0/0)
ECS Security Group: sg-0f09d69458e00340e (civilclaw-ecs-sg — port 3001 from ALB SG only)
VPC:                vpc-04a495305334ab696 (default)
Subnets:            subnet-0ef6c9d61b7ac740a (us-east-1a), subnet-048381d0a1f40590b (us-east-1c)
Log Group:          /ecs/civilclaw
IAM Execution Role: ecsTaskExecutionRole
IAM Task Role:      ecsTaskRole
```

### Secrets Manager ARNs (with random suffix)

```
OpenAI:    arn:aws:secretsmanager:us-east-1:324037324697:secret:civilclaw/openai-api-key-pcmAkH
Anthropic: arn:aws:secretsmanager:us-east-1:324037324697:secret:civilclaw/anthropic-api-key-LH6Kvd
```

---

## Environment Variables (in Task Definition)

| Variable | Source | Value |
|----------|--------|-------|
| `NODE_ENV` | environment | `production` |
| `PORT` | environment | `3001` |
| `CIVILCLAW_PROVIDER` | environment | `openai` |
| `CIVILCLAW_MODEL` | environment | `gpt-5.2` |
| `OPENAI_API_KEY` | Secrets Manager | `civilclaw/openai-api-key` |
| `ANTHROPIC_API_KEY` | Secrets Manager | `civilclaw/anthropic-api-key` |

---

## Common Operations

### View logs

```bash
# Recent logs
aws logs tail /ecs/civilclaw --region us-east-1 --since 1h

# Follow live
aws logs tail /ecs/civilclaw --region us-east-1 --follow
```

### Manual deploy (rebuild & push)

```bash
# Authenticate with ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin 324037324697.dkr.ecr.us-east-1.amazonaws.com

# Build for amd64 (required on Apple Silicon)
docker build --platform linux/amd64 \
  -t 324037324697.dkr.ecr.us-east-1.amazonaws.com/civilclaw:latest .

# Push
docker push 324037324697.dkr.ecr.us-east-1.amazonaws.com/civilclaw:latest

# Force ECS to pull the new image
aws ecs update-service --cluster civilclaw --service civilclaw-api \
  --force-new-deployment --region us-east-1

# Wait for rollout
aws ecs wait services-stable --cluster civilclaw --services civilclaw-api --region us-east-1
```

### Update a secret

```bash
aws secretsmanager update-secret \
  --secret-id civilclaw/openai-api-key \
  --secret-string "sk-new-key-here" \
  --region us-east-1

# Force restart to pick up new secret
aws ecs update-service --cluster civilclaw --service civilclaw-api \
  --force-new-deployment --region us-east-1
```

### Change model/provider

Update the task definition environment variables, re-register, and deploy:

```bash
# Edit /tmp/civilclaw-task-def.json (change CIVILCLAW_PROVIDER / CIVILCLAW_MODEL)
aws ecs register-task-definition --cli-input-json file:///tmp/civilclaw-task-def.json --region us-east-1
aws ecs update-service --cluster civilclaw --service civilclaw-api \
  --task-definition civilclaw --force-new-deployment --region us-east-1
```

### Scale up/down

```bash
# Scale to 0 (stop — saves cost)
aws ecs update-service --cluster civilclaw --service civilclaw-api \
  --desired-count 0 --region us-east-1

# Scale back to 1
aws ecs update-service --cluster civilclaw --service civilclaw-api \
  --desired-count 1 --region us-east-1
```

### Check service health

```bash
# Service status
aws ecs describe-services --cluster civilclaw --services civilclaw-api --region us-east-1 \
  --query "services[0].{status:status,running:runningCount,desired:desiredCount}"

# Health check endpoint
curl -s http://civilclaw-alb-1249569867.us-east-1.elb.amazonaws.com/api/status | python3 -m json.tool

# Target group health
aws elbv2 describe-target-health \
  --target-group-arn arn:aws:elasticloadbalancing:us-east-1:324037324697:targetgroup/civilclaw-tg/bfe85dc6477e2c5c \
  --region us-east-1
```

---

## GitHub Actions CI/CD

Workflow: `.github/workflows/deploy.yml`

**Triggers:** Push to `main` branch

**Required GitHub Secrets:**
- `AWS_ACCESS_KEY_ID` — from IAM user `civilclaw-deployer`
- `AWS_SECRET_ACCESS_KEY` — from IAM user `civilclaw-deployer`

**What it does:**
1. Checks out code
2. Authenticates with AWS + ECR
3. Builds Docker image (tagged with git SHA + `latest`)
4. Pushes to ECR
5. Renders new task definition with updated image
6. Deploys to ECS and waits for stability

**Note:** The workflow needs a `sed` step added before the render-task-definition step to replace `ACCOUNT_ID` placeholders. Alternatively, hardcode the account ID in `deploy/ecs-task-definition.json`.

---

## Cost Estimate

| Resource | Monthly Cost |
|----------|-------------|
| Fargate (1 vCPU, 4 GB, 24/7) | ~$42 |
| ALB (base + low traffic) | ~$22 |
| CloudWatch Logs | ~$1 |
| Secrets Manager (2 secrets) | ~$1 |
| ECR storage | ~$1 |
| **Total** | **~$67/month** |

**To reduce cost:** Scale to 0 when not in use (`desired-count 0`). At ~$0.058/hr, running 8 hrs/day = ~$14/month for Fargate.

---

## Future: Add HTTPS

When ready for a custom domain with HTTPS:

1. Request an ACM certificate: `aws acm request-certificate --domain-name civilclaw.yourdomain.com`
2. Validate via DNS (add the CNAME record ACM gives you)
3. Add HTTPS listener on port 443 to the ALB
4. Redirect HTTP (port 80) to HTTPS
5. Point your domain CNAME to `civilclaw-alb-1249569867.us-east-1.elb.amazonaws.com`

---

## Teardown (delete everything)

```bash
# 1. Delete ECS service
aws ecs update-service --cluster civilclaw --service civilclaw-api --desired-count 0 --region us-east-1
aws ecs delete-service --cluster civilclaw --service civilclaw-api --force --region us-east-1

# 2. Delete ECS cluster
aws ecs delete-cluster --cluster civilclaw --region us-east-1

# 3. Delete ALB + target group + listener
aws elbv2 delete-load-balancer --load-balancer-arn arn:aws:elasticloadbalancing:us-east-1:324037324697:loadbalancer/app/civilclaw-alb/58476e834dcfb8e0 --region us-east-1
aws elbv2 delete-target-group --target-group-arn arn:aws:elasticloadbalancing:us-east-1:324037324697:targetgroup/civilclaw-tg/bfe85dc6477e2c5c --region us-east-1

# 4. Delete security groups
aws ec2 delete-security-group --group-id sg-0f09d69458e00340e --region us-east-1
aws ec2 delete-security-group --group-id sg-000ee20c26b3a446a --region us-east-1

# 5. Delete ECR repository (and all images)
aws ecr delete-repository --repository-name civilclaw --force --region us-east-1

# 6. Delete secrets
aws secretsmanager delete-secret --secret-id civilclaw/openai-api-key --force-delete-without-recovery --region us-east-1
aws secretsmanager delete-secret --secret-id civilclaw/anthropic-api-key --force-delete-without-recovery --region us-east-1

# 7. Delete log group
aws logs delete-log-group --log-group-name /ecs/civilclaw --region us-east-1

# 8. Delete IAM roles and policies
aws iam delete-role-policy --role-name ecsTaskExecutionRole --policy-name SecretsManagerRead
aws iam detach-role-policy --role-name ecsTaskExecutionRole --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam delete-role --role-name ecsTaskExecutionRole
aws iam delete-role --role-name ecsTaskRole

# 9. Delete CI/CD user
aws iam detach-user-policy --user-name civilclaw-deployer --policy-arn arn:aws:iam::324037324697:policy/civilclaw-deploy-policy
aws iam delete-access-key --user-name civilclaw-deployer --access-key-id <KEY_ID>
aws iam delete-user --user-name civilclaw-deployer
aws iam delete-policy --policy-arn arn:aws:iam::324037324697:policy/civilclaw-deploy-policy
```
