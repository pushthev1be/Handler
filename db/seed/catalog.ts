// Fictional clients, products and materials. Dates are day offsets from "now" so the
// approved / expired split holds whenever the seed runs.
// Every client deliberately contains the traps the evals look for: superseded versions,
// expired items, drafts and a withdrawn latest version — and all three share vocabulary
// ("savings card", "patient brochure") so cross-client leakage would actually be visible.

export interface SeedDoc {
  job_code: string;
  version: number;
  title: string;
  material_type: string;
  status: "draft" | "approved" | "withdrawn";
  approved_days_ago?: number;
  expires_in_days?: number | null;
  max_order_qty?: number;
  body: string;
}

export interface SeedStock {
  job_code: string;
  location: string;
  on_hand: number;
  reorder_point: number;
}

export interface SeedClient {
  slug: string;
  name: string;
  product: string;
  docs: SeedDoc[];
  /** Warehouse stock. Includes stock of expired / withdrawn materials: it exists, but must not ship. */
  stock: SeedStock[];
}

export const catalog: SeedClient[] = [
  {
    slug: "northwind",
    name: "Northwind Therapeutics",
    product: "Zelvantra",
    docs: [
      {
        job_code: "NWT-ZEL-0101", version: 1, status: "approved", approved_days_ago: 400, expires_in_days: 300,
        title: "Zelvantra Patient Starter Brochure", material_type: "patient brochure",
        body: "Zelvantra patient starter brochure, 2024 edition. 8-page tri-fold for patients beginning therapy. Lists the Zelvantra Connect support line 1-800-555-0101 and the original pen storage chart.",
      },
      {
        job_code: "NWT-ZEL-0101", version: 2, status: "approved", approved_days_ago: 60, expires_in_days: 670,
        title: "Zelvantra Patient Starter Brochure", material_type: "patient brochure",
        body: "Zelvantra patient starter brochure, 2026 edition. 8-page tri-fold for patients beginning therapy. Covers what to expect in the first month, pen storage at room temperature, and the Zelvantra Connect support line 1-800-555-0199 staffed by nurse educators. Packed in bundles of 25.",
      },
      {
        job_code: "NWT-ZEL-0102", version: 1, status: "approved", approved_days_ago: 120, expires_in_days: 610,
        title: "Zelvantra HCP Dosing Guide", material_type: "hcp guide",
        body: "Zelvantra dosing guide for healthcare professionals. Two-sided laminated card summarising the titration schedule, missed-dose guidance and the reference to full prescribing information. For use by sales representatives in physician offices.",
      },
      {
        job_code: "NWT-ZEL-0103", version: 1, status: "approved", approved_days_ago: 500, expires_in_days: -30,
        title: "Zelvantra Savings Card (2025 program)", material_type: "savings card",
        body: "Zelvantra copay savings card for the 2025 program year. Eligible commercially insured patients pay as little as $5 per fill. Program terms printed on reverse.",
      },
      {
        job_code: "NWT-ZEL-0104", version: 1, status: "draft",
        title: "Zelvantra Pen Injection Video Card", material_type: "patient leaflet",
        body: "DRAFT, not approved. Wallet card with a QR code linking to the Zelvantra pen injection training video.",
      },
      {
        job_code: "NWT-ZEL-0105", version: 1, status: "approved", approved_days_ago: 200, expires_in_days: 500,
        title: "Zelvantra Travel Kit Insert", material_type: "patient leaflet",
        body: "Zelvantra travel kit insert explaining how to carry pens on flights, cooler pack use and customs letter template.",
      },
      {
        job_code: "NWT-ZEL-0105", version: 2, status: "withdrawn", approved_days_ago: 90, expires_in_days: 600,
        title: "Zelvantra Travel Kit Insert", material_type: "patient leaflet",
        body: "Withdrawn by medical-legal review. Zelvantra travel kit insert, revised cooler guidance.",
      },
    ],
    stock: [
      { job_code: "NWT-ZEL-0101", location: "MEM-A-01-03", on_hand: 1200, reorder_point: 200 },
      { job_code: "NWT-ZEL-0102", location: "MEM-A-01-07", on_hand: 85, reorder_point: 100 },
      { job_code: "NWT-ZEL-0103", location: "MEM-Q-02-01", on_hand: 640, reorder_point: 0 },
      { job_code: "NWT-ZEL-0105", location: "MEM-Q-02-02", on_hand: 300, reorder_point: 0 },
    ],
  },
  {
    slug: "halcyon",
    name: "Halcyon Biopharma",
    product: "Ostravel",
    docs: [
      {
        job_code: "HLC-OST-2201", version: 1, status: "approved", approved_days_ago: 45, expires_in_days: 685,
        title: "Ostravel Patient Brochure", material_type: "patient brochure",
        body: "Ostravel patient brochure. 12-page booklet explaining once-weekly tablet dosing, taking Ostravel with a full glass of water, and how to enrol in the Halcyon HelpPath program at 1-800-555-0222.",
      },
      {
        job_code: "HLC-OST-2202", version: 1, status: "approved", approved_days_ago: 30, expires_in_days: 335,
        title: "Ostravel Savings Card", material_type: "savings card",
        body: "Ostravel copay savings card, 2026 program. Eligible commercially insured patients may pay $0 per prescription. Activation via HelpPath website.",
        max_order_qty: 500,
      },
      {
        job_code: "HLC-OST-2203", version: 2, status: "approved", approved_days_ago: 20, expires_in_days: 710,
        title: "Ostravel HCP Reimbursement Guide", material_type: "hcp guide",
        body: "Ostravel reimbursement guide for office staff. Prior authorization checklist, sample letter of medical necessity and HelpPath benefits verification steps.",
      },
      {
        job_code: "HLC-OST-2203", version: 1, status: "approved", approved_days_ago: 380, expires_in_days: 350,
        title: "Ostravel HCP Reimbursement Guide", material_type: "hcp guide",
        body: "Ostravel reimbursement guide, first edition. Prior authorization checklist using the retired PA-17 form.",
      },
      {
        job_code: "HLC-OST-2204", version: 1, status: "approved", approved_days_ago: 700, expires_in_days: -5,
        title: "Ostravel Sample Request Form", material_type: "order form",
        body: "Ostravel sample request form for prescribers. Fax-back form for starter samples.",
      },
      {
        job_code: "HLC-OST-2205", version: 1, status: "draft",
        title: "Ostravel Nurse Educator Flip Chart", material_type: "hcp guide",
        body: "DRAFT. Desk flip chart for nurse educators covering Ostravel counselling points.",
      },
    ],
    stock: [
      { job_code: "HLC-OST-2201", location: "MEM-B-03-02", on_hand: 900, reorder_point: 150 },
      { job_code: "HLC-OST-2202", location: "MEM-B-03-05", on_hand: 4000, reorder_point: 500 },
      { job_code: "HLC-OST-2203", location: "MEM-B-04-01", on_hand: 150, reorder_point: 50 },
      { job_code: "HLC-OST-2204", location: "MEM-Q-02-03", on_hand: 75, reorder_point: 0 },
    ],
  },
  {
    slug: "meridian",
    name: "Meridian Rx",
    product: "Cardivane",
    docs: [
      {
        job_code: "MRX-CRD-3301", version: 1, status: "approved", approved_days_ago: 800, expires_in_days: 100,
        title: "Cardivane Patient Diary", material_type: "patient brochure",
        body: "Cardivane patient diary, first edition. Daily blood pressure log, 30 days.",
      },
      {
        job_code: "MRX-CRD-3301", version: 2, status: "approved", approved_days_ago: 400, expires_in_days: 300,
        title: "Cardivane Patient Diary", material_type: "patient brochure",
        body: "Cardivane patient diary, second edition. Daily blood pressure log, 60 days.",
      },
      {
        job_code: "MRX-CRD-3301", version: 3, status: "approved", approved_days_ago: 10, expires_in_days: 720,
        title: "Cardivane Patient Diary", material_type: "patient brochure",
        body: "Cardivane patient diary, third edition. 90-day blood pressure and heart rate log with a pocket for the Meridian CareLine card, call 1-800-555-0333.",
      },
      {
        job_code: "MRX-CRD-3302", version: 1, status: "approved", approved_days_ago: 75, expires_in_days: 655,
        title: "Cardivane HCP Detail Aid", material_type: "hcp guide",
        body: "Cardivane detail aid for cardiology offices. Six-panel visual aid used by representatives during physician calls.",
      },
      {
        job_code: "MRX-CRD-3303", version: 1, status: "approved", approved_days_ago: 420, expires_in_days: -60,
        title: "Cardivane Copay Savings Card", material_type: "savings card",
        body: "Cardivane copay savings card. Eligible patients pay $10 per month. Program ended.",
      },
      {
        job_code: "MRX-CRD-3304", version: 1, status: "approved", approved_days_ago: 15, expires_in_days: 715,
        title: "Cardivane Pharmacy Counter Display", material_type: "display",
        body: "Cardivane pharmacy counter display with tear-off patient leaflets. Heavy item, ships flat.",
        max_order_qty: 20,
      },
    ],
    stock: [
      { job_code: "MRX-CRD-3301", location: "MEM-C-05-01", on_hand: 2000, reorder_point: 300 },
      { job_code: "MRX-CRD-3302", location: "MEM-C-05-04", on_hand: 60, reorder_point: 40 },
      { job_code: "MRX-CRD-3303", location: "MEM-Q-02-04", on_hand: 250, reorder_point: 0 },
      { job_code: "MRX-CRD-3304", location: "MEM-C-06-09", on_hand: 12, reorder_point: 15 },
    ],
  },
];
