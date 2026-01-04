# ORISO LiveKit Deployment

LiveKit server for group video calls in the ORISO platform.

## Architecture

- **Matrix Server**: Handles users, authentication, rooms, chat, 1-on-1 calls
- **LiveKit Server**: Handles group video calls (3+ participants)

## Deployment

```bash
# Deploy LiveKit
kubectl apply -f k8s-livekit.yaml

# Check status
kubectl get pods -n caritas -l app=livekit
kubectl logs -n caritas -l app=livekit

# Check service
kubectl get svc -n caritas livekit
kubectl get ingress -n caritas livekit-ingress
```

## Configuration

- **URL**: https://livekit.oriso.site
- **API Key**: APIm7qGJ8kR3fN2pL5tX
- **API Secret**: secretW9vY4bH6nK8mP2qR7sT3xZ5
- **Port**: 7880 (HTTP)
- **RTC Ports**: 50000-50100 (UDP)

## Testing

```bash
# Test LiveKit is running
curl https://livekit.oriso.site

# Check health
kubectl exec -n caritas -it $(kubectl get pod -n caritas -l app=livekit -o jsonpath='{.items[0].metadata.name}') -- wget -O- http://localhost:7880
```

## Integration with Frontend

The frontend will use LiveKit for group calls:
- Install `livekit-client` npm package
- Connect to `wss://livekit.oriso.site`
- Use API key for authentication
- Matrix handles signaling, LiveKit handles media

## Troubleshooting

```bash
# View logs
kubectl logs -n caritas -l app=livekit -f

# Restart LiveKit
kubectl rollout restart deployment/livekit -n caritas

# Delete and redeploy
kubectl delete -f k8s-livekit.yaml
kubectl apply -f k8s-livekit.yaml
```

## Security

- API keys are stored in ConfigMap (should move to Secret in production)
- HTTPS enabled via cert-manager
- Only accessible via ingress (ClusterIP service)


