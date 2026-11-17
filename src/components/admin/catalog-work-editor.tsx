"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { uploadToPrivateStorage } from "@/lib/upload-client";

type Asset = {
  id: string;
  kind: "MASTER" | "STEM" | "PREVIEW" | "OTHER";
  status: "PENDING" | "PROCESSING" | "READY" | "FAILED" | "ARCHIVED";
  label: string | null;
  fileName: string;
  durationMs: number | null;
  sampleRateHz: number | null;
  bitDepth: number | null;
  channels: number | null;
  processingJobs: Array<{
    status: string;
    attempts: number;
    maxAttempts: number;
    lastError: string | null;
  }>;
};

type Stem = {
  id?: string;
  slug: string;
  label: string;
  description: string | null;
  position: number;
  isFeatured: boolean;
  audioAssets?: Asset[];
};

type Credit = {
  id?: string;
  role: string;
  displayName: string;
  position: number;
};

type Section = {
  id?: string;
  kind: string;
  title: string;
  body: string;
  position: number;
};

type RevealStep = {
  id?: string;
  atMs: number;
  action:
    | "ADD_SOURCE"
    | "REMOVE_SOURCE"
    | "ALL_SOURCES"
    | "FULL_MIX"
    | "SILENCE";
  stemGroupId: string | null;
  caption: string | null;
};

type Reveal = {
  id?: string;
  name: string;
  description: string | null;
  isPublished: boolean;
  steps: RevealStep[];
};

type WorkPayload = {
  work: {
    id: string;
    slug: string;
    title: string;
    subtitle: string | null;
    description: string | null;
    catalogNumber: string | null;
    bpm: string | number | null;
    musicalKey: string | null;
    durationMs: number | null;
    primaryArtistId: string | null;
    status: "DRAFT" | "PROCESSING" | "READY" | "PUBLISHED" | "ARCHIVED";
    publishedAt: string | null;
    artwork: {
      id: string;
      status: "PENDING" | "READY" | "FAILED";
      fileName: string;
    } | null;
    credits: Credit[];
    sections: Section[];
    stemGroups: Stem[];
    audioAssets: Asset[];
    collections: Array<{ collectionId: string; collection: { id: string } }>;
    revealSequences: Array<Reveal>;
  };
  artists: Array<{ id: string; name: string; displayName: string | null }>;
  collections: Array<{ id: string; title: string; slug: string }>;
};

type EditorState = {
  title: string;
  slug: string;
  subtitle: string;
  description: string;
  catalogNumber: string;
  bpm: string;
  musicalKey: string;
  durationMs: string;
  primaryArtistId: string;
  credits: Credit[];
  sections: Section[];
  stems: Stem[];
  collectionIds: string[];
  reveal: Reveal | null;
};

function stateFromPayload(payload: WorkPayload): EditorState {
  const work = payload.work;
  return {
    title: work.title,
    slug: work.slug,
    subtitle: work.subtitle ?? "",
    description: work.description ?? "",
    catalogNumber: work.catalogNumber ?? "",
    bpm: work.bpm == null ? "" : String(work.bpm),
    musicalKey: work.musicalKey ?? "",
    durationMs: work.durationMs == null ? "" : String(work.durationMs),
    primaryArtistId: work.primaryArtistId ?? "",
    credits: work.credits.map((credit, index) => ({ ...credit, position: index })),
    sections: work.sections.map((section, index) => ({ ...section, position: index })),
    stems: work.stemGroups.map((stem, index) => ({ ...stem, position: index })),
    collectionIds: work.collections.map((entry) => entry.collection.id),
    reveal: work.revealSequences[0]
      ? {
          ...work.revealSequences[0],
          steps: work.revealSequences[0].steps.map((step) => ({ ...step })),
        }
      : null,
  };
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function CatalogWorkEditor({ workId }: { workId: string }) {
  const [data, setData] = useState<WorkPayload | null>(null);
  const [state, setState] = useState<EditorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/works/" + workId, { cache: "no-store" });
    const payload = (await response.json()) as WorkPayload & { error?: string };

    if (!response.ok) {
      throw new Error(payload.error || "Unable to load Work.");
    }

    setData(payload);
    setState(stateFromPayload(payload));
  }, [workId]);

  useEffect(() => {
    void load()
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to load Work."))
      .finally(() => setLoading(false));
  }, [load]);

  const processing = useMemo(() => {
    if (!data) return false;
    const assets = [
      ...data.work.audioAssets,
      ...data.work.stemGroups.flatMap((stem) => stem.audioAssets ?? []),
    ];
    return assets.some((asset) => asset.status === "PENDING" || asset.status === "PROCESSING");
  }, [data]);

  useEffect(() => {
    if (!processing) return;
    const timer = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [processing, load]);

  if (loading) {
    return <div className="cms-loading">Loading catalog editor…</div>;
  }

  if (!data || !state) {
    return <div className="cms-error">{error ?? "Work unavailable."}</div>;
  }

  const work = data.work;
  const editable = work.status !== "ARCHIVED";

  function patchState(patch: Partial<EditorState>) {
    setState((current) => (current ? { ...current, ...patch } : current));
  }

  function move<T>(items: T[], index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= items.length) return items;
    const next = [...items];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    return next;
  }

  async function save() {
    const currentState = state;
    if (!currentState) return;

    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/admin/works/" + workId, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          work: {
            title: currentState.title,
            slug: currentState.slug,
            subtitle: currentState.subtitle,
            description: currentState.description,
            catalogNumber: currentState.catalogNumber,
            bpm: currentState.bpm,
            musicalKey: currentState.musicalKey,
            durationMs: currentState.durationMs,
            primaryArtistId: currentState.primaryArtistId || null,
          },
          credits: currentState.credits.map((item, position) => ({ ...item, position })),
          sections: currentState.sections.map((item, position) => ({ ...item, position })),
          stems: currentState.stems.map((item, position) => ({ ...item, position })),
          collectionIds: currentState.collectionIds,
          reveal: currentState.reveal,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Unable to save Work.");

      await load();
      setMessage("Saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save Work.");
    } finally {
      setSaving(false);
    }
  }

  async function workAction(action: "publish" | "unpublish" | "archive" | "restore") {
    setBusyAction(action);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/admin/works/" + workId, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Unable to update Work.");
      await load();
      setMessage(
        action === "publish"
          ? "Published."
          : action === "unpublish"
            ? "Unpublished."
            : action === "archive"
              ? "Archived."
              : "Restored.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update Work.");
    } finally {
      setBusyAction(null);
    }
  }

  async function uploadAudio(file: File, kind: "MASTER" | "STEM", stemGroupId: string | null) {
    const key = stemGroupId ?? "master";
    setUploading(key);
    setError(null);
    setMessage(null);

    try {
      const intent = await fetch("/api/admin/works/" + workId + "/assets/upload-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type || "audio/wav",
          sizeBytes: file.size,
          kind,
          stemGroupId,
          label: kind === "MASTER" ? "Full Mix" : undefined,
        }),
      });
      const intentPayload = (await intent.json()) as {
        assetId?: string;
        uploadUrl?: string;
        requiredHeaders?: Record<string, string>;
        error?: string;
      };
      if (!intent.ok || !intentPayload.assetId || !intentPayload.uploadUrl) {
        throw new Error(intentPayload.error || "Unable to prepare upload.");
      }

      await uploadToPrivateStorage({
        file,
        uploadUrl: intentPayload.uploadUrl,
        requiredHeaders: intentPayload.requiredHeaders,
        kind: "audio",
        assetId: intentPayload.assetId,
        onFallback: () => setMessage("Direct storage upload unavailable; uploading " + file.name + " through the server…"),
      });

      const complete = await fetch(
        "/api/admin/assets/" + intentPayload.assetId + "/complete",
        { method: "POST" },
      );
      const completePayload = (await complete.json()) as { error?: string };
      if (!complete.ok) {
        throw new Error(completePayload.error || "Unable to queue audio processing.");
      }

      await load();
      setMessage(file.name + " uploaded and queued for processing.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Audio upload failed.");
    } finally {
      setUploading(null);
    }
  }

  async function uploadArtwork(file: File) {
    setUploading("artwork");
    setError(null);
    setMessage(null);

    try {
      const intent = await fetch("/api/admin/works/" + workId + "/artwork/upload-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
        }),
      });
      const payload = (await intent.json()) as {
        assetId?: string;
        uploadUrl?: string;
        requiredHeaders?: Record<string, string>;
        error?: string;
      };
      if (!intent.ok || !payload.assetId || !payload.uploadUrl) {
        throw new Error(payload.error || "Unable to prepare artwork upload.");
      }

      await uploadToPrivateStorage({
        file,
        uploadUrl: payload.uploadUrl,
        requiredHeaders: payload.requiredHeaders,
        kind: "artwork",
        assetId: payload.assetId,
      });

      const complete = await fetch("/api/admin/artwork/" + payload.assetId + "/complete", {
        method: "POST",
      });
      const completed = (await complete.json()) as { error?: string };
      if (!complete.ok) throw new Error(completed.error || "Unable to verify artwork.");

      await load();
      setMessage("Artwork uploaded.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Artwork upload failed.");
    } finally {
      setUploading(null);
    }
  }

  function fileHandler(callback: (file: File) => void) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) callback(file);
      event.target.value = "";
    };
  }

  return (
    <div className="cms-editor">
      <header className="cms-editor__header">
        <div>
          <p className="eyebrow">Catalog CMS</p>
          <h1>{work.title}</h1>
          <div className="cms-status-line">
            <span className={"cms-status cms-status--" + work.status.toLowerCase()}>
              {work.status}
            </span>
            {processing ? <span>Audio processing in progress</span> : null}
            {work.publishedAt ? (
              <span>Published {new Date(work.publishedAt).toLocaleDateString()}</span>
            ) : null}
          </div>
        </div>
        <div className="cms-header-actions">
          <a
            className="cms-secondary-button"
            href={"/admin/catalog/works/" + work.id + "/preview"}
            target="_blank"
          >
            Preview ↗
          </a>
          {work.status === "PUBLISHED" ? (
            <a className="cms-secondary-button" href={"/works/" + work.slug} target="_blank">
              Open public Work ↗
            </a>
          ) : null}
          <button
            className="cms-primary-button"
            disabled={!editable || saving}
            onClick={() => void save()}
            type="button"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </header>

      {message ? <div className="cms-message">{message}</div> : null}
      {error ? <div className="cms-error">{error}</div> : null}

      <nav className="cms-section-nav" aria-label="Work editor sections">
        <a href="#metadata">Metadata</a>
        <a href="#artwork">Artwork</a>
        <a href="#sources">Source groups</a>
        <a href="#credits">Credits</a>
        <a href="#editorial">Editorial</a>
        <a href="#collections">Collections</a>
        <a href="#reveal">Reveal</a>
        <a href="#publishing">Publishing</a>
      </nav>

      <section className="cms-panel" id="metadata">
        <div className="cms-panel__heading">
          <p className="eyebrow">01 / Metadata</p>
          <h2>The Work</h2>
        </div>
        <div className="cms-grid cms-grid--2">
          <label className="cms-field">
            <span>Title</span>
            <input
              disabled={!editable}
              maxLength={180}
              onChange={(event) => patchState({ title: event.target.value })}
              value={state.title}
            />
          </label>
          <label className="cms-field">
            <span>Slug</span>
            <div className="cms-inline-field">
              <input
                disabled={!editable}
                onChange={(event) => patchState({ slug: event.target.value })}
                value={state.slug}
              />
              <button
                disabled={!editable}
                onClick={() => patchState({ slug: slugify(state.title) })}
                type="button"
              >
                Generate
              </button>
            </div>
          </label>
          <label className="cms-field cms-field--wide">
            <span>Subtitle</span>
            <input
              disabled={!editable}
              onChange={(event) => patchState({ subtitle: event.target.value })}
              value={state.subtitle}
            />
          </label>
          <label className="cms-field cms-field--wide">
            <span>Description</span>
            <textarea
              disabled={!editable}
              onChange={(event) => patchState({ description: event.target.value })}
              rows={6}
              value={state.description}
            />
          </label>
          <label className="cms-field">
            <span>Primary artist</span>
            <select
              disabled={!editable}
              onChange={(event) => patchState({ primaryArtistId: event.target.value })}
              value={state.primaryArtistId}
            >
              <option value="">No primary artist</option>
              {data.artists.map((artist) => (
                <option key={artist.id} value={artist.id}>
                  {artist.displayName || artist.name}
                </option>
              ))}
            </select>
          </label>
          <label className="cms-field">
            <span>Catalog number</span>
            <input
              disabled={!editable}
              onChange={(event) => patchState({ catalogNumber: event.target.value })}
              value={state.catalogNumber}
            />
          </label>
          <label className="cms-field">
            <span>BPM</span>
            <input
              disabled={!editable}
              inputMode="decimal"
              onChange={(event) => patchState({ bpm: event.target.value })}
              value={state.bpm}
            />
          </label>
          <label className="cms-field">
            <span>Musical key</span>
            <input
              disabled={!editable}
              onChange={(event) => patchState({ musicalKey: event.target.value })}
              value={state.musicalKey}
            />
          </label>
          <label className="cms-field">
            <span>Duration (milliseconds)</span>
            <input
              disabled={!editable}
              inputMode="numeric"
              onChange={(event) => patchState({ durationMs: event.target.value })}
              value={state.durationMs}
            />
          </label>
        </div>
      </section>

      <section className="cms-panel" id="artwork">
        <div className="cms-panel__heading">
          <p className="eyebrow">02 / Artwork</p>
          <h2>Cover image</h2>
          <p>JPG, PNG, or WebP up to 20 MB. Stored privately and exposed only through signed storefront delivery.</p>
        </div>
        <div className="cms-upload-row">
          <div>
            <strong>{work.artwork?.fileName ?? "No artwork uploaded"}</strong>
            <span>{work.artwork ? work.artwork.status : "Typographic jacket will be used"}</span>
          </div>
          <label className="cms-upload-button">
            {uploading === "artwork" ? "Uploading…" : work.artwork ? "Replace artwork" : "Upload artwork"}
            <input
              accept="image/jpeg,image/png,image/webp"
              disabled={!editable || uploading !== null}
              onChange={fileHandler((file) => void uploadArtwork(file))}
              type="file"
            />
          </label>
        </div>
      </section>

      <section className="cms-panel" id="sources">
        <div className="cms-panel__heading cms-panel__heading--actions">
          <div>
            <p className="eyebrow">03 / Source material</p>
            <h2>Master & source groups</h2>
            <p>Groups are arbitrary musical sections, not a fixed instrument taxonomy.</p>
          </div>
          <button
            className="cms-secondary-button"
            disabled={!editable}
            onClick={() =>
              patchState({
                stems: [
                  ...state.stems,
                  {
                    slug: "source-group-" + (state.stems.length + 1),
                    label: "New Source Group",
                    description: "",
                    position: state.stems.length,
                    isFeatured: false,
                  },
                ],
              })
            }
            type="button"
          >
            + Add source group
          </button>
        </div>

        <div className="cms-source-master">
          <div>
            <p className="eyebrow">Full master</p>
            <h3>{work.audioAssets[0]?.fileName ?? "No master uploaded"}</h3>
            {work.audioAssets[0] ? <AssetStatus asset={work.audioAssets[0]} /> : null}
          </div>
          <label className="cms-upload-button">
            {uploading === "master" ? "Uploading…" : "Upload master"}
            <input
              accept="audio/*,.wav,.aif,.aiff,.flac"
              disabled={!editable || uploading !== null}
              onChange={fileHandler((file) => void uploadAudio(file, "MASTER", null))}
              type="file"
            />
          </label>
        </div>

        <div className="cms-repeater">
          {state.stems.map((stem, index) => (
            <article className="cms-repeater__item" key={stem.id ?? "new-" + index}>
              <div className="cms-repeater__handle">
                <span>{String(index + 1).padStart(2, "0")}</span>
                <button
                  disabled={!editable || index === 0}
                  onClick={() => patchState({ stems: move(state.stems, index, -1) })}
                  type="button"
                >
                  ↑
                </button>
                <button
                  disabled={!editable || index === state.stems.length - 1}
                  onClick={() => patchState({ stems: move(state.stems, index, 1) })}
                  type="button"
                >
                  ↓
                </button>
              </div>
              <div className="cms-grid cms-grid--2">
                <label className="cms-field">
                  <span>Group label</span>
                  <input
                    disabled={!editable}
                    onChange={(event) => {
                      const stems = [...state.stems];
                      stems[index] = { ...stem, label: event.target.value };
                      patchState({ stems });
                    }}
                    value={stem.label}
                  />
                </label>
                <label className="cms-field">
                  <span>Slug</span>
                  <input
                    disabled={!editable}
                    onChange={(event) => {
                      const stems = [...state.stems];
                      stems[index] = { ...stem, slug: event.target.value };
                      patchState({ stems });
                    }}
                    value={stem.slug}
                  />
                </label>
                <label className="cms-field cms-field--wide">
                  <span>Description</span>
                  <textarea
                    disabled={!editable}
                    onChange={(event) => {
                      const stems = [...state.stems];
                      stems[index] = { ...stem, description: event.target.value };
                      patchState({ stems });
                    }}
                    rows={3}
                    value={stem.description ?? ""}
                  />
                </label>
              </div>
              <div className="cms-repeater__footer">
                <label className="cms-check">
                  <input
                    checked={stem.isFeatured}
                    disabled={!editable}
                    onChange={(event) => {
                      const stems = [...state.stems];
                      stems[index] = { ...stem, isFeatured: event.target.checked };
                      patchState({ stems });
                    }}
                    type="checkbox"
                  />
                  Featured source group
                </label>
                <div className="cms-repeater__actions">
                  {stem.id ? (
                    <label className="cms-upload-button">
                      {uploading === stem.id ? "Uploading…" : "Upload stem"}
                      <input
                        accept="audio/*,.wav,.aif,.aiff,.flac"
                        disabled={!editable || uploading !== null}
                        onChange={fileHandler((file) => void uploadAudio(file, "STEM", stem.id!))}
                        type="file"
                      />
                    </label>
                  ) : (
                    <span className="cms-hint">Save this group before uploading audio.</span>
                  )}
                  <button
                    className="cms-danger-button"
                    disabled={!editable || Boolean(stem.audioAssets?.length)}
                    onClick={() =>
                      patchState({ stems: state.stems.filter((_, itemIndex) => itemIndex !== index) })
                    }
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              </div>
              {stem.audioAssets?.map((asset) => (
                <AssetStatus asset={asset} key={asset.id} />
              ))}
            </article>
          ))}
        </div>
      </section>

      <RepeaterSection
        eyebrow="04 / Credits"
        title="Credits"
        addLabel="+ Add credit"
        onAdd={() =>
          patchState({
            credits: [
              ...state.credits,
              { role: "", displayName: "", position: state.credits.length },
            ],
          })
        }
      >
        {state.credits.map((credit, index) => (
          <div className="cms-repeater__item cms-repeater__item--compact" key={credit.id ?? index}>
            <div className="cms-grid cms-grid--2">
              <label className="cms-field">
                <span>Role</span>
                <input
                  disabled={!editable}
                  onChange={(event) => {
                    const credits = [...state.credits];
                    credits[index] = { ...credit, role: event.target.value };
                    patchState({ credits });
                  }}
                  placeholder="Producer"
                  value={credit.role}
                />
              </label>
              <label className="cms-field">
                <span>Name</span>
                <input
                  disabled={!editable}
                  onChange={(event) => {
                    const credits = [...state.credits];
                    credits[index] = { ...credit, displayName: event.target.value };
                    patchState({ credits });
                  }}
                  value={credit.displayName}
                />
              </label>
            </div>
            <div className="cms-repeater__actions">
              <button disabled={index === 0} onClick={() => patchState({ credits: move(state.credits, index, -1) })} type="button">↑</button>
              <button disabled={index === state.credits.length - 1} onClick={() => patchState({ credits: move(state.credits, index, 1) })} type="button">↓</button>
              <button className="cms-danger-button" onClick={() => patchState({ credits: state.credits.filter((_, i) => i !== index) })} type="button">Remove</button>
            </div>
          </div>
        ))}
      </RepeaterSection>

      <RepeaterSection
        eyebrow="05 / Editorial"
        title="Work notes"
        addLabel="+ Add section"
        onAdd={() =>
          patchState({
            sections: [
              ...state.sections,
              { kind: "Work Note", title: "", body: "", position: state.sections.length },
            ],
          })
        }
      >
        {state.sections.map((section, index) => (
          <article className="cms-repeater__item" key={section.id ?? index}>
            <div className="cms-grid cms-grid--2">
              <label className="cms-field">
                <span>Section kind</span>
                <input
                  disabled={!editable}
                  onChange={(event) => {
                    const sections = [...state.sections];
                    sections[index] = { ...section, kind: event.target.value };
                    patchState({ sections });
                  }}
                  value={section.kind}
                />
              </label>
              <label className="cms-field">
                <span>Heading</span>
                <input
                  disabled={!editable}
                  onChange={(event) => {
                    const sections = [...state.sections];
                    sections[index] = { ...section, title: event.target.value };
                    patchState({ sections });
                  }}
                  value={section.title}
                />
              </label>
              <label className="cms-field cms-field--wide">
                <span>Body</span>
                <textarea
                  disabled={!editable}
                  onChange={(event) => {
                    const sections = [...state.sections];
                    sections[index] = { ...section, body: event.target.value };
                    patchState({ sections });
                  }}
                  rows={8}
                  value={section.body}
                />
              </label>
            </div>
            <div className="cms-repeater__actions">
              <button disabled={index === 0} onClick={() => patchState({ sections: move(state.sections, index, -1) })} type="button">↑</button>
              <button disabled={index === state.sections.length - 1} onClick={() => patchState({ sections: move(state.sections, index, 1) })} type="button">↓</button>
              <button className="cms-danger-button" onClick={() => patchState({ sections: state.sections.filter((_, i) => i !== index) })} type="button">Remove</button>
            </div>
          </article>
        ))}
      </RepeaterSection>

      <section className="cms-panel" id="collections">
        <div className="cms-panel__heading">
          <p className="eyebrow">06 / Collections</p>
          <h2>Archive placement</h2>
        </div>
        {data.collections.length ? (
          <div className="cms-check-grid">
            {data.collections.map((collection) => (
              <label className="cms-check-card" key={collection.id}>
                <input
                  checked={state.collectionIds.includes(collection.id)}
                  disabled={!editable}
                  onChange={(event) =>
                    patchState({
                      collectionIds: event.target.checked
                        ? [...state.collectionIds, collection.id]
                        : state.collectionIds.filter((id) => id !== collection.id),
                    })
                  }
                  type="checkbox"
                />
                <span>
                  <strong>{collection.title}</strong>
                  <small>{collection.slug}</small>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="cms-empty">No active Collections yet. Collection assignment is optional.</p>
        )}
      </section>

      <section className="cms-panel" id="reveal">
        <div className="cms-panel__heading cms-panel__heading--actions">
          <div>
            <p className="eyebrow">07 / Reveal the Record</p>
            <h2>Guided reconstruction</h2>
            <p>Every timed transition is creator-authored. There is no default reveal order.</p>
          </div>
          {state.reveal ? (
            <button className="cms-danger-button" onClick={() => patchState({ reveal: null })} type="button">
              Remove sequence
            </button>
          ) : (
            <button
              className="cms-secondary-button"
              disabled={!editable}
              onClick={() =>
                patchState({
                  reveal: {
                    name: "Reveal the Record",
                    description: "",
                    isPublished: false,
                    steps: [{ atMs: 0, action: "SILENCE", stemGroupId: null, caption: "Begin from silence." }],
                  },
                })
              }
              type="button"
            >
              Create sequence
            </button>
          )}
        </div>

        {state.reveal ? (
          <>
            <div className="cms-grid cms-grid--2">
              <label className="cms-field">
                <span>Sequence name</span>
                <input
                  disabled={!editable}
                  onChange={(event) => patchState({ reveal: { ...state.reveal!, name: event.target.value } })}
                  value={state.reveal.name}
                />
              </label>
              <label className="cms-check cms-check--standalone">
                <input
                  checked={state.reveal.isPublished}
                  disabled={!editable}
                  onChange={(event) => patchState({ reveal: { ...state.reveal!, isPublished: event.target.checked } })}
                  type="checkbox"
                />
                Publish guided sequence with the Work
              </label>
              <label className="cms-field cms-field--wide">
                <span>Description</span>
                <textarea
                  disabled={!editable}
                  onChange={(event) => patchState({ reveal: { ...state.reveal!, description: event.target.value } })}
                  rows={3}
                  value={state.reveal.description ?? ""}
                />
              </label>
            </div>

            <div className="cms-repeater">
              {state.reveal.steps.map((step, index) => (
                <article className="cms-repeater__item cms-repeater__item--compact" key={step.id ?? index}>
                  <div className="cms-grid cms-grid--4">
                    <label className="cms-field">
                      <span>At ms</span>
                      <input
                        inputMode="numeric"
                        onChange={(event) => {
                          const steps = [...state.reveal!.steps];
                          steps[index] = { ...step, atMs: Number(event.target.value) || 0 };
                          patchState({ reveal: { ...state.reveal!, steps } });
                        }}
                        value={step.atMs}
                      />
                    </label>
                    <label className="cms-field">
                      <span>Action</span>
                      <select
                        onChange={(event) => {
                          const action = event.target.value as RevealStep["action"];
                          const steps = [...state.reveal!.steps];
                          steps[index] = {
                            ...step,
                            action,
                            stemGroupId:
                              action === "ADD_SOURCE" || action === "REMOVE_SOURCE"
                                ? step.stemGroupId
                                : null,
                          };
                          patchState({ reveal: { ...state.reveal!, steps } });
                        }}
                        value={step.action}
                      >
                        <option value="SILENCE">Silence</option>
                        <option value="ADD_SOURCE">Add source</option>
                        <option value="REMOVE_SOURCE">Remove source</option>
                        <option value="ALL_SOURCES">All sources</option>
                        <option value="FULL_MIX">Full mix</option>
                      </select>
                    </label>
                    <label className="cms-field">
                      <span>Source group</span>
                      <select
                        disabled={step.action !== "ADD_SOURCE" && step.action !== "REMOVE_SOURCE"}
                        onChange={(event) => {
                          const steps = [...state.reveal!.steps];
                          steps[index] = { ...step, stemGroupId: event.target.value || null };
                          patchState({ reveal: { ...state.reveal!, steps } });
                        }}
                        value={step.stemGroupId ?? ""}
                      >
                        <option value="">Choose group</option>
                        {state.stems.filter((stem) => stem.id).map((stem) => (
                          <option key={stem.id} value={stem.id}>{stem.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="cms-field">
                      <span>Caption</span>
                      <input
                        onChange={(event) => {
                          const steps = [...state.reveal!.steps];
                          steps[index] = { ...step, caption: event.target.value };
                          patchState({ reveal: { ...state.reveal!, steps } });
                        }}
                        value={step.caption ?? ""}
                      />
                    </label>
                  </div>
                  <div className="cms-repeater__actions">
                    <button onClick={() => {
                      const steps = [...state.reveal!.steps];
                      steps.splice(index + 1, 0, { atMs: step.atMs + 5000, action: "ADD_SOURCE", stemGroupId: null, caption: "" });
                      patchState({ reveal: { ...state.reveal!, steps } });
                    }} type="button">+ After</button>
                    <button className="cms-danger-button" onClick={() => patchState({ reveal: { ...state.reveal!, steps: state.reveal!.steps.filter((_, i) => i !== index) } })} type="button">Remove</button>
                  </div>
                </article>
              ))}
              {state.reveal.steps.length === 0 ? (
                <button className="cms-secondary-button" onClick={() => patchState({ reveal: { ...state.reveal!, steps: [{ atMs: 0, action: "SILENCE", stemGroupId: null, caption: "" }] } })} type="button">
                  + Add first step
                </button>
              ) : null}
            </div>
          </>
        ) : (
          <p className="cms-empty">No guided sequence configured.</p>
        )}
      </section>

      <section className="cms-panel" id="publishing">
        <div className="cms-panel__heading">
          <p className="eyebrow">08 / Publishing</p>
          <h2>Release state</h2>
          <p>Publishing requires a READY Work with a successfully processed master source and no failed or processing source assets.</p>
        </div>
        <div className="cms-publish-actions">
          {work.status === "PUBLISHED" ? (
            <button
              className="cms-secondary-button"
              disabled={busyAction !== null}
              onClick={() => void workAction("unpublish")}
              type="button"
            >
              Unpublish
            </button>
          ) : work.status === "ARCHIVED" ? (
            <button
              className="cms-primary-button"
              disabled={busyAction !== null}
              onClick={() => void workAction("restore")}
              type="button"
            >
              Restore Work
            </button>
          ) : (
            <>
              <button
                className="cms-primary-button"
                disabled={busyAction !== null || work.status !== "READY"}
                onClick={() => void workAction("publish")}
                type="button"
              >
                Publish Work
              </button>
              <button
                className="cms-danger-button"
                disabled={busyAction !== null || processing}
                onClick={() => void workAction("archive")}
                type="button"
              >
                Archive
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function AssetStatus({ asset }: { asset: Asset }) {
  const job = asset.processingJobs[0];
  return (
    <div className="cms-asset-status">
      <span className={"cms-status cms-status--" + asset.status.toLowerCase()}>
        {asset.status}
      </span>
      <span>{asset.fileName}</span>
      {asset.sampleRateHz ? <span>{asset.sampleRateHz / 1000} kHz</span> : null}
      {asset.bitDepth ? <span>{asset.bitDepth}-bit</span> : null}
      {asset.channels ? <span>{asset.channels === 2 ? "Stereo" : asset.channels + " ch"}</span> : null}
      {job?.status === "FAILED" && job.lastError ? (
        <span className="cms-error-inline">{job.lastError}</span>
      ) : null}
    </div>
  );
}

function RepeaterSection({
  eyebrow,
  title,
  addLabel,
  onAdd,
  children,
}: {
  eyebrow: string;
  title: string;
  addLabel: string;
  onAdd: () => void;
  children: ReactNode;
}) {
  const id = title === "Credits" ? "credits" : "editorial";
  return (
    <section className="cms-panel" id={id}>
      <div className="cms-panel__heading cms-panel__heading--actions">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
        <button className="cms-secondary-button" onClick={onAdd} type="button">
          {addLabel}
        </button>
      </div>
      <div className="cms-repeater">{children}</div>
    </section>
  );
}
