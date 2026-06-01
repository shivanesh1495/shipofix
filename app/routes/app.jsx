import {
  Outlet,
  useLoaderData,
  useNavigation,
  useRevalidator,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

import { AppProvider as PolarisProvider } from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import customStyles from "../styles.css?url";
import translations from "@shopify/polaris/locales/en.json";

export const links = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "stylesheet", href: customStyles },
];

/* Thin indeterminate progress bar pinned to the top of the viewport. Shows
   whenever React Router is navigating or revalidating a loader — gives instant
   visual feedback that the app is working while the (network-bound) dashboard
   loader runs, instead of the page appearing frozen. */
function TopProgressBar() {
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const active =
    navigation.state !== "idle" || revalidator.state === "loading";
  return (
    <div
      className={`global-progress${active ? " global-progress--active" : ""}`}
      role="progressbar"
      aria-hidden={!active}
    />
  );
}

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <PolarisProvider i18n={translations}>
      <AppProvider embedded apiKey={apiKey}>
        <TopProgressBar />
        <s-app-nav>
          <s-link href="/app">Home</s-link>
        </s-app-nav>
        <Outlet />
      </AppProvider>
    </PolarisProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
