// Org special-attribute labels and internal admin notes. Mirror the backend
// AdminView projections (explabs/api/routes/org_labels.py); snake_case fields.

/** One org special-attribute label as the admin CRUD API returns it. */
export type OrgLabel = {
  id: string;
  org_id: string;
  key: string;
  created_by: string;
  created_at: string;
};

/** One internal, author-attributed admin note on an org. */
export type OrgAdminNote = {
  id: string;
  org_id: string;
  author_user_id: string;
  author_email: string;
  body: string;
  created_at: string;
  updated_at: string;
};
