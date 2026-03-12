#!/usr/bin/env bash
# One-time AWS infrastructure setup for claude-ecs-app.
# Run this once before the first deployment.
# Prerequisites: AWS CLI configured, jq installed.

set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

ECR_REPO="claude-ecs-app"
CLUSTER_NAME="claude-cluster"
LOG_GROUP="/ecs/claude-ecs-app"
SECRET_PREFIX="claude-ecs-app"
ROLE_NAME="ecsTaskExecutionRole"

echo "==> Setting up infrastructure"
echo "    Region:  $AWS_REGION"
echo "    Account: $AWS_ACCOUNT_ID"
echo ""

# --------------------------------------------------------------------------
# 1. ECR repository
# --------------------------------------------------------------------------
echo "[1/6] Creating ECR repository '$ECR_REPO'..."
aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$AWS_REGION" &>/dev/null \
  && echo "      Already exists — skipping." \
  || aws ecr create-repository \
       --repository-name "$ECR_REPO" \
       --region "$AWS_REGION" \
       --image-scanning-configuration scanOnPush=true \
       --output json | jq -r '.repository.repositoryUri' | xargs echo "      Created:"

# --------------------------------------------------------------------------
# 2. CloudWatch log group
# --------------------------------------------------------------------------
echo "[2/6] Creating CloudWatch log group '$LOG_GROUP'..."
aws logs describe-log-groups --log-group-name-prefix "$LOG_GROUP" --region "$AWS_REGION" \
  | jq -r '.logGroups[].logGroupName' | grep -qxF "$LOG_GROUP" \
  && echo "      Already exists — skipping." \
  || aws logs create-log-group --log-group-name "$LOG_GROUP" --region "$AWS_REGION" \
       && echo "      Created."

# --------------------------------------------------------------------------
# 3. ECS cluster
# --------------------------------------------------------------------------
echo "[3/6] Creating ECS cluster '$CLUSTER_NAME'..."
STATUS=$(aws ecs describe-clusters --clusters "$CLUSTER_NAME" --region "$AWS_REGION" \
  --query 'clusters[0].status' --output text 2>/dev/null || echo "MISSING")
if [ "$STATUS" = "ACTIVE" ]; then
  echo "      Already active — skipping."
else
  aws ecs create-cluster \
    --cluster-name "$CLUSTER_NAME" \
    --capacity-providers FARGATE \
    --region "$AWS_REGION" \
    --output json | jq -r '.cluster.clusterArn' | xargs echo "      Created:"
fi

# --------------------------------------------------------------------------
# 4. IAM task execution role
# --------------------------------------------------------------------------
echo "[4/6] Creating IAM role '$ROLE_NAME'..."
aws iam get-role --role-name "$ROLE_NAME" &>/dev/null \
  && echo "      Already exists — skipping." \
  || {
    aws iam create-role \
      --role-name "$ROLE_NAME" \
      --assume-role-policy-document '{
        "Version": "2012-10-17",
        "Statement": [{
          "Effect": "Allow",
          "Principal": {"Service": "ecs-tasks.amazonaws.com"},
          "Action": "sts:AssumeRole"
        }]
      }' --output json | jq -r '.Role.Arn' | xargs echo "      Created:"

    aws iam attach-role-policy \
      --role-name "$ROLE_NAME" \
      --policy-arn "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"

    # Secrets Manager read access so the task can pull secrets
    aws iam attach-role-policy \
      --role-name "$ROLE_NAME" \
      --policy-arn "arn:aws:iam::aws:policy/SecretsManagerReadWrite"

    echo "      Policies attached."
  }

# --------------------------------------------------------------------------
# 5. Secrets Manager — ANTHROPIC_API_KEY
# --------------------------------------------------------------------------
echo "[5/6] Storing ANTHROPIC_API_KEY in Secrets Manager..."
aws secretsmanager describe-secret \
  --secret-id "$SECRET_PREFIX/ANTHROPIC_API_KEY" --region "$AWS_REGION" &>/dev/null \
  && echo "      Already exists — skipping (update manually if needed)." \
  || {
    read -r -p "      Enter ANTHROPIC_API_KEY: " -s ANTHROPIC_API_KEY; echo ""
    aws secretsmanager create-secret \
      --name "$SECRET_PREFIX/ANTHROPIC_API_KEY" \
      --secret-string "$ANTHROPIC_API_KEY" \
      --region "$AWS_REGION" --output json | jq -r '.ARN' | xargs echo "      Created:"
  }

# --------------------------------------------------------------------------
# 6. Secrets Manager — NGROK_AUTHTOKEN
# --------------------------------------------------------------------------
echo "[6/6] Storing NGROK_AUTHTOKEN in Secrets Manager..."
aws secretsmanager describe-secret \
  --secret-id "$SECRET_PREFIX/NGROK_AUTHTOKEN" --region "$AWS_REGION" &>/dev/null \
  && echo "      Already exists — skipping (update manually if needed)." \
  || {
    read -r -p "      Enter NGROK_AUTHTOKEN: " -s NGROK_AUTHTOKEN; echo ""
    aws secretsmanager create-secret \
      --name "$SECRET_PREFIX/NGROK_AUTHTOKEN" \
      --secret-string "$NGROK_AUTHTOKEN" \
      --region "$AWS_REGION" --output json | jq -r '.ARN' | xargs echo "      Created:"
  }

echo ""
echo "Infrastructure setup complete!"
echo "Next step: run  ./scripts/deploy.sh  to build and deploy the app."
