/**
 * Independent Contractor Agreement.
 *
 * Provenance: written from scratch using as reference the IRS Publication
 * 1779 (Independent Contractor or Employee) guidance, the U.S. Department
 * of Labor's Fact Sheet 13 on the Fair Labor Standards Act, and standard
 * plain-language drafting principles for service-provider contracts. No
 * content copied from any third-party template provider or competitor
 * product.
 *
 * Worker classification is the central legal risk in any independent-
 * contractor agreement. The IRS uses a multi-factor test centered on
 * behavioral control, financial control, and the nature of the
 * relationship; some states (notably California under AB5 and similar
 * statutes) use stricter tests. This template includes language that
 * supports independent-contractor classification, but contract language
 * alone does not determine classification. The user must consult an
 * attorney about whether the working relationship actually qualifies.
 *
 * Status: PREVIEW. Not attorney-reviewed yet. The reviewedBy and
 * reviewedAt fields must be populated by a licensed attorney before
 * this template is shown to public users without the preview warning.
 */

export default {
  id: 'independent-contractor',
  version: '1.0.0',
  title: 'Independent Contractor Agreement',
  category: 'services',
  jurisdictionHint: 'us-general',
  partyRoles: ['Client', 'Contractor'],
  signatureCount: 2,
  description:
    'A services agreement between a business hiring an independent contractor and the contractor themselves. Covers scope of work, fees, intellectual property, confidentiality, and the worker-classification factors that distinguish a contractor from an employee.',
  reviewedBy: null,
  reviewedAt: null,
  body: [
    { type: 'title', text: 'Independent Contractor Agreement' },

    {
      type: 'paragraph',
      text:
        'This Independent Contractor Agreement (the "Agreement") is entered into as of [Effective Date] between [Client Name] ("Client") and [Contractor Name] ("Contractor"). Client wishes to engage Contractor to provide certain services, and Contractor wishes to provide those services as an independent contractor. The parties agree as follows.',
    },

    {
      type: 'clause',
      heading: '1. Services.',
      paragraphs: [
        'Contractor will provide the services described in Exhibit A or, if no Exhibit A is attached, the services described here: [Description of Services] (the "Services").',
        'Contractor will perform the Services in a professional manner, using the skill, care, and diligence ordinarily expected of a qualified contractor in Contractor\'s field. Contractor controls the means, methods, schedule, and location of the Services, subject only to deadlines and deliverable specifications the parties agree to in writing.',
      ],
    },

    {
      type: 'clause',
      heading: '2. Term.',
      paragraphs: [
        'This Agreement starts on the Effective Date and continues until the Services are complete, or until ended sooner under Section 9. Either party may end this Agreement for convenience on thirty (30) days\' written notice to the other.',
      ],
    },

    {
      type: 'clause',
      heading: '3. Fees and payment.',
      paragraphs: [
        'Client will pay Contractor the fees described in Exhibit A or, if no Exhibit A is attached, the fees described here: [Fee Description] (the "Fees").',
        'Contractor will invoice Client [monthly / on completion / on milestone] for Fees earned. Client will pay each undisputed invoice within thirty (30) days of receipt. If Client disputes any part of an invoice, Client will pay the undisputed portion on schedule and tell Contractor in writing what the dispute is within fifteen (15) days of receiving the invoice. The parties will work in good faith to resolve any dispute.',
        'Contractor is responsible for all taxes on the Fees, including income tax and self-employment tax. Client will not withhold taxes from payments to Contractor. Client will issue an IRS Form 1099 (or applicable equivalent) for Fees that meet the reporting threshold.',
      ],
    },

    {
      type: 'clause',
      heading: '4. Independent contractor relationship.',
      paragraphs: [
        'Contractor is an independent contractor, not an employee, partner, agent, or joint venturer of Client. Contractor is not entitled to employee benefits of any kind, including health insurance, retirement contributions, paid leave, workers\' compensation, or unemployment insurance.',
        'Contractor controls the manner and means of performing the Services. Contractor may engage assistants or subcontractors at Contractor\'s own expense, provided each assistant or subcontractor is bound by confidentiality and intellectual-property terms no less protective than those in this Agreement. Contractor may provide services to other clients during the term, provided doing so does not breach Section 6.',
        'Each party will be solely responsible for its own expenses unless the parties agree otherwise in writing.',
      ],
    },

    {
      type: 'clause',
      heading: '5. Intellectual property.',
      paragraphs: [
        '"Deliverables" means the work product Contractor creates for Client under this Agreement. Contractor will deliver all Deliverables on completion of the relevant Services or, if Client requests, at reasonable points during the term.',
        'Subject to Section 5.3, Contractor assigns to Client all right, title, and interest in the Deliverables, including all copyrights, patents, trade secrets, and other intellectual property rights. Contractor will sign any further documents reasonably needed to record the assignment.',
        'Contractor retains ownership of any tools, methods, techniques, or other materials Contractor developed before or outside the engagement, even if used in performing the Services ("Contractor IP"). To the extent Contractor IP is incorporated into a Deliverable, Contractor grants Client a worldwide, perpetual, royalty-free, non-exclusive license to use that Contractor IP as part of the Deliverable.',
      ],
    },

    {
      type: 'clause',
      heading: '6. Confidentiality.',
      paragraphs: [
        'Each party may receive confidential information from the other in connection with this Agreement. Each party will use the other\'s confidential information only to perform under this Agreement, will not share it with any third party except as needed to perform and under confidentiality obligations no less protective than those here, and will protect it with at least reasonable care.',
        'Confidential information does not include information that is publicly known, was already known to the receiving party before disclosure, is received from a third party with the right to disclose it, or is independently developed without reference to the other party\'s confidential information.',
        'The confidentiality obligations in this Section 6 survive for two (2) years after the end of this Agreement.',
      ],
    },

    {
      type: 'clause',
      heading: '7. Representations.',
      paragraphs: [
        'Each party represents that it has the right to enter into this Agreement and to perform its obligations. Contractor represents that the Services and Deliverables will not infringe any third party\'s intellectual property or other rights, and that Contractor has the right to assign the Deliverables to Client under Section 5.',
        'Except as stated in this Section 7, neither party makes any warranty about the Services or Deliverables, express or implied, including any implied warranties of merchantability or fitness for a particular purpose.',
      ],
    },

    {
      type: 'clause',
      heading: '8. Liability.',
      paragraphs: [
        'Neither party will be liable to the other for any indirect, incidental, consequential, special, or punitive damages arising out of this Agreement, even if advised of the possibility of such damages. Each party\'s total liability under this Agreement is limited to the total Fees paid or payable under this Agreement.',
        'These limits do not apply to: (a) breach of Section 6 (Confidentiality); (b) Contractor\'s indemnification obligations under Section 7 for infringement; (c) either party\'s fraud or willful misconduct; or (d) any liability that cannot be limited under applicable law.',
      ],
    },

    {
      type: 'clause',
      heading: '9. Termination.',
      paragraphs: [
        'Either party may end this Agreement immediately on written notice if the other party materially breaches the Agreement and fails to cure the breach within fifteen (15) days after written notice describing the breach.',
        'On end of this Agreement for any reason: (a) Contractor will deliver to Client all Deliverables completed or in progress as of the end date; (b) Client will pay Contractor for all Services performed and expenses incurred up to the end date; and (c) Sections 5, 6, 7, 8, and 10 survive.',
      ],
    },

    {
      type: 'clause',
      heading: '10. General provisions.',
      paragraphs: [
        'This Agreement is the entire agreement between the parties about the Services and replaces any prior agreement on that subject. It may be changed only by a written amendment signed by both parties. If any part is held unenforceable, the rest stays in effect.',
        'Notices under this Agreement must be in writing and sent to the address each party puts in the signature block below (or to any address either party later gives the other in writing). Notices are effective on receipt.',
        'Neither party may assign this Agreement without the other party\'s written consent, except that Client may assign to a successor in connection with a merger, acquisition, or sale of all or substantially all of its assets.',
        'This Agreement is governed by the laws of the state where Contractor performs the Services, without regard to conflict-of-law principles. The parties will try to resolve any dispute informally before starting litigation or other proceedings.',
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
        { role: 'CONTRACTOR', fields: ['Signed', 'Name', 'Title', 'Date'] },
      ],
    },
  ],
};
