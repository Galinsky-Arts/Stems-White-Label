import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { safeObjectContentType } from "./object-content-type";
import { Readable } from "node:stream";

type StorageConfig = {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
};

let cachedClient: S3Client | null = null;

export function getStorageConfig(): StorageConfig {
  const bucket = process.env.OBJECT_STORAGE_BUCKET?.trim();
  const region = process.env.OBJECT_STORAGE_REGION?.trim() || "us-east-1";
  const endpoint = process.env.OBJECT_STORAGE_ENDPOINT?.trim() || undefined;
  const accessKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim();

  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Object storage requires bucket, access key ID, and secret access key.",
    );
  }

  return {
    bucket,
    region,
    endpoint,
    forcePathStyle:
      (process.env.OBJECT_STORAGE_FORCE_PATH_STYLE || "").toLowerCase() ===
      "true",
    accessKeyId,
    secretAccessKey,
  };
}

export function getStorageClient() {
  if (cachedClient) return cachedClient;

  const config = getStorageConfig();

  cachedClient = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return cachedClient;
}

export function normalizeStorageKey(key: string) {
  const segments = key.split("/").filter(Boolean);

  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        segment.includes("\\") ||
        segment.includes("\0"),
    )
  ) {
    throw new Error("Invalid storage key.");
  }

  return segments.join("/");
}

export async function createPrivateUploadUrl(input: {
  storageKey: string;
  contentType: string;
  contentLength: number;
  expiresInSeconds?: number;
}) {
  const config = getStorageConfig();
  const key = normalizeStorageKey(input.storageKey);
  if (!Number.isSafeInteger(input.contentLength) || input.contentLength <= 0) throw new Error("Upload length must be a positive integer.");
  if (safeObjectContentType(input.contentType) !== input.contentType.trim().toLowerCase()) throw new Error("Unsupported upload content type.");

  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: input.contentType,
    ContentLength: input.contentLength,
  });

  return getSignedUrl(getStorageClient(), command, {
    expiresIn: input.expiresInSeconds ?? 15 * 60,
    signableHeaders: new Set(["content-type", "content-length"]),
  });
}

export async function createPrivateDownloadUrl(input: {
  storageKey: string;
  fileName: string;
  contentType?: string | null;
  expiresInSeconds?: number;
}) {
  const config = getStorageConfig();
  const safeName = input.fileName.replace(/[\r\n"]/g, "_").slice(0, 220) || "download";
  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: normalizeStorageKey(input.storageKey),
    ResponseContentDisposition: 'attachment; filename="' + safeName + '"',
    ResponseContentType: safeObjectContentType(input.contentType),
  });

  return getSignedUrl(getStorageClient(), command, {
    expiresIn: input.expiresInSeconds ?? Math.max(
      60,
      Number(process.env.DOWNLOAD_URL_TTL_SECONDS) || 5 * 60,
    ),
  });
}

export async function uploadPrivateStream(input: {
  storageKey: string;
  body: Readable;
  contentType: string;
}) {
  const config = getStorageConfig();
  const upload = new Upload({
    client: getStorageClient(),
    params: {
      Bucket: config.bucket,
      Key: normalizeStorageKey(input.storageKey),
      Body: input.body,
      ContentType: input.contentType,
    },
    queueSize: 4,
    partSize: 10 * 1024 * 1024,
    leavePartsOnError: false,
  });
  return upload.done();
}

export async function headPrivateObject(storageKey: string) {
  const config = getStorageConfig();

  return getStorageClient().send(
    new HeadObjectCommand({
      Bucket: config.bucket,
      Key: normalizeStorageKey(storageKey),
    }),
  );
}

export async function getPrivateObject(
  storageKey: string,
  options: { range?: string | null } = {},
) {
  const config = getStorageConfig();

  const object = await getStorageClient().send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: normalizeStorageKey(storageKey),
      Range: options.range || undefined,
    }),
  );
  return { ...object, ContentType: safeObjectContentType(object.ContentType) };
}

export async function putPrivateObject(input: {
  storageKey: string;
  body: Uint8Array | Buffer | Readable;
  contentType: string;
  contentLength?: number;
}) {
  const config = getStorageConfig();

  return getStorageClient().send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: normalizeStorageKey(input.storageKey),
      Body: input.body,
      ContentType: input.contentType,
      ContentLength: input.contentLength,
    }),
  );
}

export async function downloadPrivateObjectToFile(
  storageKey: string,
  destinationPath: string,
) {
  const { createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");

  const object = await getPrivateObject(storageKey);

  if (!object.Body) {
    throw new Error("Stored object has no body.");
  }

  if (!(object.Body instanceof Readable)) {
    throw new Error(
      "Object storage returned a non-Node stream in the asset worker runtime.",
    );
  }

  await pipeline(object.Body, createWriteStream(destinationPath));
}

export async function uploadFileToPrivateStorage(input: {
  storageKey: string;
  filePath: string;
  contentType: string;
}) {
  const { createReadStream, statSync } = await import("node:fs");
  const stat = statSync(input.filePath);

  return putPrivateObject({
    storageKey: input.storageKey,
    body: createReadStream(input.filePath),
    contentType: input.contentType,
    contentLength: stat.size,
  });
}
