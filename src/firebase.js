import { initializeApp } from 'firebase/app';
import { getAnalytics, logEvent } from 'firebase/analytics';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, setDoc, getDoc, getDocFromServer, deleteDoc,
  collection, getDocs, writeBatch,
  onSnapshot, query, orderBy, serverTimestamp, limit
} from 'firebase/firestore';
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';

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

export const auth = getAuth(app);
export const analytics = getAnalytics(app);

// Garante que a sessão persista entre fechamentos do app (crítico no Capacitor/WebView)
setPersistence(auth, browserLocalPersistence).catch(() => {});

// Firestore com persistência offline via IndexedDB
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});

export const storage = getStorage(app);
export const provider = new GoogleAuthProvider();

export {
  logEvent,
  signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged,
  doc, setDoc, getDoc, getDocFromServer, deleteDoc,
  collection, getDocs, writeBatch,
  onSnapshot, query, orderBy, serverTimestamp, limit,
  storageRef, uploadBytes, getDownloadURL, deleteObject,
};

// Expõe referências mínimas para o monitor de erros no index.html
// (script inline não tem acesso a módulos ES)
if (typeof window !== 'undefined') {
  window.__firebaseForErrors = { auth, db, doc, setDoc };
}
