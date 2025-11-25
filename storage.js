const { google } = require('googleapis');
const { getAuth } = require('./googleClient');
const stream = require('stream');

const drive = google.drive({ version: 'v3', auth: getAuth() });
const MAIN_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

/**
 * Creates a subfolder inside the main Drive folder
 */
const createSubfolder = async (folderName) => {
    try {
        const fileMetadata = {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [MAIN_FOLDER_ID]
        };
        const file = await drive.files.create({
            resource: fileMetadata,
            fields: 'id'
        });
        return file.data.id;
    } catch (err) {
        console.error("Error creating folder:", err);
        throw err;
    }
};

/**
 * Uploads a file to a specific Google Drive folder
 * @param {Object} file - Multer file object
 * @param {String} parentFolderId - ID of the folder to upload into
 */
const uploadFile = async (file, parentFolderId) => {
    if (!file) return null;

    try {
        const bufferStream = new stream.PassThrough();
        bufferStream.end(file.buffer);

        const fileMetadata = {
            name: file.originalname,
            parents: [parentFolderId]
        };

        const media = {
            mimeType: file.mimetype,
            body: bufferStream
        };

        const response = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, webViewLink, webContentLink'
        });

        // OPTIONAL: Make file public to anyone with the link (so images display in emails)
        // If you want them private, remove this block.
        await drive.permissions.create({
            fileId: response.data.id,
            requestBody: {
                role: 'reader',
                type: 'anyone'
            }
        });

        // webViewLink is the viewable URL
        return response.data.webViewLink;

    } catch (err) {
        console.error("Drive Upload Error:", err);
        throw new Error(`Failed to upload ${file.originalname}`);
    }
};

module.exports = { createSubfolder, uploadFile };
