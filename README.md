# Kubernetes Redis Rendering

A small Express app that caches rendered content in Redis and runs on
Kubernetes.

## Build and run locally

The app uses Node.js 22 and exact dependency versions recorded in
`app/package-lock.json`.

```sh
docker build -t kubernetes-redis-rendering:local .
```

For a local Kubernetes cluster, make the image available to the cluster (for
Docker Desktop, building it with the Docker daemon Kubernetes uses is usually
enough), then set the web app image in `k8s-manifests.yaml` to
`kubernetes-redis-rendering:local`. Apply and check the workloads:

```sh
kubectl apply -f k8s-manifests.yaml
kubectl rollout status deployment/redis -n cache-demo
kubectl rollout status deployment/web-app -n cache-demo
kubectl port-forward service/web-app-service 3000:3000 -n cache-demo
```

Open <http://localhost:3000> to see the contents of `app/content.txt` as plain
text. The `X-Cache` response header shows `MISS` on the first request and `HIT`
on subsequent requests within the 30-second TTL. Edit `app/content.txt`, then
build a new image and redeploy to publish updated text. `/healthz` is the
liveness endpoint, and `/readyz` reports whether Redis is connected.

## Container images

GitHub Actions runs app tests, parses the Kubernetes YAML, and builds the image
on pull requests. Pushes to `main` publish `latest`, `main`, and a commit-SHA
tag to GitHub Container Registry (GHCR). Pushing a semantic version tag such
as `v1.0.2` also publishes the matching version tag, which the Kubernetes
manifest uses. Published images include both AMD64 and ARM64 variants.

The GHCR package is public, so Kubernetes can pull it without credentials. If
you make it private, configure an `imagePullSecret` before deploying.

To publish a release image after merging changes:

```sh
git tag v1.0.3
git push origin v1.0.3
```

Update the image tag in `k8s-manifests.yaml` to the new version before
deploying.

## Cache and deployment notes

Redis is deliberately configured as an ephemeral, in-memory cache: restarting
the Redis pod clears cached data. It has no external service exposure or
authentication; use network policies and Redis authentication before exposing
Redis beyond this demo namespace.

The app and Redis containers run as non-root users, drop Linux capabilities,
use read-only root filesystems, and define resource requests/limits and
Kubernetes probes. Set `CACHE_TTL_SECONDS` to a positive integer to change the
cache lifetime.

Remove the demo resources with:

```sh
kubectl delete -f k8s-manifests.yaml
```
