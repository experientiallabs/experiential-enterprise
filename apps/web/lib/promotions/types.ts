// Promotional-model admin types. Mirror the backend model_promotions v2 AdminView
// and the create/update request bodies (explabs/api/routes/model_promotions.py).

export type PromotionCapScope = "lifetime" | "recurring";

/** Which money lane a promotion applies to. */
export type PromotionFundingScope = "all" | "platform_funded" | "byok";

/** Display labels for the funding-scope selector, in menu order. */
export const FUNDING_SCOPE_OPTIONS: ReadonlyArray<{
  value: PromotionFundingScope;
  label: string;
}> = [
  { value: "platform_funded", label: "Platform-funded only" },
  { value: "all", label: "All traffic" },
  { value: "byok", label: "BYOK only" },
];

/** One promotion as the admin CRUD API returns it (AdminView). */
export type ModelPromotion = {
  id: string;
  label: string;
  /** Concrete slugs in scope, sorted; [] means every model (provider-scoped). */
  model_slugs: string[];
  /** Family keys the admin picked; expansion to slugs happened client-side. */
  family_keys: string[];
  /** Provider lanes the promo is limited to; [] means any provider. */
  providers: string[];
  /** Org-label keys the account must ALL carry; [] means every account. */
  audience_labels: string[];
  /** Money lane the promo applies to; 'platform_funded' is the default. */
  funding_scope: PromotionFundingScope;
  /** Free-tier per-org cap in micro-USD (0 = pure discount, no free tier). */
  per_org_cap_micro_usd: number;
  /** Per-org charged-spend ceiling for the % discount (0 = uncapped). */
  discount_cap_micro_usd: number;
  cap_scope: PromotionCapScope;
  /** Post-cap credit discount, 0-100. */
  percent_off: number;
  active: boolean;
  display_order: number;
};

/** Body of the create write; PUT sends the same full resource (id in the path). */
export type ModelPromotionCreateInput = Omit<ModelPromotion, "id">;
