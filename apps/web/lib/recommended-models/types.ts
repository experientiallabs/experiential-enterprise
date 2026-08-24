// Recommended-set admin types. Mirror the backend recommended-models routes
// (explabs/api/routes/recommended_models.py): the catalog's starred band is
// the ordered set of public models carrying a preferred_rank.

/** One recommended public model as the admin API returns it, in rank order. */
export type RecommendedModel = {
  slug: string;
  display_name: string;
  /** 0 is the top slot; a PUT assigns ranks 0..N-1 in list order. */
  preferred_rank: number;
};
