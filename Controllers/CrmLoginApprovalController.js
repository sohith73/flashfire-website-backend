import { CrmLoginApprovalModel } from "../Schema_Models/CrmLoginApprovalModel.js";
import { CrmTrustedDeviceModel } from "../Schema_Models/CrmTrustedDeviceModel.js";
import { CrmUserModel } from "../Schema_Models/CrmUser.js";
import { issueCrmSessionAndToken } from "./CrmAuthController.js";

function toApprovalView(doc) {
  return {
    id: String(doc._id),
    approvalId: doc.sessionId,
    email: doc.email,
    name: doc.name,
    ip: doc.ip || "",
    country: doc.country || "",
    countryCode: doc.countryCode || "",
    deviceLabel: `${doc.browser || "Unknown"} on ${doc.os || "Unknown"}`,
    browser: doc.browser || "",
    os: doc.os || "",
    deviceType: doc.deviceType || "",
    status: doc.status,
    createdAt: doc.createdAt,
  };
}

export const listPendingLoginApprovals = async (req, res) => {
  try {
    const docs = await CrmLoginApprovalModel.find({ status: "pending" }).sort({ createdAt: -1 }).limit(100);
    return res.status(200).json({ success: true, data: docs.map(toApprovalView) });
  } catch (error) {
    console.error("Error listing login approvals:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to list approvals" });
  }
};

export const approveLoginApproval = async (req, res) => {
  try {
    const { approvalId } = req.params;
    const approval = await CrmLoginApprovalModel.findOne({ sessionId: approvalId });
    if (!approval) return res.status(404).json({ success: false, error: "Approval request not found" });
    if (approval.status !== "pending") {
      return res.status(409).json({ success: false, error: `Already ${approval.status}` });
    }

    const user = await CrmUserModel.findOne({ email: approval.email }).lean();
    if (!user || user.isActive === false) {
      approval.status = "denied";
      approval.resolvedAt = new Date();
      approval.resolvedBy = req.crmAdmin?.email || "admin";
      await approval.save();
      return res.status(404).json({ success: false, error: "User no longer active" });
    }

    // Remember this device so future logins from it skip approval.
    await CrmTrustedDeviceModel.findOneAndUpdate(
      { email: approval.email, deviceKey: approval.deviceKey },
      {
        email: approval.email,
        deviceKey: approval.deviceKey,
        browser: approval.browser,
        os: approval.os,
        approvedBy: req.crmAdmin?.email || "admin",
        approvedAt: new Date(),
      },
      { upsert: true }
    );

    const { token } = await issueCrmSessionAndToken({
      user,
      ip: approval.ip,
      countryCode: approval.countryCode,
      country: approval.country,
      browser: approval.browser,
      os: approval.os,
      deviceType: approval.deviceType,
      userAgent: approval.userAgent,
    });

    approval.status = "approved";
    approval.resolvedAt = new Date();
    approval.resolvedBy = req.crmAdmin?.email || "admin";
    approval.issuedToken = token;
    await approval.save();

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error approving login:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to approve login" });
  }
};

export const denyLoginApproval = async (req, res) => {
  try {
    const { approvalId } = req.params;
    const approval = await CrmLoginApprovalModel.findOne({ sessionId: approvalId });
    if (!approval) return res.status(404).json({ success: false, error: "Approval request not found" });
    if (approval.status !== "pending") {
      return res.status(409).json({ success: false, error: `Already ${approval.status}` });
    }

    approval.status = "denied";
    approval.resolvedAt = new Date();
    approval.resolvedBy = req.crmAdmin?.email || "admin";
    await approval.save();

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error denying login:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to deny login" });
  }
};
