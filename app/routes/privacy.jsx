// Public privacy policy page served at /privacy (no authentication required).
// Linked from the Shopify App Store listing's "Privacy policy URL" field.

const SUPPORT_EMAIL = "apps.zofonix@gmail.com";
const APP_NAME = "Shipofix";
const LAST_UPDATED = "June 3, 2026";

export const meta = () => [
  { title: `${APP_NAME} — Privacy Policy` },
  {
    name: "description",
    content: `Privacy policy for the ${APP_NAME} Shopify app.`,
  },
];

const page = {
  maxWidth: "760px",
  margin: "0 auto",
  padding: "48px 24px 96px",
  fontFamily:
    "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#1a1a1a",
  lineHeight: 1.6,
};

export default function PrivacyPolicy() {
  return (
    <main style={page}>
      <h1 style={{ fontSize: "32px", marginBottom: "4px" }}>Privacy Policy</h1>
      <p style={{ color: "#6b7280", marginTop: 0 }}>
        Last updated: {LAST_UPDATED}
      </p>

      <p>
        This Privacy Policy explains how the {APP_NAME} application
        (&quot;{APP_NAME}&quot;, &quot;we&quot;, &quot;us&quot;) collects, uses,
        and protects information when a merchant installs and uses the app on
        their store. By installing {APP_NAME}, you agree to the practices
        described below.
      </p>

      <h2>1. Information We Collect</h2>
      <p>
        {APP_NAME} only collects the information required to provide its shipping
        rate management features:
      </p>
      <ul>
        <li>
          <strong>Store information:</strong> your store domain and a secure
          access token issued by your store platform during installation.
        </li>
        <li>
          <strong>Shipping configuration:</strong> the shipping zones, delivery
          countries, carrier rates, pricing rules, and any files you upload to
          create or update shipping rules.
        </li>
        <li>
          <strong>Plan and billing status:</strong> the plan you select and, if
          billing is enabled, related subscription status.
        </li>
      </ul>
      <p>
        {APP_NAME} does <strong>not</strong> collect or store the personal
        information of your customers (names, addresses, emails, or payment
        details). Shipping rates are calculated in real time from the
        destination details sent to the app during checkout and are not retained
        afterward.
      </p>

      <h2>2. How We Use Information</h2>
      <p>We use the information solely to:</p>
      <ul>
        <li>Provide and operate the app&apos;s shipping rate functionality.</li>
        <li>Return shipping rates to your store&apos;s checkout.</li>
        <li>Save and manage the shipping rules you configure.</li>
        <li>Provide support and respond to your requests.</li>
      </ul>

      <h2>3. How We Share Information</h2>
      <p>
        We do <strong>not</strong> sell, rent, or trade your information. Data
        is exchanged only with your store platform&apos;s official APIs as
        needed to operate the app, and with infrastructure providers that host
        the application on our behalf under appropriate confidentiality
        obligations.
      </p>

      <h2>4. Data Storage and Security</h2>
      <p>
        Information is stored in a secure database and transmitted over
        encrypted connections (TLS/SSL). We apply reasonable technical and
        organizational measures to protect it against unauthorized access, loss,
        or misuse.
      </p>

      <h2>5. Data Retention and Deletion</h2>
      <p>
        We retain your configuration data only while the app is installed. When
        you uninstall {APP_NAME}, your session and access token are deleted, and
        associated store data is removed in accordance with the platform&apos;s
        mandatory data-removal (compliance) webhooks. You may also request
        deletion at any time by contacting us.
      </p>

      <h2>6. Your Rights</h2>
      <p>
        Depending on your location, you may have the right to access, correct,
        or delete the information associated with your store. To exercise these
        rights, contact us using the details below.
      </p>

      <h2>7. Changes to This Policy</h2>
      <p>
        We may update this Privacy Policy from time to time. Material changes
        will be reflected by updating the &quot;Last updated&quot; date at the
        top of this page.
      </p>

      <h2>8. Contact Us</h2>
      <p>
        If you have any questions about this Privacy Policy or how your data is
        handled, contact us at{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </main>
  );
}
