# VA Dashboard - Deployment Guide

This guide covers deploying the VA Dashboard using Docker, Docker Compose, and Kubernetes.

## Prerequisites

- Docker 20.10+
- Docker Compose 2.0+ (for local deployment)
- Kubernetes 1.20+ (for production deployment)
- MySQL 8.0+
- Redis 7+ (optional but recommended)

## Environment Variables

Create a `.env` file with the following variables:

```bash
# Database
DATABASE_URL=mysql://user:password@host:3306/va_dashboard
MYSQL_ROOT_PASSWORD=your_root_password
MYSQL_DATABASE=va_dashboard
MYSQL_USER=va_user
MYSQL_PASSWORD=va_password

# Redis (optional but recommended)
REDIS_URL=redis://redis:6379

# Trello Integration
TRELLO_API_KEY=your_trello_api_key
TRELLO_TOKEN=your_trello_token

# Authentication
JWT_SECRET=your_jwt_secret_min_32_characters

# Owner Configuration
OWNER_NAME=Your Name
OWNER_OPEN_ID=your_trello_user_id

# Application
VITE_APP_TITLE=VA Task Dashboard
VITE_APP_LOGO=/logo.png
PUBLIC_URL=https://your-domain.com
PORT=3000

# Email Notifications (optional)
SENDGRID_API_KEY=your_sendgrid_api_key
SENDGRID_FROM_EMAIL=noreply@yourdomain.com
NOTIFICATIONS_ENABLED=false

# LLM Providers (at least one required for ATIS)
GROQ_API_KEY=your_groq_api_key
TOGETHER_API_KEY=your_together_api_key
OPENROUTER_API_KEY=your_openrouter_api_key
OLLAMA_URL=http://localhost:11434

# Logging
LOG_LEVEL=INFO

# Rate Limiting
MAX_CONCURRENT_REQUESTS=100
REQUEST_QUEUE_TIMEOUT_MS=30000
```

## Local Development with Docker Compose

### 1. Build and Start Services

```bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f app

# Stop services
docker-compose down

# Stop and remove volumes (WARNING: deletes data)
docker-compose down -v
```

### 2. Run Database Migrations

```bash
# Run migrations
docker-compose exec app pnpm db:push
```

### 3. Access the Application

- Application: http://localhost:3000
- MySQL: localhost:3306
- Redis: localhost:6379

## Production Deployment

### Option 1: Docker Compose (Single Server)

1. **Prepare the server:**
```bash
# Install Docker and Docker Compose
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
```

2. **Deploy the application:**
```bash
# Clone repository
git clone <your-repo-url>
cd va-dashboard

# Create .env file with production values
cp .env.example .env
nano .env

# Start services
docker-compose up -d

# Run migrations
docker-compose exec app pnpm db:push

# Check health
curl http://localhost:3000/api/health
```

3. **Set up reverse proxy (nginx):**
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket support
    location /ws {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

4. **Enable SSL with Let's Encrypt:**
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

### Option 2: Kubernetes Deployment

1. **Create namespace:**
```bash
kubectl create namespace va-dashboard
```

2. **Create secrets:**
```bash
kubectl create secret generic va-dashboard-secrets \
  --from-literal=database-url='mysql://user:password@mysql:3306/va_dashboard' \
  --from-literal=jwt-secret='your_jwt_secret' \
  --from-literal=trello-api-key='your_trello_api_key' \
  --from-literal=trello-token='your_trello_token' \
  --from-literal=groq-api-key='your_groq_api_key' \
  -n va-dashboard
```

3. **Deploy MySQL:**
```yaml
# mysql-deployment.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: mysql-pvc
  namespace: va-dashboard
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 20Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mysql
  namespace: va-dashboard
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mysql
  template:
    metadata:
      labels:
        app: mysql
    spec:
      containers:
      - name: mysql
        image: mysql:9.7.2
        env:
        - name: MYSQL_ROOT_PASSWORD
          valueFrom:
            secretKeyRef:
              name: va-dashboard-secrets
              key: mysql-root-password
        - name: MYSQL_DATABASE
          value: va_dashboard
        ports:
        - containerPort: 3306
        volumeMounts:
        - name: mysql-storage
          mountPath: /var/lib/mysql
      volumes:
      - name: mysql-storage
        persistentVolumeClaim:
          claimName: mysql-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: mysql
  namespace: va-dashboard
spec:
  selector:
    app: mysql
  ports:
  - port: 3306
    targetPort: 3306
```

4. **Deploy Redis:**
```yaml
# redis-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  namespace: va-dashboard
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
      - name: redis
        image: redis:7-alpine
        ports:
        - containerPort: 6379
---
apiVersion: v1
kind: Service
metadata:
  name: redis
  namespace: va-dashboard
spec:
  selector:
    app: redis
  ports:
  - port: 6379
    targetPort: 6379
```

5. **Deploy Application:**
```yaml
# app-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: va-dashboard
  namespace: va-dashboard
spec:
  replicas: 3
  selector:
    matchLabels:
      app: va-dashboard
  template:
    metadata:
      labels:
        app: va-dashboard
    spec:
      containers:
      - name: va-dashboard
        image: your-registry/va-dashboard:latest
        ports:
        - containerPort: 3000
        env:
        - name: NODE_ENV
          value: production
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: va-dashboard-secrets
              key: database-url
        - name: REDIS_URL
          value: redis://redis:6379
        - name: JWT_SECRET
          valueFrom:
            secretKeyRef:
              name: va-dashboard-secrets
              key: jwt-secret
        - name: TRELLO_API_KEY
          valueFrom:
            secretKeyRef:
              name: va-dashboard-secrets
              key: trello-api-key
        - name: TRELLO_TOKEN
          valueFrom:
            secretKeyRef:
              name: va-dashboard-secrets
              key: trello-token
        livenessProbe:
          httpGet:
            path: /api/health/live
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /api/health/ready
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 5
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
---
apiVersion: v1
kind: Service
metadata:
  name: va-dashboard
  namespace: va-dashboard
spec:
  selector:
    app: va-dashboard
  ports:
  - port: 80
    targetPort: 3000
  type: LoadBalancer
```

6. **Apply configurations:**
```bash
kubectl apply -f mysql-deployment.yaml
kubectl apply -f redis-deployment.yaml
kubectl apply -f app-deployment.yaml
```

7. **Run migrations:**
```bash
kubectl exec -it deployment/va-dashboard -n va-dashboard -- pnpm db:push
```

## Monitoring and Logging

### Health Checks

- **Liveness:** `GET /api/health/live` - Returns 200 if app is running
- **Readiness:** `GET /api/health/ready` - Returns 200 if app is ready to serve traffic
- **Health:** `GET /api/health` - Returns detailed health status

### Logs

```bash
# Docker Compose
docker-compose logs -f app

# Kubernetes
kubectl logs -f deployment/va-dashboard -n va-dashboard

# View specific container logs
kubectl logs -f pod-name -c va-dashboard -n va-dashboard
```

### Metrics

The application exposes the following metrics:

- Cache hit/miss rates
- Request queue statistics
- WebSocket connection count
- API response times
- Error rates

## Backup and Recovery

### Database Backup

```bash
# Docker Compose
docker-compose exec mysql mysqldump -u root -p va_dashboard > backup.sql

# Kubernetes
kubectl exec -it deployment/mysql -n va-dashboard -- mysqldump -u root -p va_dashboard > backup.sql
```

### Database Restore

```bash
# Docker Compose
docker-compose exec -T mysql mysql -u root -p va_dashboard < backup.sql

# Kubernetes
kubectl exec -i deployment/mysql -n va-dashboard -- mysql -u root -p va_dashboard < backup.sql
```

## Scaling

### Horizontal Scaling

```bash
# Docker Compose (not recommended for production)
docker-compose up -d --scale app=3

# Kubernetes
kubectl scale deployment va-dashboard --replicas=5 -n va-dashboard
```

### Vertical Scaling

Update resource limits in `app-deployment.yaml` and reapply:

```yaml
resources:
  requests:
    memory: "1Gi"
    cpu: "1000m"
  limits:
    memory: "4Gi"
    cpu: "4000m"
```

## Troubleshooting

### Application won't start

1. Check logs: `docker-compose logs app` or `kubectl logs deployment/va-dashboard`
2. Verify environment variables are set correctly
3. Ensure database is accessible
4. Check disk space and memory

### Database connection errors

1. Verify DATABASE_URL is correct
2. Check MySQL is running: `docker-compose ps mysql`
3. Test connection: `docker-compose exec mysql mysql -u root -p`

### High memory usage

1. Check for memory leaks in logs
2. Reduce MAX_CONCURRENT_REQUESTS
3. Enable Redis caching
4. Scale horizontally instead of vertically

### WebSocket connection issues

1. Ensure reverse proxy supports WebSocket upgrades
2. Check firewall rules allow WebSocket connections
3. Verify Redis is running for multi-instance deployments

## Security Checklist

- [ ] Change all default passwords
- [ ] Use strong JWT_SECRET (min 32 characters)
- [ ] Enable HTTPS with valid SSL certificate
- [ ] Configure firewall to allow only necessary ports
- [ ] Set up regular database backups
- [ ] Enable Redis authentication in production
- [ ] Use secrets management (AWS Secrets Manager, HashiCorp Vault)
- [ ] Configure rate limiting appropriately
- [ ] Enable logging and monitoring
- [ ] Keep Docker images updated
- [ ] Use non-root user in containers (already configured)
- [ ] Scan images for vulnerabilities

## Performance Tuning

### Database Optimization

```sql
-- Add indexes for frequently queried columns
CREATE INDEX idx_task_assignments_founder ON task_assignments(founderId);
CREATE INDEX idx_task_assignments_status ON task_assignments(status);
CREATE INDEX idx_trello_cache_user ON trello_cache_metadata(userId, userOpenId);
```

### Redis Configuration

```bash
# Increase max memory
redis-cli CONFIG SET maxmemory 2gb
redis-cli CONFIG SET maxmemory-policy allkeys-lru
```

### Application Tuning

```bash
# Increase Node.js memory limit
NODE_OPTIONS="--max-old-space-size=4096"

# Adjust concurrency limits
MAX_CONCURRENT_REQUESTS=200
REQUEST_QUEUE_TIMEOUT_MS=60000
```

## Support

For issues and questions:
- Check logs first
- Review this deployment guide
- Check GitHub issues
- Contact support team
