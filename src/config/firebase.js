import admin from "firebase-admin";

let firebaseAdmin = null;

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

try {
  if (!projectId || !clientEmail || !privateKey) {
    console.warn("Firebase service account missing");
  } else {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
    }

    firebaseAdmin = admin;

    console.log("Firebase Admin initialized successfully");
  }
} catch (error) {
  console.error("Firebase initialization failed:", error.message);
}

export const firebaseMessaging = firebaseAdmin
  ? firebaseAdmin.messaging()
  : null;

export default firebaseAdmin;