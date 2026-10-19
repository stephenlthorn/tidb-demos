import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { eventObjectKey, linesToBody } from './s3-events';

export type S3EventSink = {
  readonly write: (lines: readonly string[]) => Promise<{ readonly key: string }>;
};

export const createS3EventSink = (options: {
  readonly bucket: string;
  readonly prefix: string;
  readonly region: string;
}): S3EventSink => {
  const client = new S3Client({ region: options.region });
  return {
    write: async (lines) => {
      const key = eventObjectKey({ prefix: options.prefix, nowMs: Date.now(), id: randomUUID() });
      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: key,
          Body: linesToBody(lines),
          ContentType: 'application/x-ndjson',
        }),
      );
      return { key };
    },
  };
};
