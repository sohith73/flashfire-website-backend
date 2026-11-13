import { getClientUserModel } from '../Utils/ClientsTrackingDB.js';

const PAID_PLANS = ['Ignite', 'Professional', 'Executive', 'Prime'];

/**
 * Paid-client analytics, sourced from the clients-tracking DB.
 * A "paid client" = any user whose planType is not "Free Trial".
 */
export const getPaidClientsAnalytics = async (req, res) => {
  try {
    const Model = await getClientUserModel();
    if (!Model) {
      return res.status(503).json({
        success: false,
        error:
          'Clients-tracking DB not configured. Set CLIENTS_TRACKING_MONGODB_URI in the backend .env.',
      });
    }

    const { fromDate, toDate } = req.query;

    // Paid = a dashboard exists. Every user in the dashboard `users` collection
    // counts as a paying client (a created dashboard = a paid client), so no
    // planType filter. byPlan below still breaks them down by plan.
    const match = {};
    if (fromDate || toDate) {
      match.createdAt = {};
      if (fromDate) {
        const f = new Date(fromDate);
        f.setHours(0, 0, 0, 0);
        match.createdAt.$gte = f;
      }
      if (toDate) {
        const t = new Date(toDate);
        t.setHours(23, 59, 59, 999);
        match.createdAt.$lte = t;
      }
    }

    const [monthly, byPlan, total] = await Promise.all([
      Model.aggregate([
        { $match: match },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
            total: { $sum: 1 },
            ignite: { $sum: { $cond: [{ $eq: ['$planType', 'Ignite'] }, 1, 0] } },
            professional: { $sum: { $cond: [{ $eq: ['$planType', 'Professional'] }, 1, 0] } },
            executive: { $sum: { $cond: [{ $eq: ['$planType', 'Executive'] }, 1, 0] } },
            prime: { $sum: { $cond: [{ $eq: ['$planType', 'Prime'] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Model.aggregate([
        { $match: match },
        { $group: { _id: '$planType', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Model.countDocuments(match),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        totalPaidClients: total,
        plans: PAID_PLANS,
        monthly: monthly.map((m) => ({
          month: m._id,
          total: m.total,
          ignite: m.ignite,
          professional: m.professional,
          executive: m.executive,
          prime: m.prime,
        })),
        byPlan: byPlan
          .filter((p) => p._id)
          .map((p) => ({ plan: p._id, count: p.count })),
      },
    });
  } catch (error) {
    console.error('Error fetching paid-client analytics:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch paid-client analytics',
    });
  }
};
