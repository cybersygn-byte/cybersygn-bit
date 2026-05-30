/**
 * Mutual Non-Disclosure Agreement (NDA).
 *
 * Provenance: written from scratch using as reference the ABA Model
 * Confidentiality Agreement guidance (publicly available), the Cornell
 * Legal Information Institute's overview of trade secret protection,
 * and standard plain-language drafting principles. No content copied
 * from any third-party template provider, competitor product, or
 * institutional template.
 *
 * Status: PREVIEW. Not attorney-reviewed yet. The reviewedBy and
 * reviewedAt fields must be populated by a licensed attorney before
 * this template is shown to public users without the preview warning.
 */

export default {
  id: 'nda-mutual',
  version: '1.0.0',
  title: 'Mutual Non-Disclosure Agreement',
  category: 'confidentiality',
  jurisdictionHint: 'us-general',
  partyRoles: ['Party A', 'Party B'],
  signatureCount: 2,
  description:
    'A two-way confidentiality agreement for use when both parties expect to share sensitive information with each other. Common starting point for exploratory business discussions, vendor evaluations, and early-stage partnerships.',
  reviewedBy: null,
  reviewedAt: null,
  body: [
    { type: 'title', text: 'Mutual Non-Disclosure Agreement' },

    {
      type: 'paragraph',
      text:
        'This Mutual Non-Disclosure Agreement (the "Agreement") is entered into as of [Effective Date] between [Party A Name] ("Party A") and [Party B Name] ("Party B"). Party A and Party B each refer to themselves below as the "Disclosing Party" when sharing information and as the "Receiving Party" when receiving information.',
    },

    {
      type: 'clause',
      heading: '1. Purpose.',
      paragraphs: [
        'The parties wish to explore [Purpose of Discussions] (the "Purpose"). In the course of that exploration each party may share information that the other party is not otherwise entitled to receive. This Agreement sets out the terms under which that information will be shared and protected.',
      ],
    },

    {
      type: 'clause',
      heading: '2. Confidential Information.',
      paragraphs: [
        '"Confidential Information" means any non-public information the Disclosing Party shares with the Receiving Party in connection with the Purpose, in any form, whether marked confidential or not, including technical information, business plans, customer and pricing data, source code, product roadmaps, and any other information a reasonable person would understand to be confidential given the circumstances of disclosure.',
        'Confidential Information does not include information that: (a) is or becomes publicly known through no act of the Receiving Party; (b) was already known to the Receiving Party before the disclosure, as shown by contemporaneous records; (c) is received from a third party who had the right to disclose it and did so without restriction; or (d) is independently developed by the Receiving Party without reference to the Disclosing Party\'s Confidential Information.',
      ],
    },

    {
      type: 'clause',
      heading: '3. Use and protection.',
      paragraphs: [
        'The Receiving Party will use Confidential Information only for the Purpose, will not share it with any third party except as expressly permitted by this Agreement, and will protect it with at least the same care it uses for its own confidential information of a similar nature (and in no event less than reasonable care).',
        'The Receiving Party may share Confidential Information with its employees, contractors, and professional advisors who: (a) have a clear need to know it for the Purpose, and (b) are bound by confidentiality obligations no less restrictive than those in this Agreement. The Receiving Party remains responsible for any breach by anyone it shares Confidential Information with.',
      ],
    },

    {
      type: 'clause',
      heading: '4. Compelled disclosure.',
      paragraphs: [
        'If the Receiving Party is required by law, regulation, or valid legal process to disclose Confidential Information, it will, where legally permitted, give the Disclosing Party prompt written notice so the Disclosing Party can seek a protective order. The Receiving Party will disclose only the portion of Confidential Information legally required to be disclosed.',
      ],
    },

    {
      type: 'clause',
      heading: '5. Term and return.',
      paragraphs: [
        'This Agreement starts on the Effective Date and continues for two (2) years unless ended sooner by written agreement of the parties. The confidentiality obligations in Sections 3 and 4 survive for two (2) years after the end of this Agreement.',
        'On written request from the Disclosing Party, the Receiving Party will, within thirty (30) days, return or destroy all Confidential Information in its possession and certify in writing that it has done so. The Receiving Party may retain copies required by its standard backup and retention systems or by law, provided those copies remain subject to this Agreement for as long as they exist.',
      ],
    },

    {
      type: 'clause',
      heading: '6. No license, no warranty.',
      paragraphs: [
        'Nothing in this Agreement grants the Receiving Party any license or other right in the Disclosing Party\'s Confidential Information, intellectual property, or any other property. The Disclosing Party makes no representation or warranty about the accuracy or completeness of Confidential Information it shares.',
      ],
    },

    {
      type: 'clause',
      heading: '7. Remedies.',
      paragraphs: [
        'Money damages may not be enough to remedy a breach of this Agreement. Either party may seek injunctive relief in addition to any other remedies available at law or in equity.',
      ],
    },

    {
      type: 'clause',
      heading: '8. General provisions.',
      paragraphs: [
        'This Agreement is the entire agreement between the parties about the subject matter and replaces any prior agreement on that subject. It may be changed only by a written amendment signed by both parties. If any part of this Agreement is held unenforceable, the rest stays in effect. A failure by either party to enforce any right under this Agreement is not a waiver of that right going forward.',
        'Notices under this Agreement must be in writing and sent to the address each party puts in the signature block below (or to any address either party later gives the other in writing).',
        'This Agreement does not create a partnership, joint venture, agency, employment, or franchise relationship between the parties. Neither party may assign this Agreement without the other party\'s written consent.',
      ],
    },

    {
      type: 'paragraph',
      text:
        'The parties agree to the terms above as of the Effective Date.',
      style: 'spacer',
    },

    {
      type: 'signatureBlock',
      parties: [
        {
          role: 'PARTY A',
          fields: ['Signed', 'Name', 'Title', 'Date'],
        },
        {
          role: 'PARTY B',
          fields: ['Signed', 'Name', 'Title', 'Date'],
        },
      ],
    },
  ],
};
