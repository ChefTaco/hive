export const PACKAGE_NAME = '@hivemagnus/hive-iam-server'
export const DEFAULT_PORT = 4200
export const HEALTH_PATH = '/api/v1/health/ready'
export const REDIS_IMAGE = 'redis:7.4.7-alpine'
export const REDIS_DOCKER_COMMAND = `docker run -d --name hive-redis -p 127.0.0.1:6379:6379 ${REDIS_IMAGE}`
