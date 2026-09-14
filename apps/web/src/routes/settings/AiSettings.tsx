import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AI_PROVIDERS,
  AI_PROVIDER_LABELS,
  type AiProvider,
  type AiProviderSettings,
  type AiSettingsResponse,
} from "@issue-pipeline/shared";
import { useState } from "react";
import { getAiSettings, listAiModels, selectAiProvider, testAiProvider, updateAiProvider } from "../../lib/api";

/**
 * Which AI provider drafts your issues. "Team default" is the server's setup;
 * picking a provider shows its key and model settings. A saved key is never
 * shown again, only its last four characters.
 */
export function AiSettings() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", "ai"], queryFn: getAiSettings });
  const choose = useMutation({
    mutationFn: selectAiProvider,
    onSuccess: (data) => queryClient.setQueryData(["settings", "ai"], data),
  });

  if (settings.isPending) return <p className="muted">Loading…</p>;
  if (settings.error) return <p className="status status--bad">{settings.error.message}</p>;

  const data = settings.data;
  const selected = data.provider;
  const panel = selected ? data.providers.find((p) => p.provider === selected) : undefined;

  return (
    <>
      <section className="card">
        <h2>AI model</h2>
        <p className="muted small">Used for the runs you start or retry. Other people's choices do not affect yours.</p>
        <div className="choice-list" role="radiogroup" aria-label="AI provider">
          <label className="choice">
            <input
              type="radio"
              name="ai-provider"
              checked={selected === null}
              onChange={() => choose.mutate(null)}
              disabled={choose.isPending}
            />
            <span>
              <strong>Team default</strong>
              <span className="muted small"> · {teamLabel(data.team_provider)}</span>
            </span>
          </label>
          {AI_PROVIDERS.map((provider) => {
            const p = data.providers.find((x) => x.provider === provider)!;
            return (
              <label key={provider} className="choice">
                <input
                  type="radio"
                  name="ai-provider"
                  checked={selected === provider}
                  onChange={() => choose.mutate(provider)}
                  disabled={choose.isPending}
                />
                <span>
                  <strong>{AI_PROVIDER_LABELS[provider]}</strong>
                  {p.has_key && <span className="badge">your key</span>}
                  {!p.has_key && p.team_key && <span className="badge">team key</span>}
                </span>
              </label>
            );
          })}
        </div>
        {choose.error && <p className="status status--bad spaced">{choose.error.message}</p>}
      </section>

      {panel && <ProviderPanel key={panelKey(panel)} settings={panel} />}
    </>
  );
}

function teamLabel(provider: string): string {
  return (AI_PROVIDERS as readonly string[]).includes(provider)
    ? AI_PROVIDER_LABELS[provider as AiProvider]
    : provider === "lmstudio"
      ? "LM Studio"
      : "not configured";
}

/** Remount the form whenever the saved values change, so it starts from them. */
const panelKey = (p: AiProviderSettings) => [p.provider, p.model_select, p.model_draft, p.key_last4, p.has_key].join("|");

function ProviderPanel({ settings }: { settings: AiProviderSettings }) {
  const queryClient = useQueryClient();
  const provider = settings.provider;
  const label = AI_PROVIDER_LABELS[provider];

  const [modelSelect, setModelSelect] = useState(settings.model_select ?? "");
  const [modelDraft, setModelDraft] = useState(settings.model_draft ?? "");
  const [apiKey, setApiKey] = useState("");
  const [replacingKey, setReplacingKey] = useState(!settings.has_key);

  const canListModels = settings.has_key || settings.team_key;
  const models = useQuery({
    queryKey: ["settings", "ai", provider, "models", settings.key_last4],
    queryFn: () => listAiModels(provider),
    enabled: canListModels,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const saved = (data: AiSettingsResponse) => {
    queryClient.setQueryData(["settings", "ai"], data);
    test.reset();
  };

  const save = useMutation({
    mutationFn: () =>
      updateAiProvider(provider, {
        model_select: modelSelect.trim() || null,
        model_draft: modelDraft.trim() || null,
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      }),
    onSuccess: saved,
  });

  const removeKey = useMutation({
    mutationFn: () =>
      updateAiProvider(provider, {
        model_select: settings.model_select,
        model_draft: settings.model_draft,
        clear_key: true,
      }),
    onSuccess: saved,
  });

  const test = useMutation({ mutationFn: () => testAiProvider(provider) });

  const dirty =
    apiKey.trim() !== "" || modelSelect.trim() !== (settings.model_select ?? "") || modelDraft.trim() !== (settings.model_draft ?? "");
  const listId = `models-${provider}`;
  const noKey = !settings.has_key && !settings.team_key;

  return (
    <section className="card">
      <h2>{label} settings</h2>
      {noKey && (
        <p className="banner banner--warn">
          Runs you start will fail until you add a {label} API key: the team has no key for {label}.
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="field">
          <span>API key</span>
          {settings.has_key && !replacingKey ? (
            <div className="row">
              <span>
                Saved key ending in <code>…{settings.key_last4}</code>
              </span>
              <span className="actions">
                <button type="button" onClick={() => setReplacingKey(true)}>
                  Replace
                </button>
                <button type="button" onClick={() => removeKey.mutate()} disabled={removeKey.isPending}>
                  {removeKey.isPending ? "Removing…" : "Remove"}
                </button>
              </span>
            </div>
          ) : (
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={settings.team_key ? "Optional: leave blank to use the team key" : `Paste your ${label} API key`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              aria-label={`${label} API key`}
            />
          )}
          <span className="muted small">
            Stored encrypted and only used by the server. It is never shown again after saving.
          </span>
        </div>

        <label className="field">
          <span>Model for choosing files</span>
          <input
            list={listId}
            value={modelSelect}
            onChange={(e) => setModelSelect(e.target.value)}
            placeholder={settings.default_model_select ? `Default: ${settings.default_model_select}` : "Choose a model"}
          />
          <span className="muted small">A small, fast model is enough: it only picks which files to read.</span>
        </label>

        <label className="field">
          <span>Model for drafting issues</span>
          <input
            list={listId}
            value={modelDraft}
            onChange={(e) => setModelDraft(e.target.value)}
            placeholder={settings.default_model_draft ? `Default: ${settings.default_model_draft}` : "Choose a model"}
          />
          <span className="muted small">Use a capable model: it writes the drafts.</span>
        </label>

        <datalist id={listId}>
          {models.data?.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name ?? undefined}
            </option>
          ))}
        </datalist>
        {!canListModels && <p className="muted small">Save a key to see the available models.</p>}
        {models.isFetching && <p className="muted small">Loading models…</p>}
        {models.error && <p className="status status--bad small">{models.error.message}</p>}
        {models.data && <p className="muted small">{models.data.length} models available. Start typing to filter.</p>}

        {save.error && <p className="status status--bad">{save.error.message}</p>}
        {removeKey.error && <p className="status status--bad">{removeKey.error.message}</p>}

        <div className="actions">
          <button type="submit" className="primary" disabled={!dirty || save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={() => test.mutate()} disabled={dirty || noKey || test.isPending}>
            {test.isPending ? "Testing…" : "Test"}
          </button>
          {dirty && <span className="muted small">Save before testing.</span>}
        </div>
        {test.error && <p className="status status--bad spaced">{test.error.message}</p>}
        {test.data && (
          <p className={`status spaced ${test.data.ok ? "status--good" : "status--bad"}`}>
            {test.data.message}
            {test.data.ok && ` (${test.data.model_select}, ${test.data.model_draft})`}
          </p>
        )}
      </form>
    </section>
  );
}
