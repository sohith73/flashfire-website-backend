import mongoose from 'mongoose';

const CRM_MODULE_KEYS = [
  'email_campaign',
  'campaign_manager',
  'whatsapp_campaign',
  'analytics',
  'all_data',
  'workflows',
  'leads',
  'meta_leads',
  'claim_leads',
  'claim_leads_02',
  'call_leads',
  'meeting_links',
  'bda_admin',
  'activity_logs',
  'lead_analytics',
  'graphs03',
  'phone_calls',
  'payment_links',
  'payroll',
  'deductions',
];

// View = `<module>` (legacy key, backwards-compatible). Edit = `<module>_edit`.
// Holding `<module>_edit` without `<module>` is meaningless — controllers/UI treat
// edit as implying view.
const CRM_PERMISSION_KEYS = [
  ...CRM_MODULE_KEYS,
  ...CRM_MODULE_KEYS.map((k) => `${k}_edit`),
];

const CrmUserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    permissions: {
      type: [String],
      default: [],
      validate: {
        validator: function (perms) {
          return Array.isArray(perms) && perms.every((p) => CRM_PERMISSION_KEYS.includes(p));
        },
        message: 'Invalid permission key in permissions array',
      },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Admins may sign into /admin/dashboard via OTP (mailed to this email).
    isAdmin: {
      type: Boolean,
      default: false,
    },
    role: {
      type: String,
      enum: ['admin', 'bda'],
      default: 'bda',
    },
  },
  { timestamps: true }
);

export const CrmUserModel = mongoose.models.CrmUser || mongoose.model('CrmUser', CrmUserSchema);
export const CRM_PERMISSION_KEYS_ALLOWED = CRM_PERMISSION_KEYS;
export const CRM_MODULE_KEYS_ALLOWED = CRM_MODULE_KEYS;


