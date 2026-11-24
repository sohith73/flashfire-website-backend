import { PaymentModel } from "../Schema_Models/Payment.js";
import { DiscordConnect } from "../Utils/DiscordConnect.js";
import { sendPaymentConfirmationEmail } from "../Utils/PaymentEmailHelper.js";
import { kickAutoOnboard } from "../Utils/AutoOnboard.js";

/**
 * Create a new payment record
 */
export const createPayment = async (req, res) => {
  try {
    const {
      paypalOrderId,
      paypalPayerId,
      paypalPayerEmail,
      amount,
      currency,
      planName,
      planSubtitle,
      description,
      customerFirstName,
      customerLastName,
      customerEmail,
      customerMobile,
      customerPassword,
      utmSource,
      utmMedium,
      utmCampaign,
    } = req.body;

    // Validate required fields
    if (!paypalOrderId || !paypalPayerId || !paypalPayerEmail || !amount || 
        !planName || !planSubtitle || !customerFirstName || !customerLastName || 
        !customerEmail || !customerMobile || !customerPassword) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Check if payment with this PayPal order ID already exists
    const existingPayment = await PaymentModel.findOne({ paypalOrderId });
    if (existingPayment) {
      return res.status(200).json({
        success: true,
        message: 'Payment already exists',
        data: existingPayment
      });
    }

    // Create new payment record
    const payment = await PaymentModel.create({
      paypalOrderId,
      paypalPayerId,
      paypalPayerEmail,
      amount: parseFloat(amount),
      currency: currency || 'USD',
      planName,
      planSubtitle,
      description,
      customerFirstName,
      customerLastName,
      customerEmail: customerEmail.toLowerCase(),
      customerMobile,
      customerPassword, // Store password securely (consider hashing in production)
      paymentStatus: 'completed',
      utmSource: utmSource || null,
      utmMedium: utmMedium || null,
      utmCampaign: utmCampaign || null,
    });

    // A stored completed payment becomes a dashboard client and a Discord channel right away.
    kickAutoOnboard();

    console.log('✅ Payment saved to database:', {
      paymentId: payment.paymentId,
      customerEmail: payment.customerEmail,
      amount: payment.amount,
      planName: payment.planName
    });

    // ✅ Schedule payment confirmation email to be sent after 1 minute
    // PayPal sends its default email immediately, we send our custom email after 1 minute
    console.log('⏰ Scheduling payment confirmation email to be sent in 1 minute...');
    
    setTimeout(async () => {
      try {
        console.log('📧 Sending delayed payment confirmation email to:', payment.customerEmail);
        
        const emailResult = await sendPaymentConfirmationEmail({
          customerEmail: payment.customerEmail,
          customerFirstName: payment.customerFirstName,
          customerLastName: payment.customerLastName,
          amount: payment.amount,
          currency: payment.currency,
          planName: payment.planName,
          planSubtitle: payment.planSubtitle,
          paypalOrderId: payment.paypalOrderId,
          paymentDate: payment.paymentDate || new Date()
        });

        if (emailResult.success) {
          console.log('✅ Delayed payment confirmation email sent successfully to:', payment.customerEmail);
        } else {
          console.error('❌ Failed to send delayed payment confirmation email:', emailResult.error);
        }
      } catch (emailError) {
        console.error('❌ Error sending delayed payment confirmation email:', emailError);
        // Don't fail the payment creation if email fails
      }
    }, 60 * 1000); // 1 minute delay (60 seconds * 1000 milliseconds)

    console.log('✅ Payment confirmation email scheduled for 1 minute delay');

    // ✅ Send to Discord with email status
    try {
      const discordMessage = {
        "Message": "💳 A New Payment Received!",
        "Client Name": `${customerFirstName} ${customerLastName}`,
        "Client Email": customerEmail,
        "Client Mobile": customerMobile,
        "Amount Paid": `${currency} ${amount.toFixed(2)}`,
        "Plan": `${planName} - ${planSubtitle}`,
        "Transaction ID": paypalOrderId,
        "Payment Status": "Completed",
        "Confirmation Email": "✅ Scheduled (will send in 1 minute after PayPal email)",
        "Payment Date": new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
      };
      
      await DiscordConnect(process.env.DISCORD_WEB_HOOK_URL, JSON.stringify(discordMessage, null, 2));
      console.log('✅ Payment notification sent to Discord');
    } catch (discordError) {
      console.error('❌ Failed to send Discord notification:', discordError);
      // Don't fail the payment creation if Discord fails
    }

    return res.status(201).json({
      success: true,
      message: 'Payment saved successfully',
      data: payment
    });
  } catch (error) {
    console.error('❌ Error creating payment:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to create payment record'
    });
  }
};

/**
 * Get all payments
 */
export const getAllPayments = async (req, res) => {
  try {
    const { page = 1, limit = 50, status, fromDate, toDate } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Build query
    const query = {};
    if (status && status !== 'all') {
      query.paymentStatus = status;
    }
    if (fromDate || toDate) {
      query.paymentDate = {};
      if (fromDate) {
        query.paymentDate.$gte = new Date(fromDate);
      }
      if (toDate) {
        query.paymentDate.$lte = new Date(toDate);
      }
    }

    const payments = await PaymentModel.find(query)
      .sort({ paymentDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await PaymentModel.countDocuments(query);

    return res.status(200).json({
      success: true,
      data: payments,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('❌ Error fetching payments:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch payments'
    });
  }
};

/**
 * Get payment by ID
 */
export const getPaymentById = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const payment = await PaymentModel.findOne({ paymentId });

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'Payment not found'
      });
    }

    return res.status(200).json({
      success: true,
      data: payment
    });
  } catch (error) {
    console.error('❌ Error fetching payment:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch payment'
    });
  }
};

/**
 * Get payments by customer email
 */
export const getPaymentsByEmail = async (req, res) => {
  try {
    const { email } = req.params;
    const payments = await PaymentModel.find({ 
      customerEmail: email.toLowerCase() 
    }).sort({ paymentDate: -1 });

    return res.status(200).json({
      success: true,
      data: payments
    });
  } catch (error) {
    console.error('❌ Error fetching payments by email:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch payments'
    });
  }
};

