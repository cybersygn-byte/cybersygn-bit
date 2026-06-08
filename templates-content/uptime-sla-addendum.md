# UPTIME SERVICE LEVEL AGREEMENT ADDENDUM

> **This is a customizable starting template, not a finished legal document.**
> Replace every **[BRACKETED]** field with your specifics, delete or adapt any
> clause that does not fit your deal, and have a licensed attorney in the
> governing jurisdiction review it before you or anyone else signs. CyberSygn
> is not a law firm and this template is not legal advice.

---

This Uptime Service Level Agreement Addendum (this "**Addendum**") is entered into
as of **[EFFECTIVE DATE]** (the "**Effective Date**") by and between:

**[PROVIDER LEGAL NAME]**, a **[STATE] [ENTITY TYPE, e.g. limited liability company]**
with its principal place of business at **[PROVIDER ADDRESS]** ("**Provider**"); and

**[CUSTOMER LEGAL NAME]**, a **[STATE] [ENTITY TYPE]** with its principal place of
business at **[CUSTOMER ADDRESS]** ("**Customer**").

Provider and Customer are each a "**Party**" and together the "**Parties**."

**Recitals.** The Parties have entered into the **[NAME OF UNDERLYING AGREEMENT,
e.g. SaaS Subscription Agreement]** dated **[DATE]** (the "**Underlying
Agreement**"), under which Provider makes a hosted service available to Customer.
The Parties wish to add committed availability targets, measurement rules, and
service credits to that relationship. In consideration of the mutual promises
below, the Parties agree as follows.

---

## 1. Relationship to the Underlying Agreement

1.1 **Incorporation.** This Addendum is incorporated into and forms part of the
Underlying Agreement. Capitalized terms not defined here have the meanings given in
the Underlying Agreement.

1.2 **Order of precedence.** If a conflict exists between this Addendum and the body
of the Underlying Agreement on the subject of availability and service credits, this
Addendum controls. In all other respects, the Underlying Agreement remains in full
effect.

1.3 **Covered service.** This Addendum applies to the hosted service identified in
**[EXHIBIT / DESCRIPTION]** (the "**Service**"), excluding any beta, trial,
free-tier, or sandbox environment unless expressly stated.

## 2. Definitions

2.1 **Availability.** "**Availability**" means the percentage of minutes in a
calendar month during which the Service is materially functional and reachable by
Customer, calculated as: (Total Minutes in Month − Downtime Minutes − Excluded
Minutes) ÷ (Total Minutes in Month − Excluded Minutes) × 100.

2.2 **Downtime.** "**Downtime**" means any period in which the Service is
unavailable or materially impaired such that Customer cannot perform its core
functions, as measured by Provider's monitoring described in Section 4, excluding
periods that qualify as Excluded Minutes.

2.3 **Excluded Minutes.** "**Excluded Minutes**" means minutes during Scheduled
Maintenance, Emergency Maintenance, or events described in Section 5.

2.4 **Scheduled Maintenance.** "**Scheduled Maintenance**" means planned maintenance
for which Provider gives at least **[NUMBER, e.g. 48]** hours' advance notice, not to
exceed **[NUMBER, e.g. 8]** hours in any calendar month.

2.5 **Service Credit.** "**Service Credit**" means a credit applied against future
fees as the exclusive remedy for failure to meet the Availability target, calculated
under Section 3.

## 3. Availability Commitment and Service Credits

3.1 **Monthly target.** Provider will use commercially reasonable efforts to achieve
monthly Availability of at least **[e.g. 99.9%]** (the "**Availability Target**") for
the Service.

3.2 **Service Credit schedule.** If monthly Availability falls below the Availability
Target, Customer is eligible for a Service Credit calculated as a percentage of the
monthly fees for the affected Service, as follows:

| Monthly Availability | Service Credit |
| --- | --- |
| Below **[99.9%]** but at or above **[99.0%]** | **[10%]** |
| Below **[99.0%]** but at or above **[95.0%]** | **[25%]** |
| Below **[95.0%]** | **[50%]** |

3.3 **Maximum credit.** Total Service Credits for any calendar month will not exceed
**[e.g. 50%]** of the monthly fees for the affected Service for that month.

3.4 **Claim procedure.** To receive a Service Credit, Customer must submit a written
claim to **[PROVIDER CONTACT]** within **[NUMBER, e.g. 30]** days after the end of
the month in which the shortfall occurred, including the dates, times, and a
reasonable description of the Downtime. Provider will validate the claim against its
monitoring records.

3.5 **Form and exclusivity.** Approved Service Credits are applied to a future
invoice and are non-refundable and non-transferable. Service Credits are Customer's
sole and exclusive remedy for any failure to meet the Availability Target, except as
stated in Section 6.

## 4. Measurement and Reporting

4.1 **Measurement.** Provider will measure Availability using its own monitoring
systems and methodology, applied consistently across customers. Provider's records
are the authoritative source for calculating Availability, absent manifest error.

4.2 **Status and reporting.** Provider will maintain a status page or comparable
mechanism describing current Service status and significant incidents, and will
provide an Availability summary on Customer's reasonable request, not more than
**[NUMBER, e.g. once]** per month.

4.3 **Incident communication.** Provider will use commercially reasonable efforts to
notify Customer of material incidents affecting the Service and to provide periodic
updates until resolution.

## 5. Exclusions

5.1 **Excluded events.** Downtime does not include, and the Availability calculation
excludes, unavailability caused by: (a) Scheduled or Emergency Maintenance; (b)
factors outside Provider's reasonable control, including internet, third-party
infrastructure, or force majeure events; (c) Customer's equipment, software,
network, or configuration; (d) Customer's acts or omissions, or those of its users
or third parties acting on its behalf; (e) Customer's use of the Service in a manner
inconsistent with the Documentation; or (f) suspension or termination permitted under
the Underlying Agreement.

5.2 **Emergency Maintenance.** "**Emergency Maintenance**" means maintenance Provider
reasonably determines is necessary to protect the security, integrity, or operation
of the Service. Provider will give such notice as is practicable under the
circumstances.

5.3 **Beta and free tiers.** No Availability Target or Service Credit applies to any
beta, trial, free-tier, or sandbox use of the Service.

## 6. Chronic Shortfall and Termination

6.1 **Chronic shortfall.** If monthly Availability falls below **[e.g. 95.0%]** for
**[NUMBER, e.g. three]** consecutive months, or below the Availability Target for
**[NUMBER, e.g. four]** months in any rolling **[NUMBER, e.g. twelve]**-month period,
Customer may terminate the affected Service on **[NUMBER, e.g. 30]** days' written
notice without penalty, as Customer's additional remedy.

6.2 **Refund on chronic termination.** If Customer terminates under Section 6.1,
Provider will refund any prepaid, unused fees for the terminated Service for the
period after the effective date of termination, subject to the terms of the
Underlying Agreement.

## 7. General

7.1 **No other warranties.** Except for the commitments in this Addendum, the Service
is provided subject to the warranties and disclaimers in the Underlying Agreement.
This Addendum does not expand any other warranty.

7.2 **Changes to the SLA.** Provider may update the methodology or Availability
Target on **[NUMBER, e.g. 30]** days' prior written notice, provided no update will
materially reduce the Availability Target during a paid term Customer has already
purchased without Customer's consent.

7.3 **Governing law.** This Addendum is governed by the laws of the State of
**[STATE]**, consistent with the Underlying Agreement, without regard to its
conflict-of-laws rules.

7.4 **Entire agreement on subject; amendment.** This Addendum is the entire agreement
of the Parties on the subject of Service availability and credits and supersedes
prior discussions on that subject. It may be amended only by a writing signed by both
Parties or as permitted in Section 7.2.

7.5 **Counterparts and electronic signature.** This Addendum may be signed in
counterparts and by electronic signature, each of which is an original and all of
which together form one agreement.

---

**IN WITNESS WHEREOF**, the Parties have executed this Addendum as of the Effective
Date.

| **PROVIDER** | **CUSTOMER** |
| --- | --- |
| Signature: __________________________ | Signature: __________________________ |
| Printed name: **[NAME]** | Printed name: **[NAME]** |
| Title: **[TITLE]** | Title: **[TITLE]** |
| Date: __________________________ | Date: __________________________ |

---

*Template provided by CyberSygn. Not legal advice. CyberSygn is not a law firm.
Consult a licensed attorney in your jurisdiction before relying on this document.*
