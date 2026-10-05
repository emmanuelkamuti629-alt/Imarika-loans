require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const path = require('path');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Database Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/imarika')
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error('MongoDB Connection Error:', err));

// User Schema
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String }, // Optional for OAuth users
  googleId: { type: String },
  githubId: { type: String },
  mpesaNumber: { type: String },
  loanLimit: { type: Number, default: 2000 }, // New users start with KES 2,000
  walletBalance: { type: Number, default: 0 },
  pendingBalance: { type: Number, default: 0 },
  activeLoan: {
    amount: Number,
    upfrontFee: Number,
    interest: Number,
    totalRepayment: Number,
    dueDate: Date,
    status: { type: String, enum: ['pending', 'active', 'repaid'], default: 'pending' }
  }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

// JWT Generation
const generateToken = (user) => {
  return jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '7d' });
};

// --- PASSPORT CONFIGURATION ---

// Google Strategy
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'GOOGLE_CLIENT_ID',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'GOOGLE_CLIENT_SECRET',
    callbackURL: process.env.GOOGLE_CALLBACK_URL || '/api/auth/google/callback'
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      let user = await User.findOne({ email: profile.emails[0].value });
      if (!user) {
        user = await User.create({
          name: profile.displayName,
          email: profile.emails[0].value,
          googleId: profile.id
        });
      } else if (!user.googleId) {
        user.googleId = profile.id;
        await user.save();
      }
      return done(null, user);
    } catch (err) {
      return done(err, null);
    }
  }
));

// GitHub Strategy
passport.use(new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID || 'GITHUB_CLIENT_ID',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || 'GITHUB_CLIENT_SECRET',
    callbackURL: process.env.GITHUB_CALLBACK_URL || '/api/auth/github/callback'
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails && profile.emails.length > 0 ? profile.emails[0].value : `${profile.username}@github.com`;
      let user = await User.findOne({ email });
      if (!user) {
        user = await User.create({
          name: profile.displayName || profile.username,
          email: email,
          githubId: profile.id
        });
      } else if (!user.githubId) {
        user.githubId = profile.id;
        await user.save();
      }
      return done(null, user);
    } catch (err) {
      return done(err, null);
    }
  }
));

app.use(passport.initialize());

// --- AUTHENTICATION ROUTES ---

// 1. Local Registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, mpesaNumber } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Please enter all required fields' });

    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ error: 'User already exists' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = await User.create({ name, email, password: hashedPassword, mpesaNumber });
    const token = generateToken(newUser);

    res.status(201).json({ token, user: { id: newUser._id, name: newUser.name, email: newUser.email } });
  } catch (err) {
    res.status(500).json({ error: 'Server error during registration' });
  }
});

// 2. Local Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' });

    const token = generateToken(user);
    res.json({ token, user: { id: user._id, name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: 'Server error during login' });
  }
});

// 3. Google OAuth
app.get('/api/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/api/auth/google/callback', 
  passport.authenticate('google', { session: false, failureRedirect: '/?error=google_auth_failed' }),
  (req, res) => {
    const token = generateToken(req.user);
    res.redirect(`/?token=${token}&name=${encodeURIComponent(req.user.name)}`);
  }
);

// 4. GitHub OAuth
app.get('/api/auth/github', passport.authenticate('github', { scope: ['user:email'] }));
app.get('/api/auth/github/callback', 
  passport.authenticate('github', { session: false, failureRedirect: '/?error=github_auth_failed' }),
  (req, res) => {
    const token = generateToken(req.user);
    res.redirect(`/?token=${token}&name=${encodeURIComponent(req.user.name)}`);
  }
);

// --- MOCK LOAN ROUTES (For testing dashboard) ---

app.get('/api/user/dashboard', async (req, res) => {
  // In a real app, you'd use a JWT middleware here
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
    const user = await User.findById(decoded.id).select('-password');
    res.json(user);
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.post('/api/loan/apply', async (req, res) => {
  // Mock Payhero STK Push integration
  const { amount, term, phone } = req.body;
  
  const upfrontFee = amount * 0.10; // 10% upfront fee
  const interest = amount * 0.08;   // 8% interest
  const totalRepayment = amount + interest;

  // Here you would call Payhero API to initiate STK push for the upfrontFee
  console.log(`Initiating M-Pesa STK Push for KES ${upfrontFee} to ${phone} via Payhero API`);
  
  res.json({ 
    message: 'STK Push initiated', 
    details: { amount, term, upfrontFee, interest, totalRepayment },
    checkoutRequestID: 'mock_payhero_id_12345'
  });
});

// Payhero Callback Webhook
app.post('/api/payhero/callback', async (req, res) => {
  console.log('Payhero Callback Received:', req.body);
  // Logic to check if payment was successful, then update user wallet balance
  // and disburse the loan.
  res.status(200).send('OK');
});

// Serve frontend for any other route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
