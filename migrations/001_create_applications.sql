CREATE TABLE IF NOT EXISTS merchant_applications (
  id text PRIMARY KEY,
  business_name text NOT NULL,
  email text NOT NULL,
  status text NOT NULL CHECK (
    status IN (
      'submitted',
      'verifying',
      'needs_information',
      'needs_review',
      'ready_for_approval',
      'approved',
      'rejected',
      'provisioning_failed'
    )
  ),
  submitted_at timestamptz NOT NULL,
  application jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS merchant_applications_submitted_at_idx
  ON merchant_applications (submitted_at DESC);
