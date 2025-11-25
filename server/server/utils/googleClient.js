const { google } = require('googleapis');
const path = require('path');

// Singleton Auth Client
const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/spreadsheets'
    ],
});

const getAuth = () => auth;

module.exports = { getAuth };
