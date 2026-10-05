require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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
  username: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  limit: { type: Number, default: 50000 },
  walletBalance: { type: Number, default: 0 },
  activeLoan: { type: mongoose.Schema.Types.ObjectId, ref: 'Loan' }
});

const LoanSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  amount: { type: Number, required: true },
  upfrontFee: { type: Number, required: true },
  termDays: { type: Number, required: true },
  interestRate: { type: Number, default: 8 },
  totalRepayment: { type: Number, required: true },
  status: { type: String, enum: ['pending_payment', 'active', 'completed', 'rejected'], default: 'pending_payment' },
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

// --- Auth Middleware ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// --- Auth Routes ---

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, phone, password } = req.body;
    
    // Check if user exists
    const existingUser = await User.findOne({ $or: [{ email }, { phone }] });
    if (existingUser) return res.status(400).json({ error: 'User already exists' });

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = await User.create({ username, email, phone, password: hashedPassword });
    
    // Create JWT
    const token = jwt.sign({ id: newUser._id }, process.env.JWT_SECRET, { expiresIn: '1d' });
    
    res.status(201).json({ token, user: { id: newUser._id, username: newUser.username, email: newUser.email, phone: newUser.phone, limit: newUser.limit, walletBalance: newUser.walletBalance } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1d' });
    
    res.json({ token, user: { id: user._id, username: user.username, email: user.email, phone: user.phone, limit: user.limit, walletBalance: user.walletBalance } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Protected API Routes ---

app.get('/api/dashboard', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const activeLoan = await Loan.findOne({ userId: user._id, status: 'active' });
    const transactions = await Transaction.find({ userId: user._id }).sort({ createdAt: -1 }).limit(5);
    
    res.json({ user, activeLoan, transactions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/loan/apply', authenticateToken, async (req, res) => {
  const { amount, termDays } = req.body;
  const userId = req.user.id;

  if (amount < 1000) return res.status(400).json({ error: 'Minimum loan amount is KES 1,000' });

  const upfrontFee = amount * 0.10;
  const totalRepayment = amount + (amount * 0.08);
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + termDays);

  try {
    const loan = await Loan.create({ userId, amount, upfrontFee, termDays, totalRepayment, dueDate, status: 'pending_payment' });
    res.json({ message: 'Loan application created. Please pay the 10% upfront fee.', loan, paymentRequired: upfrontFee });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/payhero/stk-push', authenticateToken, async (req, res) => {
  const { phone, amount, loanId } = req.body;
  try {
    // Mock Payhero logic
    res.json({ success: true, message: 'STK Push sent to user phone' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to initiate payment' });
  }
});

app.post('/api/payhero/callback', async (req, res) => {
  // Callback logic remains the same
  res.status(200).json({ received: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
