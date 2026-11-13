
import VerifyInterestedClient from "./Middlewares/VerifyInterestedClient.js";
import { getDashboardData, sendNow, renderDashboard } from "./Controllers/DashboardController.js";
import { searchClientReminders, getRecentErrors, renderReminderDashboard } from "./Controllers/ReminderDashboardController.js";
import Register_Sessions from "./Controllers/Register_Sessions.js";
import Contact from "./Controllers/Contact.js";
import Signup from "./Controllers/Signup.js";
import GetUsersWithoutBookings from "./Controllers/GetUsersWithoutBookings.js";
import GetUsersWithoutBookingsDetailed from "./Controllers/GetUsersWithoutBookingsDetailed.js";
import GetUsersWithoutBookingsPaginated from "./Controllers/GetUsersWithoutBookingsPaginated.js";
import DeleteUserRecords from "./Controllers/DeleteUserRecords.js";
import SendEmailCampaign from "./Controllers/SendEmailCampaign.js";
import GetEmailCampaigns from "./Controllers/GetEmailCampaigns.js";
import CreateScheduledEmailCampaign from "./Controllers/CreateScheduledEmailCampaign.js";
import GetScheduledEmailCampaigns from "./Controllers/GetScheduledEmailCampaigns.js";
import UpdateScheduledEmailCampaignStatus from "./Controllers/UpdateScheduledEmailCampaignStatus.js";
import GetUserCampaigns from "./Controllers/GetUserCampaigns.js";
import GetCampaignDetails from "./Controllers/GetCampaignDetails.js";
import ResendEmailCampaign from "./Controllers/ResendEmailCampaign.js";
import { saveEmailTemplate, getEmailTemplates, deleteEmailTemplate, updateEmailTemplateFields } from "./Controllers/EmailTemplateController.js";
import EmployerForm from "./Controllers/EmployerForm.js";
import TwilioReminder from "./Controllers/TwilioReminder.js";
import twilio from 'twilio';
import SendEmailReminder from "./Controllers/SendEmailReminder.js";
// Campaign Controllers
import {
  createCampaign,
  getAllCampaigns,
  getCampaignById,
  trackPageVisit,
  trackButtonClick,
  updateCampaign,
  deleteCampaign,
  getCampaignStatistics
} from "./Controllers/CampaignController.js";
import {
  trackAllPageVisits,
  getRealTimeStats
} from "./Controllers/PageVisitController.js";
import {
  getAllBookings,
  getAllBookingsPaginated,
  getMeetingsBookedToday,
  getMeetingsByDate,
  getBookingById,
  updateBookingStatus,
  getBookingsByEmail,
  exportBookingsForMicroservice,
  markBookingsAsSynced,
  captureFrontendBooking,
  rescheduleBooking,
  updateBookingNotes,
  updateBookingTemperature,
  createBookingManually,
  getLeadsPaginated,
  getLeadsIds,
  getDistinctBookingUtm,
  getMeetingLinks,
  updateBookingAmount,
  bulkCreateLeads,
  handlePaidClientFromMicroservice,
  getMeetingNotes,
  getLeadsAnalytics
} from "./Controllers/CampaignBookingController.js";
import ScheduleFollowUp from "./Controllers/ScheduleFollowUpController.js";
import {
  syncDiscordBdaReminders,
  processDiscordMeetRemindersHttp,
  processCriticalRemindersHttp,
} from "./Controllers/SyncController.js";
import TestCallStatus from "./test/TestCallStatus.js";
import TestPayPalEmail from "./test/TestPayPalEmail.js";
// Webhook Controllers
import { handleCalendlyWebhook, testWebhook } from "./Controllers/CalendlyWebhookController.js";
import { handlePayPalWebhook } from "./Controllers/PayPalWebhookController.js";
import { handleStripeWebhook } from "./Controllers/StripeWebhookController.js";
import {
  captureStripeWebhook,
  listStripeWebhookEvents,
  getStripeWebhookEventStats,
  getStripeWebhookEvent,
} from "./Controllers/StripeCaptureWebhookController.js";
import { handleFirefliesWebhook } from "./Controllers/FirefliesWebhookController.js";
import { handleGoogleMeetMetadataWebhook } from "./Controllers/GoogleMeetMetadataController.js";
// BDA Attendance Controllers
import {
  requestBdaOtp,
  verifyBdaOtp,
  getMyMeetings,
  reportJoin,
  reportLeave,
  reportEndEvent,
  manualMark,
  markAbsent,
  warnAbsent,
  beaconLeave,
  beaconReportEndEvent,
  updateBdaName,
  createTestMeeting,
  sseConnection,
  getAttendanceByBooking,
  getAttendanceBulk,
  getMissedMeetingLogs
} from "./Controllers/BdaAttendanceController.js";
import { requireBdaExtension } from "./Middlewares/CrmAuth.js";
// Facebook Conversion API Controllers
import { sendScheduleEventManual, sendCustomEvent } from "./Controllers/FacebookConversionController.js";
// Meta Lead Ads Webhook Controllers
import {
  verifyMetaWebhook,
  handleMetaLeadWebhook,
  createMetaLeadManually,
  upsertMetaLeadFromSheet
} from "./Controllers/MetaLeadWebhookController.js";
// Website Meta Ads Form Controller
import { submitMetaAdsFormLead } from "./Controllers/MetaAdsFormController.js";
// Payment Reminder Controllers
import { schedulePaymentReminder, getPaymentReminders, cancelPaymentReminder } from "./Controllers/PaymentReminderController.js";
// Payment Controllers
import { createPayment, getAllPayments, getPaymentById, getPaymentsByEmail } from "./Controllers/PaymentController.js";
import { getMessageTypes, sendMessage, testConnection, sendSimpleMessage } from "./Controllers/WhatsAppController.js";
import { testWhatsAppTemplate, testNoShowTemplate } from "./Controllers/WhatsAppTestController.js";
// WhatsApp Campaign Controllers
import { 
  getWatiTemplates, 
  getMobileNumbersByStatus, 
  getWhatsAppCampaignById,
  createWhatsAppCampaign, 
  getAllWhatsAppCampaigns, 
  getScheduledWhatsAppCampaigns,
  sendWhatsAppCampaignNow
} from "./Controllers/WhatsAppCampaignController.js";
// Workflow Controllers
import {
  createWorkflow,
  getAllWorkflows,
  getWorkflowById,
  updateWorkflow,
  deleteWorkflow,
  processScheduledWorkflows,
  getBookingsByStatusForBulk,
  triggerWorkflowsForAllByStatus,
  checkWorkflowsNeedPlanDetails,
  resendAllFailedWhatsApp,
  getCustomWorkflowsForBooking,
  attachCustomWorkflowToBooking,
  detachCustomWorkflowFromBooking,
  triggerCustomWorkflowForBooking
} from "./Controllers/WorkflowController.js";
// Workflow Log Controllers
import {
  getWorkflowLogs,
  getWorkflowLogById,
  getWorkflowLogStats,
  sendWorkflowLogNow,
  deleteWorkflowLog,
  deleteAllWorkflowsForBookingByStatus
} from "./Controllers/WorkflowLogController.js";
// Redis/BullBoard removed — scheduling handled by MongoDB-based JobScheduler + UnifiedScheduler
import { crmAdminLogin, crmAdminRequestOtp, crmAdminVerifyOtp, listCrmUsers, createCrmUser, updateCrmUser, deleteCrmUser } from './Controllers/CrmAdminController.js';
import { getActivityLogs, getActivityFilters } from './Controllers/ActivityLogController.js';
import { getPaidClientsAnalytics } from './Controllers/PaidClientsController.js';
import { getFunnelAnalytics } from './Controllers/FunnelAnalyticsController.js';
import { getStripePaymentsByMonth, getStripeAllMonthsSummary, getStripePaidPlanMonthlySummary } from './Controllers/StripeDataController.js';
import { getManualPaymentsByMonth, createManualPayment, updateManualPayment, deleteManualPayment } from './Controllers/ManualPaymentController.js';
import { generatePaymentLink, redirectShortLink } from './Controllers/PaymentLinkController.js';
import { getPayroll, createPayroll, updatePayroll, deletePayroll } from './Controllers/PayrollController.js';
import { listMySessions, revokeMySession, listAllSessions, adminRevokeSession } from './Controllers/CrmSessionController.js';
import {
  listDesignedTemplates,
  getDesignedTemplate,
  saveDesignedTemplate,
  deleteDesignedTemplate,
  sendDesignedTemplate,
  getEmailSignaturePreview,
} from './Controllers/DesignedEmailTemplateController.js';
import {
  getBdaMeetingsAnalytics,
  getNoShowFollowupAnalytics,
  getBdaCallActivity,
  getBdaScorecard,
  getBdaStatusBreakdown,
} from './Controllers/Graphs03Controller.js';
import {
  zoomPhoneWebhook,
  getCallMinutesByPhone,
  getCallsForLead,
  getRecentCalls,
  proxyCallRecording,
  proxyCallTranscript,
  getZoomWebhookEvents,
  triggerZoomSync,
  getNoShowLeadsWithoutCalls,
  getCallerNumbers,
  getLiveCallForLead,
  getAgentPresence,
} from './Controllers/ZoomPhoneController.js';
import {
  getCallLeads,
  getCallLeadsSummary,
  addCallLeadNote,
  triggerCallLeadAssignment,
} from './Controllers/CallLeadsController.js';
import { requestCrmOtp, verifyCrmOtp, crmMe, getLoginApprovalStatus } from './Controllers/CrmAuthController.js';
import { listPendingLoginApprovals, approveLoginApproval, denyLoginApproval } from './Controllers/CrmLoginApprovalController.js';
import { requireCrmAdmin, requireCrmUser, requireCrmPermission, requireCrmAnyPermission, requireCrmEdit, requireCrmEditLive, attachCrmUserOptional } from './Middlewares/CrmAuth.js';
import {
  getAvailableLeads,
  getLeadByEmail,
  claimLead,
  updateLeadDetails,
  getBdaAnalysis,
  getMyClaimedLeads,
  getBdaLeadsByEmail,
  getAllClientsWithClaimInfo,
  getMyBdaPerformance,
  bdaUnclaimLead,
  adminUnclaimLead,
  getPendingBdaApprovalsForCrm,
  handleBdaApprovalEmailAction,
  adminResolveBdaApproval
} from './Controllers/BdaLeadController.js';
import { getIncentiveConfig, saveIncentiveConfig } from './Controllers/BdaIncentiveController.js';
import {
  searchLeads as claim02SearchLeads,
  listMyClaims as claim02ListMyClaims,
  claimLead as claim02ClaimLead,
  updateOwnClaim as claim02UpdateOwnClaim,
  adminListAll as claim02AdminListAll,
  adminSetStatus as claim02AdminSetStatus,
  adminUpdateClaim as claim02AdminUpdateClaim,
  adminListBdas as claim02AdminListBdas,
} from './Controllers/BdaClaim02Controller.js';
// import {GetMeetDetails} from "./Utils/GetMeetDetails.js";
// import Calendly_Meet_Integration from "./Controllers/Calendly_Meet_Integration.js";



//these routes are defined and codes are written only requires minor modification to suit on a case by case basis..


import express from 'express';

// BDA attendance v2 route groups (plan sections 5.3, 8.3 and 2.8). Each registers its own paths.
import { registerAttendanceRoutes } from "./Routes/attendanceRoutes.js";
import { registerDeductionRoutes } from "./Routes/deductionRoutes.js";
import { registerBdaProfileRoutes } from "./Routes/bdaProfileRoutes.js";
import { registerLeaveRoutes } from "./Routes/leaveRoutes.js";
import { registerSalesAllocationRoutes } from "./Routes/salesAllocationRoutes.js";
import { registerAbsenceRoutes } from "./Routes/absenceRoutes.js";
import { registerWarningLetterRoutes } from "./Routes/warningLetterRoutes.js";
import { registerCalendlyRecapRoutes } from "./Routes/calendlyRecapRoutes.js";
import { registerAttendanceSetupRoutes } from "./Routes/attendanceSetupRoutes.js";

export default function Routes(app) {

  //login routes and registration routes :
  //the login and registraion routes works but we should or can use supabase auth system
  // the login and registraion routes doesnot have email verification integrated in it..
  //since login and registration routes are not required as of now...



  //admin routes to add a job...
  //CheckJobExistance is the middleware that checks if the job being added is already present to avoid duplicate records..
  //CheckJobExistance uses job ID as parameter , job id is generated by ()=>date.now()...it keeps the id unique..
  //  job adding by admin routes....here a auth is required for enabling only authenticated admin to add job and authenticated user 
  //LocalTokenValidator can be used 


  //this is the place where all the paid users will appear to the BDE and also the relevant jobs will also appear
  //my idea is that on clicking each of the paid user we open the student dashboard where all the details like education,
  // skills, jobs applied, interview status etc can be done..
  //apart from these only an admin can create a new admin or a paid user and the admin can post a job to db using the '''/admin/addjobs route'''



  //this is the route when a new user clicks on the try now button..it verifies the details and adds details to the database..
  app.post('/', VerifyInterestedClient, Register_Sessions);
  //this is the route that calandly posts on for sending meeting details..from here meeting details or sessions can be added to DB for sales people..
  //  app.post("/calendly-webhook",GetMeetDetails);
  //the routes that handles contact us page..
  app.post('/api/contact', Contact);
  app.post('/signup', Signup);
  app.get('/api/users/without-bookings', GetUsersWithoutBookings);
  app.get('/api/users/without-bookings/detailed', GetUsersWithoutBookingsDetailed);
  app.get('/api/users/without-bookings/paginated', GetUsersWithoutBookingsPaginated);
  app.delete('/api/users/delete/:email', DeleteUserRecords);
  app.post('/api/email-campaign/send', SendEmailCampaign);
  app.post('/api/email-campaign/scheduled', CreateScheduledEmailCampaign);
  app.get('/api/email-campaigns', GetEmailCampaigns);
  app.get('/api/email-campaigns/scheduled', GetScheduledEmailCampaigns);
  app.put('/api/email-campaigns/scheduled/:campaignId/status', UpdateScheduledEmailCampaignStatus);
  app.get('/api/email-campaigns/user/:email', GetUserCampaigns);
  app.get('/api/email-campaigns/:campaignId/details/:userEmail', GetCampaignDetails);
  app.post('/api/email-campaign/resend', ResendEmailCampaign);

  // ==================== CRM AUTH (OTP) + ADMIN ====================
  app.post('/api/crm/admin/login', crmAdminLogin);
  app.post('/api/crm/admin/otp/request', crmAdminRequestOtp);
  app.post('/api/crm/admin/otp/verify', crmAdminVerifyOtp);
  app.get('/api/crm/admin/users', requireCrmAdmin, listCrmUsers);
  app.post('/api/crm/admin/users', requireCrmAdmin, createCrmUser);
  app.put('/api/crm/admin/users/:id', requireCrmAdmin, updateCrmUser);
  app.delete('/api/crm/admin/users/:id', requireCrmAdmin, deleteCrmUser);

  // Activity feed — gated by the `activity_logs` permission (admin tick).
  app.get('/api/crm/activity-logs', requireCrmUser, requireCrmPermission('activity_logs'), getActivityLogs);
  app.get('/api/crm/activity-logs/filters', requireCrmUser, requireCrmPermission('activity_logs'), getActivityFilters);

  // Graphs module — paid-client analytics sourced from the clients-tracking DB.
  app.get('/api/crm/paid-clients/analytics', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads', 'lead_analytics']), getPaidClientsAnalytics);

  // Analytics tab — form → scheduled → attended → paid funnel table.
  app.get('/api/crm/analytics/funnel', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads', 'lead_analytics', 'all_data']), getFunnelAnalytics);

  // Graphs 03 — per-BDA performance: meetings vs paid, and no-show follow-up coverage.
  app.get('/api/crm/graphs03/bda-meetings', requireCrmUser, requireCrmAnyPermission(['graphs03', 'leads', 'meta_leads', 'lead_analytics', 'all_data']), getBdaMeetingsAnalytics);
  app.get('/api/crm/graphs03/no-show-followup', requireCrmUser, requireCrmAnyPermission(['graphs03', 'leads', 'meta_leads', 'lead_analytics', 'all_data', 'phone_calls']), getNoShowFollowupAnalytics);
  app.get('/api/crm/graphs03/bda-call-activity', requireCrmUser, requireCrmAnyPermission(['graphs03', 'leads', 'meta_leads', 'lead_analytics', 'all_data', 'phone_calls']), getBdaCallActivity);
  app.get('/api/crm/graphs03/bda-scorecard', requireCrmUser, requireCrmAnyPermission(['graphs03', 'leads', 'meta_leads', 'lead_analytics', 'all_data']), getBdaScorecard);
  app.get('/api/crm/graphs03/bda-status-breakdown', requireCrmUser, requireCrmAnyPermission(['graphs03', 'leads', 'meta_leads', 'lead_analytics', 'all_data']), getBdaStatusBreakdown);

  // Stripe Data tab — month-wise succeeded charges enriched with Checkout line-item plan name.
  app.get('/api/crm/stripe/payments', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads', 'lead_analytics', 'all_data']), getStripePaymentsByMonth);
  app.get('/api/crm/stripe/summary', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads', 'lead_analytics', 'all_data']), getStripeAllMonthsSummary);
  app.get('/api/crm/stripe/paid-plan-summary', requireCrmUser, requireCrmAnyPermission(['graphs03', 'leads', 'meta_leads', 'lead_analytics', 'all_data']), getStripePaidPlanMonthlySummary);

  // Raw Stripe webhook capture log — what Stripe is actually sending us.
  // /stats is declared before /:id so it is not read as an event id.
  app.get('/api/crm/stripe/webhook-events', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads', 'lead_analytics', 'all_data']), listStripeWebhookEvents);
  app.get('/api/crm/stripe/webhook-events/stats', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads', 'lead_analytics', 'all_data']), getStripeWebhookEventStats);
  app.get('/api/crm/stripe/webhook-events/:id', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads', 'lead_analytics', 'all_data']), getStripeWebhookEvent);

  // Manual INR payment entries — merged into the Stripe Data tab alongside Stripe charges.
  app.get('/api/crm/stripe/manual-payments', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads', 'lead_analytics', 'all_data']), getManualPaymentsByMonth);
  app.post('/api/crm/stripe/manual-payments', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads', 'lead_analytics', 'all_data']), createManualPayment);
  app.put('/api/crm/stripe/manual-payments/:id', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads', 'lead_analytics', 'all_data']), updateManualPayment);
  app.delete('/api/crm/stripe/manual-payments/:id', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads', 'lead_analytics', 'all_data']), deleteManualPayment);

  // Payment Link Generator — BDA internal tool
  app.post('/api/crm/generate-payment-link', requireCrmUser, requireCrmPermission('payment_links'), generatePaymentLink);
  // Public short-link redirect for generated payment links.
  app.get('/s/:code', redirectShortLink);

  // Payroll — employee salary, incentives and deductions.
  app.get('/api/payroll', requireCrmUser, requireCrmPermission('payroll'), getPayroll);
  app.post('/api/payroll', requireCrmUser, requireCrmPermission('payroll'), createPayroll);
  app.put('/api/payroll/:id', requireCrmUser, requireCrmPermission('payroll'), updatePayroll);
  app.delete('/api/payroll/:id', requireCrmUser, requireCrmPermission('payroll'), deletePayroll);

  // Zoom Phone — webhook is public (HMAC-verified inside).
  app.post('/api/zoom-phone/webhook', zoomPhoneWebhook);
  // CRM-facing endpoints for the Leads / All-Data tables.
  app.get('/api/crm/call-logs/minutes-by-phone', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads', 'all_data', 'phone_calls']), getCallMinutesByPhone);
  app.get('/api/crm/call-logs', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads', 'all_data', 'phone_calls']), getCallsForLead);
  app.get('/api/crm/call-logs/recent', requireCrmUser, requireCrmPermission('phone_calls'), getRecentCalls);
  app.post('/api/crm/call-logs/sync', requireCrmUser, requireCrmPermission('phone_calls'), triggerZoomSync);
  // Outbound "call from which number" picker: the agent's allowed caller-IDs + live status.
  app.get('/api/crm/zoom-phone/numbers', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads', 'all_data', 'phone_calls']), getCallerNumbers);
  // Live call status right after dialing (polled by the CRM call button).
  app.get('/api/crm/call-logs/live', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads', 'all_data', 'phone_calls']), getLiveCallForLead);
  // Agent availability (cached Zoom presence / on-call state).
  app.get('/api/crm/agents/:email/presence', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads', 'all_data', 'phone_calls']), getAgentPresence);
  app.get('/api/crm/phone-gaps/no-show', requireCrmUser, requireCrmAnyPermission(['leads', 'phone_calls', 'meta_leads']), getNoShowLeadsWithoutCalls);
  app.get('/api/crm/call-logs/:callId/recording', requireCrmUser, requireCrmPermission('phone_calls'), proxyCallRecording);
  app.get('/api/crm/call-logs/:callId/transcript', requireCrmUser, requireCrmPermission('phone_calls'), proxyCallTranscript);
  // Debug: raw Zoom webhook deliveries — quickest way to see if events arrive at all.
  app.get('/api/crm/zoom-phone/events', requireCrmUser, requireCrmPermission('phone_calls'), getZoomWebhookEvents);
  // Same data, admin-token gated — easier for one-off debugging.
  app.get('/api/crm/admin/zoom-phone/events', requireCrmAdmin, getZoomWebhookEvents);

  // Call Leads — Meta leads that never booked a meeting, 24h+ after the form fill.
  // Note the permission set: the BDAs who actually work this list hold `leads`/`all_data`,
  // NOT `phone_calls`, so gating on phone_calls alone would hide the tab from them.
  const CALL_LEADS_VIEW = ['leads', 'leads_edit', 'meta_leads', 'meta_leads_edit', 'all_data', 'all_data_edit', 'phone_calls', 'phone_calls_edit'];
  const CALL_LEADS_EDIT = ['leads_edit', 'meta_leads_edit', 'all_data_edit', 'phone_calls_edit'];
  app.get('/api/crm/call-leads', requireCrmUser, requireCrmAnyPermission(CALL_LEADS_VIEW), getCallLeads);
  app.get('/api/crm/call-leads/summary', requireCrmUser, requireCrmAnyPermission(CALL_LEADS_VIEW), getCallLeadsSummary);
  app.post('/api/crm/call-leads/:bookingId/notes', requireCrmUser, requireCrmAnyPermission(CALL_LEADS_EDIT), addCallLeadNote);
  // Force an assignment pass (unassigned leads → the fixed assignee). The scheduler
  // does this on a timer; the controller rejects BDAs, so only admins can trigger it.
  app.post('/api/crm/call-leads/assign', requireCrmUser, requireCrmAnyPermission(CALL_LEADS_EDIT), triggerCallLeadAssignment);
  app.post('/scripts/assign/calls', async (req, res) => {
    try {
      if (req.body?.set !== true) {
        return res.status(400).json({ success: false, error: 'Missing or invalid body parameter: {set: true}' });
      }
      const { reassignAllLeadsToKalpataru } = await import('./Controllers/CallLeadsController.js');
      const result = await reassignAllLeadsToKalpataru();
      res.status(200).json({ success: true, ...result });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/crm/auth/request-otp', requestCrmOtp);
  app.post('/api/crm/auth/verify-otp', verifyCrmOtp);
  app.get('/api/crm/auth/me', requireCrmUser, crmMe);
  app.get('/api/crm/auth/login-approval/:approvalId/status', getLoginApprovalStatus);

  // BDA login approval — admin reviews new-device login attempts before the BDA can sign in.
  app.get('/api/crm/admin/login-approvals', requireCrmAdmin, listPendingLoginApprovals);
  app.post('/api/crm/admin/login-approvals/:approvalId/approve', requireCrmAdmin, approveLoginApproval);
  app.post('/api/crm/admin/login-approvals/:approvalId/deny', requireCrmAdmin, denyLoginApproval);

  // Active Sessions — device/IP/location tracking for CRM logins.
  app.get('/api/crm/sessions', requireCrmUser, listMySessions);
  app.post('/api/crm/sessions/:sessionId/revoke', requireCrmUser, revokeMySession);
  app.get('/api/crm/admin/sessions', requireCrmAdmin, listAllSessions);
  app.post('/api/crm/admin/sessions/:sessionId/revoke', requireCrmAdmin, adminRevokeSession);

  app.get('/api/bda/available-leads', requireCrmUser, getAvailableLeads);
  app.get('/api/bda/lead-by-email/:email', requireCrmUser, getLeadByEmail);
  app.post('/api/bda/claim-lead/:bookingId', requireCrmUser, requireCrmEdit('claim_leads'), claimLead);
  app.post('/api/bda/unclaim-lead/:bookingId', requireCrmUser, requireCrmEdit('claim_leads'), bdaUnclaimLead);
  app.put('/api/bda/update-lead/:bookingId', requireCrmUser, requireCrmEdit('claim_leads'), updateLeadDetails);
  app.get('/api/bda/my-leads', requireCrmUser, getMyClaimedLeads);
  app.get('/api/bda/performance', requireCrmUser, getMyBdaPerformance);

  // --- Claim Leads 02 (lightweight parallel claim flow) ---
  // Own permission (claim_leads_02), independent of the original Claim Leads
  // tab. All under requireCrmUser; admin vs BDA is decided in-controller from
  // req.crmUser.bdaRole. Mutations require the claim_leads_02 edit permission.
  app.get('/api/bda/claim02/search', requireCrmUser, claim02SearchLeads);
  app.get('/api/bda/claim02/my', requireCrmUser, claim02ListMyClaims);
  app.get('/api/bda/claim02/bdas', requireCrmUser, claim02AdminListBdas);
  app.get('/api/bda/claim02/admin/all', requireCrmUser, claim02AdminListAll);
  // Claiming + a BDA editing their own row needs claim_leads_02 edit.
  app.post('/api/bda/claim02/claim/:bookingId', requireCrmUser, requireCrmEditLive('claim_leads_02'), claim02ClaimLead);
  app.put('/api/bda/claim02/:id', requireCrmUser, requireCrmEditLive('claim_leads_02'), claim02UpdateOwnClaim);
  // Admin-only actions (approve/deny, edit any row) are gated in-controller by
  // bdaRole === 'admin' — an admin does not need the claim_leads_02 edit grant.
  app.put('/api/bda/claim02/admin/:id', requireCrmUser, claim02AdminUpdateClaim);
  app.post('/api/bda/claim02/admin/:id/approve', requireCrmUser, claim02AdminSetStatus);
  app.get('/api/bda/analysis', requireCrmAdmin, getBdaAnalysis);
  app.get('/api/bda/leads/:email', requireCrmAdmin, getBdaLeadsByEmail);
  app.get('/api/crm/admin/clients/claims', requireCrmAdmin, getAllClientsWithClaimInfo);
  app.post('/api/crm/admin/booking/:bookingId/unclaim', requireCrmAdmin, adminUnclaimLead);
  app.get('/api/crm/admin/bda-incentives/config', requireCrmAdmin, getIncentiveConfig);
  app.put('/api/crm/admin/bda-incentives/config', requireCrmAdmin, saveIncentiveConfig);
  app.get('/api/bda/incentives/config', requireCrmUser, getIncentiveConfig);
  app.get('/api/crm/bda-approvals/pending', requireCrmUser, requireCrmPermission('bda_admin'), getPendingBdaApprovalsForCrm);
  app.get('/api/bda/approvals/:approvalId/email-action', handleBdaApprovalEmailAction);
  app.get('/api/crm/admin/bda-approvals/pending', requireCrmAdmin, getPendingBdaApprovalsForCrm);
  app.post('/api/crm/admin/bda-approvals/:approvalId/decision', requireCrmAdmin, adminResolveBdaApproval);

  // ==================== BDA ATTENDANCE (Extension) ====================
  app.post('/api/bda-attendance/request-otp', requestBdaOtp);
  app.post('/api/bda-attendance/verify-otp', verifyBdaOtp);
  app.post('/api/bda-attendance/update-name', requireBdaExtension, updateBdaName);
  app.get('/api/bda-attendance/my-meetings', requireBdaExtension, getMyMeetings);
  app.post('/api/bda-attendance/report-join', requireBdaExtension, reportJoin);
  app.post('/api/bda-attendance/report-leave', requireBdaExtension, reportLeave);
  app.post('/api/bda-attendance/report-end-event', requireBdaExtension, reportEndEvent);
  app.post('/api/bda-attendance/manual-mark', requireBdaExtension, manualMark);
  app.post('/api/bda-attendance/mark-absent', requireBdaExtension, markAbsent);
  app.post('/api/bda-attendance/warn-absent', requireBdaExtension, warnAbsent);
  app.post('/api/bda-attendance/beacon-leave', beaconLeave); // No middleware — token verified in body
  app.post('/api/bda-attendance/beacon-end-event', beaconReportEndEvent); // token in body; meet-link-only fallback
  // Test-only meeting creator. Never exposed in production; admin-gated elsewhere.
  if (process.env.NODE_ENV !== 'production') {
    app.post('/api/bda-attendance/create-test-meeting', requireCrmAdmin, createTestMeeting);
  }
  app.get('/api/bda-attendance/sse', sseConnection);
  app.get('/api/bda-attendance/by-booking/:bookingId', requireCrmUser, requireCrmPermission('meeting_links'), getAttendanceByBooking);
  app.get('/api/bda-attendance/bulk', requireCrmUser, requireCrmPermission('meeting_links'), getAttendanceBulk);
  app.get('/api/bda-attendance/missed-logs', requireCrmUser, requireCrmPermission('meeting_links'), getMissedMeetingLogs);

  // BDA attendance v2: mark-present, heartbeat, my-window, my-month, admin queues and health.
  // Registered AFTER the legacy routes above so the old mark-absent and warn-absent stay as no-ops.
  registerAttendanceRoutes(app);
  // Deductions ledger, waive and activate, payroll pull. Inert while DEDUCTIONS_MODE is unset or off.
  registerDeductionRoutes(app);
  // BDA registry admin (aliases, leave days, tracked flag).
  registerBdaProfileRoutes(app);
  // Leave requests: a BDA asks, an admin approves, approval waives that day's deductions.
  registerLeaveRoutes(app);
  // Sales Lead Allocation: admins hand calls to BDAs, BDAs see their own, Discord reminder 5 min before.
  registerSalesAllocationRoutes(app);
registerAbsenceRoutes(app);
  // Warning letters at 7, 10 and 15 missed meetings in a calendar month (counting starts 13 Nov 2026): drafted, sent, shown to admins.
  registerWarningLetterRoutes(app);
  // Calendly Notetaker recaps sent by the Gmail Apps Script, and the CRM views of them.
  registerCalendlyRecapRoutes(app);
  // One-call setup (seed the registry, audit and re-link calls, status checklist). Dry run unless apply is sent.
  registerAttendanceSetupRoutes(app);

  // Email Template Routes
  app.post('/api/email-templates', saveEmailTemplate);
  app.get('/api/email-templates', getEmailTemplates);
  app.put('/api/email-templates/fields', updateEmailTemplateFields);
  app.delete('/api/email-templates/:templateId', deleteEmailTemplate);

  // Designed (in-dashboard, self-hosted HTML) email templates — gated by email_campaign.
  app.get('/api/crm/email-templates/designed', requireCrmUser, requireCrmPermission('email_campaign'), listDesignedTemplates);
  // Must stay above /designed/:id, or Express matches "signature" as an id.
  app.get('/api/crm/email-templates/designed/signature', requireCrmUser, requireCrmPermission('email_campaign'), getEmailSignaturePreview);
  app.get('/api/crm/email-templates/designed/:id', requireCrmUser, requireCrmPermission('email_campaign'), getDesignedTemplate);
  app.post('/api/crm/email-templates/designed', requireCrmUser, requireCrmEdit('email_campaign'), saveDesignedTemplate);
  app.delete('/api/crm/email-templates/designed/:id', requireCrmUser, requireCrmEdit('email_campaign'), deleteDesignedTemplate);
  app.post('/api/crm/email-templates/designed/:id/send', requireCrmUser, requireCrmEdit('email_campaign'), sendDesignedTemplate);
  
  // WhatsApp Campaign Routes
  app.get('/api/whatsapp-campaigns/templates', getWatiTemplates);
  app.get('/api/whatsapp-campaigns/mobile-numbers', getMobileNumbersByStatus);
  app.post('/api/whatsapp-campaigns', createWhatsAppCampaign);
  app.get('/api/whatsapp-campaigns/scheduled', getScheduledWhatsAppCampaigns);
  app.get('/api/whatsapp-campaigns/:campaignId', getWhatsAppCampaignById);
  app.post('/api/whatsapp-campaigns/:campaignId/send-now', sendWhatsAppCampaignNow);
  app.get('/api/whatsapp-campaigns', getAllWhatsAppCampaigns);
  
  app.post('/employerform', EmployerForm);
  // app.post('/calendly-webhook',Calendly_Meet_Integration);
  //  app.post("/twilio-ivr", TwilioReminder);

  // ==================== CAMPAIGN ROUTES ====================
  // Campaign Management
  app.post('/api/campaigns', createCampaign); // Create new campaign
  app.get('/api/campaigns', getAllCampaigns); // Get all campaigns
  app.get('/api/campaigns/stats', getCampaignStatistics); // Get overall statistics
  app.get('/api/campaigns/:campaignId', getCampaignById); // Get specific campaign with details
  app.put('/api/campaigns/:campaignId', updateCampaign); // Update campaign
  app.delete('/api/campaigns/:campaignId', deleteCampaign); // Delete campaign

  // Tracking
  app.post('/api/campaigns/track/visit', trackPageVisit); // Track page visit with UTM
  app.post('/api/campaigns/track/button-click', trackButtonClick); // Track button click with UTM
  
  // Real-time page visit tracking (all traffic - campaigns + organic + direct)
  app.post('/api/track/page-visit', trackAllPageVisits); // Track all page visits (real-time)
  app.get('/api/stats/realtime', getRealTimeStats); // Get real-time stats

  // Booking Management
  app.post('/api/campaign-bookings/manual', createBookingManually); // Create booking manually
  app.post('/api/leads/bulk-create', bulkCreateLeads); // Bulk create leads from CSV
  app.get('/api/campaign-bookings', getAllBookings); // Get all bookings (legacy)
  app.get('/api/campaign-bookings/paginated', getAllBookingsPaginated); // Get paginated bookings with filters
  app.get('/api/campaign-bookings/distinct-utm', getDistinctBookingUtm); // Distinct utm/meta values for filter dropdowns
  app.get('/api/campaign-bookings/today', getMeetingsBookedToday); // Get meetings booked today
  app.get('/api/campaign-bookings/by-date', getMeetingsByDate); // Get meetings by date
  app.get('/api/campaign-bookings/debug/all', async (req, res) => {
    // DEBUG ENDPOINT - Shows ALL bookings with full details
    try {
      const { CampaignBookingModel } = await import('./Schema_Models/CampaignBooking.js');
      const bookings = await CampaignBookingModel.find().sort({ bookingCreatedAt: -1 }).limit(20);
      return res.status(200).json({
        success: true,
        count: bookings.length,
        bookings: bookings.map(b => ({
          bookingId: b.bookingId,
          campaignId: b.campaignId,
          utmSource: b.utmSource,
          clientName: b.clientName,
          clientEmail: b.clientEmail,
          clientPhone: b.clientPhone,
          calendlyMeetLink: b.calendlyMeetLink,
          scheduledEventStartTime: b.scheduledEventStartTime,
          bookingCreatedAt: b.bookingCreatedAt,
          bookingStatus: b.bookingStatus
        }))
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });
  app.get('/api/campaign-bookings/:bookingId', getBookingById); // Get specific booking
  app.get('/api/campaign-bookings/email/:email', getBookingsByEmail); // Get bookings by email
  app.put('/api/campaign-bookings/:bookingId/status', attachCrmUserOptional, updateBookingStatus); // Update booking status (status-ownership enforced inside)
  app.post('/api/campaign-bookings/:bookingId/reschedule', rescheduleBooking); // Reschedule booking and refresh queue
  app.put('/api/campaign-bookings/:bookingId/notes', updateBookingNotes); // Update booking notes
  app.put('/api/campaign-bookings/:bookingId/temperature', attachCrmUserOptional, updateBookingTemperature); // Rate lead hot/warm/cold after the meeting
  app.post('/api/campaign-bookings/:bookingId/meeting-notes', getMeetingNotes); // Get meeting notes from Fireflies
  app.put('/api/campaign-bookings/:bookingId/amount', updateBookingAmount); // Update booking amount (leads only)
  app.post('/api/campaign-bookings/:bookingId/follow-up', ScheduleFollowUp); // Schedule follow-up (email, call, WhatsApp)
  app.post('/api/campaign-bookings/frontend-capture', captureFrontendBooking); // Capture from frontend (backup)
  
  // ==================== FACEBOOK CONVERSION API ROUTES ====================
  app.post('/api/facebook-conversion/schedule', sendScheduleEventManual); // Manually send Schedule event (testing)
  app.post('/api/facebook-conversion/custom', sendCustomEvent); // Send custom conversion event (testing)
  
  app.get('/api/leads/paginated', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads']), getLeadsPaginated);
  app.get('/api/leads/ids', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads']), getLeadsIds);
  app.get('/api/leads/analytics', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads', 'lead_analytics', 'graphs03']), getLeadsAnalytics);
  app.get('/api/meeting-links', requireCrmUser, requireCrmPermission('meeting_links'), getMeetingLinks);

  app.get('/api/campaign-bookings/:bookingId/custom-workflows', requireCrmUser, getCustomWorkflowsForBooking);
  app.post('/api/campaign-bookings/:bookingId/custom-workflows/:workflowId/attach', requireCrmUser, attachCustomWorkflowToBooking);
  app.delete('/api/campaign-bookings/:bookingId/custom-workflows/:workflowId/detach', requireCrmUser, detachCustomWorkflowFromBooking);
  app.post('/api/campaign-bookings/:bookingId/custom-workflows/:workflowId/trigger', requireCrmUser, triggerCustomWorkflowForBooking);

  // Microservice Integration
  app.get('/api/campaign-bookings/export', exportBookingsForMicroservice); // Export bookings
  app.post('/api/campaign-bookings/mark-synced', markBookingsAsSynced); // Mark as synced
  app.post('/api/microservice/paid', handlePaidClientFromMicroservice); // Handle paid client webhook from microservice

  // ==================== WEBHOOK ROUTES ====================
  // Calendly Webhooks
  app.post('/api/webhooks/calendly', handleCalendlyWebhook); // Handle Calendly webhook events
  app.get('/api/webhooks/test', testWebhook); // Test webhook functionality
  // PayPal Webhooks
  app.post('/api/webhooks/paypal', handlePayPalWebhook); // Handle PayPal webhook events (PAYMENT.CAPTURE.COMPLETED, etc.)
  // Stripe Webhooks
  app.post('/api/webhooks/stripe', handleStripeWebhook); // Handle Stripe payment events and send PDF invoice email
  // Capture-only endpoint: records every delivery to the StripeWebhookEvent log
  // and does nothing else. Add it in Stripe as a SEPARATE endpoint (its own
  // signing secret → STRIPE_CAPTURE_WEBHOOK_SECRET) and subscribe it to every
  // event type — it cannot double-charge or double-email, so over-subscribing
  // is free. Raw body comes from the express.raw mount on the /api/webhooks/stripe
  // prefix in index.js.
  app.post('/api/webhooks/stripe/capture', captureStripeWebhook);
  // Google Meet / recording metadata (from n8n or other automations)
  app.post('/api/webhooks/google-meet-metadata', handleGoogleMeetMetadataWebhook); // Attach Google Meet / video URLs to CRM leads
  // Meta Lead Ads Webhooks
  app.get('/api/webhooks/meta-leads', verifyMetaWebhook); // Meta webhook verification (GET)
  app.post('/api/webhooks/meta-leads', handleMetaLeadWebhook); // Receive Meta Lead Ad submissions (POST)
  app.post('/api/meta-leads/manual', createMetaLeadManually); // Manually create Meta lead (for testing)
  app.post('/meta-leads-from-sheet', upsertMetaLeadFromSheet); // Google Apps Script / Sheets → MongoDB upsert by metaLeadId
  app.post('/api/meta-ads-form/lead', submitMetaAdsFormLead); // Website lead form → CRM meta lead + workflows
  // Zoom Phone webhook is registered once above (zoomPhoneWebhook) — the duplicate
  // stub handler that previously lived here was dead code (never reached) and was removed.
  // Fireflies Webhooks (DISABLED - Fireflies integration removed)
  // app.post('/api/webhooks/fireflies', express.raw({ type: 'application/json' }), (req, res, next) => {
  //   try {
  //     req.rawBody = req.body.toString('utf8');
  //     req.body = JSON.parse(req.rawBody);
  //     next();
  //   } catch (err) {
  //     return res.status(400).json({ success: false, message: 'Invalid JSON' });
  //   }
  // }, handleFirefliesWebhook); // Handle Fireflies webhook events (Transcription completed)

  // ==================== SYNC ROUTES ====================
  app.get('/sync/discordbdareminders', syncDiscordBdaReminders); // Backfill Discord BDA reminders for all upcoming meetings
  app.post('/sync/discordbdareminders', syncDiscordBdaReminders);
  app.get('/sync/process-discord-meet-reminders', processDiscordMeetRemindersHttp); // Cron tick (optional DISCORD_MEET_REMINDER_PROCESS_SECRET)
  app.post('/sync/process-discord-meet-reminders', processDiscordMeetRemindersHttp);
  app.get('/sync/process-critical-reminders', processCriticalRemindersHttp); // Calls + WA + Discord (cron secret)
  app.post('/sync/process-critical-reminders', processCriticalRemindersHttp);

  // ==================== TEST ROUTES ====================
  app.post('/test/callstatus', TestCallStatus); // Test call status with Indian number
  app.get('/test/paypal', TestPayPalEmail); // Test PayPal payment confirmation email

  // ==================== PAYMENT REMINDER ROUTES ====================
  app.post('/api/payment-reminders', schedulePaymentReminder); // Schedule payment reminder
  app.get('/api/payment-reminders/:bookingId', getPaymentReminders); // Get scheduled reminders for booking
  app.delete('/api/payment-reminders/:jobId', cancelPaymentReminder); // Cancel scheduled reminder

  // ==================== PAYMENT ROUTES ====================
  app.post('/api/payments', createPayment); // Create new payment record
  app.get('/api/payments', getAllPayments); // Get all payments
  app.get('/api/payments/:paymentId', getPaymentById); // Get payment by ID
  app.get('/api/payments/email/:email', getPaymentsByEmail); // Get payments by customer email

  // ==================== WHATSAPP MESSAGING ROUTES ====================
  app.get('/api/whatsapp/message-types', getMessageTypes); // Get available message types
  app.post('/api/whatsapp/send-message', sendMessage); // Send WhatsApp message
  app.get('/api/whatsapp/test', testConnection); // Test WhatsApp connection
  app.post('/api/whatsapp/send-simple', sendSimpleMessage); // Send simple WhatsApp message (mobile + message only)
  app.post('/api/whatsapp/test-template', testWhatsAppTemplate); // Test WhatsApp template with custom parameters
  app.post('/api/whatsapp/test-noshow', testNoShowTemplate); // Test no-show WhatsApp template with default values

  // ==================== WORKFLOW ROUTES ====================
  app.post('/api/workflows', createWorkflow); // Create new workflow
  app.get('/api/workflows', getAllWorkflows); // Get all workflows
  // Specific routes must come before parameterized routes
  app.post('/api/workflows/process-scheduled', processScheduledWorkflows); // Process scheduled workflows (cron job)
  app.get('/api/workflows/bulk/bookings-by-status', getBookingsByStatusForBulk); // Get bookings by status for bulk actions
  app.post('/api/workflows/bulk/trigger-by-status', triggerWorkflowsForAllByStatus); // Trigger workflows for all bookings with status
  app.post('/api/workflows/bulk/resend-failed-whatsapp', resendAllFailedWhatsApp); // Resend all failed WhatsApp workflow logs
  app.get('/api/workflows/check-plan-details', checkWorkflowsNeedPlanDetails); // Check if workflows need plan details for an action
  // Parameterized routes come last
  app.get('/api/workflows/:workflowId', getWorkflowById); // Get workflow by ID
  app.put('/api/workflows/:workflowId', updateWorkflow); // Update workflow
  app.delete('/api/workflows/:workflowId', deleteWorkflow); // Delete workflow

  // ==================== WORKFLOW LOG ROUTES ====================
  app.get('/api/workflow-logs', getWorkflowLogs); // Get workflow logs with pagination
  app.get('/api/workflow-logs/stats', getWorkflowLogStats); // Get workflow log statistics
  app.get('/api/workflow-logs/:logId', getWorkflowLogById); // Get workflow log by ID
  app.post('/api/workflow-logs/:logId/send-now', sendWorkflowLogNow); // Send workflow log email immediately
  app.delete('/api/workflow-logs/:logId', deleteWorkflowLog); // Delete a single workflow log
  app.delete('/api/workflow-logs/booking/:bookingId/status/:triggerAction', deleteAllWorkflowsForBookingByStatus); // Delete all workflows for a booking by status

  app.get('/details', renderDashboard);
  app.get('/api/dashboard/data', getDashboardData);
  app.post('/api/dashboard/send-now', sendNow);

  // ==================== REMINDER DASHBOARD ====================
  app.get('/admin/reminders', renderReminderDashboard); // HTML dashboard
  app.get('/api/admin/reminders/search', searchClientReminders); // Search API
  app.get('/api/admin/reminders/errors', getRecentErrors); // Recent errors API

  // // Handle Gather result
  // app.post("/twilio/response", (req, res) => {
  //   const VoiceResponse = twilio.twiml.VoiceResponse;
  //   const twiml = new VoiceResponse();

  //   const digit = (req.body?.Digits || "").trim();
  //   if (digit === "1") {
  //     twiml.say("Great. See you in the meeting. Goodbye!");
  //   } else {
  //     twiml.say("Input received. Goodbye!");
  //   }
  //   res.status(200).type("text/xml").send(twiml.toString());
  // });

  // app.post('/sendReminderEmail', SendEmailReminder);
}

// LoginVerifier, LocalTokenValidator
// LoginVerifier, LocalTokenValidator
