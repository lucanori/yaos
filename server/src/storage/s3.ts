import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

export interface S3StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

export interface S3Object {
  key: string;
  size: number;
  lastModified?: Date;
  contentType?: string;
  etag?: string;
}

/**
 * S3ObjectBody - AWS SDK v3 returns various stream types in different environments:
 * - Node.js/Bun: Node.js Readable stream (async iterable)
 * - Browser: Web ReadableStream
 * - Or Uint8Array if already loaded
 */
export interface S3ObjectBody {
  body: unknown;
  contentType?: string;
  contentLength?: number;
  httpMetadata?: {
    contentType?: string;
  };
}

export class S3Storage {
  private client: S3Client;
  private bucket: string;

  constructor(config: S3StorageConfig) {
    const s3Config: S3ClientConfig = {
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle ?? true,
    };

    this.client = new S3Client(s3Config);
    this.bucket = config.bucket;
  }

  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array> | string,
    options?: {
      contentType?: string;
      metadata?: Record<string, string>;
    }
  ): Promise<void> {
    const input = {
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: options?.contentType ?? "application/octet-stream",
      Metadata: options?.metadata,
    };

    const upload = new Upload({
      client: this.client,
      params: input,
    });

    await upload.done();
  }

  async get(key: string): Promise<S3ObjectBody | null> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const response = await this.client.send(command);

      return {
        body: response.Body,
        contentType: response.ContentType,
        contentLength: response.ContentLength,
        httpMetadata: {
          contentType: response.ContentType,
        },
      };
    } catch (err: unknown) {
      if (this.isNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  }

  async head(key: string): Promise<S3Object | null> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const response = await this.client.send(command);

      return {
        key,
        size: response.ContentLength ?? 0,
        lastModified: response.LastModified,
        contentType: response.ContentType,
        etag: response.ETag?.replace(/"/g, ""),
      };
    } catch (err: unknown) {
      if (this.isNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  }

  async list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    objects: S3Object[];
    truncated: boolean;
    cursor?: string;
  }> {
    const command = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: options?.prefix,
      MaxKeys: options?.limit ?? 1000,
      ContinuationToken: options?.cursor,
    });

    const response = await this.client.send(command);

    const objects: S3Object[] =
      response.Contents?.map((obj) => ({
        key: obj.Key ?? "",
        size: obj.Size ?? 0,
        lastModified: obj.LastModified,
        etag: obj.ETag?.replace(/"/g, ""),
      })) ?? [];

    return {
      objects,
      truncated: response.IsTruncated ?? false,
      cursor: response.NextContinuationToken,
    };
  }

  async delete(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    await this.client.send(command);
  }

  private isNotFoundError(err: unknown): boolean {
    if (err && typeof err === "object") {
      const error = err as { name?: string; Code?: string };
      return (
        error.name === "NoSuchKey" ||
        error.name === "NotFound" ||
        error.Code === "NoSuchKey"
      );
    }
    return false;
  }
}