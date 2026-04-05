const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Uploads a proof-of-payment file to Cloudinary.
 *
 * @param {Object} file - Multer file object (has buffer and mimetype)
 * @param {string} locksmithCode - Customer code used as the public_id prefix
 * @returns {Promise<{ url: string, publicId: string }>}
 */
async function uploadProofOfPayment(file, locksmithCode) {
  if (
    !process.env.CLOUDINARY_CLOUD_NAME?.trim() ||
    !process.env.CLOUDINARY_API_KEY?.trim() ||
    !process.env.CLOUDINARY_API_SECRET?.trim()
  ) {
    return Promise.reject(
      new Error(
        "Cloudinary env missing: set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET"
      )
    );
  }

  return new Promise((resolve, reject) => {
    const safeCode = locksmithCode.replace(/[^a-zA-Z0-9_-]/g, "_");
    const timestamp = Date.now();
    const publicId = `vula24/proof-of-payment/${safeCode}_${timestamp}`;

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        resource_type: "auto",
        folder: undefined, // public_id already contains the folder path
      },
      (error, result) => {
        if (error) {
          console.error("[Cloudinary] Upload error:", error);
          return reject(new Error(error.message || "Cloudinary upload failed"));
        }
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
        });
      }
    );

    uploadStream.end(file.buffer);
  });
}

module.exports = { uploadProofOfPayment };
