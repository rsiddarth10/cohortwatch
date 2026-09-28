import { createReadStream } from 'node:fs';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type _Object,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { SimulatorConfig } from '@cw/common';

/**
 * Minimal S3 port for the Parquet lake. Works against any S3-compatible endpoint (RustFS in compose,
 * AWS S3, GCS interop, MinIO, SeaweedFS) purely through config: endpoint, region, keys, path-style.
 */
export class Lake {
  readonly client: S3Client;
  readonly bucket: string;

  constructor(cfg: SimulatorConfig['lake']) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async uploadFile(key: string, path: string): Promise<void> {
    await new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentType: 'application/vnd.apache.parquet',
      },
    }).done();
  }

  async putJson(key: string, body: unknown): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(body, null, 2),
        ContentType: 'application/json',
      }),
    );
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return JSON.parse(await r.Body!.transformToString()) as T;
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw err;
    }
  }

  async getBytes(key: string): Promise<Uint8Array> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return r.Body!.transformToByteArray();
  }

  async list(prefix: string): Promise<_Object[]> {
    const out: _Object[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      out.push(...(r.Contents ?? []));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const objects = await this.list(prefix);
    for (let i = 0; i < objects.length; i += 1000) {
      const chunk = objects.slice(i, i + 1000).map((o) => ({ Key: o.Key! }));
      await this.client.send(
        new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: chunk, Quiet: true } }),
      );
    }
    return objects.length;
  }
}
