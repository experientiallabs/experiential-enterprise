// Named / abstract alias shapes, mirroring the backend's /api/aliases views
// (explabs/api/routes/aliases.py). Fields stay snake_case so the payloads pass
// through the data source untransformed.

export type NamedAlias = {
  alias_id: string;
  name: string;
  org_id: string;
  active: boolean;
  current_revision_id: string | null;
  target_model_slug: string | null;
  target_model_id: string | null;
};

export type NamedAliasList = {
  aliases: NamedAlias[];
};

export type AliasRevision = {
  revision_id: string;
  model_slug: string | null;
  model_id: string | null;
  is_current: boolean;
  created_at: string;
};

export type AliasRevisionList = {
  name: string;
  alias_id: string;
  revisions: AliasRevision[];
};

// One model an alias can point at, projected from the catalog listing.
export type AliasModelOption = {
  slug: string;
  display_name: string;
};
