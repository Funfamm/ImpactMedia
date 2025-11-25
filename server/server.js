const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const castingRoutes = require('./routes/casting');
const analyticsRoutes = require('./routes/analytics');
const sponsorRoutes = require('./routes/sponsor');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors()); // Allow Client to hit Server
app.use(express.json()); // Parse JSON bodies

// Routes
app.use('/api/casting', castingRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/sponsor', sponsorRoutes);

// Health Check
app.get('/', (req, res) => {
  res.send('AI Impact Media Server is Running');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
