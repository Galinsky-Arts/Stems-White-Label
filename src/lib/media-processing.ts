import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { runMediaCommand, SAFE_MEDIA_INPUT_ARGS } from "./media-command";

export type AudioMetadata = {
  durationMs: number;
  sampleRateHz: number | null;
  bitDepth: number | null;
  channels: number | null;
};

type FfprobeDocument = {
  streams?: Array<{
    codec_type?: string;
    sample_rate?: string;
    bits_per_sample?: number;
    bits_per_raw_sample?: string;
    channels?: number;
    duration?: string;
  }>;
  format?: {
    duration?: string;
  };
};

export function parseFfprobeMetadata(document: FfprobeDocument): AudioMetadata {
  const audio = document.streams?.find(
    (stream) => stream.codec_type === "audio",
  );

  if (!audio) {
    throw new Error("Uploaded file does not contain an audio stream.");
  }

  const durationSeconds = Number(
    document.format?.duration ?? audio.duration ?? "0",
  );

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Audio duration could not be determined.");
  }

  const sampleRate = Number(audio.sample_rate);
  const rawBitDepth = Number(audio.bits_per_raw_sample);
  const bitDepth =
    Number.isFinite(rawBitDepth) && rawBitDepth > 0
      ? rawBitDepth
      : audio.bits_per_sample && audio.bits_per_sample > 0
        ? audio.bits_per_sample
        : null;

  return {
    durationMs: Math.round(durationSeconds * 1000),
    sampleRateHz:
      Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : null,
    bitDepth,
    channels:
      audio.channels && audio.channels > 0 ? audio.channels : null,
  };
}

export async function probeAudio(filePath: string) {
  const executable = process.env.FFPROBE_PATH || "ffprobe";
  const result = await runMediaCommand(executable, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    ...SAFE_MEDIA_INPUT_ARGS,
    filePath,
  ]);

  let document: FfprobeDocument;

  try {
    document = JSON.parse(result.stdout.toString("utf8")) as FfprobeDocument;
  } catch {
    throw new Error("ffprobe returned invalid JSON.");
  }

  return parseFfprobeMetadata(document);
}

export async function transcodePreview(
  sourcePath: string,
  previewPath: string,
) {
  const executable = process.env.FFMPEG_PATH || "ffmpeg";

  await runMediaCommand(executable, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...SAFE_MEDIA_INPUT_ARGS,
    "-i",
    sourcePath,
    "-map",
    "0:a:0",
    "-vn",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "192k",
    "-ar",
    "44100",
    previewPath,
  ]);
}

export type WaveformData = {
  version: 1;
  sampleRateHz: number;
  points: number[];
};

export function pcm16ToWaveform(
  pcm: Buffer,
  targetPoints = 1200,
  sampleRateHz = 2000,
): WaveformData {
  const sampleCount = Math.floor(pcm.length / 2);

  if (sampleCount === 0) {
    return { version: 1, sampleRateHz, points: [] };
  }

  const pointCount = Math.min(targetPoints, sampleCount);
  const samplesPerPoint = Math.max(1, Math.ceil(sampleCount / pointCount));
  const points: number[] = [];

  for (let start = 0; start < sampleCount; start += samplesPerPoint) {
    const end = Math.min(sampleCount, start + samplesPerPoint);
    let peak = 0;

    for (let index = start; index < end; index += 1) {
      const value = Math.abs(pcm.readInt16LE(index * 2));
      if (value > peak) peak = value;
    }

    points.push(Number((peak / 32768).toFixed(4)));
  }

  return { version: 1, sampleRateHz, points };
}

export async function generateWaveform(filePath: string) {
  const executable = process.env.FFMPEG_PATH || "ffmpeg";
  const sampleRateHz = 2000;

  const result = await runMediaCommand(
    executable,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      ...SAFE_MEDIA_INPUT_ARGS,
      "-i",
      filePath,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      String(sampleRateHz),
      "-f",
      "s16le",
      "pipe:1",
    ],
    {
      maxStdoutBytes: 128 * 1024 * 1024,
    },
  );

  return pcm16ToWaveform(result.stdout, 1200, sampleRateHz);
}

export async function sha256File(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);

    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
