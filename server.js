// server.js - Enhanced Medical Screening System with MongoDB and Local ONNX Model 
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const fs = require('fs').promises;
const fsSync = require('fs');
const bcrypt = require('bcrypt');

// Import the ModelManager
const ModelManager = require('./models/ModelManager');

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/medical_screening_app';

// Initialize ModelManager
const modelManager = new ModelManager();

// Doctor profiles (in production, this should be in database)
const doctorProfiles = {
  '1': {
    name: 'Dr. Debra Rinyai',
    specialty: 'Infectious Diseases',
    location: 'Nairobi',
    photo: 'https://media.licdn.com/dms/image/v2/D4D03AQHvreljwrWTHA/profile-displayphoto-shrink_400_400/profile-displayphoto-shrink_400_400/0/1667146142894?e=1756944000&v=beta&t=HCb9MeHFbp1ua5ZFXiroweOhbfXSIGCwGBjv57qiA-o',
    username: 'doctor1'
  },
  '2': {
    name: 'Dr. Sharon Lavin',
    specialty: 'Tropical Medicine',
    location: 'Mombasa',
    photo: 'https://media.licdn.com/dms/image/v2/C4D03AQEN0VHacwo6DQ/profile-displayphoto-shrink_800_800/profile-displayphoto-shrink_800_800/0/1646507114320?e=1756944000&v=beta&t=Gg51H5SnQ7uN4Kst88Nl8gTVh9TMc1h9aulTarprEPM',
    username: 'doctor2'
  },
  '3': {
    name: 'Dr. Juliet Ndolo',
    specialty: 'Tropical Medicine',
    location: 'Mombasa',
    photo: 'https://media.licdn.com/dms/image/v2/D4D03AQFHMBsr29kbEw/profile-displayphoto-shrink_400_400/profile-displayphoto-shrink_400_400/0/1713880497242?e=1756944000&v=beta&t=RKRpKW1dP6VTTBPwZBb-d_DRr4hNPi-4r2FIROsLveY',
    username: 'doctor3'
  }
};

// MongoDB Schemas
const patientResultSchema = new mongoose.Schema({
  username: { type: String, required: true, index: true },
  prediction: { type: String, required: true },
  confidence: { type: Number, required: true },
  symptoms: { type: Object, default: null },
  timestamp: { type: Date, default: Date.now },
  date: { type: String },
  time: { type: String }
});

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  email: { type: String, unique: true, sparse: true },
  password: { type: String, required: true },
  full_name: { type: String },
  role: { type: String, required: true, enum: ['user', 'doctor', 'admin'] },
  doctorId: { type: String }, // For doctor users
  created_at: { type: Date, default: Date.now },
  is_active: { type: Boolean, default: true }
});

const adminLogSchema = new mongoose.Schema({
  admin_username: { type: String, required: true },
  action: { type: String, required: true },
  target_user: { type: String, default: null },
  details: { type: String, default: null },
  timestamp: { type: Date, default: Date.now }
});

const doctorAssessmentSchema = new mongoose.Schema({
  doctorId: { type: String, required: true, index: true },
  from: { type: String, required: true },
  prediction: { type: String },
  confidence: { type: Number },
  symptoms: { type: Object },
  riskLevel: { type: String, enum: ['Low', 'Medium', 'High'], default: 'Medium' },
  status: { type: String, enum: ['pending', 'reviewed', 'completed'], default: 'pending' },
  timestamp: { type: Date, default: Date.now }
});

// Create indexes for better performance
patientResultSchema.index({ username: 1, timestamp: -1 });
adminLogSchema.index({ timestamp: -1 });
doctorAssessmentSchema.index({ doctorId: 1, timestamp: -1 });
userSchema.index({ username: 1, role: 1 });

// MongoDB Models
const PatientResult = mongoose.model('PatientResult', patientResultSchema);
const User = mongoose.model('User', userSchema);
const AdminLog = mongoose.model('AdminLog', adminLogSchema);
const DoctorAssessment = mongoose.model('DoctorAssessment', doctorAssessmentSchema);

// Admin logging function
const logAdminAction = async (adminUsername, action, targetUser = null, details = null) => {
  try {
    const log = new AdminLog({
      admin_username: adminUsername,
      action,
      target_user: targetUser,
      details
    });
    await log.save();
    console.log(`📝 Admin action logged: ${action} by ${adminUsername}`);
  } catch (err) {
    console.error('❌ Error logging admin action:', err);
  }
};

// Create default admin function
const createDefaultAdmin = async () => {
  try {
    const existingAdmin = await User.findOne({ role: 'admin' });
    
    if (!existingAdmin) {
      const defaultAdminUsername = 'admin';
      const defaultAdminPassword = 'admin123';
      
      const hashedPassword = await bcrypt.hash(defaultAdminPassword, 10);
      
      const defaultAdmin = new User({
        username: defaultAdminUsername,
        password: hashedPassword,
        full_name: 'System Administrator',
        email: 'admin@medicalsystem.com',
        role: 'admin',
        is_active: true
      });
      
      await defaultAdmin.save();
      
      console.log('🔑 Default admin account created:');
      console.log(`   Username: ${defaultAdminUsername}`);
      console.log(`   Password: ${defaultAdminPassword}`);
      console.log('   ⚠️ IMPORTANT: Change the default password after first login!');
      
      await logAdminAction(defaultAdminUsername, 'SYSTEM_STARTUP', null, 'Default admin account created');
    } else {
      console.log('✅ Admin account already exists');
    }
  } catch (error) {
    console.error('❌ Error creating default admin:', error);
  }
};

// Create default doctor accounts function
const createDefaultDoctors = async () => {
  try {
    console.log('🩺 Checking for doctor accounts...');
    
    for (const [doctorId, profile] of Object.entries(doctorProfiles)) {
      const existingDoctor = await User.findOne({ username: profile.username });
      
      if (!existingDoctor) {
        const defaultPassword = profile.username;
        console.log(`🔐 Creating doctor ${profile.username} with password: ${defaultPassword}`);
        
        const hashedPassword = await bcrypt.hash(defaultPassword, 10);
        
        const doctorUser = new User({
          username: profile.username,
          password: hashedPassword,
          full_name: profile.name,
          email: `${profile.username}@medicalsystem.com`,
          role: 'doctor',
          doctorId: doctorId,
          is_active: true
        });
        
        await doctorUser.save();
        
        const testResult = await bcrypt.compare(defaultPassword, hashedPassword);
        console.log(`🔐 Password test for ${profile.username}: ${testResult ? 'PASS' : 'FAIL'}`);
        
        console.log(`🩺 Doctor account created: ${profile.username} (${profile.name})`);
        
        await logAdminAction('SYSTEM', 'CREATE_DOCTOR_ACCOUNT', profile.username, 
          `Auto-created doctor account for ${profile.name}`);
      } else {
        console.log(`✅ Doctor account already exists: ${profile.username}`);
        
        const testPassword = profile.username;
        const passwordWorks = await bcrypt.compare(testPassword, existingDoctor.password);
        console.log(`🔐 Existing password test for ${profile.username}: ${passwordWorks ? 'PASS' : 'FAIL'}`);
        
        if (!passwordWorks) {
          console.log(`🔧 Fixing password for ${profile.username}...`);
          const newHashedPassword = await bcrypt.hash(testPassword, 10);
          await User.findOneAndUpdate(
            { username: profile.username },
            { password: newHashedPassword }
          );
          console.log(`✅ Password fixed for ${profile.username}`);
        }
      }
    }
    console.log('🩺 Doctor account setup completed');
  } catch (error) {
    console.error('❌ Error creating doctor accounts:', error);
  }
};

// Create required directories
const createDirectories = async () => {
  const dirs = ['uploads', 'public', 'patient_data', 'models'];
  for (const dir of dirs) {
    const dirPath = path.join(process.cwd(), dir);
    try {
      if (!fsSync.existsSync(dirPath)) {
        fsSync.mkdirSync(dirPath, { recursive: true });
        console.log(`✅ Created directory: ${dir}`);
      }
    } catch (error) {
      console.warn(`⚠️ Could not create directory ${dir}:`, error.message);
    }
  }
};
createDirectories();

// Add connection pooling and timeout handling
const connectWithRetry = async () => {
  try {
    await mongoose.connect(MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
  } catch (error) {
    console.log('MongoDB connection failed, retrying in 5 seconds...');
    setTimeout(connectWithRetry, 5000);
  }
};
// Enhanced savePatientResult function
const savePatientResult = async (username, result) => {
  try {
    if (!result.prediction) {
      throw new Error('Prediction is required');
    }

    if (!username) {
      throw new Error('Username is required');
    }

    const now = new Date();
    
    const safeConfidence = Number.isFinite(result.confidence) ? result.confidence : 0.8;
    const safePrediction = result.prediction;
    
    if (safePrediction !== 'Anemic' && safePrediction !== 'Non-anemic') {
      throw new Error(`Invalid prediction value: ${safePrediction}`);
    }

    const patientResult = new PatientResult({
      username,
      prediction: safePrediction,
      confidence: safeConfidence,
      symptoms: result.symptoms || null,
      timestamp: now,
      date: now.toLocaleDateString(),
      time: now.toLocaleTimeString()
    });

    const saved = await patientResult.save();
    console.log(`✅ Saved result for patient: ${username} (ID: ${saved._id}, Prediction: ${safePrediction})`);
    return saved;
  } catch (err) {
    console.error('❌ Error saving patient result:', err);
    console.error('❌ Input data was:', { username, result });
    throw err;
  }
};

const getPatientResults = async (username) => {
  try {
    const results = await PatientResult.find({ username })
      .sort({ timestamp: -1 })
      .limit(50)
      .lean();
    return results;
  } catch (err) {
    console.error('❌ Error fetching patient results:', err);
    throw err;
  }
};

const getAllPatientResults = async () => {
  try {
    const results = await PatientResult.find()
      .sort({ timestamp: -1 })
      .lean();
    return results;
  } catch (err) {
    console.error('❌ Error fetching all patient results:', err);
    throw err;
  }
};

const getSystemStats = async () => {
  try {
    const [totalUsersCount, totalTests, anemicCases, todayTests, weeklyTests, userActivity, predictionTrends, monthlyStats] = await Promise.all([
      PatientResult.distinct('username').then(users => users.length),
      PatientResult.countDocuments(),
      PatientResult.countDocuments({ prediction: 'Anemic' }),
      PatientResult.countDocuments({
        timestamp: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }
      }),
      PatientResult.aggregate([
        {
          $match: {
            timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]),
      PatientResult.aggregate([
        {
          $group: {
            _id: "$username",
            tests: { $sum: 1 },
            last_test: { $max: "$timestamp" }
          }
        },
        { $sort: { tests: -1 } },
        { $limit: 10 }
      ]),
      PatientResult.aggregate([
        {
          $group: {
            _id: "$prediction",
            count: { $sum: 1 }
          }
        }
      ]),
      PatientResult.aggregate([
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m", date: "$timestamp" } },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: -1 } },
        { $limit: 12 }
      ])
    ]);

    return {
      totalUsers: [{ count: totalUsersCount }],
      totalTests: [{ count: totalTests }],
      anemicCases: [{ count: anemicCases }],
      todayTests: [{ count: todayTests }],
      weeklyTests: weeklyTests.map(item => ({ date: item._id, count: item.count })),
      userActivity: userActivity.map(item => ({ 
        username: item._id, 
        tests: item.tests, 
        last_test: item.last_test 
      })),
      predictionTrends: predictionTrends.map(item => ({ 
        prediction: item._id, 
        count: item.count 
      })),
      monthlyStats: monthlyStats.map(item => ({ 
        month: item._id, 
        count: item.count 
      }))
    };
  } catch (err) {
    console.error('❌ Error getting system stats:', err);
    throw err;
  }
};

const deletePatientResult = async (username, resultId) => {
  try {
    const result = await PatientResult.findOneAndDelete({ 
      _id: resultId, 
      username: username 
    });
    
    if (!result) {
      throw new Error('Result not found or unauthorized');
    }
    
    console.log(`✅ Deleted result ID: ${resultId} for patient: ${username}`);
    return true;
  } catch (err) {
    console.error('❌ Error deleting patient result:', err);
    throw err;
  }
};

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration with MongoDB store
app.use(session({
  secret: process.env.SESSION_SECRET || 'anemia-malaria-secret-2024',
  resave: false,
  saveUninitialized: true,
  store: MongoStore.create({
    mongoUrl: MONGODB_URI,
    touchAfter: 24 * 3600
  }),
  cookie: { 
    secure: false,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Multer configuration - disk storage for local model processing
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    console.log('File upload attempt:', {
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size
    });
    
    // Use ModelManager validation
    const validationErrors = modelManager.validateImageFile(file);
    if (validationErrors.length > 0) {
      return cb(new Error(validationErrors[0]));
    }
    
    console.log('✅ File accepted for upload');
    cb(null, true);
  },
  limits: { 
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 1 
  }
});

// Authentication middleware
const requireAuth = (req, res, next) => {
  if (!req.session.loggedIn) {
    return res.redirect('/login');
  }
  next();
};

const requireRole = (role) => {
  return (req, res, next) => {
    if (!req.session.loggedIn) return res.redirect('/login');
    if (req.session.role !== role) {
      return res.status(403).send(`
        <h3>Access Denied</h3>
        <p>You don't have permission to access this page.</p>
        <a href="/dashboard">Go to Dashboard</a>
      `);
    }
    next();
  };
};

const requireAdmin = (req, res, next) => {
  if (!req.session.loggedIn) return res.redirect('/login');
  if (req.session.role !== 'admin') {
    return res.status(403).send(`
      <h3>Access Denied</h3>
      <p>Administrator access required.</p>
      <a href="/dashboard">Go to Dashboard</a>
    `);
  }
  next();
};

// DEBUG ROUTES
app.get('/debug/users', async (req, res) => {
  try {
    const users = await User.find({}, 'username role doctorId full_name is_active').lean();
    res.json({
      totalUsers: users.length,
      users: users
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/debug/user/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username }).lean();
    if (user) {
      res.json({
        username: user.username,
        role: user.role,
        doctorId: user.doctorId,
        hasPassword: !!user.password,
        passwordHashLength: user.password ? user.password.length : 0,
        is_active: user.is_active
      });
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));

app.get('/login', (req, res) => {
  if (req.session.loggedIn) {
    return res.redirect('/dashboard');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/signup', (req, res) => {
  if (req.session.loggedIn) {
    return res.redirect('/dashboard');
  }
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.post('/signup', async (req, res) => {
  const { username, password, full_name, role } = req.body;

  try {
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.redirect('/signup?error=User already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      username,
      password: hashedPassword,
      full_name,
      role,
      is_active: true
    });

    await newUser.save();

    res.redirect(`/login?prefill=true&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&loginType=${role}`);
  } catch (error) {
    console.error('Signup error:', error);
    res.redirect('/signup?error=Signup failed');
  }
});

// Enhanced login route
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  
  console.log('🔐 Login attempt:', { username, passwordLength: password?.length });

  try {
    const user = await User.findOne({ username });
    console.log('👤 User lookup result:', { 
      found: !!user, 
      role: user?.role, 
      doctorId: user?.doctorId,
      is_active: user?.is_active 
    });

    if (!user) {
      console.log('❌ User not found in database');
      return res.redirect('/login?error=Invalid username or password');
    }

    if (!user.is_active) {
      console.log('❌ User account is inactive');
      return res.redirect('/login?error=Account is inactive');
    }

    console.log('🔐 Attempting password comparison...');
    const passwordMatch = await bcrypt.compare(password, user.password);
    console.log('🔐 Password match result:', passwordMatch);
    
    if (!passwordMatch) {
      console.log('❌ Password comparison failed');
      return res.redirect('/login?error=Invalid username or password');
    }

    req.session.loggedIn = true;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.doctorId = user.doctorId;

    console.log(`✅ User logged in successfully:`, {
      username: user.username,
      role: user.role,
      doctorId: user.doctorId
    });

    return res.redirect('/dashboard');
  } catch (error) {
    console.error('❌ Login error:', error);
    return res.redirect('/login?error=Login failed');
  }
});

// API endpoint for current user info
app.get('/api/current-user', requireAuth, (req, res) => {
  try {
    res.json({
      username: req.session.username,
      role: req.session.role,
      doctorId: req.session.doctorId,
      loggedIn: req.session.loggedIn
    });
  } catch (error) {
    console.error('Error getting current user:', error);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

app.get('/dashboard', requireAuth, (req, res) => {
  if (req.session.role === 'doctor') {
    return res.redirect(`/doctor/${req.session.doctorId}`);
  }
  
  if (req.session.role === 'admin') {
    return res.redirect('/admin');
  }
  
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Admin Dashboard Route
app.get('/admin', requireAdmin, async (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-dashboard.html'));
});

// API endpoint to get dashboard data
app.get('/api/admin/dashboard-data', requireAdmin, async (req, res) => {
  try {
    const stats = await getSystemStats();
    const allResults = await getAllPatientResults();
    const allAssessments = await DoctorAssessment.find()
      .sort({ timestamp: -1 })
      .lean();
    const allUsers = await User.find({}, '-password')
      .sort({ created_at: -1 })
      .lean();

    const assessmentsWithDoctors = allAssessments.map(assessment => ({
      ...assessment,
      doctorName: doctorProfiles[assessment.doctorId]?.name || 'Unknown Doctor'
    }));

    const totalUsers = await User.countDocuments({ role: { $ne: 'admin' } });
    const totalTests = await PatientResult.countDocuments();
    const anemicCases = await PatientResult.countDocuments({ prediction: 'Anemic' });
    const todayTests = await PatientResult.countDocuments({
      timestamp: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }
    });
    const totalAssessments = allAssessments.length;

    const dashboardData = {
      stats: {
        totalUsers,
        totalTests,
        anemicCases,
        todayTests,
        totalAssessments,
        weeklyTests: stats.weeklyTests || [],
        monthlyStats: stats.monthlyStats || []
      },
      patientResults: allResults.slice(0, 50),
      doctorAssessments: assessmentsWithDoctors.slice(0, 50),
      users: allUsers
    };

    res.json(dashboardData);
  } catch (error) {
    console.error('Error loading dashboard data:', error);
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

// Admin API endpoints (keeping existing ones for brevity)
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await User.find({}, '-password')
      .sort({ created_at: -1 })
      .lean();
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// User routes
app.get('/symptoms', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'symptom-checker.html'));
});

app.get('/send-assessment', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'send-assessment.html'));
});

app.get('/history', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'patient-history.html'));
});

// UPDATED: Main prediction endpoint using local ONNX model
app.post('/predict', requireAuth, upload.single('eyelid'), async (req, res) => {
  console.log('Prediction request received from user:', req.session.username);
  
  if (!req.file) {
    return res.status(400).json({ 
      error: 'No file uploaded',
      code: 'NO_FILE'
    });
  }

  const imagePath = req.file.path;

  try {
    console.log('Processing image for prediction with local ONNX model...');
    
    // Use ModelManager to make prediction
    const result = await modelManager.predict(imagePath);
    console.log('Local model prediction result:', result);
    
    // Save to database
    const savedResult = await savePatientResult(req.session.username, {
      prediction: result.prediction,
      confidence: result.confidence,
      symptoms: req.body.symptoms || null
    });

    console.log('✅ Successfully saved prediction result:', savedResult._id);

    // Clean up uploaded file
    try {
      await fs.unlink(imagePath);
      console.log('✅ Cleaned up uploaded file');
    } catch (cleanupError) {
      console.warn('⚠️ Could not clean up file:', cleanupError.message);
    }

    // Return results
    res.json({
      success: true,
      prediction: result.prediction,
      confidence: result.confidence,
      confidencePercentage: Math.round(result.confidence * 100),
      source: result.modelSource || 'local_onnx',
      usingDefault: result.usingDefaultPrediction || false
    });

  } catch (error) {
    console.error('❌ Prediction failed:', error);
    
    // Clean up uploaded file on error
    try {
      await fs.unlink(imagePath);
    } catch (cleanupError) {
      console.warn('⚠️ Could not clean up file after error:', cleanupError.message);
    }
    
    res.status(500).json({
      error: 'Prediction failed',
      code: 'PREDICTION_ERROR',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// NEW: Alternative prediction endpoint using the updated format
app.post('/api/predict', requireAuth, upload.single('image'), async (req, res) => {
  console.log('API prediction request received from user:', req.session.username);
  
  if (!req.file) {
    return res.status(400).json({ 
      success: false,
      error: 'No file uploaded',
      message: 'Please upload an image file'
    });
  }

  const imagePath = req.file.path;

  try {
    console.log('Processing image with local ONNX model...');
    
    // Use ModelManager to make prediction
    const result = await modelManager.predict(imagePath);
    console.log('Local model API prediction result:', result);
    
    // Save to database
    const savedResult = await savePatientResult(req.session.username, {
      prediction: result.prediction,
      confidence: result.confidence,
      symptoms: req.body.symptoms || null
    });

    console.log('✅ API prediction saved:', savedResult._id);
    
    // Clean up uploaded file
    try {
      await fs.unlink(imagePath);
    } catch (cleanupError) {
      console.warn('⚠️ Could not clean up file:', cleanupError.message);
    }
    
    res.json({
      success: true,
      prediction: {
        result: result.prediction,
        confidence: result.confidence,
        confidencePercentage: Math.round(result.confidence * 100)
      },
      message: 'Prediction completed successfully',
      savedResultId: savedResult._id,
      modelSource: result.modelSource || 'local_onnx'
    });
    
  } catch (error) {
    console.error('❌ API Prediction failed:', error);
    
    // Clean up uploaded file on error
    try {
      await fs.unlink(imagePath);
    } catch (cleanupError) {
      console.warn('⚠️ Could not clean up file after error:', cleanupError.message);
    }
    
    res.status(500).json({
      success: false,
      error: 'Prediction failed',
      message: 'Local model prediction failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Send assessment to doctor
app.post('/api/sendToDoctor', requireAuth, async (req, res) => {
  const { doctorId, assessmentData } = req.body;
  
  console.log('Send to doctor request:', {
    from: req.session.username,
    doctorId,
    assessmentData
  });
  
  if (!doctorId || !assessmentData) {
    return res.status(400).json({ error: 'Missing required data.' });
  }

  if (!doctorProfiles[doctorId]) {
    return res.status(400).json({ error: 'Invalid doctor selected.' });
  }

  try {
    let prediction = assessmentData.prediction;
    if (!prediction || (prediction !== 'Anemic' && prediction !== 'Non-anemic')) {
      prediction = 'Non-anemic';
      console.log('⚠️ Using default prediction for assessment');
    }

    const assessment = new DoctorAssessment({
      doctorId,
      from: req.session.username,
      prediction: prediction,
      confidence: assessmentData.confidence || 0.8,
      symptoms: assessmentData.symptoms || {},
      riskLevel: assessmentData.riskLevel || 'Medium',
      status: 'pending'
    });

    const savedAssessment = await assessment.save();
    console.log('✅ Assessment saved:', savedAssessment._id);

    const resultWithSymptoms = {
      prediction: prediction,
      confidence: assessmentData.confidence || 0.8,
      symptoms: assessmentData.symptoms || {}
    };
    
    const savedResult = await savePatientResult(req.session.username, resultWithSymptoms);
    console.log('✅ Patient result saved:', savedResult._id);

    console.log(`✅ Assessment sent to doctor ${doctorId} from user ${req.session.username}`);
    res.json({ 
      success: true, 
      message: `Assessment sent to ${doctorProfiles[doctorId].name} successfully.`,
      assessmentId: savedAssessment._id
    });
  } catch (error) {
    console.error('❌ Error saving assessment:', error);
    res.status(500).json({ 
      error: 'Failed to send assessment to doctor',
      details: error.message 
    });
  }
});

// Get doctor assessments
app.get('/api/getDoctorAssessments', requireAuth, async (req, res) => {
  try {
    const { doctorId } = req.query;
    
    if (req.session.role !== 'doctor') {
      return res.status(403).json({ error: 'Access denied - doctors only' });
    }
    
    if (req.session.doctorId !== doctorId) {
      return res.status(403).json({ error: 'Access denied - can only view your own assessments' });
    }
    
    console.log(`🔍 Fetching assessments for doctor ${doctorId} (${req.session.username})`);
    
    const assessments = await DoctorAssessment.find({ doctorId })
      .sort({ timestamp: -1 })
      .lean();
    
    console.log(`✅ Found ${assessments.length} assessments for doctor ${doctorId}`);
    
    res.json(assessments);
  } catch (error) {
    console.error('Error fetching doctor assessments:', error);
    res.status(500).json({ error: 'Failed to fetch assessments' });
  }
});

// API endpoint to get patient history
app.get('/api/patient-history', requireAuth, async (req, res) => {
  try {
    const results = await getPatientResults(req.session.username);
    res.json(results);
  } catch (error) {
    console.error('Error fetching patient history:', error);
    res.status(500).json({ error: 'Failed to fetch patient history' });
  }
});

// Get patient statistics
app.get('/api/patient-stats', requireAuth, async (req, res) => {
  try {
    const results = await getPatientResults(req.session.username);
    
    if (results.length === 0) {
      return res.json({
        totalTests: 0,
        anemicResults: 0,
        normalResults: 0,
        avgConfidence: 0,
        thisWeekTests: 0,
        lastTest: null,
        trend: 'stable'
      });
    }

    const totalTests = results.length;
    const anemicResults = results.filter(r => r.prediction === 'Anemic').length;
    const normalResults = results.filter(r => r.prediction === 'Non-anemic').length;
    const avgConfidence = results.reduce((sum, r) => sum + r.confidence, 0) / totalTests;

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const thisWeekTests = results.filter(r => 
      new Date(r.timestamp) > weekAgo
    ).length;

    const lastTest = results[0];

    let trend = 'stable';
    if (results.length >= 6) {
      const recent3 = results.slice(0, 3);
      const previous3 = results.slice(3, 6);
      const recentAvg = recent3.reduce((sum, r) => sum + r.confidence, 0) / 3;
      const previousAvg = previous3.reduce((sum, r) => sum + r.confidence, 0) / 3;
      
      if (recentAvg > previousAvg + 0.1) trend = 'improving';
      else if (recentAvg < previousAvg - 0.1) trend = 'declining';
    }

    res.json({
      totalTests,
      anemicResults,
      normalResults,
      avgConfidence: Math.round(avgConfidence * 100),
      thisWeekTests,
      lastTest,
      trend
    });
  } catch (error) {
    console.error('Error fetching patient stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// API endpoint to get available doctors
app.get('/api/doctors', requireAuth, (req, res) => {
  try {
    const availableDoctors = {};
    
    Object.entries(doctorProfiles).forEach(([id, doctor]) => {
      availableDoctors[id] = {
        name: doctor.name,
        specialty: doctor.specialty,
        location: doctor.location,
        photo: doctor.photo,
        username: doctor.username
      };
    });
    
    res.json(availableDoctors);
  } catch (error) {
    console.error('Error fetching doctors:', error);
    res.status(500).json({ error: 'Failed to fetch doctors' });
  }
});

// Test endpoint for doctor data
app.get('/api/test-doctor-data/:doctorId', requireAuth, async (req, res) => {
  try {
    const { doctorId } = req.params;
    
    const doctorProfile = doctorProfiles[doctorId];
    if (!doctorProfile) {
      return res.status(404).json({ error: 'Doctor not found' });
    }

    const assessments = await DoctorAssessment.find({ doctorId })
      .sort({ timestamp: -1 })
      .lean();

    const stats = {
      total: assessments.length,
      pending: assessments.filter(a => a.status === 'pending').length,
      highRisk: assessments.filter(a => a.riskLevel === 'High').length,
      today: assessments.filter(a => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return new Date(a.timestamp) >= today;
      }).length
    };

    res.json({
      doctor: doctorProfile,
      assessments: assessments.slice(0, 5),
      stats
    });
  } catch (error) {
    console.error('Error in test endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Model management endpoints
app.get('/api/model-status', requireAuth, (req, res) => {
  try {
    const status = modelManager.getModelStatus();
    res.json(status);
  } catch (error) {
    console.error('Error getting model status:', error);
    res.status(500).json({ error: 'Failed to get model status' });
  }
});

app.post('/api/model/retry-load', requireAuth, async (req, res) => {
  try {
    console.log('🔄 Manual model reload requested by:', req.session.username);
    const status = await modelManager.retryLoadModel();
    res.json({ success: true, status });
  } catch (error) {
    console.error('Error retrying model load:', error);
    res.status(500).json({ error: 'Failed to retry model loading' });
  }
});

app.post('/api/model/clear-cache', requireAuth, async (req, res) => {
  try {
    console.log('🗑️ Model cache clear requested by:', req.session.username);
    const result = await modelManager.clearCache();
    res.json(result);
  } catch (error) {
    console.error('Error clearing model cache:', error);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// Doctor dashboard
app.get('/doctor/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  
  if (req.session.role !== 'doctor') {
    return res.status(403).send(`
      <h3>Access Denied</h3>
      <p>Only doctors can access this page.</p>
      <a href="/dashboard">Go to Dashboard</a>
    `);
  }

  if (req.session.doctorId !== id) {
    return res.status(403).send(`
      <h3>Access Denied</h3>
      <p>You can only access your own dashboard.</p>
      <a href="/doctor/${req.session.doctorId}">Go to Your Dashboard</a>
    `);
  }

  const doctor = doctorProfiles[id];
  if (!doctor) {
    return res.status(404).send('<h3>Doctor not found</h3>');
  }

  try {
    const assessments = await DoctorAssessment.find({ doctorId: id })
      .sort({ timestamp: -1 })
      .lean();
    
    const modelStatus = modelManager.getModelStatus();
    
    let html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Doctor Dashboard - ${doctor.name}</title>
        <style>
          body {
            font-family: 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #e8f5e8, #f0f9f0);
            margin: 0;
            padding: 20px;
          }
          .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 16px;
            box-shadow: 0 15px 40px rgba(0, 0, 0, 0.1);
            padding: 30px;
          }
          .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 2px solid #e0e0e0;
          }
          .doctor-info {
            display: flex;
            align-items: center;
            gap: 20px;
          }
          .doctor-info img {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            border: 3px solid #4caf50;
          }
          .doctor-details h1 {
            color: #2e7d32;
            margin: 0;
            font-size: 1.8em;
          }
          .doctor-details p {
            color: #666;
            margin: 5px 0;
          }
          .logout-btn {
            background: #d32f2f;
            color: white;
            padding: 10px 20px;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            text-decoration: none;
            font-weight: bold;
          }
          .logout-btn:hover {
            background: #b71c1c;
          }
          .model-status {
            background: ${modelStatus.isLoaded ? '#e8f5e8' : '#ffebee'};
            color: ${modelStatus.isLoaded ? '#2e7d32' : '#d32f2f'};
            padding: 10px 15px;
            border-radius: 8px;
            margin-bottom: 20px;
            text-align: center;
            font-weight: bold;
          }
          .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
          }
          .stat-card {
            background: #f0f9f0;
            padding: 20px;
            border-radius: 12px;
            text-align: center;
            border: 2px solid #e8f5e8;
          }
          .stat-card h3 {
            color: #2e7d32;
            margin: 0 0 10px 0;
            font-size: 2em;
          }
          .stat-card p {
            color: #666;
            margin: 0;
          }
          .assessment-card {
            background: #f9f9f9;
            border: 1px solid #e0e0e0;
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
            transition: transform 0.2s ease;
          }
          .assessment-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
          }
          .assessment-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
          }
          .assessment-meta {
            color: #666;
            font-size: 0.9em;
          }
          .risk-badge {
            padding: 5px 15px;
            border-radius: 20px;
            font-weight: bold;
            font-size: 0.8em;
          }
          .risk-high {
            background: #ffebee;
            color: #d32f2f;
          }
          .risk-medium {
            background: #fff3e0;
            color: #f57c00;
          }
          .risk-low {
            background: #e8f5e8;
            color: #2e7d32;
          }
          .symptoms-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 10px;
            margin-top: 10px;
          }
          .symptom-item {
            background: #f0f9f0;
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 0.9em;
            text-align: center;
          }
          .symptom-yes {
            background: #ffebee;
            color: #d32f2f;
          }
          .symptom-no {
            background: #e8f5e8;
            color: #2e7d32;
          }
          .no-assessments {
            text-align: center;
            color: #666;
            font-style: italic;
            padding: 40px;
          }
          .onnx-badge {
            background: #e3f2fd;
            color: #1976d2;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 0.7em;
            margin-left: 10px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="doctor-info">
              <img src="${doctor.photo}" alt="${doctor.name}">
              <div class="doctor-details">
                <h1>${doctor.name} <span class="onnx-badge">Local ONNX</span></h1>
                <p><strong>Specialty:</strong> ${doctor.specialty}</p>
                <p><strong>Location:</strong> ${doctor.location}</p>
              </div>
            </div>
            <form action="/logout" method="POST" style="display: inline;">
              <button type="submit" class="logout-btn">Logout</button>
            </form>
          </div>

          <div class="model-status">
            Model Status: ${modelStatus.isLoaded ? 'Loaded ✅' : 'Not Loaded ❌'} 
            | Source: ${modelStatus.modelSource} 
            | Repository: ${modelStatus.repository}
          </div>

          <div class="stats">
            <div class="stat-card">
              <h3>${assessments.length}</h3>
              <p>Total Assessments</p>
            </div>
            <div class="stat-card">
              <h3>${assessments.filter(a => a.status === 'pending').length}</h3>
              <p>Pending Reviews</p>
            </div>
            <div class="stat-card">
              <h3>${assessments.filter(a => a.riskLevel === 'High').length}</h3>
              <p>High Risk Cases</p>
            </div>
          </div>

          <h2>Patient Assessments <span class="onnx-badge">Powered by Local ONNX Model</span></h2>
    `;

    if (assessments.length === 0) {
      html += '<div class="no-assessments">No assessments received yet.</div>';
    } else {
      assessments.forEach((assessment, index) => {
        const date = new Date(assessment.timestamp).toLocaleString();
        const riskClass = assessment.riskLevel ? 
          `risk-${assessment.riskLevel.toLowerCase()}` : 'risk-medium';
        
        html += `
          <div class="assessment-card">
            <div class="assessment-header">
              <div class="assessment-meta">
                <strong>From:</strong> ${assessment.from} | 
                <strong>Received:</strong> ${date}
              </div>
              <div class="risk-badge ${riskClass}">
                ${assessment.riskLevel || 'Medium'} Risk
              </div>
            </div>
            
            <div><strong>Prediction:</strong> ${assessment.prediction || 'N/A'}</div>
            <div><strong>Confidence:</strong> ${Math.round((assessment.confidence || 0.8) * 100)}%</div>
            
            ${assessment.symptoms ? `
              <div style="margin-top: 15px;">
                <strong>Symptoms:</strong>
                <div class="symptoms-grid">
                  ${Object.entries(assessment.symptoms).map(([symptom, value]) => 
                    `<div class="symptom-item symptom-${value}">${symptom}: ${value}</div>`
                  ).join('')}
                </div>
              </div>
            ` : ''}
          </div>
        `;
      });
    }

    html += `
        </div>
      </body>
      </html>
    `;

    res.send(html);
  } catch (error) {
    console.error('Error loading doctor dashboard:', error);
    res.status(500).send('Error loading doctor dashboard');
  }
});

// Logout route
app.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
    }
    res.redirect('/login');
  });
});

// Health check endpoint - Updated to show local model status
app.get('/health', async (req, res) => {
  const modelStatus = modelManager.getModelStatus();

  const health = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    databaseConnected: mongoose.connection.readyState === 1,
    uploadsDirectory: fsSync.existsSync(path.join(__dirname, 'uploads')),
    publicDirectory: fsSync.existsSync(path.join(__dirname, 'public')),
    memoryUsage: process.memoryUsage(),
    uptime: process.uptime(),
    localModel: {
      status: modelStatus.isLoaded ? 'loaded' : 'not_loaded',
      modelSource: modelStatus.modelSource,
      repository: modelStatus.repository,
      isLoading: modelStatus.isLoading,
      loadAttempts: modelStatus.loadAttempts,
      maxAttempts: modelStatus.maxAttempts
    }
  };

  res.json(health);
});

// Updated startServer function
async function startServer() {
  try {
    console.log('🚀 Initializing Medical Screening System with Local ONNX Model...');
    
    // Connect to MongoDB
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB database');
    
    // Initialize ModelManager
    console.log('🤖 Initializing local ONNX model...');
    await modelManager.initialize();
    
    // Create default accounts
    await createDefaultAdmin();
    await createDefaultDoctors();
    console.log('✅ Default accounts setup completed');
    
    // Start server
    app.listen(PORT, () => {
      const modelStatus = modelManager.getModelStatus();
      
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📱 Medical Screening System is ready!`);
      console.log(`🌐 Access the application at: http://localhost:${PORT}`);
      console.log(`🤖 AI Model: Local ONNX ${modelStatus.isLoaded ? '(Loaded ✅)' : '(Not Loaded ❌)'}`);
      console.log(`📊 Model Source: ${modelStatus.modelSource}`);
      console.log(`📦 Repository: ${modelStatus.repository}`);
      console.log('');
      console.log('🔐 Default Login Credentials:');
      console.log('   Admin: admin / admin123');
      console.log('   Doctor 1: doctor1 / doctor1');
      console.log('   Doctor 2: doctor2 / doctor2');  
      console.log('   Doctor 3: doctor3 / doctor3');
      console.log('');
      if (!modelStatus.isLoaded) {
        console.log('⚠️ Warning: Local ONNX model not loaded!');
        console.log('   The system will use default predictions until the model loads.');
        console.log('   Check the model status at /api/model-status');
      }
    });
    
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}


if (process.env.VERCEL) {
  // For Vercel deployment - export the app
  module.exports = app;
} else {
  // For local development - start the server
  startServer();
}