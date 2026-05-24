/**
 * BulkEdit — Excel-based bulk shipping rule editor.
 *
 * Vendor downloads a pre-filled .xlsx, edits Logic # / values, uploads.
 * Empty Logic # rows are skipped — existing rules stay untouched.
 */

import { useCallback, useEffect, useState } from "react";
import { useFetcher } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  DropZone,
  InlineStack,
  List,
  Modal,
  Text,
} from "@shopify/polaris";
import BulkEditDocs from "./BulkEditDocs";

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
  const [confirmDownload, setConfirmDownload] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lastDeleteData, setLastDeleteData] = useState(null);
  const [docsOpen, setDocsOpen] = useState(false);

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
     on the Bulk Edit tab is the right thing here). Effect, not render-time,
     so we don't update the parent component while this one is rendering. */
  useEffect(() => {
    if (
      deleteFetcher.state !== "idle" ||
      !deleteFetcher.data ||
      deleteFetcher.data === lastDeleteData
    ) {
      return;
    }
    setLastDeleteData(deleteFetcher.data);
    if (deleteFetcher.data.message && onToast) onToast(deleteFetcher.data.message);
    if (deleteFetcher.data.error && onToast) onToast(`Error: ${deleteFetcher.data.error}`);
  }, [deleteFetcher.state, deleteFetcher.data, lastDeleteData, onToast]);

  // Surface upload result when fetcher settles (also an effect for the same reason).
  useEffect(() => {
    if (
      fetcher.state !== "idle" ||
      !fetcher.data ||
      fetcher.data === lastResult
    ) {
      return;
    }
    setLastResult(fetcher.data);
    setFile(null);
    if (fetcher.data.message && onToast) onToast(fetcher.data.message);
    if (fetcher.data.error && onToast) onToast(`Error: ${fetcher.data.error}`);
    if (fetcher.data.success && onApplied) onApplied();
  }, [fetcher.state, fetcher.data, lastResult, onToast, onApplied]);

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

      {/* Quick pointer to the full guide (Logic #, codes, examples) */}
      <Banner
        tone="info"
        title="New to the template? Read the guide first."
        action={{
          content: "View documentation",
          onAction: () => setDocsOpen(true),
        }}
      >
        <Text>
          The guide explains the two editable sheets — <b>Bulk Edit</b> for
          coverage + logic, and <b>Rate Bands</b> for category slabs (Logic 2
          &amp; 3) — and lists every Logic # and country / zone code.
        </Text>
      </Banner>

      {/* Step 1: download */}
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center" gap="400" wrap={false}>
            <Text variant="headingMd" as="h3">
              Step 1 · Download the template
            </Text>
            <InlineStack gap="200" wrap={false}>
              <Button onClick={() => setDocsOpen(true)}>
                View documentation
              </Button>
              <Button
                variant="primary"
                loading={downloading}
                onClick={handleDownloadTemplate}
                accessibilityLabel="Download Excel template"
              >
                Download .xlsx
              </Button>
            </InlineStack>
          </InlineStack>
          <Text tone="subdued">
            The workbook ships with four sheets: <b>Bulk Edit</b> (coverage +
            logic, with Country / Zone dropdowns pre-filled), <b>Rate Bands</b>{" "}
            (slabs for Logic 2 &amp; 3 — one row per band, linked by Name),{" "}
            <b>All Regions</b> (read-only reference), and <b>Instructions</b>.
            Fill in only the rows you need.
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

      {/* Full Excel walkthrough — Logic # reference, country codes, examples */}
      <BulkEditDocs open={docsOpen} onClose={() => setDocsOpen(false)} />

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
