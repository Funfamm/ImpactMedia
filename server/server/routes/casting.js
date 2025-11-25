const express = require('express');
const multer = require('multer');
const { createSubfolder, uploadFile } = require('../utils/storage');
const { Resend } = require('resend');
const router = express.Router();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const resend = new Resend(process.env.RESEND_API_KEY);

const cpUpload = upload.fields([
    { name: 'photos', maxCount: 6 }, 
    { name: 'voice', maxCount: 1 }
]);

router.post('/', cpUpload, async (req, res) => {
    try {
        const formData = req.body;
        const files = req.files;

        // 1. Create a unique subfolder in Drive (e.g. "Applicant_Name_Timestamp")
        const folderName = `Applicant_${formData.name}_${Date.now()}`;
        const folderId = await createSubfolder(folderName);

        // 2. Upload Images to that Folder
        const imagePromises = (files['photos'] || []).map(file => uploadFile(file, folderId));
        const imageUrls = await Promise.all(imagePromises);

        // 3. Upload Voice to that Folder
        let voiceUrl = null;
        if (files['voice'] && files['voice'][0]) {
            voiceUrl = await uploadFile(files['voice'][0], folderId);
        }

        // 4. Send Email via Resend
        const emailContent = `
            <h1>New Casting Submission</h1>
            <p><strong>Name:</strong> ${formData.name}</p>
            <p><strong>Email:</strong> ${formData.email}</p>
            <p><strong>Handle:</strong> ${formData.socialType} / ${formData.social}</p>
            <p><strong>Location:</strong> ${formData.location}</p>
            <hr />
            <h3>Files</h3>
            <p><strong>Drive Folder:</strong> <a href="https://drive.google.com/drive/folders/${folderId}">Open Folder</a></p>
            <p><strong>Voice Sample:</strong> <a href="${voiceUrl || '#'}">${voiceUrl ? 'Listen' : 'No Audio'}</a></p>
            <p><strong>Images:</strong> ${imageUrls.length} uploaded</p>
            <ul>
                ${imageUrls.map(url => `<li><a href="${url}">View Image</a></li>`).join('')}
            </ul>
        `;

        await resend.emails.send({
            from: 'Casting Bot <onboarding@resend.dev>',
            to: process.env.ADMIN_EMAIL,
            subject: `New Casting: ${formData.name}`,
            html: emailContent
        });

        res.status(200).json({ success: true, message: "Application processed successfully" });

    } catch (error) {
        console.error("Casting Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
