# Outreach drafts — the two people the build is now waiting on

**These are drafts for the founder to send. Nothing here has been sent, and nothing here should be
sent without reading it first** — both letters commit the business to a piece of professional work
and both contain figures and dates only the founder can confirm.

Why these two and not others: every remaining engineering item on this project is measured in days.
These two are measured in **months**, and neither has started. Doing the code first and the people
second adds that time to the schedule for no reason at all.

| | Who | Unblocks | Why it cannot wait |
|---|---|---|---|
| 1 | A chartered accountant (ICAG) | `Q6`, `Q4`, `Q18`, the whole of Phase 3's accounting content | §2.8 makes their review blocking, and one required piece of it — a full month of generated statements — takes **a month after they are appointed** |
| 2 | A GRA-registered tax practitioner | `Q8` | Certified Invoicing System onboarding has a lead time we do not know, and the pilot's stated opening date is already **22 days past** |

**Q21 is answered (25 August 2026): the outlet has not opened and has made no sale.** Both letters
are written for that answer — prospective advice, a clean cut-over, and a 1 January 2027 launch.
Nothing in them needs completing before sending except the recipient's name.

---

## Draft 1 — to a chartered accountant

> **Subject:** Reviewing the accounting design for a new multi-outlet ERP — Agyasei Jnr & Company Ltd

Dear ___,

I am the founder of Agyasei Jnr & Company Limited, a construction-materials wholesale and retail
business opening in Techiman, Bono Region, and growing to around 25 outlets over the next ten
years. We open on 1 January 2027. We are building our own point-of-sale, stock and accounting system rather than buying one,
because our outlets have to keep trading through hours or days without mobile data and no
off-the-shelf package does that.

I am looking to engage a chartered accountant for a defined piece of review work, and I would
rather find the right person now than at the point where it is urgent.

**What I need reviewed, before the system becomes our books:**

1. **The chart of accounts** for a multi-outlet distribution business — we need reporting by outlet
   and consolidated. There is a working draft for you to tear apart (attached: our draft chart of
   accounts, running against live test data), prepared so your review starts from something
   concrete — every account you change or reject is exactly the review working.
2. **The double-entry logic** — which accounts each kind of transaction posts to. A sale, a goods
   receipt, a stock write-off, a customer payment, freight.
3. **One full month of statements the system has generated**, checked against what you would expect
   from the same underlying transactions. This is the part with a real duration attached, and it is
   why I am writing before the software is finished rather than after.

**Separately and more urgently**, we charge contractors a credit-facility fee on overdue balances,
and there are five decisions about it that I do not think are mine to make — what the fee is charged
on, whether it compounds, the day-count basis, how it is presented on a statement, and how it is
treated for tax. Our system currently **refuses to post any fee at all** until someone qualified has
confirmed those, which I think is the right behaviour but does mean it is blocking us today. That
piece is a conversation and an email, not a month of work.

Two things I want to be straightforward about. First, we are **not** asking anyone to build payroll
tax into the software — the system will produce a payroll register and hand it to whoever computes
PAYE and SSNIT, and their figures come back in. That is a deliberate design decision and I am not
looking to revisit it. Second, I am aware that reviewing software-generated books is not the most
ordinary engagement, so if the shape of this is unfamiliar I am happy to walk through it before you
quote.

Could you tell me whether this is work you take on, roughly what you would charge, and what your
availability looks like over the next two to three months?

Kind regards,
Frederick Ofori-Boadu

---

## Draft 2 — to a GRA-registered tax practitioner

> **Subject:** Ghana e-VAT invoicing for an offline retail counter — a written question, with a brief

Dear ___,

I am the founder of Agyasei Jnr & Company Limited, a VAT-registered construction-materials retailer
and wholesaler in Techiman, Bono Region. We sell at a trade counter — walk-in customers paying cash
and contractors buying on 30 to 60 day credit — and we are building our own till and stock system.

I have one question that decides how the software is built, and I need the answer in writing:

> **When the till has no mobile data — which in our outlets means hours and sometimes days — what
> may it lawfully hand the customer at the counter, and what must happen when the connection
> returns?**

Everything else follows from that. If a GRA-issued invoice number is required before a customer can
be given a document, our counter cannot trade offline at all and the business needs rethinking. If a
locally-issued document can be regularised on reconnection, we need to know the permitted window and
what the document must say in the meantime.

I have put together a written brief so that you are not reverse-engineering the question from a
conversation. It is in two parts:

- **Brief A — e-VAT invoicing and the offline counter.** This is the urgent one. Ten specific
  questions, each with what we currently believe, how confident we are, and exactly what the
  software does differently for each possible answer.
- **Brief B** covers a second, less urgent matter and can be scheduled later.

To be useful to you, three things about how we have written it. We have said what we believe and how
confident we are, rather than asking open questions and hoping — so you can correct us cheaply
instead of starting from nothing. We have said which questions change the *numbers* and which change
the *documents*, because they carry different urgency. And we have been explicit about where our own
software does not yet enforce something it should, so you are not assuming a control that is not
there.

**On timing:** we intend to start trading on **1 January 2027**. The outlet is not yet open and has
issued no invoice, so this is a design question rather than a problem to unwind — which I hope makes
it a straightforward one to take on.

What I need to know first is simply whether this is work you take on, and what the lead time looks
like — particularly for Certified Invoicing System onboarding, if that is required, since that is the
item I cannot compress by working harder.

Kind regards,
Frederick Ofori-Boadu

---

## Notes for the founder before sending

- **Attach `docs/q8-evat-practitioner-brief.md`** to the second letter. It is written for a
  practitioner to read cold and it now includes the standard-rating question (A3.10) that the first
  version missed — that one matters, because all 219 of our stock items are currently set to the
  standard rate on nobody's authority.
- **The date inside that brief is filled in**: 1 January 2027.
- **Do not send the first letter to someone who also keeps the books.** The reviewer and the
  preparer being the same person removes the point of the review.
- If either recipient asks who built the software, say it plainly: it was built with AI assistance
  under your direction, and that is exactly why an independent qualified review is being sought
  rather than skipped.
