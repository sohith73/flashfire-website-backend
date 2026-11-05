import mongoose from 'mongoose';
import { DEDUCTION_RULES, DEDUCTION_STATUSES } from '../Utils/deductionPolicy.js';

// One row per fine, with the evidence frozen at the moment it was written (plan 8.1).
// Rows are never deleted: a waiver or a void changes `status` and keeps who, when and why.

const EvidenceSchema = new mongoose.Schema(
  {
    scheduledStart: { type: Date, default: null },
    windowClosedAt: { type: Date, default: null },
    signals: { type: Array, default: [] }, // copy of the attendance signals at verdict time
    bookingStatus: { type: String, default: null },
    callSummary: { type: mongoose.Schema.Types.Mixed, default: null },
    clientName: { type: String, default: null },
    // Extras beyond plan 8.1, kept inside the frozen snapshot:
    healthy: { type: Boolean, default: null }, // false when a source was unhealthy (plan 2.7), also on shadow rows
    // Colleagues the attendance record shows in the meeting while the assigned BDA was not: [{ bdaEmail, bdaName, joinedAt, minutes }].
    // Non-empty means the row was written as needs_review. This schema is strict, so a field left out here is silently dropped.
    coveredBy: { type: Array, default: [] },
    // Shared team accounts (e.g. "FLASHFIRE") that were in the Meet roster: [{ displayName }]. Also holds the row for review.
    unattributedStaff: { type: Array, default: [] },
    // { firstAt, lastAt } when the BDA's own extension reported them in this meeting's call. Also holds the row for review.
    extensionInCall: { type: mongoose.Schema.Types.Mixed, default: null },
    // Other meetings at the same time and whether the BDA was in one: [{ bookingId, clientName, attended }].
    doubleBookedWith: { type: Array, default: [] },
    // missed_meeting: why the BDA counts as absent, 'no_signal' (never seen in time) or 'left_early' (in time, but
    // out of the call before the minimum stay after the start). stayMs is the time in the call after the start.
    absentReason: { type: String, enum: ['no_signal', 'left_early', null], default: null },
    stayMs: { type: Number, default: null },
    // Set when a person wrote the fine: an admin marked a call absent, or approved a BDA's own report.
    manualAbsent: { type: mongoose.Schema.Types.Mixed, default: null },
    convertedFromFlag: {
      // set when an admin turned a "marked present, never joined" flag into a miss (decision D10)
      type: new mongoose.Schema(
        { reason: String, by: String, byName: String, at: Date },
        { _id: false }
      ),
      default: null,
    },
  },
  { _id: false }
);

const BdaDeductionSchema = new mongoose.Schema(
  {
    deductionId: {
      type: String,
      unique: true,
      required: true,
      default: () => `ded_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
    },
    bdaEmail: { type: String, required: true, trim: true, lowercase: true, index: true },
    bookingId: { type: String, required: true, index: true },
    rule: { type: String, enum: DEDUCTION_RULES, required: true },
    month: { type: String, required: true }, // 'YYYY-MM' in IST, indexed with bdaEmail below
    amountInr: { type: Number, required: true }, // re-priced for missed_meeting tiers
    tierIndex: { type: Number, default: null }, // nth active miss in the month, missed_meeting only
    evidence: { type: EvidenceSchema, default: () => ({}) },
    status: { type: String, enum: DEDUCTION_STATUSES, required: true },
    //  shadow        created while DEDUCTIONS_MODE=shadow, admins only
    //  needs_review  held for an admin: a source was unhealthy (plan 2.7), or a colleague / shared account /
    //                the BDA's own extension shows the meeting was attended (evidence says which)
    //  active        counts toward pay and the monthly tier
    //  waived        an admin waived it with a reason
    //  voided        the system cancelled it (late evidence, meeting reassigned before the window)
    waivedBy: { type: String, default: null },
    waivedByName: { type: String, default: null },
    waivedAt: { type: Date, default: null },
    waiverReason: { type: String, default: null },
    voidedAt: { type: Date, default: null },
    voidReason: { type: String, default: null },
    // Extras beyond plan 8.1: who moved a needs_review row to active, so an activation leaves a trail too.
    reviewedBy: { type: String, default: null },
    reviewedByName: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
    reviewReason: { type: String, default: null },
  },
  { timestamps: true }
);

// Makes every evaluator idempotent: a second run, or a second backend instance, cannot add a duplicate fine.
BdaDeductionSchema.index({ bookingId: 1, bdaEmail: 1, rule: 1 }, { unique: true });
BdaDeductionSchema.index({ bdaEmail: 1, month: 1 });
BdaDeductionSchema.index({ status: 1 });

export const BdaDeductionModel = mongoose.models.BdaDeduction || mongoose.model('BdaDeduction', BdaDeductionSchema);
