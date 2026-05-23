/**
 * ZoneModal — create/edit zone modal with country/province picker.
 * Also includes the delete confirmation modal.
 */

import { useCallback, useMemo, useState } from "react";
import {
  BlockStack,
  Box,
  Checkbox,
  Divider,
  Icon,
  InlineStack,
  Scrollable,
  Text,
  TextField,
} from "@shopify/polaris";
import { Modal, TitleBar } from "@shopify/app-bridge-react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  SearchIcon,
} from "@shopify/polaris-icons";
import ALL_COUNTRIES from "../lib/locations.json";

export default function ZoneModal({
  zoneModalMode,
  modalZoneName,
  setModalZoneName,
  modalSelectedRegions,
  setModalSelectedRegions,
  expandedCountries,
  setExpandedCountries,
  countrySearch,
  setCountrySearch,
  onSave,
  // Delete modal
  deletingZoneId,
  setDeletingZoneId,
  onConfirmDelete,
}) {
  const filteredCountries = useMemo(() => {
    if (!countrySearch) return ALL_COUNTRIES;
    const q = countrySearch.toLowerCase();
    return ALL_COUNTRIES.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q),
    );
  }, [countrySearch]);

  const toggleCountry = useCallback(
    (code) => {
      setModalSelectedRegions((prev) => {
        const isPartiallyOrFullySelected =
          prev[code]?.checked || prev[code]?.indeterminate;
        if (isPartiallyOrFullySelected) {
          const next = { ...prev };
          delete next[code];
          return next;
        } else {
          return {
            ...prev,
            [code]: { checked: true, indeterminate: false, provinces: [] },
          };
        }
      });
    },
    [setModalSelectedRegions],
  );

  const toggleProvince = useCallback(
    (countryCode, provinceCode) => {
      setModalSelectedRegions((prev) => {
        const countryData = prev[countryCode] || {
          checked: false,
          indeterminate: false,
          provinces: [],
        };
        const allStates =
          ALL_COUNTRIES.find((c) => c.code === countryCode)?.provinces || [];
        const allStateCodes = allStates.map((s) => s.code);

        let newProvinces;
        if (countryData.indeterminate) {
          newProvinces = countryData.provinces.includes(provinceCode)
            ? countryData.provinces.filter((p) => p !== provinceCode)
            : [...countryData.provinces, provinceCode];
        } else if (countryData.checked) {
          newProvinces = allStateCodes.filter((p) => p !== provinceCode);
        } else {
          newProvinces = [provinceCode];
        }

        if (newProvinces.length === 0) {
          const next = { ...prev };
          delete next[countryCode];
          return next;
        }

        if (newProvinces.length === allStateCodes.length) {
          return {
            ...prev,
            [countryCode]: {
              checked: true,
              indeterminate: false,
              provinces: [],
            },
          };
        }

        return {
          ...prev,
          [countryCode]: {
            checked: false,
            indeterminate: true,
            provinces: newProvinces,
          },
        };
      });
    },
    [setModalSelectedRegions],
  );

  const toggleExpandCountry = useCallback(
    (code, e) => {
      e.stopPropagation();
      setExpandedCountries((prev) => {
        const next = new Set(prev);
        if (next.has(code)) next.delete(code);
        else next.add(code);
        return next;
      });
    },
    [setExpandedCountries],
  );

  return (
    <>
      {/* ── Zone Create/Edit Modal ── */}
      <Modal id="zone-modal">
        <Box padding="400">
          <BlockStack gap="400">
            <TextField
              label="Zone Name"
              value={modalZoneName}
              onChange={setModalZoneName}
              autoComplete="off"
              placeholder="e.g. South Asia, Europe, North America"
              helpText="Customers won't see this name"
            />

            <Divider />

            <InlineStack align="space-between" blockAlign="center">
              <Text variant="headingSm">Regions</Text>
              <span className="selection-counter">
                {Object.keys(modalSelectedRegions).length} selected
              </span>
            </InlineStack>

            <TextField
              label="Search countries"
              labelHidden
              value={countrySearch}
              onChange={setCountrySearch}
              prefix={<Icon source={SearchIcon} />}
              autoComplete="off"
              placeholder="Search countries..."
            />

            <Scrollable style={{ maxHeight: "320px" }} shadow>
              <div style={{ padding: "4px 0" }}>
                {filteredCountries.map((country) => {
                  const stateData = modalSelectedRegions[country.code];
                  const isChecked = stateData?.checked || false;
                  const isIndeterminate = stateData?.indeterminate || false;
                  const isExpanded = expandedCountries.has(country.code);
                  const countryObj = ALL_COUNTRIES.find(
                    (c) => c.code === country.code,
                  );
                  const provinces = countryObj?.provinces || [];
                  const hasProvinces = provinces.length > 0;

                  return (
                    <div
                      key={country.code}
                      style={{ display: "flex", flexDirection: "column" }}
                    >
                      <div
                        className="country-list-item"
                        onClick={() => toggleCountry(country.code)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                          }}
                        >
                          <Checkbox
                            label=""
                            labelHidden
                            checked={
                              isIndeterminate ? "indeterminate" : isChecked
                            }
                            onChange={() => toggleCountry(country.code)}
                          />
                          <span className="country-name">{country.name}</span>
                          <span className="country-code">{country.code}</span>
                        </div>
                        {hasProvinces && (
                          <div
                            onClick={(e) =>
                              toggleExpandCountry(country.code, e)
                            }
                            style={{ cursor: "pointer", padding: "4px" }}
                          >
                            <Icon
                              source={
                                isExpanded ? ChevronUpIcon : ChevronDownIcon
                              }
                              tone="base"
                            />
                          </div>
                        )}
                      </div>

                      {isExpanded && hasProvinces && (
                        <div
                          style={{
                            paddingLeft: "32px",
                            background: "#f9f9f9",
                            borderBottom: "1px solid #eee",
                          }}
                        >
                          {provinces.map((prov) => {
                            const provSelected =
                              stateData?.checked ||
                              (stateData?.indeterminate &&
                                stateData.provinces.includes(prov.code));
                            return (
                              <div
                                key={prov.code}
                                className="country-list-item"
                                onClick={() =>
                                  toggleProvince(country.code, prov.code)
                                }
                              >
                                <Checkbox
                                  label=""
                                  labelHidden
                                  checked={!!provSelected}
                                  onChange={() =>
                                    toggleProvince(country.code, prov.code)
                                  }
                                />
                                <span className="country-name">
                                  {prov.name}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Scrollable>
          </BlockStack>
        </Box>

        <TitleBar
          title={
            zoneModalMode === "create"
              ? "Create Shipping Zone"
              : "Edit Shipping Zone"
          }
        >
          <button onClick={() => shopify.modal.hide("zone-modal")}>
            Cancel
          </button>
          <button
            variant="primary"
            onClick={onSave}
            disabled={
              !modalZoneName ||
              Object.keys(modalSelectedRegions).length === 0
            }
          >
            {zoneModalMode === "create" ? "Create" : "Save"}
          </button>
        </TitleBar>
      </Modal>

      {/* ── Delete Confirmation Modal ── */}
      <Modal id="delete-zone-modal" variant="small">
        <Box padding="400">
          <Text variant="bodyMd">
            Are you sure you want to delete this zone? This will also remove any
            custom shipping rules associated with it. This action cannot be
            undone.
          </Text>
        </Box>
        <TitleBar title="Delete Shipping Zone">
          <button
            onClick={() => {
              setDeletingZoneId(null);
              shopify.modal.hide("delete-zone-modal");
            }}
          >
            Cancel
          </button>
          <button
            variant="primary"
            tone="critical"
            onClick={onConfirmDelete}
          >
            Delete
          </button>
        </TitleBar>
      </Modal>
    </>
  );
}
