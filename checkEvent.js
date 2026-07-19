const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc } = require('firebase/firestore');
const fs = require('fs');

// We don't have the config, let's just grep the events from a snapshot if we can?
// Actually I don't have the firebase config available in node. 
