require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error('MongoDB Connection Error:', err));

// --- Schemas ---
const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  email: String,
  limit: { type: Number, default: 50000 },
  walletBalance: { type: Number, default: 0 },
  activeLoan: { type: mongoose.Schema.Types.ObjectId, ref: 'Loan' }
});

const LoanSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  amount: { type: Number, required: true },
  upfrontFee: { type: Number, required: true }, // 10%
  termDays: { type: Number, required: true },
  interestRate: { type: Number, default: 8 }, // 8% per term
  totalRepayment: { type: Number, required: true },
  status: { 
    type: String, 
    enum: ['pending_payment', 'active', 'completed', 'rejected'], 
    default: 'pending_payment' 
  },
  dueDate: Date,
  createdAt: { type: Date, default: Date.now }
});

const TransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['loan_disbursed', 'repayment', 'upfront_fee', 'deposit', 'withdrawal'] },
  amount: Number,
  status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
  reference: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Loan = mongoose.model('Loan', LoanSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);

// --- API Routes ---

// 1. Get Dashboard Data (Mocking auth for this example)
app.get('/api/dashboard', async (req, res) => {
  try {
    // In production, get userId from JWT
    let user = await User.findOne({ phone: '254712345678' });
    if (!user) {
      user = await User.create({ name: 'Emmanuel Kamuti', phone: '254712345678', walletBalance: 12350 });
    }
    const activeLoan = await Loan.findOne({ userId: user._id, status: 'active' });
    const transactions = await Transaction.find({ userId: user._id }).sort({ createdAt: -1 }).limit(5);
    
    res.json({ user, activeLoan, transactions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Apply for Loan (Calculates 10% upfront fee)
app.post('/api/loan/apply', async (req, res) => {
  const { userId, amount, termDays } = req.body;

  if (amount < 1000) {
    return res.status(400).json({ error: 'Minimum loan amount is KES 1,000' });
  }

  const upfrontFee = amount * 0.10; // 10% fee
  const interestRate = 8; // 8% flat
  const totalRepayment = amount + (amount * (interestRate / 100));

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + termDays);

  try {
    const loan = await Loan.create({
      userId,
      amount,
      upfrontFee,
      termDays,
      totalRepayment,
      dueDate,
      status: 'pending_payment'
    });

    res.json({ 
      message: 'Loan application created. Please pay the 10% upfront fee to proceed.',
      loan,
      paymentRequired: upfrontFee
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Initiate Payhero STK Push for the 10% fee
app.post('/api/payhero/stk-push', async (req, res) => {
  const { phone, amount, loanId } = req.body;

  // Validate minimum fee
  if (amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  try {
    const authToken = process.env.PAYHERO_AUTH_TOKEN;
    
    // Payhero API Payload (Adjust based on actual Payhero docs)
    const payload = {
      amount: amount,
      phone_number: phone,
      channel_id: process.env.PAYHERO_CHANNEL_ID,
      provider: 'm-pesa',
      external_reference: `LOAN_FEE_${loanId}`,
      callback_url: process.env.PAYHERO_CALLBACK_URL
    };

    // NOTE: Replace with actual Payhero endpoint
    // const response = await axios.post('https://api.payhero.co.ke/v1/stkpush', payload, {
    //   headers: { Authorization: `Basic ${authToken}` }
    // });

    // Mock Response for testing
    console.log('Mock Payhero STK Push initiated for:', payload);
    res.json({ success: true, message: 'STK Push sent to user phone', reference: payload.external_reference });

  } catch (error) {
    console.error('Payhero Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to initiate payment' });
  }
});

// 4. Payhero Webhook Callback
app.post('/api/payhero/callback', async (req, res) => {
  const { external_reference, status, amount, transaction_id } = req.body;

  try {
    if (status === 'Success' || status === 'success') {
      const loanId = external_reference.split('_')[2];
      
      // Update Loan Status
      await Loan.findByIdAndUpdate(loanId, { status: 'active' });

      // Record Transaction
      const loan = await Loan.findById(loanId);
      await Transaction.create({
        userId: loan.userId,
        type: 'upfront_fee',
        amount: amount,
        status: 'success',
        reference: transaction_id
      });

      // Disburse loan to user wallet (In real life, this triggers a B2C transfer)
      await User.findByIdAndUpdate(loan.userId, { $inc: { walletBalance: loan.amount } });
      
      console.log('Payment successful, loan activated:', loanId);
    } else {
      console.log('Payment failed for ref:', external_reference);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Callback Error:', error);
    res.status(500).json({ error: 'Callback processing failed' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
