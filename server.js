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
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("FATAL ERROR: MONGODB_URI is not defined in environment variables.");
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
  .then(() => console.log('MongoDB Connected Successfully'))
  .catch(err => {
    console.error('MongoDB Connection Error:', err);
    process.exit(1); 
  });

// User Schema
const userSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  middleName: { type: String },
  surname: { type: String, required: true },
  username: { type: String, required: true, unique: true }, // Unique
  email: { type: String, required: true, unique: true },    // Unique
  phoneNumber: { type: String, required: true },            // NOT unique
  password: { type: String }, 
  googleId: { type: String },
  githubId: { type: String },
  mpesaNumber: { type: String },                            // NOT unique
  loanLimit: { type: Number, default: 2000 },
  walletBalance: { type: Number, default: 0 },
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
          firstName: profile.name.givenName || profile.displayName,
          surname: profile.name.familyName || '',
          email: profile.emails[0].value,
          username: profile.emails[0].value.split('@')[0] + Math.floor(Math.random() * 1000),
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
          firstName: profile.displayName || profile.username,
          surname: '',
          email: email,
          username: profile.username,
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

// Local Registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { firstName, middleName, surname, username, email, phoneNumber, password } = req.body;
    
    if (!firstName || !surname || !username || !email || !phoneNumber || !password) {
      return res.status(400).json({ error: 'Please enter all required fields' });
    }

    // Check for existing user by EMAIL or USERNAME only (Phone number is ignored here)
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      return res.status(400).json({ error: 'Email or Username already exists. Please login.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = await User.create({ 
      firstName, middleName, surname, username, email, phoneNumber, password: hashedPassword 
    });
    
    const token = generateToken(newUser);
    res.status(201).json({ token, user: { id: newUser._id, name: `${firstName} ${surname}`, email: newUser.email } });
  
  } catch (err) {
    console.error("=== REGISTRATION ERROR ===");
    console.error(err);
    
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern)[0];
      return res.status(400).json({ error: `An account with that ${field} already exists.` });
    }
    
    res.status(500).json({ error: `Server Error: ${err.message}` });
  }
});

// Local Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Account not found. Please sign up.' });

    if (!user.password) {
      return res.status(400).json({ error: 'This email is registered with Google or GitHub. Please use the social login buttons below.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Incorrect password' });

    const token = generateToken(user);
    res.json({ token, user: { id: user._id, name: `${user.firstName} ${user.surname}`, email: user.email } });
  } catch (err) {
    console.error("Login Error:", err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// Google OAuth
app.get('/api/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/api/auth/google/callback', 
  passport.authenticate('google', { session: false, failureRedirect: '/?error=google_auth_failed' }),
  (req, res) => {
    const token = generateToken(req.user);
    const fullName = `${req.user.firstName} ${req.user.surname || ''}`.trim();
    res.redirect(`/?token=${token}&name=${encodeURIComponent(fullName)}`);
  }
);

// GitHub OAuth
app.get('/api/auth/github', passport.authenticate('github', { scope: ['user:email'] }));
app.get('/api/auth/github/callback', 
  passport.authenticate('github', { session: false, failureRedirect: '/?error=github_auth_failed' }),
  (req, res) => {
    const token = generateToken(req.user);
    const fullName = `${req.user.firstName} ${req.user.surname || ''}`.trim();
    res.redirect(`/?token=${token}&name=${encodeURIComponent(fullName)}`);
  }
);

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
