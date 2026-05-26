/**
 * BulkEdit — Excel-based bulk shipping rule editor.
 *
 * Vendor downloads a pre-filled .xlsx, edits Logic # / values, uploads.
 * Empty Logic # rows are skipped — existing rules stay untouched.
 *
 * Uploaded rules are written into ZoneRule with source='bulk' and live
 * alongside one-by-one zone rules. Re-uploading replaces every previously-
 * uploaded bulk rule but never touches zone-wise rules.
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
  Text,
} from "@shopify/polaris";
import BulkEditDocs from "./BulkEditDocs";

export default function BulkEdit({ onToast, onApplied }) {
  const fetcher = useFetcher();
  const [file, setFile] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const [downloading, setDownloading] = useState(false);
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

  // Surface upload result when fetcher settles (effect, not render-time,
  // so we don't update the parent component while this one is rendering).
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
    /* Surface the result via toast. A rejected upload (success === false
       with a message) must read as an error, not a green confirmation. */
    if (fetcher.data.message && onToast) {
      const prefix = fetcher.data.success === false ? "Error: " : "";
      onToast(`${prefix}${fetcher.data.message}`);
    }
    if (fetcher.data.error && onToast) onToast(`Error: ${fetcher.data.error}`);
    if (fetcher.data.success && onApplied) onApplied();
  }, [fetcher.state, fetcher.data, lastResult, onToast, onApplied]);

  const uploading =
    fetcher.state === "submitting" || fetcher.state === "loading";

  /* Result banners — extracted into a render helper so they can sit inside
     the left column of the two-column layout (next to the upload action),
     instead of full-width below the whole grid. */
  const renderResultBanners = () => (
    <>
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
      {lastResult && lastResult.warnings && lastResult.warnings.length > 0 && (
        <Banner tone="warning" title={`${lastResult.warnings.length} heads-up${lastResult.warnings.length === 1 ? "" : "s"} — rules still applied`}>
          <List type="bullet">
            {lastResult.warnings.slice(0, 12).map((w, i) => (
              <List.Item key={i}>
                <Text variant="bodySm">{w}</Text>
              </List.Item>
            ))}
          </List>
        </Banner>
      )}
      {lastResult && lastResult.success === false && Array.isArray(lastResult.errors) && lastResult.errors.length > 0 && (
        <Banner tone="critical" title={lastResult.message || "Upload rejected — fix the issues below."}>
          <BlockStack gap="200">
            <Text variant="bodySm">
              Your existing rules were <b>not</b> changed. Fix the issues
              below in the spreadsheet and upload again — the upload only
              applies when every rule is valid.
            </Text>
            <List type="bullet">
              {lastResult.errors.slice(0, 20).map((e, i) => (
                <List.Item key={i}>
                  <Text variant="bodySm">{e}</Text>
                </List.Item>
              ))}
            </List>
            {lastResult.errors.length > 20 && (
              <Text variant="bodySm" tone="subdued">
                …and {lastResult.errors.length - 20} more.
              </Text>
            )}
          </BlockStack>
        </Banner>
      )}
      {lastResult && lastResult.error && (
        <Banner tone="critical" title="Upload failed">
          <Text>{lastResult.error}</Text>
        </Banner>
      )}
    </>
  );

  return (
    <BlockStack gap="400">
      {/* Two-column layout. LEFT column holds the full workflow top-to-
          bottom: Step 1 (download) → Step 2 (upload) → result banners.
          RIGHT column holds the docs pointer. Collapses to one column
          under 980 px via the bulk-edit-split CSS class. */}
      <div className="bulk-edit-split">
        {/* ── LEFT column: Step 1 → Step 2 → results ── */}
        <div className="bulk-edit-split-col">
          <BlockStack gap="400">
            {/* Step 1: download */}
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text variant="headingMd" as="h3">
                    Step 1 · Download the template
                  </Text>
                  <Text tone="subdued">
                    The workbook ships with four sheets: <b>Bulk Edit</b> (coverage +
                    logic, with Country / Zone dropdowns pre-filled), <b>Rate Bands</b>{" "}
                    (slabs for Logic 2 &amp; 3 — one row per band, linked by Name),{" "}
                    <b>All Regions</b> (read-only reference), and <b>Instructions</b>.
                    Fill in only the rows you need.
                  </Text>
                </BlockStack>
                <InlineStack align="end" gap="200" wrap={false}>
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
              </BlockStack>
            </Card>

            {/* Step 2: upload */}
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text variant="headingMd" as="h3">Step 2 · Upload the filled template</Text>
                  <Text tone="subdued">
                    Uploading replaces every previously-uploaded rule for this
                    shop. Rules you created one-by-one from the All rates tab
                    are untouched.
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
            {/* Result banners render below the upload card on the LEFT side
                so feedback sits next to the action that produced it. */}
            {renderResultBanners()}
          </BlockStack>
        </div>

        {/* ── RIGHT column: docs pointer ── */}
        <div className="bulk-edit-split-col">
          <BlockStack gap="400">
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
          </BlockStack>
        </div>
      </div>

      {/* Full Excel walkthrough — Logic # reference, country codes, examples */}
      <BulkEditDocs open={docsOpen} onClose={() => setDocsOpen(false)} />
    </BlockStack>
  );
}
