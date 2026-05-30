/**
 * General Services Agreement.
 *
 * Provenance: written from scratch using as reference the Uniform
 * Commercial Code Article 2 (where applicable to goods provided as part
 * of services), the Restatement (Second) of Contracts on standard
 * commercial-contract drafting principles, and the ABA's general
 * guidance on service-provider contract structure. No content copied
 * from any third-party template provider or competitor product.
 *
 * This template is meant for business-to-business service engagements
 * where the service provider is an established business (not a sole-
 * proprietor independent contractor). If the provider is an individual,
 * use the Independent Contractor Agreement template instead, which
 * includes worker-classification language.
 *
 * Status: PREVIEW. Not attorney-reviewed yet. The reviewedBy and
 * reviewedAt fields must be populated by a licensed attorney before
 * this template is shown to public users without the preview warning.
 */

export default {
  id: 'services-agreement',
  version: '1.0.0',
  title: 'Services Agreement',
  category: 'services',
  jurisdictionHint: 'us-general',
  partyRoles: ['Client', 'Provider'],
  signatureCount: 2,
  description:
    'A business-to-business agreement for ongoing or project-based services. Covers scope, fees, deliverables, intellectual property, warranties, and standard commercial terms.',
  reviewedBy: null,
  reviewedAt: null,
  body: [
    { type: 'title', text: 'Services Agreement' },

    {
      type: 'paragraph',
      text:
        'This Services Agreement (the "Agreement") is entered into as of [Effective Date] between [Client Name], a [Client State] [Client Entity Type] ("Client"), and [Provider Name], a [Provider State] [Provider Entity Type] ("Provider"). Provider will provide certain services to Client, and Client will pay Provider for those services, on the terms below.',
    },

    {
      type: 'clause',
      heading: '1. Services and statements of work.',
      paragraphs: [
        'Provider will provide the services described in one or more Statements of Work that the parties sign and attach to this Agreement (each, a "Statement of Work" or "SOW"). The terms of this Agreement apply to every SOW. If an SOW conflicts with this Agreement, the SOW controls for that engagement only.',
        'Each SOW will describe: (a) the services to be performed; (b) the deliverables, if any; (c) the schedule or milestones; (d) the fees and any expense terms; and (e) any other terms specific to that engagement. An SOW is effective only when signed by both parties.',
      ],
    },

    {
      type: 'clause',
      heading: '2. Performance standards.',
      paragraphs: [
        'Provider will perform the services in a professional manner, using personnel with the skill, training, and experience appropriate to the engagement. Provider will use commercially reasonable efforts to meet the schedule in each SOW, but unless an SOW expressly says otherwise, schedule dates are estimates and not guarantees.',
        'Provider will comply with all laws and regulations that apply to its business and to the services. Client will give Provider access to the information, personnel, and facilities Provider reasonably needs to perform the services.',
      ],
    },

    {
      type: 'clause',
      heading: '3. Fees, expenses, and payment.',
      paragraphs: [
        'Client will pay Provider the fees set out in each SOW. Unless an SOW says otherwise, fees are based on time-and-materials at Provider\'s then-current rates.',
        'Client will reimburse Provider for reasonable, pre-approved out-of-pocket expenses incurred in performing the services, at cost and with receipts. Provider will not incur reimbursable expenses above [$500] in any month without Client\'s prior written approval.',
        'Provider will invoice Client [monthly] for fees and expenses. Client will pay each undisputed invoice within thirty (30) days of receipt. Late payments accrue interest at one percent (1%) per month or the maximum rate allowed by law, whichever is less. If Client disputes any part of an invoice, Client will pay the undisputed portion on schedule and tell Provider in writing what the dispute is within fifteen (15) days of the invoice date.',
        'Fees do not include taxes. Client is responsible for sales, use, and similar transactional taxes on the services, except for taxes based on Provider\'s net income.',
      ],
    },

    {
      type: 'clause',
      heading: '4. Deliverables and ownership.',
      paragraphs: [
        '"Deliverables" means the work product Provider creates for Client under an SOW and identifies as a Deliverable in that SOW.',
        'Subject to Section 4.3, Provider assigns to Client all right, title, and interest in the Deliverables, including all copyrights and other intellectual property rights, on Client\'s payment in full of the fees for the Deliverable. Until that payment, Provider grants Client a temporary, non-exclusive license to use the Deliverable for the purposes set out in the SOW.',
        'Provider retains ownership of all of Provider\'s pre-existing materials, methodologies, tools, and know-how, including any improvements or extensions made during the engagement that are not specific to Client\'s business ("Provider IP"). To the extent Provider IP is incorporated into a Deliverable, Provider grants Client a worldwide, perpetual, royalty-free, non-exclusive license to use that Provider IP as embedded in the Deliverable, but not to extract, modify, or distribute it on its own.',
      ],
    },

    {
      type: 'clause',
      heading: '5. Confidentiality.',
      paragraphs: [
        'Each party may receive confidential information from the other in performing this Agreement. "Confidential Information" means non-public information one party shares with the other in any form, that a reasonable person would understand to be confidential given the circumstances. Confidential Information does not include information that is publicly known, was known to the receiving party before disclosure, is received from a third party with the right to disclose, or is independently developed by the receiving party.',
        'Each party will use Confidential Information only to perform this Agreement, will not share it with any third party except advisors and personnel with a clear need to know and bound by confidentiality obligations no less protective than those here, and will protect it with at least reasonable care.',
        'The confidentiality obligations in this Section 5 survive for three (3) years after the end of this Agreement.',
      ],
    },

    {
      type: 'clause',
      heading: '6. Warranties.',
      paragraphs: [
        'Each party represents and warrants that it has the right to enter into this Agreement and to perform its obligations. Provider warrants that: (a) the services will be performed in a professional manner consistent with industry standards; and (b) the Deliverables will not infringe any third party\'s intellectual property or other rights.',
        'For breach of the warranty in Section 6.1(a), Client\'s exclusive remedy and Provider\'s entire liability is for Provider to re-perform the affected services at no additional charge, provided Client notifies Provider of the breach in writing within thirty (30) days of the affected services being performed.',
        'Except for the warranties in this Section 6, neither party makes any warranty, express or implied. The parties disclaim all implied warranties, including the implied warranties of merchantability, fitness for a particular purpose, and non-infringement.',
      ],
    },

    {
      type: 'clause',
      heading: '7. Indemnification.',
      paragraphs: [
        'Provider will defend Client against any third-party claim that the services or Deliverables infringe a U.S. copyright, trademark, or patent of that third party, and will pay any damages and reasonable attorneys\' fees awarded against Client or agreed in settlement, provided Client gives Provider prompt written notice of the claim, sole control of the defense and settlement, and reasonable cooperation.',
        'If a claim under Section 7.1 is made or appears likely, Provider may, at its option and expense: (a) modify the affected services or Deliverables so they are non-infringing while substantially preserving their function; (b) obtain a license that allows Client to continue using them; or (c) end the affected SOW and refund any fees Client paid for services or Deliverables not yet delivered.',
        'Provider\'s indemnification does not apply to claims arising from: (a) Client\'s modification of the services or Deliverables; (b) combination of the services or Deliverables with materials not supplied by Provider, if the claim would not have arisen without that combination; or (c) Client\'s use of the services or Deliverables outside the scope of this Agreement.',
        'Section 7 states the parties\' entire liability and exclusive remedy for any third-party intellectual-property claim.',
      ],
    },

    {
      type: 'clause',
      heading: '8. Liability.',
      paragraphs: [
        'Neither party will be liable to the other for any indirect, incidental, consequential, special, or punitive damages arising out of this Agreement, even if advised of the possibility of such damages.',
        'Each party\'s total liability under this Agreement is limited to the total fees paid or payable under the SOW that gave rise to the claim, in the twelve (12) months before the claim arose.',
        'These limits do not apply to: (a) breach of Section 5 (Confidentiality); (b) Provider\'s indemnification obligations under Section 7; (c) either party\'s fraud or willful misconduct; or (d) any liability that cannot be limited under applicable law.',
      ],
    },

    {
      type: 'clause',
      heading: '9. Term and termination.',
      paragraphs: [
        'This Agreement starts on the Effective Date and continues until ended under this Section 9. Either party may end this Agreement for convenience on sixty (60) days\' written notice. Either party may end this Agreement immediately on written notice if the other party materially breaches the Agreement or any SOW and fails to cure the breach within thirty (30) days after written notice describing the breach.',
        'On end of this Agreement: (a) every SOW in progress also ends, unless the parties agree in writing to continue specific SOWs to their natural completion; (b) Provider will deliver all Deliverables completed or in progress as of the end date; (c) Client will pay Provider for all services performed and reimbursable expenses incurred up to the end date; and (d) Sections 4, 5, 6, 7, 8, and 10 survive.',
      ],
    },

    {
      type: 'clause',
      heading: '10. General provisions.',
      paragraphs: [
        'This Agreement, together with every SOW signed under it, is the entire agreement between the parties about the services and replaces any prior agreement on that subject. It may be changed only by a written amendment signed by both parties. If any part is held unenforceable, the rest stays in effect. A failure by either party to enforce any right under this Agreement is not a waiver of that right going forward.',
        'Notices under this Agreement must be in writing and sent to the address each party puts in the signature block below. Notices are effective on receipt if delivered by hand or by overnight courier, or three (3) business days after mailing if sent by certified mail.',
        'Neither party may assign this Agreement without the other party\'s written consent, except that either party may assign to a successor in connection with a merger, acquisition, or sale of all or substantially all of its assets. An assignment in violation of this Section 10.3 is void.',
        'This Agreement does not create a partnership, joint venture, agency, employment, or franchise relationship. Provider is an independent contractor of Client.',
        'This Agreement is governed by the laws of [Governing Law State], without regard to conflict-of-law principles. The parties will try to resolve any dispute informally before starting litigation.',
        'A force-majeure event (a circumstance beyond a party\'s reasonable control, such as a natural disaster, war, civil unrest, government action, or widespread infrastructure failure) excuses that party\'s performance for the duration of the event, except for the obligation to pay money already owed.',
      ],
    },

    {
      type: 'paragraph',
      text: 'The parties agree to the terms above as of the Effective Date.',
      style: 'spacer',
    },

    {
      type: 'signatureBlock',
      parties: [
        { role: 'CLIENT', fields: ['Signed', 'Name', 'Title', 'Date'] },
        { role: 'PROVIDER', fields: ['Signed', 'Name', 'Title', 'Date'] },
      ],
    },
  ],
};
