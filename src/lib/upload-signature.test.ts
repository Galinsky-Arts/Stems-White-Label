import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateUploadUrl } from "./object-storage";

test("private upload signatures bind declared content type and byte length", async () => {
  const values = { OBJECT_STORAGE_BUCKET: "offline-security-fixture", OBJECT_STORAGE_REGION: "us-east-1", OBJECT_STORAGE_ACCESS_KEY_ID: "offline-fixture-access", OBJECT_STORAGE_SECRET_ACCESS_KEY: "offline-fixture-secret", OBJECT_STORAGE_ENDPOINT: "https://objects.fixture.example" };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    const input = { storageKey: "tenants/fixture/original.wav", contentType: "audio/wav", contentLength: 1024 };
    const url = new URL(await createPrivateUploadUrl(input));
    const signed = url.searchParams.get("X-Amz-SignedHeaders")!.split(";");
    assert.ok(signed.includes("content-type"));
    assert.ok(signed.includes("content-length"));
    for (const length of [0, -1, NaN, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(createPrivateUploadUrl({ ...input, contentLength: length }));
    await assert.rejects(createPrivateUploadUrl({ ...input, contentType: "text/html" }));
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
