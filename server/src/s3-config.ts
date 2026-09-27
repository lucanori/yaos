import type { S3StorageConfig } from "./storage/s3";

export interface S3ConfigOptions {
  defaultBucket?: string;
}

export function readOptionalS3Config(options: S3ConfigOptions = {}): S3StorageConfig | undefined {
  const endpoint = process.env.S3_ENDPOINT?.trim();
  if (!endpoint) {
    return undefined;
  }

  const bucket = process.env.S3_BUCKET?.trim() || options.defaultBucket;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();

  if (!bucket || !accessKeyId || !secretAccessKey) {
    return undefined;
  }

  return {
    endpoint,
    region: process.env.S3_REGION?.trim() || "us-east-1",
    bucket,
    accessKeyId,
    secretAccessKey,
  };
}
