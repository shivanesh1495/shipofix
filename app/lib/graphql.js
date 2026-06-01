/**
 * Named GraphQL query & mutation constants.
 * Extracted from app._index.jsx to reduce noise and enable reuse.
 */

/* ── Carrier Service queries ─────────────────────────────────────────── */

export const QUERY_CARRIER_SERVICES = `#graphql
  query ListCarrierServices {
    carrierServices(first: 20) {
      edges { node { id name callbackUrl active } }
    }
  }
`;

export const MUTATION_CREATE_CARRIER = `#graphql
  mutation CreateCarrierService($input: DeliveryCarrierServiceCreateInput!) {
    carrierServiceCreate(input: $input) {
      carrierService { id }
      userErrors { message }
    }
  }
`;

export const MUTATION_UPDATE_CARRIER = `#graphql
  mutation UpdateCarrierService($input: DeliveryCarrierServiceUpdateInput!) {
    carrierServiceUpdate(input: $input) {
      carrierService { id callbackUrl }
      userErrors { field message }
    }
  }
`;

export const MUTATION_DELETE_CARRIER = `#graphql
  mutation DeleteCarrierService($id: ID!) {
    carrierServiceDelete(id: $id) {
      userErrors { message }
    }
  }
`;

/* ── Delivery zone queries ───────────────────────────────────────────── */

export const QUERY_DELIVERY_ZONES = `#graphql
  query GetZones {
    shop { billingAddress { countryCodeV2 } }
    deliveryProfiles(first: 5) {
      edges {
        node {
          id
          name
          default
          profileLocationGroups {
            locationGroup {
              id
            }
            locationGroupZones(first: 100) {
              edges {
                node {
                  zone {
                    id
                    name
                    countries {
                      code { countryCode restOfWorld }
                      name
                      provinces {
                        code
                        name
                      }
                    }
                  }
                  methodDefinitions(first: 10) {
                    edges {
                      node {
                        id
                        name
                        active
                        rateProvider {
                          __typename
                          ... on DeliveryParticipant {
                            id
                          }
                          ... on DeliveryRateDefinition {
                            id
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const MUTATION_DELIVERY_PROFILE_UPDATE = `#graphql
  mutation DeliveryProfileUpdate($profileId: ID!, $profile: DeliveryProfileInput!) {
    deliveryProfileUpdate(id: $profileId, profile: $profile) {
      profile { id }
      userErrors { field message }
    }
  }
`;
