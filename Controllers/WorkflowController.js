import { WorkflowModel } from '../Schema_Models/Workflow.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { WorkflowLogModel } from '../Schema_Models/WorkflowLog.js';
import { Logger } from '../Utils/Logger.js';
import sgMail from '@sendgrid/mail';
import watiService from '../Utils/WatiService.js';
import { DateTime } from 'luxon';
import { getRescheduleLinkForBooking } from '../Utils/CalendlyAPIHelper.js';
import { buildTemplateParameters } from '../Utils/TemplateParameterBuilder.js';
import { safeErrorDetails } from '../Utils/safeErrorDetails.js';
import { DesignedEmailTemplateModel } from '../Schema_Models/DesignedEmailTemplate.js';
import { applyEmailFooter } from '../Utils/EmailFooter.js';
import { isUnsubscribed } from '../Utils/Unsubscribe.js';
import { renderDesignedEmail, buildBookingTokens, unsubscribeAsm } from './DesignedEmailTemplateController.js';

function normalizePhoneForMatching(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/[\s\-\(\)]/g, '');
  if (cleaned.startsWith('+1') && cleaned.length >= 12) {
    return cleaned.slice(-10);
  } else if (cleaned.startsWith('1') && cleaned.length >= 11 && /^\d+$/.test(cleaned)) {
    return cleaned.slice(-10);
  } else if (cleaned.length >= 10 && /^\d+$/.test(cleaned)) {
    return cleaned.slice(-10);
  }
  const digitsOnly = cleaned.replace(/\D/g, '');
  return digitsOnly.length >= 10 ? digitsOnly.slice(-10) : null;
}

function getCountryCodeFromPhone(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/[\s\-\(\)]/g, '').trim();
  
  if (!cleaned.startsWith('+')) {
    return null;
  }
  
  if (cleaned.startsWith('+91')) {
    return 'IN';
  }
  
  if (cleaned.startsWith('+1')) {
    return 'US';
  }
  
  return null;
}

function filterByCountryCode(bookings, includeCountries) {
  if (!includeCountries || includeCountries.length === 0) return bookings;
  
  return bookings.filter(booking => {
    if (!booking.clientPhone) return false;
    
    const phone = String(booking.clientPhone).trim();
    if (!phone || !phone.startsWith('+')) return false;
    
    if (includeCountries.includes('IN') && phone.startsWith('+91')) {
      return true;
    }
    
    if (includeCountries.includes('US') && phone.startsWith('+1')) {
      return true;
    }
    
    return false;
  });
}

/**
 * Check if a client (by email or phone) has any booking with status 'paid'.
 * Used to prevent workflows from being sent to paid clients.
 * @param {string} clientEmail - Client email (optional)
 * @param {string} clientPhone - Client phone (optional)
 * @returns {Promise<boolean>} - True if client has any paid booking
 */
export async function clientHasPaidBooking(clientEmail, clientPhone) {
  if (!clientEmail && !clientPhone) return false;

  const conditions = [];
  if (clientEmail) {
    conditions.push({ clientEmail: String(clientEmail).trim().toLowerCase() });
  }
  if (clientPhone) {
    const norm = normalizePhoneForMatching(clientPhone);
    if (norm) {
      conditions.push({ normalizedClientPhone: norm });
    }
  }
  if (conditions.length === 0) return false;

  const paid = await CampaignBookingModel.exists({
    $or: conditions,
    bookingStatus: 'paid'
  });
  return !!paid;
}

const clientMatchConditions = (clientEmail, clientPhone) => {
  const conditions = [];
  if (clientEmail) conditions.push({ clientEmail: String(clientEmail).trim().toLowerCase() });
  const norm = clientPhone ? normalizePhoneForMatching(clientPhone) : null;
  if (norm) conditions.push({ normalizedClientPhone: norm });
  return conditions;
};

// A "you have not booked yet" nudge is wrong once the client holds a booking that is
// scheduled, rescheduled, completed or paid. Matching is by email OR phone, because
// the Calendly booking often arrives under a different email than the lead form.
const BOOKED_STATUSES = ['scheduled', 'rescheduled', 'completed', 'paid'];

/**
 * True if the client (email or phone) has a booking, other than excludeBookingId,
 * in a booked state. Used to stop not-scheduled workflows reaching clients who booked.
 */
export async function clientHasBookedElsewhere(clientEmail, clientPhone, excludeBookingId = null) {
  const conditions = clientMatchConditions(clientEmail, clientPhone);
  if (conditions.length === 0) return false;

  const query = { $or: conditions, bookingStatus: { $in: BOOKED_STATUSES } };
  if (excludeBookingId) query.bookingId = { $ne: excludeBookingId };
  return !!(await CampaignBookingModel.exists(query));
}

/**
 * Cancel pending not-scheduled workflows on every OTHER not-scheduled booking this
 * client holds. Called when a booking lands, so a lead-form record with a different
 * bookingId stops getting nudges the moment the client books.
 */
export async function cancelNotScheduledWorkflowsForClient(clientEmail, clientPhone, keepBookingId = null) {
  const conditions = clientMatchConditions(clientEmail, clientPhone);
  if (conditions.length === 0) return { cancelledBookings: 0 };

  const query = { $or: conditions, bookingStatus: 'not-scheduled' };
  if (keepBookingId) query.bookingId = { $ne: keepBookingId };
  const siblings = await CampaignBookingModel.find(query).select('bookingId').lean();

  for (const sibling of siblings) {
    await cancelScheduledWorkflows(sibling.bookingId, 'scheduled', 'not-scheduled');
  }
  return { cancelledBookings: siblings.length };
}

function deduplicateBookings(bookings) {
  const groupedMap = new Map();
  
  for (const booking of bookings) {
    if (!booking.clientEmail && !booking.clientPhone) continue;
    
    const normalizedEmail = booking.clientEmail ? booking.clientEmail.trim().toLowerCase() : null;
    const normalizedPhone = normalizePhoneForMatching(booking.clientPhone);
    const groupKey = normalizedPhone || normalizedEmail;
    
    if (!groupKey) continue;
    
    if (!groupedMap.has(groupKey)) {
      groupedMap.set(groupKey, booking);
    } else {
      const existing = groupedMap.get(groupKey);
      const existingEventTime = existing.scheduledEventStartTime ? new Date(existing.scheduledEventStartTime).getTime() : 0;
      const currentEventTime = booking.scheduledEventStartTime ? new Date(booking.scheduledEventStartTime).getTime() : 0;
      
      if (currentEventTime > existingEventTime) {
        groupedMap.set(groupKey, booking);
      } else if (currentEventTime === existingEventTime) {
        const existingTime = existing.bookingCreatedAt ? new Date(existing.bookingCreatedAt).getTime() : 0;
        const currentTime = booking.bookingCreatedAt ? new Date(booking.bookingCreatedAt).getTime() : 0;
        
        if (currentTime > existingTime) {
          groupedMap.set(groupKey, booking);
        }
      }
    }
  }
  
  return Array.from(groupedMap.values());
}


function getTimezoneAbbreviationFromIANA(timezone, meetingStart) {
  if (!timezone || !meetingStart) {
    return null;
  }

  try {
    const meetingStartUTC = DateTime.fromJSDate(new Date(meetingStart), { zone: 'utc' });
    const meetingInTimezone = meetingStartUTC.setZone(timezone);
    const offset = meetingInTimezone.offset / 60; // Offset in hours from UTC

    // Pacific — generic label, see normalizeTimezoneLabel()
    if (timezone.includes('Los_Angeles') || timezone.includes('Pacific')) {
      return 'PT';
    }
    
    // Eastern — generic label, see normalizeTimezoneLabel()
    if (timezone.includes('New_York') || timezone.includes('Eastern')) {
      return 'ET';
    }
    
    // Central — generic label, see normalizeTimezoneLabel()
    if (timezone.includes('Chicago') || timezone.includes('Central')) {
      return 'CT';
    }
    
    // Mountain — generic label, see normalizeTimezoneLabel()
    if (timezone.includes('Denver') || timezone.includes('Mountain')) {
      return 'MT';
    }

    // Default: try to determine from offset
    if (offset === -8 || offset === -7) return 'PT';
    if (offset === -5 || offset === -4) return 'ET';
    if (offset === -6 || offset === -5) return 'CT';
    if (offset === -7 || offset === -6) return 'MT';

    // Fallback: return generic abbreviation
    console.warn('⚠️ [WorkflowController] Unknown timezone, using offset-based fallback', {
      timezone,
      offset
    });
    return 'ET'; // Default fallback
  } catch (error) {
    console.warn('⚠️ [WorkflowController] Error converting timezone, defaulting to ET:', error.message);
    return 'ET';
  }
}

sgMail.setApiKey(process.env.SENDGRID_API_KEY_1 || process.env.SENDGRID_API_KEY);

// ==================== CREATE WORKFLOW ====================
export const createWorkflow = async (req, res) => {
  try {
    const { triggerAction, steps, name, description } = req.body;

    if (!triggerAction || !steps || !Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Trigger action and at least one step are required'
      });
    }

    const validActions = ['not-scheduled', 'no-show', 'complete', 'cancel', 're-schedule', 'paid', 'custom'];
    if (!validActions.includes(triggerAction)) {
      return res.status(400).json({
        success: false,
        message: `Invalid trigger action. Must be one of: ${validActions.join(', ')}`
      });
    }

    if (triggerAction === 'custom' && (!name || typeof name !== 'string' || name.trim() === '')) {
      return res.status(400).json({
        success: false,
        message: 'Template name is required for custom workflows'
      });
    }

    // Validate steps
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step.channel || !['email', 'whatsapp'].includes(step.channel)) {
        return res.status(400).json({
          success: false,
          message: `Step ${i + 1}: Invalid channel. Must be 'email' or 'whatsapp'`
        });
      }
      if (typeof step.daysAfter !== 'number' || step.daysAfter < 0) {
        return res.status(400).json({
          success: false,
          message: `Step ${i + 1}: daysAfter must be a non-negative number`
        });
      }
      if (step.hoursAfter !== undefined && (typeof step.hoursAfter !== 'number' || step.hoursAfter < 0 || step.hoursAfter > 23)) {
        return res.status(400).json({
          success: false,
          message: `Step ${i + 1}: hoursAfter must be a number between 0 and 23`
        });
      }
      if (!step.templateId || step.templateId.trim() === '') {
        return res.status(400).json({
          success: false,
          message: `Step ${i + 1}: templateId is required`
        });
      }
    }

    // Sort steps by order
    const sortedSteps = steps.map((step, index) => ({
      ...step,
      hoursAfter: step.hoursAfter || 0,
      order: step.order !== undefined ? step.order : index
    })).sort((a, b) => a.order - b.order);

    const isCustom = triggerAction === 'custom';
    const workflow = new WorkflowModel({
      triggerAction,
      steps: sortedSteps,
      name: name || null,
      description: description || null,
      isActive: true,
      isCustom: isCustom
    });

    await workflow.save();

    return res.status(201).json({
      success: true,
      message: 'Workflow created successfully',
      data: workflow
    });

  } catch (error) {
    console.error('Error creating workflow:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create workflow',
      error: error.message
    });
  }
};

// ==================== GET ALL WORKFLOWS ====================
export const getAllWorkflows = async (req, res) => {
  try {
    const { triggerAction, isActive, isCustom } = req.query;

    let query = {};
    if (triggerAction) query.triggerAction = triggerAction;
    if (isActive !== undefined) query.isActive = isActive === 'true';
    if (isCustom !== undefined) query.isCustom = isCustom === 'true';

    const workflows = await WorkflowModel.find(query)
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: workflows.length,
      data: workflows
    });

  } catch (error) {
    console.error('Error fetching workflows:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch workflows',
      error: error.message
    });
  }
};

// ==================== GET WORKFLOW BY ID ====================
export const getWorkflowById = async (req, res) => {
  try {
    const { workflowId } = req.params;

    const workflow = await WorkflowModel.findOne({ workflowId });

    if (!workflow) {
      return res.status(404).json({
        success: false,
        message: 'Workflow not found'
      });
    }

    return res.status(200).json({
      success: true,
      data: workflow
    });

  } catch (error) {
    console.error('Error fetching workflow:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch workflow',
      error: error.message
    });
  }
};

// ==================== UPDATE WORKFLOW ====================
export const updateWorkflow = async (req, res) => {
  try {
    const { workflowId } = req.params;
    const { triggerAction, steps, name, description, isActive } = req.body;

    const workflow = await WorkflowModel.findOne({ workflowId });

    if (!workflow) {
      return res.status(404).json({
        success: false,
        message: 'Workflow not found'
      });
    }

    // Validate triggerAction if provided
    if (triggerAction) {
      const validActions = ['not-scheduled', 'no-show', 'complete', 'cancel', 're-schedule', 'paid', 'custom'];
      if (!validActions.includes(triggerAction)) {
        return res.status(400).json({
          success: false,
          message: `Invalid trigger action. Must be one of: ${validActions.join(', ')}`
        });
      }
      workflow.triggerAction = triggerAction;
    }

    // Validate and update steps if provided
    if (steps && Array.isArray(steps)) {
      if (steps.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'At least one step is required'
        });
      }

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (!step.channel || !['email', 'whatsapp'].includes(step.channel)) {
          return res.status(400).json({
            success: false,
            message: `Step ${i + 1}: Invalid channel. Must be 'email' or 'whatsapp'`
          });
        }
        if (typeof step.daysAfter !== 'number' || step.daysAfter < 0) {
          return res.status(400).json({
            success: false,
            message: `Step ${i + 1}: daysAfter must be a non-negative number`
          });
        }
        if (step.hoursAfter !== undefined && (typeof step.hoursAfter !== 'number' || step.hoursAfter < 0 || step.hoursAfter > 23)) {
          return res.status(400).json({
            success: false,
            message: `Step ${i + 1}: hoursAfter must be a number between 0 and 23`
          });
        }
        if (!step.templateId || step.templateId.trim() === '') {
          return res.status(400).json({
            success: false,
            message: `Step ${i + 1}: templateId is required`
          });
        }
      }

      // Sort steps by order
      const sortedSteps = steps.map((step, index) => ({
        ...step,
        hoursAfter: step.hoursAfter || 0,
        order: step.order !== undefined ? step.order : index
      })).sort((a, b) => a.order - b.order);

      workflow.steps = sortedSteps;
    }

    if (name !== undefined) workflow.name = name || null;
    if (description !== undefined) workflow.description = description || null;
    if (isActive !== undefined) workflow.isActive = isActive;

    await workflow.save();

    return res.status(200).json({
      success: true,
      message: 'Workflow updated successfully',
      data: workflow
    });

  } catch (error) {
    console.error('Error updating workflow:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update workflow',
      error: error.message
    });
  }
};

// ==================== DELETE WORKFLOW ====================
export const deleteWorkflow = async (req, res) => {
  try {
    const { workflowId } = req.params;

    const workflow = await WorkflowModel.findOneAndDelete({ workflowId });

    if (!workflow) {
      return res.status(404).json({
        success: false,
        message: 'Workflow not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Workflow deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting workflow:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete workflow',
      error: error.message
    });
  }
};

// ==================== CUSTOM WORKFLOWS FOR BOOKING ====================
export const getCustomWorkflowsForBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const booking = await CampaignBookingModel.findOne({ bookingId }).lean();
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }
    const attachedIds = booking.attachedCustomWorkflowIds || [];
    if (attachedIds.length === 0) {
      return res.status(200).json({ success: true, data: { workflows: [], bookingId } });
    }
    const workflows = await WorkflowModel.find({
      workflowId: { $in: attachedIds },
      isCustom: true,
      isActive: true
    }).sort({ createdAt: -1 }).lean();
    return res.status(200).json({
      success: true,
      data: { workflows, bookingId }
    });
  } catch (error) {
    console.error('Error fetching custom workflows for booking:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch custom workflows',
      error: error.message
    });
  }
};

export const attachCustomWorkflowToBooking = async (req, res) => {
  try {
    const { bookingId, workflowId } = req.params;
    const booking = await CampaignBookingModel.findOne({ bookingId });
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }
    const workflow = await WorkflowModel.findOne({ workflowId, isCustom: true });
    if (!workflow) {
      return res.status(404).json({ success: false, message: 'Custom workflow not found' });
    }
    const attached = booking.attachedCustomWorkflowIds || [];
    if (attached.includes(workflowId)) {
      return res.status(200).json({
        success: true,
        message: 'Workflow already attached',
        data: { bookingId, workflowId }
      });
    }
    attached.push(workflowId);
    booking.attachedCustomWorkflowIds = attached;
    await booking.save();
    return res.status(200).json({
      success: true,
      message: 'Custom workflow attached to lead',
      data: { bookingId, workflowId }
    });
  } catch (error) {
    console.error('Error attaching custom workflow:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to attach custom workflow',
      error: error.message
    });
  }
};

export const detachCustomWorkflowFromBooking = async (req, res) => {
  try {
    const { bookingId, workflowId } = req.params;
    const booking = await CampaignBookingModel.findOne({ bookingId });
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }
    const attached = booking.attachedCustomWorkflowIds || [];
    booking.attachedCustomWorkflowIds = attached.filter((id) => id !== workflowId);
    await booking.save();
    return res.status(200).json({
      success: true,
      message: 'Custom workflow detached from lead',
      data: { bookingId, workflowId }
    });
  } catch (error) {
    console.error('Error detaching custom workflow:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to detach custom workflow',
      error: error.message
    });
  }
};

export const triggerCustomWorkflowForBooking = async (req, res) => {
  try {
    const { bookingId, workflowId } = req.params;
    const booking = await CampaignBookingModel.findOne({ bookingId }).lean();
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }
    if (booking.bookingStatus === 'paid' || booking.bookingStatus === 'ignored') {
      return res.status(400).json({
        success: false,
        message: 'Workflows are disabled for paid/ignored leads'
      });
    }
    const workflow = await WorkflowModel.findOne({ workflowId, isCustom: true, isActive: true }).lean();
    if (!workflow) {
      return res.status(404).json({ success: false, message: 'Custom workflow not found or inactive' });
    }
    const attached = booking.attachedCustomWorkflowIds || [];
    if (!attached.includes(workflowId)) {
      return res.status(400).json({
        success: false,
        message: 'This custom workflow is not attached to this lead'
      });
    }
    const results = {
      triggered: true,
      workflowsTriggered: [],
      errors: []
    };
    const { calculateScheduledDate } = await import('../Utils/cronScheduler.js');
    for (const step of workflow.steps) {
      try {
        const hoursAfter = step.hoursAfter || 0;
        if (step.daysAfter === 0 && hoursAfter === 0) {
          await executeWorkflowStep(step, booking, workflow.workflowId, workflow.name, 'custom');
          results.workflowsTriggered.push({
            workflowId: workflow.workflowId,
            workflowName: workflow.name,
            step,
            executed: true,
            executedAt: new Date()
          });
        } else {
          const executionDate = calculateScheduledDate(new Date(), step.daysAfter, step.channel, bookingId, hoursAfter);
          await scheduleWorkflowStep(bookingId, step, workflow.workflowId, executionDate, booking, workflow.name, 'custom');
          results.workflowsTriggered.push({
            workflowId: workflow.workflowId,
            workflowName: workflow.name,
            step,
            scheduled: true,
            scheduledFor: executionDate
          });
        }
      } catch (error) {
        console.error('Error processing custom workflow step:', error);
        await logWorkflowExecution({
          workflowId: workflow.workflowId,
          workflowName: workflow.name,
          triggerAction: 'custom',
          bookingId,
          booking,
          step,
          status: 'failed',
          error: error.message,
          scheduledFor: new Date()
        });
        results.errors.push({ step, error: error.message });
      }
    }
    return res.status(200).json({
      success: true,
      message: 'Custom workflow triggered',
      data: results
    });
  } catch (error) {
    console.error('Error triggering custom workflow:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to trigger custom workflow',
      error: error.message
    });
  }
};

// ==================== CHECK IF WORKFLOWS NEED PLAN DETAILS ====================
export const checkWorkflowsNeedPlanDetails = async (req, res) => {
  try {
    const { action } = req.query; // 'completed', 'canceled', etc.

    if (!action) {
      return res.status(400).json({
        success: false,
        message: 'Action is required'
      });
    }

    const actionMap = {
      'not-scheduled': 'not-scheduled',
      'no-show': 'no-show',
      'completed': 'complete',
      'canceled': 'cancel',
      'rescheduled': 're-schedule',
      'paid': 'paid'
    };

    const triggerAction = actionMap[action];
    if (!triggerAction) {
      return res.status(400).json({
        success: false,
        message: `Invalid action. Must be one of: ${Object.keys(actionMap).join(', ')}`
      });
    }

    // Find active workflows for this action
    const workflows = await WorkflowModel.find({
      triggerAction,
      isActive: true
    }).lean();

    // Check if any workflow has finalkk or plan_followup_utility_01dd template
    let hasPlanDetailsTemplate = false;
    for (const workflow of workflows) {
      for (const step of workflow.steps) {
        if (step.channel === 'whatsapp') {
          const templateName = step.templateName || step.templateId;
          if (templateName === 'finalkk' || step.templateId === 'finalkk' || 
              templateName === 'plan_followup_utility_01dd' || step.templateId === 'plan_followup_utility_01dd') {
            hasPlanDetailsTemplate = true;
            break;
          }
        }
      }
      if (hasPlanDetailsTemplate) break;
    }

    return res.status(200).json({
      success: true,
      needsPlanDetails: hasPlanDetailsTemplate,
      workflowsCount: workflows.length
    });

  } catch (error) {
    console.error('Error checking workflows for plan details:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to check workflows',
      error: error.message
    });
  }
};

// ==================== TRIGGER WORKFLOW ====================
export const triggerWorkflow = async (bookingId, action) => {
  try {
    // Map action to triggerAction format
    const actionMap = {
      'not-scheduled': 'not-scheduled',
      'no-show': 'no-show',
      'completed': 'complete',
      'canceled': 'cancel',
      'rescheduled': 're-schedule',
      'paid': 'paid'
    };

    const triggerAction = actionMap[action];
    if (!triggerAction) {
      console.log(`⚠️ No workflow trigger for action: ${action}`);
      return { success: false, message: `No workflow trigger for action: ${action}` };
    }

    // Find active workflows for this action
    const workflows = await WorkflowModel.find({
      triggerAction,
      isActive: true
    }).lean();

    if (workflows.length === 0) {
      console.log(`ℹ️ No active workflows found for action: ${triggerAction}`);
      return { success: true, triggered: false, message: 'No workflows to trigger' };
    }

    // Get booking details
    const booking = await CampaignBookingModel.findOne({ bookingId }).lean();
    if (!booking) {
      return { success: false, message: 'Booking not found' };
    }

    // STRICT: Never send workflows to paid/ignored clients
    if (booking.bookingStatus === 'paid' || booking.bookingStatus === 'ignored') {
      Logger.info('Skipping workflow trigger: booking is paid/ignored', { bookingId, clientEmail: booking.clientEmail });
      return { success: true, triggered: false, message: 'Paid/ignored clients do not receive workflows' };
    }
    const hasPaid = await clientHasPaidBooking(booking.clientEmail, booking.clientPhone);
    if (hasPaid) {
      Logger.info('Skipping workflow trigger: client has paid booking elsewhere', { bookingId, clientEmail: booking.clientEmail });
      return { success: true, triggered: false, message: 'Paid clients do not receive workflows' };
    }

    const results = {
      triggered: true,
      workflowsTriggered: [],
      errors: []
    };

    const { calculateScheduledDate } = await import('../Utils/cronScheduler.js');

    for (const workflow of workflows) {
      for (const step of workflow.steps) {
        try {
          const stepHoursAfter = step.hoursAfter || 0;
          if (step.daysAfter === 0 && stepHoursAfter === 0) {
            await executeWorkflowStep(step, booking, workflow.workflowId, workflow.name, triggerAction);
            results.workflowsTriggered.push({
              workflowId: workflow.workflowId,
              workflowName: workflow.name,
              step: step,
              executed: true,
              executedAt: new Date()
            });
          } else {
            // Use channel-specific timing for workflows (or exact time if hoursAfter > 0)
            const executionDate = calculateScheduledDate(new Date(), step.daysAfter, step.channel, bookingId, stepHoursAfter);
            await scheduleWorkflowStep(bookingId, step, workflow.workflowId, executionDate, booking, workflow.name, triggerAction);
            results.workflowsTriggered.push({
              workflowId: workflow.workflowId,
              workflowName: workflow.name,
              step: step,
              scheduled: true,
              scheduledFor: executionDate
            });
          }
        } catch (error) {
          console.error(`Error processing workflow step:`, error);
          // Log failed execution
          await logWorkflowExecution({
            workflowId: workflow.workflowId,
            workflowName: workflow.name,
            triggerAction,
            bookingId,
            booking,
            step,
            status: 'failed',
            error: error.message,
            scheduledFor: new Date()
          });
          results.errors.push({
            workflowId: workflow.workflowId,
            step: step,
            error: error.message
          });
        }
      }
    }

    return { success: true, ...results };

  } catch (error) {
    console.error('Error triggering workflow:', error);
    return { success: false, error: error.message };
  }
};


/**
 * Cancel all scheduled WorkflowLog entries for a booking (e.g. when status changes to paid).
 * The cron processes WorkflowLog with status 'scheduled' - we must cancel those to prevent execution.
 */
export const cancelScheduledWorkflowLogsForBooking = async (bookingId, reason = 'Booking status changed to paid') => {
  try {
    const result = await WorkflowLogModel.updateMany(
      { bookingId, status: 'scheduled' },
      { $set: { status: 'cancelled', error: reason, executedAt: null } }
    );
    if (result.modifiedCount > 0) {
      Logger.info('Cancelled scheduled workflow logs for paid booking', {
        bookingId,
        cancelledCount: result.modifiedCount,
        reason
      });
    }
    return { success: true, cancelled: result.modifiedCount };
  } catch (error) {
    Logger.error('Error cancelling scheduled workflow logs', { bookingId, error: error.message });
    return { success: false, cancelled: 0, error: error.message };
  }
};

export const cancelScheduledWorkflows = async (bookingId, newStatus, oldStatus = null) => {
  try {
    // Statuses that should cancel all scheduled workflows
    // Cancel workflows when moving to these statuses from workflow-triggering statuses (like 'no-show')
    // This prevents old workflows from executing for the wrong status
    const cancelTriggerStatuses = ['completed', 'paid', 'canceled', 'scheduled', 'rescheduled', 'not-scheduled', 'ignored'];
    
    if (!cancelTriggerStatuses.includes(newStatus)) {
      return { success: true, cancelled: 0, message: 'Status does not require workflow cancellation' };
    }

    // Get booking with scheduled workflows
    const booking = await CampaignBookingModel.findOne({ bookingId });
    if (!booking) {
      return { success: false, error: 'Booking not found' };
    }

    // Find all scheduled (not executed, failed, or already cancelled) workflows
    const scheduledWorkflows = (booking.scheduledWorkflows || []).filter(
      sw => sw.status === 'scheduled'
    );

    const cancellationReason = `Status changed to ${newStatus}`;
    const cancelledWorkflows = [];

    // Cancel each scheduled workflow
    for (const scheduledWorkflow of scheduledWorkflows) {
      try {
        // Update workflow status to cancelled
        await CampaignBookingModel.updateOne(
          { bookingId, 'scheduledWorkflows._id': scheduledWorkflow._id },
          { 
            $set: { 
              'scheduledWorkflows.$.status': 'cancelled',
              'scheduledWorkflows.$.error': cancellationReason
            } 
          }
        );

        // Log cancellation in workflow logs
        await logWorkflowExecution({
          workflowId: scheduledWorkflow.workflowId,
          workflowName: null, // We don't have workflow name here, but that's okay
          triggerAction: null, // Original trigger action is not stored in scheduledWorkflow
          bookingId,
          booking: {
            clientEmail: booking.clientEmail,
            clientName: booking.clientName,
            clientPhone: booking.clientPhone
          },
          step: scheduledWorkflow.step,
          status: 'cancelled', // Use 'cancelled' status for cancelled workflows in logs
          scheduledFor: scheduledWorkflow.scheduledFor,
          executedAt: null,
          error: cancellationReason,
          cancellationReason: cancellationReason
        });

        cancelledWorkflows.push({
          workflowId: scheduledWorkflow.workflowId,
          step: scheduledWorkflow.step,
          scheduledFor: scheduledWorkflow.scheduledFor,
          cancelledAt: new Date()
        });

        console.log(`✅ Cancelled scheduled workflow for booking ${bookingId}:`, {
          workflowId: scheduledWorkflow.workflowId,
          daysAfter: scheduledWorkflow.step.daysAfter,
          scheduledFor: scheduledWorkflow.scheduledFor,
          reason: cancellationReason
        });

      } catch (workflowError) {
        console.error(`Error cancelling workflow ${scheduledWorkflow.workflowId}:`, workflowError);
        // Continue with other workflows even if one fails
      }
    }

    // Also cancel the actual WorkflowLog rows (the cron reads from this collection,
    // not from booking.scheduledWorkflows). Without this, embedded array is updated
    // but the cron still fires the not-scheduled / old-status logs.
    let cancelledLogs = 0;
    try {
      const logResult = await WorkflowLogModel.updateMany(
        { bookingId, status: 'scheduled' },
        { $set: { status: 'cancelled', error: cancellationReason, executedAt: null } }
      );
      cancelledLogs = logResult.modifiedCount || 0;
    } catch (logCancelErr) {
      Logger.error('Failed to cancel WorkflowLog rows during status change', {
        bookingId, newStatus, error: logCancelErr.message
      });
    }

    Logger.info('Cancelled scheduled workflows due to status change', {
      bookingId,
      oldStatus,
      newStatus,
      cancelledCount: cancelledWorkflows.length,
      cancelledLogCount: cancelledLogs,
      clientEmail: booking.clientEmail
    });

    return {
      success: true,
      cancelled: cancelledWorkflows.length,
      cancelledLogs,
      workflows: cancelledWorkflows,
      message: `Cancelled ${cancelledWorkflows.length} scheduled workflow(s) and ${cancelledLogs} log(s)`
    };

  } catch (error) {
    console.error('Error cancelling scheduled workflows:', error);
    Logger.error('Error cancelling scheduled workflows', {
      bookingId,
      newStatus,
      error: error.message,
      stack: error.stack
    });
    return { success: false, error: error.message };
  }
};

// ==================== EXECUTE WORKFLOW STEP ====================
async function executeWorkflowStep(step, booking, workflowId, workflowName = null, triggerAction = null) {
  let responseData = null;
  const executedAt = new Date();
  
  try {
    if (step.channel === 'email') {
      if (!booking.clientEmail) {
        throw new Error('Client email not available');
      }
      if (await isUnsubscribed(booking.clientEmail)) throw new Error('Recipient unsubscribed');
      const domainName = step.domainName || 'flashfiremails.com';

      let senderEmail;
      if (step.senderEmail) {
        senderEmail = step.senderEmail;
      } else {
        senderEmail = process.env.SENDER_EMAIL || process.env.SENDGRID_FROM_EMAIL || 'elizabeth@flashfirehq.com';
      }

      if (!senderEmail) {
        throw new Error('Sender email not configured');
      }

      // A templateId that is NOT a SendGrid dynamic-template id (d-xxxx) is the
      // Mongo _id of an in-dashboard DesignedEmailTemplate. Render + send its HTML.
      const isDesigned = !!step.templateId && !/^d-/i.test(String(step.templateId).trim());

      let msg;
      if (isDesigned) {
        const tpl = await DesignedEmailTemplateModel.findById(step.templateId).lean();
        if (!tpl) throw new Error(`Designed template not found: ${step.templateId}`);
        const { subject, html, from } = renderDesignedEmail(tpl, buildBookingTokens(booking));
        // Honour a per-step sender override if one was configured.
        const sendFrom = step.senderEmail ? { email: step.senderEmail, name: from.name } : from;
        msg = { to: booking.clientEmail, from: sendFrom, subject, html, ...unsubscribeAsm() };
      } else {
        msg = {
          to: booking.clientEmail,
          from: senderEmail,
          templateId: step.templateId,
          dynamicTemplateData: {
            domain: domainName,
            clientName: booking.clientName,
            bookingId: booking.bookingId
          }
        };
      }

      applyEmailFooter(msg, booking, { designed: isDesigned, triggerAction });
      const result = await sgMail.send(msg);
      responseData = { statusCode: result[0]?.statusCode, messageId: result[0]?.headers?.['x-message-id'] };
      console.log(`✅ Email sent via workflow ${workflowId} to ${booking.clientEmail} (${isDesigned ? 'designed' : 'sendgrid'} template)`);

      // Log successful execution
      await logWorkflowExecution({
        workflowId,
        workflowName,
        triggerAction,
        bookingId: booking.bookingId,
        booking,
        step,
        status: 'executed',
        executedAt,
        responseData
      });

    } else if (step.channel === 'whatsapp') {
      // Send WhatsApp via WATI
      if (!booking.clientPhone) {
        throw new Error('Client phone number not available');
      }

      // Resolve the actual WATI template name from ID if templateName is missing
      let resolvedTemplateName = step.templateName;
      if (!resolvedTemplateName && step.templateId) {
        try {
          resolvedTemplateName = await watiService.resolveTemplateName(null, step.templateId);
          console.log(`[WorkflowController] Resolved template ID ${step.templateId} → name: ${resolvedTemplateName}`);
        } catch (resolveErr) {
          console.warn(`[WorkflowController] Could not resolve template ID:`, resolveErr.message);
          resolvedTemplateName = step.templateId;
        }
      }

      const parameters = await buildTemplateParameters(resolvedTemplateName || step.templateId, { booking, step, executedAt });

      const watiTemplateName = resolvedTemplateName;
      const watiTemplateId = step.templateId;
      
      const result = await watiService.sendTemplateMessage({
        mobileNumber: booking.clientPhone,
        templateName: watiTemplateName,
        templateId: watiTemplateId,
        parameters: parameters,
        campaignId: `workflow_${workflowId}_${Date.now()}`
      });

      if (!result.success) {
        const errorDetails = result.watiResponse ? JSON.stringify(result.watiResponse, null, 2) : '';
        const errorMessage = result.error || 'Failed to send WhatsApp message';
        const fullError = errorDetails ? `${errorMessage}\nWATI Response: ${errorDetails}` : errorMessage;
        
        console.error(`❌ [WorkflowController] WhatsApp send failed for workflow ${workflowId}:`, {
          bookingId: booking.bookingId,
          clientPhone: booking.clientPhone,
          templateName: watiTemplateName,
          templateId: watiTemplateId,
          parameters: parameters,
          error: errorMessage,
          watiResponse: result.watiResponse
        });
        
        throw new Error(fullError);
      }

      responseData = result.data;
      console.log(`✅ WhatsApp sent via workflow ${workflowId} to ${booking.clientPhone}`);

      // Log successful execution
      await logWorkflowExecution({
        workflowId,
        workflowName,
        triggerAction,
        bookingId: booking.bookingId,
        booking,
        step,
        status: 'executed',
        executedAt,
        responseData
      });
    }

    return { success: true, responseData };

  } catch (error) {
    console.error('Error executing workflow step:', error);
    
    // Log failed execution
    await logWorkflowExecution({
      workflowId,
      workflowName,
      triggerAction,
      bookingId: booking.bookingId,
      booking,
      step,
      status: 'failed',
      executedAt,
      error: error.message,
      errorDetails: safeErrorDetails(error)
    });
    
    throw error;
  }
}

// ==================== SCHEDULE WORKFLOW STEP ====================
async function scheduleWorkflowStep(bookingId, step, workflowId, executionDate, booking, workflowName = null, triggerAction = null) {
  try {
    // Store scheduled workflow execution in booking document
    // We'll add a field to track scheduled workflows
    // Always fetch the booking document (not lean) so we can save it
    let bookingDoc = await CampaignBookingModel.findOne({ bookingId });
    if (!bookingDoc) {
      throw new Error('Booking not found');
    }

    // Initialize scheduledWorkflows array if it doesn't exist
    if (!bookingDoc.scheduledWorkflows) {
      bookingDoc.scheduledWorkflows = [];
    }

    // Add scheduled workflow step
    bookingDoc.scheduledWorkflows.push({
      workflowId,
      step,
      scheduledFor: executionDate,
      status: 'scheduled',
      createdAt: new Date()
    });

    await bookingDoc.save();

    // Log scheduled execution
    await logWorkflowExecution({
      workflowId,
      workflowName,
      triggerAction,
      bookingId,
      booking,
      step,
      status: 'scheduled',
      scheduledFor: executionDate
    });

    console.log(`📅 Scheduled workflow step for booking ${bookingId} at ${executionDate}`);

    return { success: true };

  } catch (error) {
    console.error('Error scheduling workflow step:', error);
    throw error;
  }
}

// ==================== LOG WORKFLOW EXECUTION ====================
async function logWorkflowExecution({ workflowId, workflowName, triggerAction, bookingId, booking, step, status, scheduledFor, executedAt = null, error = null, errorDetails = null, responseData = null, cancellationReason = null }) {
  try {
    // Generate idempotency key for scheduled workflows to prevent duplicates
    const idempotencyKey = status === 'scheduled'
      ? `${bookingId}_${workflowId}_${step.templateId || step.templateName}_${step.daysAfter}_${step.hoursAfter || 0}`
      : undefined;

    const logData = {
      workflowId,
      workflowName: workflowName || null,
      triggerAction: triggerAction || null,
      bookingId,
      clientEmail: booking.clientEmail,
      clientName: booking.clientName || null,
      clientPhone: booking.clientPhone || null,
      step: {
        channel: step.channel,
        daysAfter: step.daysAfter,
        hoursAfter: step.hoursAfter || 0,
        templateId: step.templateId,
        templateName: step.templateName || null,
        domainName: step.domainName || null,
        senderEmail: step.senderEmail || null,
        order: step.order || 0,
        templateConfig: step.templateConfig || null
      },
      status,
      scheduledFor: scheduledFor || executedAt || new Date(),
      executedAt: executedAt || null,
      error: error || cancellationReason || null,
      errorDetails: errorDetails || null,
      responseData: responseData || null
    };

    if (idempotencyKey) {
      // Use findOneAndUpdate with upsert to deduplicate scheduled entries
      const existing = await WorkflowLogModel.findOneAndUpdate(
        { idempotencyKey },
        { $setOnInsert: { ...logData, idempotencyKey } },
        { upsert: true, returnDocument: 'after' }
      );
      return existing;
    }

    const log = new WorkflowLogModel(logData);
    await log.save();
    return log;
  } catch (error) {
    // Handle duplicate key error gracefully (idempotency working as expected)
    if (error.code === 11000 && error.keyPattern?.idempotencyKey) {
      console.log(`[WorkflowController] Duplicate workflow log prevented (idempotency key exists) for booking ${bookingId}`);
      return null;
    }
    console.error('Error logging workflow execution:', error);
    // Don't throw - logging errors shouldn't break workflow execution
    return null;
  }
}

// ==================== PROCESS SCHEDULED WORKFLOWS ====================
export const processScheduledWorkflows = async () => {
  try {
    const now = new Date();
    
    // Find bookings with scheduled workflows that are due (exclude cancelled)
    const bookings = await CampaignBookingModel.find({
      'scheduledWorkflows.status': 'scheduled',
      'scheduledWorkflows.scheduledFor': { $lte: now }
    }).lean();

    console.log(`🔍 Found ${bookings.length} bookings with due workflow steps`);

    for (const booking of bookings) {
      for (const scheduledWorkflow of booking.scheduledWorkflows || []) {
        // Skip cancelled workflows
        if (scheduledWorkflow.status === 'cancelled') {
          continue;
        }
        
        if (scheduledWorkflow.status === 'scheduled' && 
            new Date(scheduledWorkflow.scheduledFor) <= now) {
          try {
            // STRICT: Skip paid/ignored clients - never execute workflows for them
            if (booking.bookingStatus === 'paid' || booking.bookingStatus === 'ignored') {
              await CampaignBookingModel.updateOne(
                { bookingId: booking.bookingId, 'scheduledWorkflows._id': scheduledWorkflow._id },
                { $set: { 'scheduledWorkflows.$.status': 'cancelled', 'scheduledWorkflows.$.error': 'Skipped: Client is paid/ignored' } }
              );
              continue;
            }
            const hasPaid = await clientHasPaidBooking(booking.clientEmail, booking.clientPhone);
            if (hasPaid) {
              await CampaignBookingModel.updateOne(
                { bookingId: booking.bookingId, 'scheduledWorkflows._id': scheduledWorkflow._id },
                { $set: { 'scheduledWorkflows.$.status': 'cancelled', 'scheduledWorkflows.$.error': 'Skipped: Client has paid booking' } }
              );
              continue;
            }
            // Get workflow details for logging
            const workflow = await WorkflowModel.findOne({ workflowId: scheduledWorkflow.workflowId }).lean();
            
            await executeWorkflowStep(
              scheduledWorkflow.step,
              booking,
              scheduledWorkflow.workflowId,
              workflow?.name || null,
              workflow?.triggerAction || null
            );

            // Update status to executed
            await CampaignBookingModel.updateOne(
              { bookingId: booking.bookingId, 'scheduledWorkflows._id': scheduledWorkflow._id },
              { $set: { 'scheduledWorkflows.$.status': 'executed', 'scheduledWorkflows.$.executedAt': new Date() } }
            );

            console.log(`✅ Executed scheduled workflow step for booking ${booking.bookingId}`);
          } catch (error) {
            console.error(`❌ Error executing scheduled workflow for booking ${booking.bookingId}:`, error);
            
            // Update status to failed
            await CampaignBookingModel.updateOne(
              { bookingId: booking.bookingId, 'scheduledWorkflows._id': scheduledWorkflow._id },
              { $set: { 'scheduledWorkflows.$.status': 'failed', 'scheduledWorkflows.$.error': error.message } }
            );
          }
        }
      }
    }

    return { success: true, processed: bookings.length };

  } catch (error) {
    console.error('Error processing scheduled workflows:', error);
    return { success: false, error: error.message };
  }
};

export const getBookingsByStatusForBulk = async (req, res) => {
  try {
    const { status, includeCountries } = req.query;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: 'Status is required'
      });
    }

    const statusMap = {
      'not-scheduled': 'not-scheduled',
      'no-show': 'no-show',
      'completed': 'completed',
      'canceled': 'canceled',
      'rescheduled': 'rescheduled',
      'paid': 'paid'
    };

    const dbStatus = statusMap[status];
    if (!dbStatus) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${Object.keys(statusMap).join(', ')}`
      });
    }

    let includeCountryCodes = [];
    if (includeCountries) {
      try {
        includeCountryCodes = JSON.parse(includeCountries);
      } catch (e) {
        includeCountryCodes = Array.isArray(includeCountries) ? includeCountries : [];
      }
    }

    // For not-scheduled status, include leads without scheduledEventStartTime (meta leads)
    const baseQuery = dbStatus === 'not-scheduled'
      ? { $or: [
          { scheduledEventStartTime: { $exists: true, $ne: null } },
          { leadSource: 'meta_lead_ad' },
          { bookingStatus: 'not-scheduled' }
        ]}
      : { scheduledEventStartTime: { $exists: true, $ne: null } };

    const allBookings = await CampaignBookingModel.find(baseQuery)
      .select('bookingId clientEmail clientName clientPhone bookingStatus scheduledEventStartTime scheduledWorkflows bookingCreatedAt')
      .sort({ scheduledEventStartTime: -1, bookingCreatedAt: -1 })
      .lean();

    const groupedMap = new Map();
    
    for (const booking of allBookings) {
      const normalizedPhone = normalizePhoneForMatching(booking.clientPhone);
      const groupKey = normalizedPhone || booking.clientEmail;
      
      if (!groupedMap.has(groupKey)) {
        groupedMap.set(groupKey, {
          booking: booking,
          totalBookings: 1,
          hasPaid: booking.bookingStatus === 'paid'
        });
      } else {
        const existing = groupedMap.get(groupKey);
        existing.totalBookings += 1;
        
        const existingIsPaid = existing.booking.bookingStatus === 'paid';
        const currentIsPaid = booking.bookingStatus === 'paid';
        
        if (currentIsPaid && !existingIsPaid) {
          existing.booking = booking;
          existing.hasPaid = true;
        } else if (!currentIsPaid && existingIsPaid) {
        } else {
          const existingEventTime = existing.booking.scheduledEventStartTime ? new Date(existing.booking.scheduledEventStartTime).getTime() : 0;
          const currentEventTime = booking.scheduledEventStartTime ? new Date(booking.scheduledEventStartTime).getTime() : 0;
          
          if (currentEventTime > existingEventTime) {
            existing.booking = booking;
          } else if (currentEventTime === existingEventTime) {
            const existingTime = existing.booking.bookingCreatedAt ? new Date(existing.booking.bookingCreatedAt).getTime() : 0;
            const currentTime = booking.bookingCreatedAt ? new Date(booking.bookingCreatedAt).getTime() : 0;
            
            if (currentTime > existingTime) {
              existing.booking = booking;
            }
          }
        }
      }
    }

    let uniqueBookings = Array.from(groupedMap.values()).map(item => item.booking);
    
    uniqueBookings = uniqueBookings.filter(booking => booking.bookingStatus === dbStatus);

    let filteredBookings = uniqueBookings;
    if (includeCountryCodes.length > 0) {
      filteredBookings = filterByCountryCode(uniqueBookings, includeCountryCodes);
    }

    const bookingsWithWorkflowCheck = filteredBookings.map(booking => {
      const hasScheduledWorkflows = booking.scheduledWorkflows && 
        booking.scheduledWorkflows.some(sw => sw.status === 'scheduled');
      
      return {
        bookingId: booking.bookingId,
        clientEmail: booking.clientEmail,
        clientName: booking.clientName,
        clientPhone: booking.clientPhone,
        bookingStatus: booking.bookingStatus,
        scheduledEventStartTime: booking.scheduledEventStartTime,
        hasScheduledWorkflows: hasScheduledWorkflows,
        scheduledWorkflowsCount: booking.scheduledWorkflows?.filter(sw => sw.status === 'scheduled').length || 0
      };
    });

    const total = bookingsWithWorkflowCheck.length;
    const withWorkflows = bookingsWithWorkflowCheck.filter(b => b.hasScheduledWorkflows).length;
    const withoutWorkflows = total - withWorkflows;

    return res.status(200).json({
      success: true,
      data: {
        bookings: bookingsWithWorkflowCheck,
        summary: {
          total,
          withScheduledWorkflows: withWorkflows,
          withoutScheduledWorkflows: withoutWorkflows
        }
      }
    });

  } catch (error) {
    console.error('Error fetching bookings by status:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch bookings',
      error: error.message
    });
  }
};

export const resendAllFailedWhatsApp = async (req, res) => {
  try {
    const { status } = req.body || {};

    const statusMap = {
      'not-scheduled': 'not-scheduled',
      'no-show': 'no-show',
      'completed': 'completed',
      'canceled': 'canceled',
      'rescheduled': 'rescheduled',
      'paid': 'paid'
    };

    if (!status || !statusMap[status]) {
      return res.status(400).json({
        success: false,
        message: 'Valid status is required (not-scheduled, no-show, completed, canceled, rescheduled, paid)'
      });
    }

    const targetBookingStatus = statusMap[status];

    const failedLogs = await WorkflowLogModel.find({
      status: 'failed',
      'step.channel': 'whatsapp'
    })
      .sort({ createdAt: -1 })
      .lean();

    if (failedLogs.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No failed WhatsApp workflow logs found',
        data: {
          total: 0,
          resent: 0,
          deleted: 0,
          errors: []
        }
      });
    }

    const results = {
      total: failedLogs.length,
      resent: 0,
      deleted: 0,
      errors: []
    };

    const bookingCache = new Map();
    const workflowCache = new Map();
    // Dedupe key to avoid sending multiple WhatsApps to the same client
    // for the same workflow step (bookingId + templateId + daysAfter)
    const dedupeKeys = new Set();

    for (const log of failedLogs) {
      try {
        let booking = bookingCache.get(log.bookingId);
        if (!booking) {
          booking = await CampaignBookingModel.findOne({ bookingId: log.bookingId }).lean();
          if (!booking) {
            results.errors.push({
              logId: log.logId,
              bookingId: log.bookingId,
              error: 'Booking not found'
            });
            continue;
          }
          bookingCache.set(log.bookingId, booking);
        }

        // Skip and delete logs where the booking's current status no longer matches
        // the status selected in the CRM ("Send to All Failed WhatsApp").
        if (booking.bookingStatus !== targetBookingStatus) {
          await WorkflowLogModel.deleteOne({ logId: log.logId });
          results.deleted++;
          continue;
        }

        if (!booking.clientPhone) {
          results.errors.push({
            logId: log.logId,
            bookingId: log.bookingId,
            error: 'Client phone number not available'
          });
          continue;
        }

        const existingSuccess = await WorkflowLogModel.findOne({
          bookingId: log.bookingId,
          workflowId: log.workflowId,
          'step.channel': 'whatsapp',
          'step.templateId': log.step.templateId,
          'step.daysAfter': log.step.daysAfter,
          'step.hoursAfter': log.step.hoursAfter || 0,
          status: 'executed'
        }).lean();

        if (existingSuccess) {
          await WorkflowLogModel.deleteOne({ logId: log.logId });
          results.deleted++;
          continue;
        }

        // Dedupe: if we've already re-scheduled this exact client/template/day,
        // don't schedule another message – just delete the extra failed log.
        const dedupeKey = `${log.bookingId || booking.bookingId}_${log.step.templateId || ''}_${log.step.daysAfter || 0}_${log.step.hoursAfter || 0}`;
        if (dedupeKeys.has(dedupeKey)) {
          await WorkflowLogModel.deleteOne({ logId: log.logId });
          results.deleted++;
          continue;
        }

        let workflow = workflowCache.get(log.workflowId);
        if (!workflow) {
          workflow = await WorkflowModel.findOne({ workflowId: log.workflowId }).lean();
          if (!workflow) {
            results.errors.push({
              logId: log.logId,
              bookingId: log.bookingId,
              error: 'Workflow not found'
            });
            continue;
          }
          workflowCache.set(log.workflowId, workflow);
        }

        const step = workflow.steps.find(s =>
          s.channel === log.step.channel &&
          s.templateId === log.step.templateId &&
          s.daysAfter === log.step.daysAfter &&
          (s.hoursAfter || 0) === (log.step.hoursAfter || 0)
        );

        if (!step) {
          results.errors.push({
            logId: log.logId,
            bookingId: log.bookingId,
            error: 'Workflow step not found'
          });
          continue;
        }

        const stepWithConfig = {
          ...step,
          templateName: step.templateName || step.templateId || log.step.templateName || log.step.templateId,
          templateConfig: step.templateConfig || {}
        };

        try {
          const originalScheduledFor = log.scheduledFor ? new Date(log.scheduledFor) : null;
          const now = new Date();

          // Always (re)schedule via the workflow scheduler rather than sending immediately.
          // If the original scheduled time is still in the future, keep it.
          // Otherwise, schedule a new send a few minutes from now.
          const scheduledFor =
            originalScheduledFor && originalScheduledFor > now
              ? originalScheduledFor
              : new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes from now

          await scheduleWorkflowStep(
            log.bookingId,
            stepWithConfig,
            log.workflowId,
            scheduledFor,
            booking,
            log.workflowName || workflow.name,
            log.triggerAction
          );

          // Mark this combination as processed to avoid duplicate sends
          const dedupeKey = `${log.bookingId || booking.bookingId}_${log.step.templateId || ''}_${log.step.daysAfter || 0}_${log.step.hoursAfter || 0}`;
          dedupeKeys.add(dedupeKey);

          await WorkflowLogModel.deleteOne({ logId: log.logId });
          results.resent++;
          results.deleted++;
        } catch (stepError) {
          console.error(`Error executing workflow step for log ${log.logId}:`, stepError);
          results.errors.push({
            logId: log.logId,
            bookingId: log.bookingId,
            error: stepError.message || 'Failed to resend'
          });
        }
      } catch (error) {
        console.error(`Error resending failed WhatsApp log ${log.logId}:`, error);
        results.errors.push({
          logId: log.logId,
          bookingId: log.bookingId,
          error: error.message
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: `Resent ${results.resent} failed WhatsApp workflow(s), deleted ${results.deleted} old record(s)`,
      data: results
    });

  } catch (error) {
    console.error('Error resending all failed WhatsApp workflows:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to resend failed WhatsApp workflows',
      error: error.message
    });
  }
};

export const triggerWorkflowsForAllByStatus = async (req, res) => {
  try {
    const { status, skipExisting = true, includeCountries = [] } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: 'Status is required'
      });
    }

    const statusMap = {
      'not-scheduled': { dbStatus: 'not-scheduled', action: 'not-scheduled' },
      'no-show': { dbStatus: 'no-show', action: 'no-show' },
      'completed': { dbStatus: 'completed', action: 'completed' },
      'canceled': { dbStatus: 'canceled', action: 'canceled' },
      'rescheduled': { dbStatus: 'rescheduled', action: 'rescheduled' },
      'paid': { dbStatus: 'paid', action: 'paid' }
    };

    const statusInfo = statusMap[status];
    if (!statusInfo) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${Object.keys(statusMap).join(', ')}`
      });
    }

    // For not-scheduled status, include leads without scheduledEventStartTime (meta leads)
    const baseQuery = statusInfo.dbStatus === 'not-scheduled'
      ? { $or: [
          { scheduledEventStartTime: { $exists: true, $ne: null } },
          { leadSource: 'meta_lead_ad' },
          { bookingStatus: 'not-scheduled' }
        ]}
      : { scheduledEventStartTime: { $exists: true, $ne: null } };

    const allBookings = await CampaignBookingModel.find(baseQuery)
      .select('bookingId clientEmail clientName clientPhone bookingStatus scheduledEventStartTime scheduledWorkflows bookingCreatedAt')
      .sort({ scheduledEventStartTime: -1, bookingCreatedAt: -1 })
      .lean();

    if (allBookings.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No bookings found',
        data: {
          total: 0,
          processed: 0,
          skipped: 0,
          errors: []
        }
      });
    }

    const groupedMap = new Map();
    
    for (const booking of allBookings) {
      const normalizedPhone = normalizePhoneForMatching(booking.clientPhone);
      const groupKey = normalizedPhone || booking.clientEmail;
      
      if (!groupedMap.has(groupKey)) {
        groupedMap.set(groupKey, {
          booking: booking,
          totalBookings: 1,
          hasPaid: booking.bookingStatus === 'paid'
        });
      } else {
        const existing = groupedMap.get(groupKey);
        existing.totalBookings += 1;
        
        const existingIsPaid = existing.booking.bookingStatus === 'paid';
        const currentIsPaid = booking.bookingStatus === 'paid';
        
        if (currentIsPaid && !existingIsPaid) {
          existing.booking = booking;
          existing.hasPaid = true;
        } else if (!currentIsPaid && existingIsPaid) {
        } else {
          const existingEventTime = existing.booking.scheduledEventStartTime ? new Date(existing.booking.scheduledEventStartTime).getTime() : 0;
          const currentEventTime = booking.scheduledEventStartTime ? new Date(booking.scheduledEventStartTime).getTime() : 0;
          
          if (currentEventTime > existingEventTime) {
            existing.booking = booking;
          } else if (currentEventTime === existingEventTime) {
            const existingTime = existing.booking.bookingCreatedAt ? new Date(existing.booking.bookingCreatedAt).getTime() : 0;
            const currentTime = booking.bookingCreatedAt ? new Date(booking.bookingCreatedAt).getTime() : 0;
            
            if (currentTime > existingTime) {
              existing.booking = booking;
            }
          }
        }
      }
    }

    let uniqueBookings = Array.from(groupedMap.values()).map(item => item.booking);
    
    uniqueBookings = uniqueBookings.filter(booking => booking.bookingStatus === statusInfo.dbStatus);

    // STRICT: Exclude clients who have any paid booking - never send workflows to paid clients
    const bookingsToProcess = [];
    for (const booking of uniqueBookings) {
      const hasPaid = await clientHasPaidBooking(booking.clientEmail, booking.clientPhone);
      if (hasPaid) {
        Logger.info('Skipping bulk workflow trigger: client has paid booking', {
          bookingId: booking.bookingId,
          clientEmail: booking.clientEmail
        });
        continue;
      }
      bookingsToProcess.push(booking);
    }
    uniqueBookings = bookingsToProcess;

    if (uniqueBookings.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No bookings found with this status',
        data: {
          total: 0,
          processed: 0,
          skipped: 0,
          errors: []
        }
      });
    }

    let filteredBookings = uniqueBookings;
    if (includeCountries && includeCountries.length > 0) {
      filteredBookings = filterByCountryCode(uniqueBookings, includeCountries);
    }

    const bookings = filteredBookings;

    const actionMap = {
      'not-scheduled': 'not-scheduled',
      'no-show': 'no-show',
      'completed': 'complete',
      'canceled': 'cancel',
      'rescheduled': 're-schedule',
      'paid': 'paid'
    };

    const triggerAction = actionMap[statusInfo.action];
    
    const workflows = await WorkflowModel.find({
      triggerAction,
      isActive: true
    }).lean();

    if (workflows.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No active workflows found for this status',
        data: {
          total: bookings.length,
          processed: 0,
          skipped: bookings.length,
          errors: []
        }
      });
    }

    const results = {
      total: bookings.length,
      processed: 0,
      skipped: 0,
      errors: []
    };

    for (const booking of bookings) {
      try {
        const hasScheduledWorkflows = booking.scheduledWorkflows && 
          booking.scheduledWorkflows.some(sw => sw.status === 'scheduled');

        if (skipExisting && hasScheduledWorkflows) {
          results.skipped++;
          continue;
        }

        const workflowResult = await triggerWorkflow(booking.bookingId, statusInfo.action);
        
        if (workflowResult.success && workflowResult.triggered) {
          results.processed++;
        } else {
          results.skipped++;
        }
      } catch (error) {
        console.error(`Error processing booking ${booking.bookingId}:`, error);
        results.errors.push({
          bookingId: booking.bookingId,
          clientEmail: booking.clientEmail,
          error: error.message
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: `Processed ${results.processed} bookings, skipped ${results.skipped}`,
      data: results
    });

  } catch (error) {
    console.error('Error triggering workflows for all bookings:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to trigger workflows',
      error: error.message
    });
  }
};

