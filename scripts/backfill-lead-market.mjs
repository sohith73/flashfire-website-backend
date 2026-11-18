import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { resolveLeadMarket } from '../Utils/leadMarket.js';

/**
 * Fill leadMarket / landingRoute on website-form leads that were saved before those fields existed.
 * Source of truth, in order: metaRawData.payload.market, metaRawData.payload.pageUrl, then a "(UK)" suffix on the
 * job type note. Only leads from the website form (metaFormName meta_ads_form_website) with no leadMarket yet are
 * touched, and nothing else on the lead changes.
 *
 *   node scripts/backfill-lead-market.mjs           # dry run: prints what it would set
 *   node scripts/backfill-lead-market.mjs --apply   # writes
 */
const APPLY = process.argv.includes('--apply');

await mongoose.connect(process.env.MONGODB_URI);
const leads = await CampaignBookingModel.find({
  metaFormName: 'meta_ads_form_website',
  $or: [{ leadMarket: null }, { leadMarket: { $exists: false } }],
}).select('bookingId clientEmail anythingToKnow metaRawData').lean();

const counts = { uk: 0, us: 0, ca: 0, skipped: 0 };
for (const lead of leads) {
  const payload = lead.metaRawData?.payload ?? {};
  let { leadMarket, landingRoute } = resolveLeadMarket({ market: payload.market, landingRoute: payload.landingRoute, pageUrl: payload.pageUrl, locale: lead.metaRawData?.locale });
  if (!payload.market && !payload.pageUrl && /\(UK\)/.test(lead.anythingToKnow || '')) leadMarket = 'uk';
  if (!leadMarket) { counts.skipped += 1; continue; }
  counts[leadMarket] += 1;
  console.log(`${APPLY ? 'set' : 'would set'} ${lead.bookingId} ${lead.clientEmail} -> ${leadMarket} ${landingRoute || ''}`);
  if (APPLY) {
    await CampaignBookingModel.updateOne({ bookingId: lead.bookingId }, { $set: { leadMarket, ...(landingRoute ? { landingRoute } : {}) } });
  }
}
console.log(`${APPLY ? 'Applied' : 'Dry run'}: ${leads.length} form leads without a market`, counts);
await mongoose.disconnect();
