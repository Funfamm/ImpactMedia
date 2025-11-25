const { google } = require('googleapis');
const { getAuth } = require('../utils/googleClient'); // Use shared auth

const SHEET_ID = process.env.1-0gSI6dkkk3zOUr_hpw8H8vYUsWlCIxjheJBhp3wS8w;

const trackEventToSheet = async (data) => {
    try {
        const authClient = await getAuth().getClient();
        const sheets = google.sheets({ version: 'v4', auth: authClient });

        const row = [
            new Date().toISOString(),
            data.category,
            data.action,
            data.label,
            data.userAgent,
            data.page,
            data.sessionId,
            data.ip
        ];

        await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: 'Analytics!A:H',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [row] },
        });
        
        console.log("Analytics logged to Sheet");
    } catch (error) {
        // Log but don't crash the server if analytics fails
        console.error("Analytics Error:", error.message);
    }
};

module.exports = { trackEventToSheet };
