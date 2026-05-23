/**
 * BulkEdit — Excel-based bulk shipping rule editor.
 *
 * Vendor downloads a pre-filled .xlsx, edits Logic # / values, uploads.
 * Empty Logic # rows are skipped — existing rules stay untouched.
 */

import { useCallback, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  DropZone,
  Icon,
  InlineStack,
  List,
  Modal,
  Scrollable,
  Text,
  TextField,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";
import ALL_COUNTRIES from "../lib/locations.json";

const LOGIC_REFERENCE = [
  { num: 1, label: "Standard Flat Tier", hint: "Fill Rate column. One row per zone." },
  { num: 2, label: "Weight Based (Category)", hint: "Use Min / Max / Rate. Multiple rows per zone = bands." },
  { num: 3, label: "Price Based (Category)", hint: "Use Min / Max / Rate on cart total. Multiple rows = bands." },
  { num: 4, label: "Per KG Dynamic", hint: "Fill Rate column with rate per kg." },
  { num: 5, label: "Per Price Dynamic", hint: "Fill Rate column with decimal % (0.1 = 10%)." },
  { num: 6, label: "Per Item Dynamic", hint: "Fill Rate column with rate per item." },
];

const SORTED_COUNTRIES = [...ALL_COUNTRIES].sort((a, b) =>
  a.name.localeCompare(b.name),
);

/* Escape special regex chars so user-typed text is treated literally */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* Wrap matched substrings in <mark> for visual highlight.
   tokens is a pre-lowered list of whitespace-split search tokens. */
function highlight(text, tokens) {
  const s = String(text ?? "");
  if (!tokens.length || !s) return s;
  const re = new RegExp(`(${tokens.map(escapeRegex).join("|")})`, "gi");
  const parts = s.split(re);
  return parts.map((p, i) => {
    if (!p) return null;
    return tokens.includes(p.toLowerCase()) ? (
      <mark key={i} className="bulk-codes-mark">
        {p}
      </mark>
    ) : (
      <span key={i}>{p}</span>
    );
  });
}

export default function BulkEdit({
  enabled,
  lastUpload = null,
  onToast,
  onApplied,
  onToggleEnabled,
  toggling = false,
}) {
  const fetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const [file, setFile] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadingLast, setDownloadingLast] = useState(false);
  const [codesSearch, setCodesSearch] = useState("");
  const [confirmDownload, setConfirmDownload] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lastDeleteData, setLastDeleteData] = useState(null);

  const searchTokens = useMemo(() => {
    return codesSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
  }, [codesSearch]);

  const filteredCountries = useMemo(() => {
    if (!searchTokens.length) return SORTED_COUNTRIES;
    /* Country (or any of its zones) must match ALL tokens to be shown */
    return SORTED_COUNTRIES.filter((c) =>
      searchTokens.every((tok) => {
        if (c.name.toLowerCase().includes(tok)) return true;
        if (c.code.toLowerCase().includes(tok)) return true;
        return (c.provinces || []).some(
          (p) =>
            p.name.toLowerCase().includes(tok) ||
            p.code.toLowerCase().includes(tok),
        );
      }),
    );
  }, [searchTokens]);

  const handleDrop = useCallback((_dropped, accepted) => {
    if (accepted.length > 0) setFile(accepted[0]);
  }, []);

  const handleDownloadTemplate = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await fetch("/app/bulk-edit?intent=template", {
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "shipofix-bulk-edit.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      if (onToast) onToast(`Error: Could not download template (${e.message})`);
    } finally {
      setDownloading(false);
    }
  }, [downloading, onToast]);

  const handleUpload = useCallback(() => {
    if (!file) return;
    const body = new FormData();
    body.set("file", file, file.name);
    fetcher.submit(body, {
      method: "POST",
      action: "/app/bulk-edit",
      encType: "multipart/form-data",
    });
  }, [fetcher, file]);

  const handleDownloadLast = useCallback(async () => {
    if (downloadingLast || !lastUpload) return;
    setConfirmDownload(false);
    setDownloadingLast(true);
    try {
      const res = await fetch("/app/bulk-edit?intent=last", {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = lastUpload.filename || "shipofix-last-upload.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      if (onToast) onToast(`Error: Could not download last upload (${e.message})`);
    } finally {
      setDownloadingLast(false);
    }
  }, [downloadingLast, lastUpload, onToast]);

  const handleDeleteLast = useCallback(() => {
    setConfirmDelete(false);
    const body = new FormData();
    body.set("intent", "delete_last");
    deleteFetcher.submit(body, {
      method: "POST",
      action: "/app/bulk-edit",
    });
  }, [deleteFetcher]);

  /* Surface delete result via the same toast pipe (don't navigate — staying
     on the Bulk Edit tab is the right thing here). */
  if (
    deleteFetcher.state === "idle" &&
    deleteFetcher.data &&
    deleteFetcher.data !== lastDeleteData
  ) {
    setLastDeleteData(deleteFetcher.data);
    if (deleteFetcher.data.message && onToast) onToast(deleteFetcher.data.message);
    if (deleteFetcher.data.error && onToast) onToast(`Error: ${deleteFetcher.data.error}`);
  }

  // Surface result state when fetcher settles
  if (
    fetcher.state === "idle" &&
    fetcher.data &&
    fetcher.data !== lastResult
  ) {
    setLastResult(fetcher.data);
    setFile(null);
    if (fetcher.data.message && onToast) onToast(fetcher.data.message);
    if (fetcher.data.error && onToast) onToast(`Error: ${fetcher.data.error}`);
    if (fetcher.data.success && onApplied) onApplied();
  }

  const uploading =
    fetcher.state === "submitting" || fetcher.state === "loading";

  if (!enabled) {
    return (
      <Card>
        <Box padding="500">
          <BlockStack gap="300" align="center" inlineAlign="center">
            <Text variant="headingMd" as="h3">Bulk Edit is turned off</Text>
            <Text tone="subdued">
              Turn it on to import shipping rules from an Excel template.
            </Text>
            {onToggleEnabled && (
              <Button
                variant="primary"
                loading={toggling}
                onClick={() => onToggleEnabled(true)}
              >
                Turn on Bulk Edit
              </Button>
            )}
          </BlockStack>
        </Box>
      </Card>
    );
  }

  return (
    <BlockStack gap="400">
      {/* Feature toggle — managed by app, kept beside the workflow itself */}
      {onToggleEnabled && (
        <Card>
          <Box padding="300">
            <InlineStack align="space-between" blockAlign="center" wrap={false}>
              <BlockStack gap="050">
                <InlineStack gap="200" blockAlign="center">
                  <Text variant="headingSm" as="h3">Bulk Edit</Text>
                  <Badge tone="success">On</Badge>
                </InlineStack>
                <Text tone="subdued" variant="bodySm">
                  Import shipping rules from an Excel template · Managed by app
                </Text>
              </BlockStack>
              <Button
                tone="critical"
                loading={toggling}
                onClick={() => onToggleEnabled(false)}
              >
                Turn off
              </Button>
            </InlineStack>
          </Box>
        </Card>
      )}

      {/* Important notification with Logic # reference */}
      <Banner
        tone="warning"
        title="Before you fill the template · Logic # reference"
      >
        <BlockStack gap="200">
          <Text>
            Each zone&apos;s shipping behavior is set with a single number in the{" "}
            <b>Logic #</b> column. Leave it blank to keep the existing rule
            unchanged. Set it to <b>0</b> to reset the zone to Shopify Default.
          </Text>
          <div className="bulk-logic-grid">
            {LOGIC_REFERENCE.map((l) => (
              <div key={l.num} className="bulk-logic-row">
                <span className="bulk-logic-num">{l.num}</span>
                <div>
                  <div className="bulk-logic-label">{l.label}</div>
                  <div className="bulk-logic-hint">{l.hint}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="bulk-codes-note">
            <div className="bulk-codes-title">Country &amp; zone codes</div>
            <div className="bulk-codes-body">
              Both ISO codes are shown inline in the <b>Country</b> and{" "}
              <b>Zone</b> columns of every row — e.g.{" "}
              <code>India (IN)</code> · <code>Tamil Nadu (TN)</code>. The full
              searchable reference is below, and the <b>All Regions</b> sheet
              inside the template contains the same list.
            </div>
          </div>
        </BlockStack>
      </Banner>

      {/* Full country & zone code reference */}
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center" wrap={false}>
            <BlockStack gap="050">
              <Text variant="headingMd" as="h3">
                Country &amp; zone code reference
              </Text>
              <Text tone="subdued">
                Every country and every state / province / division — with the
                ISO codes you&apos;ll see in the template.
              </Text>
            </BlockStack>
            <Badge>
              {`${filteredCountries.length} of ${SORTED_COUNTRIES.length} countries`}
            </Badge>
          </InlineStack>

          <TextField
            label="Search countries or zones"
            labelHidden
            value={codesSearch}
            onChange={setCodesSearch}
            prefix={<Icon source={SearchIcon} />}
            placeholder="Search by country or zone name / code…"
            autoComplete="off"
            clearButton
            onClearButtonClick={() => setCodesSearch("")}
          />

          <Scrollable style={{ maxHeight: "360px" }} shadow>
            <div className="bulk-codes-list">
              {filteredCountries.map((c) => (
                <div key={c.code} className="bulk-codes-country">
                  <div className="bulk-codes-country-head">
                    <span className="bulk-codes-country-name">
                      {highlight(c.name, searchTokens)}
                    </span>
                    <span className="bulk-codes-country-code">
                      {highlight(c.code, searchTokens)}
                    </span>
                    {c.provinces && c.provinces.length > 0 && (
                      <span className="bulk-codes-country-count">
                        {c.provinces.length} zones
                      </span>
                    )}
                  </div>
                  {c.provinces && c.provinces.length > 0 && (
                    <div className="bulk-codes-province-grid">
                      {c.provinces.map((p) => (
                        <span key={p.code} className="bulk-codes-chip">
                          <span className="bulk-codes-chip-name">
                            {highlight(p.name, searchTokens)}
                          </span>
                          <span className="bulk-codes-chip-code">
                            {highlight(p.code, searchTokens)}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {filteredCountries.length === 0 && (
                <div className="bulk-codes-empty">
                  <Text tone="subdued" variant="bodySm">
                    No countries or zones match &quot;{codesSearch}&quot;.
                  </Text>
                </div>
              )}
            </div>
          </Scrollable>
        </BlockStack>
      </Card>

      {/* Step 1: download */}
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center" gap="400" wrap={false}>
            <Text variant="headingMd" as="h3">
              Step 1 · Download the template
            </Text>
            <Button
              variant="primary"
              loading={downloading}
              onClick={handleDownloadTemplate}
              accessibilityLabel="Download Excel template"
            >
              Download .xlsx
            </Button>
          </InlineStack>
          <Text tone="subdued">
            One row per official country / region — Country and Zone columns
            pre-filled as reference. The <b>Name</b> column is blank with a
            dropdown of your Shopify shipping zones; rule columns (Logic #,
            Currency, Min, Max, Rate) are blank too. Fill in only the rows you
            need. The bundled <b>All Regions</b> sheet lists every country and
            its states / provinces / divisions.
          </Text>
        </BlockStack>
      </Card>

      {/* Last upload — only when a previous file is stored */}
      {lastUpload && (
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" gap="400" wrap={false}>
              <Text variant="headingMd" as="h3">
                Last uploaded file
              </Text>
              <InlineStack gap="200" wrap={false}>
                <Button
                  loading={downloadingLast}
                  onClick={() => setConfirmDownload(true)}
                >
                  Download
                </Button>
                <Button
                  tone="critical"
                  loading={deleteFetcher.state !== "idle"}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete
                </Button>
              </InlineStack>
            </InlineStack>
            <Text tone="subdued">
              Download this to tweak a row, then delete the stored copy and
              upload the edited version. Re-uploading replaces every existing
              rule.
            </Text>
            <Box
              padding="300"
              background="bg-surface-secondary"
              borderRadius="200"
            >
              <BlockStack gap="050">
                <Text fontWeight="semibold">{lastUpload.filename}</Text>
                <Text tone="subdued" variant="bodySm">
                  {(lastUpload.size / 1024).toFixed(1)} KB · uploaded{" "}
                  {new Date(lastUpload.uploadedAt).toLocaleString()}
                </Text>
              </BlockStack>
            </Box>
          </BlockStack>
        </Card>
      )}

      {/* Step 2: upload */}
      <Card>
        <BlockStack gap="300">
          <BlockStack gap="050">
            <Text variant="headingMd" as="h3">Step 2 · Upload the filled template</Text>
            <Text tone="subdued">
              Uploading replaces the entire <b>bulk-edit ruleset</b> for this
              shop. Your zone-wise rules from Configuration Logic are
              untouched and will become active again the moment Bulk Edit is
              turned off.
            </Text>
          </BlockStack>

          <DropZone
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            type="file"
            allowMultiple={false}
            onDrop={handleDrop}
          >
            {file ? (
              <Box padding="400">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="050">
                    <Text fontWeight="semibold">{file.name}</Text>
                    <Text tone="subdued" variant="bodySm">
                      {(file.size / 1024).toFixed(1)} KB · ready to upload
                    </Text>
                  </BlockStack>
                  <Badge tone="success">Selected</Badge>
                </InlineStack>
              </Box>
            ) : (
              <DropZone.FileUpload
                actionTitle="Add file"
                actionHint="Drag a .xlsx here, or click to browse"
              />
            )}
          </DropZone>

          <InlineStack align="end" gap="200">
            {file && (
              <Button onClick={() => setFile(null)} disabled={uploading}>
                Clear
              </Button>
            )}
            <Button
              variant="primary"
              onClick={handleUpload}
              loading={uploading}
              disabled={!file || uploading}
            >
              Apply Bulk Edit
            </Button>
          </InlineStack>
        </BlockStack>
      </Card>

      {/* Results */}
      {lastResult && lastResult.success && lastResult.summary && (
        <Banner tone="success" title={lastResult.message}>
          <Text variant="bodySm">
            {lastResult.summary.updated} rule
            {lastResult.summary.updated === 1 ? "" : "s"} created
            {typeof lastResult.summary.wiped === "number" &&
              ` · ${lastResult.summary.wiped} previous rule${lastResult.summary.wiped === 1 ? "" : "s"} cleared`}
          </Text>
          {lastResult.errors && lastResult.errors.length > 0 && (
            <Box paddingBlockStart="200">
              <Text variant="bodySm" tone="critical">
                {lastResult.errors.length} row issue
                {lastResult.errors.length === 1 ? "" : "s"}:
              </Text>
              <List type="bullet">
                {lastResult.errors.slice(0, 8).map((e, i) => (
                  <List.Item key={i}>
                    <Text variant="bodySm">{e}</Text>
                  </List.Item>
                ))}
              </List>
            </Box>
          )}
        </Banner>
      )}
      {lastResult && lastResult.error && (
        <Banner tone="critical" title="Upload failed">
          <Text>{lastResult.error}</Text>
        </Banner>
      )}

      {/* Download-last confirmation */}
      <Modal
        open={confirmDownload}
        onClose={() => setConfirmDownload(false)}
        title="Download last uploaded file?"
        primaryAction={{
          content: "Download",
          onAction: handleDownloadLast,
          loading: downloadingLast,
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setConfirmDownload(false) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text>
              You&apos;ll get the original file exactly as you uploaded it
              {lastUpload?.filename ? ` (${lastUpload.filename})` : ""} — not a
              freshly generated template.
            </Text>
            <Text tone="subdued" variant="bodySm">
              Edit it offline, delete the stored copy, then upload the edited
              version to replace your current rules.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* Delete-last confirmation */}
      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete stored upload?"
        primaryAction={{
          content: "Delete",
          destructive: true,
          onAction: handleDeleteLast,
          loading: deleteFetcher.state !== "idle",
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setConfirmDelete(false) },
        ]}
      >
        <Modal.Section>
          <Text>
            Removes the cached copy of{" "}
            <b>{lastUpload?.filename || "the last upload"}</b>. Your live
            shipping rules are not affected — they only change when you upload a
            new file.
          </Text>
        </Modal.Section>
      </Modal>
    </BlockStack>
  );
}
