import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, setDoc, getDoc, deleteDoc,
  collection, getDocs, writeBatch,
  onSnapshot, query, orderBy, serverTimestamp, limit
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyAMu4ViHLd0FnDb37RJcokY0ZRL9o5Y13s",
  authDomain: "escalacao-fc.firebaseapp.com",
  projectId: "escalacao-fc",
  storageBucket: "escalacao-fc.firebasestorage.app",
  messagingSenderId: "565171747971",
  appId: "1:565171747971:web:67dc73d4d270eb68b1efb6",
  measurementId: "G-TVLYCVCQD8"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Firestore com persistência offline via IndexedDB.
// Escritas feitas sem internet ficam na fila e são enviadas
// automaticamente assim que a conexão for restaurada.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});

const storage = getStorage(app);
const provider = new GoogleAuthProvider();

// Expose to global scope for Babel script
window.__firebase = {
  auth, db, storage, provider,
  signInWithPopup, signOut, onAuthStateChanged,
  doc, setDoc, getDoc, deleteDoc,
  collection, getDocs, writeBatch,
  onSnapshot, query, orderBy, serverTimestamp, limit,
  storageRef, uploadBytes, getDownloadURL, deleteObject
};
window.dispatchEvent(new Event("firebase-ready"));
