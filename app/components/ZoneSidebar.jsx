/**
 * ZoneSidebar — zone list panel for the Configuration Logic tab.
 * Premium design with zone count badge and animated list items.
 */

import {
  Button,
  Card,
  Divider,
  Icon,
  Text,
} from "@shopify/polaris";
import {
  GlobeIcon,
  HomeIcon,
  PlusIcon,
} from "@shopify/polaris-icons";

/* Short, friendly labels for the rule preview line under each zone name.
   Keys mirror the internal logicType strings written by LogicEditor. */
const LOGIC_LABELS = {
  STANDARD_TIER: "flat price",
  WEIGHT_RANGE: "weight tiers",
  PRICE_RANGE: "order-value tiers",
  WEIGHT_MULTIPLIER: "per kilogram",
  PRICE_MULTIPLIER: "% of cart",
  ITEM_MULTIPLIER: "per item",
};

export default function ZoneSidebar({
  zones,
  selectedZoneId,
  onSelectZone,
  onCreateZone,
  disabled = false,
}) {
  const customCount = zones.filter((z) => z.rule).length;

  return (
    <Card padding="0">
      <div className="zone-sidebar-header">
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <h3>Your zones</h3>
          <span
            style={{
              fontSize: "0.65rem",
              fontWeight: 700,
              background: "#F5F5F5",
              color: "#000",
              padding: "2px 8px",
              borderRadius: "12px",
              border: "1px solid #E5E5E5",
            }}
          >
            {zones.length}
          </span>
        </div>
        <Button
          variant="plain"
          icon={PlusIcon}
          onClick={onCreateZone}
          accessibilityLabel="Add zone"
          disabled={disabled}
        />
      </div>
      <Divider />

      <div
        className="zone-sidebar-list"
        style={{ padding: "8px 0", maxHeight: "60vh", overflowY: "auto" }}
      >
        {zones.length === 0 ? (
          <div style={{ padding: "32px 20px", textAlign: "center" }}>
            <Text variant="bodySm" tone="subdued">
              You don&apos;t have any shipping zones yet. Click{" "}
              <b>Add new zone</b> below to group the countries you ship to,
              then come back to set their prices.
            </Text>
          </div>
        ) : (
          zones.map((z, i) => (
            <div
              key={z.id}
              className={`zone-item ${z.id === selectedZoneId ? "active" : ""}`}
              onClick={() => onSelectZone(z.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectZone(z.id);
                }
              }}
              role="button"
              tabIndex={0}
              aria-pressed={z.id === selectedZoneId}
              aria-label={`Select zone ${z.name}`}
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <div
                className={`zone-icon ${z.isDomestic ? "domestic" : "international"}`}
              >
                <Icon source={z.isDomestic ? HomeIcon : GlobeIcon} />
              </div>
              <div className="zone-info">
                <div className="zone-name">{z.name}</div>
                <div className="zone-meta">
                  {z.countries.length}{" "}
                  {z.countries.length === 1 ? "country" : "countries"}
                  {z.rule && (
                    <span style={{ color: "#737373", marginLeft: "6px" }}>
                      · {LOGIC_LABELS[z.rule.logicType] || z.rule.logicType.replace(/_/g, " ").toLowerCase()}
                    </span>
                  )}
                </div>
              </div>
              {z.rule ? (
                <span className="zone-badge custom">Your rate</span>
              ) : (
                <span className="zone-badge default">Shopify default</span>
              )}
            </div>
          ))
        )}
      </div>

      {customCount > 0 && (
        <>
          <Divider />
          <div style={{ padding: "10px 20px" }}>
            <Text variant="bodySm" tone="subdued">
              {customCount} of {zones.length}{" "}
              {zones.length === 1 ? "zone has" : "zones have"} a price set —
              the rest use Shopify&apos;s default rates.
            </Text>
          </div>
        </>
      )}

      <div style={{ padding: "0 16px 16px" }}>
        <button
          className="zone-create-btn"
          onClick={onCreateZone}
          disabled={disabled}
          style={disabled ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
            <path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" />
          </svg>
          Add new zone
        </button>
      </div>
    </Card>
  );
}
