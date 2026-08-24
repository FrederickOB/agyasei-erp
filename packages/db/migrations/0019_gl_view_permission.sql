-- ============================================================================
-- 0019 — `gl.view`: the capability that makes the ledger READABLE.
--
-- Written in 0005's style and for 0005's reasons (see 0009's header — the
-- catalogue is GLOBAL, a tenant composes codes and never mints one, and
-- adding a capability is a platform migration reviewed like the endpoint
-- that checks it).
--
-- WHY A NEW CODE rather than reusing `report.view.margin`: the margin code
-- guards OPERATIONAL cost figures — what a delivery cost, what a SKU's
-- moving average is. The ledger is the BOOKS: journal entries, the trial
-- balance, statements, posting exceptions. CLAUDE.md's own role sketch puts
-- "GL review" in the accounts job and nowhere else, and a code that can be
-- granted separately is what lets a tenant honour that split. Reusing the
-- margin code would have silently given every margin-reader the books.
--
-- READ-ONLY BY CONSTRUCTION, not by restraint: there is no gl.post or
-- gl.edit code to grant, because no route exists that would check one — the
-- journal is written by the posting engine from settled documents, and
-- posted entries are immutable (0015). The first manual-journal capability,
-- when Track B needs one, is its own migration and its own review.
-- ============================================================================
insert into platform.permission
  (code, domain, description, is_sensitive, requires_fresh_authorization, bound_schema)
values
  ('gl.view', 'gl',
   'Read the general ledger: journal entries, trial balance, statements, and posting exceptions.',
   -- Sensitive: the books carry every margin, every payable and every
   -- employee's net pay line. Strictly narrower audience than takings.
   true, false, null)
on conflict (code) do nothing;
