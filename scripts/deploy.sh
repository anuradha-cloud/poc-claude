#!/usr/bin/env bash
# Build, push to ECR, and deploy to ECS Fargate.
# Run setup-infra.sh first if this is your first deployment.

set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

ECR_REPO="claude-ecs-app"
ECR_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO"
CLUSTER_NAME="claude-cluster"
SERVICE_NAME="claude-service"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Deploying claude-ecs-app"
echo "    Region:  $AWS_REGION"
echo "    Account: $AWS_ACCOUNT_ID"
echo ""

# --------------------------------------------------------------------------
# 1. Login to ECR
# --------------------------------------------------------------------------
echo "[1/5] Logging in to ECR..."
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_URI"

# --------------------------------------------------------------------------
# 2. Build and push Docker image (linux/amd64 for Fargate)
# --------------------------------------------------------------------------
echo "[2/5] Building Docker image..."
docker build --platform linux/amd64 -t "$ECR_REPO:latest" "$ROOT_DIR"
docker tag "$ECR_REPO:latest" "$ECR_URI:latest"

echo "      Pushing to ECR..."
docker push "$ECR_URI:latest"
echo "      Pushed: $ECR_URI:latest"

# --------------------------------------------------------------------------
# 3. Register a new task definition revision
# --------------------------------------------------------------------------
echo "[3/5] Registering task definition..."
TASK_DEF_JSON=$(sed \
  -e "s/{{ACCOUNT_ID}}/$AWS_ACCOUNT_ID/g" \
  -e "s/{{REGION}}/$AWS_REGION/g" \
  "$ROOT_DIR/ecs/task-definition.json")

TASK_DEF_ARN=$(aws ecs register-task-definition \
  --region "$AWS_REGION" \
  --cli-input-json "$TASK_DEF_JSON" \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)
echo "      Registered: $TASK_DEF_ARN"

# --------------------------------------------------------------------------
# 4. Resolve default VPC networking
# --------------------------------------------------------------------------
echo "[4/5] Resolving default VPC networking..."
DEFAULT_VPC=$(aws ec2 describe-vpcs \
  --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text --region "$AWS_REGION")

SUBNET=$(aws ec2 describe-subnets \
  --filters "Name=vpc-id,Values=$DEFAULT_VPC" \
  --query 'Subnets[0].SubnetId' --output text --region "$AWS_REGION")

SG=$(aws ec2 describe-security-groups \
  --filters "Name=vpc-id,Values=$DEFAULT_VPC" "Name=group-name,Values=default" \
  --query 'SecurityGroups[0].GroupId' --output text --region "$AWS_REGION")

echo "      VPC=$DEFAULT_VPC  Subnet=$SUBNET  SG=$SG"

# --------------------------------------------------------------------------
# 5. Create or update ECS service
# --------------------------------------------------------------------------
echo "[5/5] Deploying service '$SERVICE_NAME'..."
SERVICE_STATUS=$(aws ecs describe-services \
  --cluster "$CLUSTER_NAME" \
  --services "$SERVICE_NAME" \
  --region "$AWS_REGION" \
  --query 'services[0].status' --output text 2>/dev/null || echo "MISSING")

if [ "$SERVICE_STATUS" = "ACTIVE" ]; then
  aws ecs update-service \
    --cluster "$CLUSTER_NAME" \
    --service "$SERVICE_NAME" \
    --task-definition "$TASK_DEF_ARN" \
    --region "$AWS_REGION" \
    --output json | jq -r '.service.serviceArn' | xargs echo "      Updated:"
else
  aws ecs create-service \
    --cluster "$CLUSTER_NAME" \
    --service-name "$SERVICE_NAME" \
    --task-definition "$TASK_DEF_ARN" \
    --launch-type FARGATE \
    --desired-count 1 \
    --network-configuration \
      "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=ENABLED}" \
    --region "$AWS_REGION" \
    --output json | jq -r '.service.serviceArn' | xargs echo "      Created:"
fi

echo ""
echo "Deployment triggered. The task usually starts within ~30 seconds."
echo ""
echo "--- How to find your ngrok URL ---"
echo "Option A (ngrok dashboard): https://dashboard.ngrok.com/tunnels"
echo ""
echo "Option B (via task public IP):"
echo "  TASK_ARN=\$(aws ecs list-tasks --cluster $CLUSTER_NAME --region $AWS_REGION --query 'taskArns[0]' --output text)"
echo "  ENI=\$(aws ecs describe-tasks --cluster $CLUSTER_NAME --tasks \$TASK_ARN --region $AWS_REGION --query 'tasks[0].attachments[0].details[?name==\`networkInterfaceId\`].value' --output text)"
echo "  PUBLIC_IP=\$(aws ec2 describe-network-interfaces --network-interface-ids \$ENI --region $AWS_REGION --query 'NetworkInterfaces[0].Association.PublicIp' --output text)"
echo "  curl http://\$PUBLIC_IP:3000/tunnel-url"
