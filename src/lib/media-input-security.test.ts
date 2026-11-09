import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { runMediaCommand } from "./media-command";
import { generateWaveform, probeAudio, transcodePreview } from "./media-processing";

test("supported standalone media still probes, transcodes and generates waveforms", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stems-media-security-"));
  try {
    const source = join(directory, "fixture.wav");
    await runMediaCommand(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", "-y", source]);
    assert.ok((await probeAudio(source)).durationMs > 0);
    const output = join(directory, "preview.mp3");
    await transcodePreview(source, output);
    assert.ok((await probeAudio(output)).durationMs > 0);
    assert.ok((await generateWaveform(source)).points.length > 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("disguised HLS uploads cannot make the worker contact a network origin", async () => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end("private fixture"); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const directory = await mkdtemp(join(tmpdir(), "stems-manifest-security-"));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const disguised = join(directory, "upload.mp3");
    await writeFile(disguised, `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://127.0.0.1:${address.port}/private\n#EXT-X-ENDLIST\n`);
    await assert.rejects(probeAudio(disguised), /Media command failed/);
    await assert.rejects(transcodePreview(disguised, join(directory, "preview.mp3")), /Media command failed/);
    await assert.rejects(generateWaveform(disguised), /Media command failed/);
    assert.equal(requests, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
