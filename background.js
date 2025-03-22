let bloomFilter = null;
let plainLists = {};
let isInitialized = false;
let initializationPromise = null;
let enabledLists = {
  'genai': true,
  'redflag': true,
  'amf': true
};

const LIST_CONFIGS = {
  'genai': {
    type: 'bloom',
    filename: 'bloom-filter.json',
    message: "Le règlement européen sur l'intelligence artificielle obligera à partir d'août 2026 les contenus « synthétiques » à être identifiables comme ayant été générés ou manipulés par une IA.<br><br>Or, d'après les constatations (humaines) de Next.ink, des articles de ce site semblent avoir été (en tout ou partie) générés par IA.<br><br>Pour en savoir plus, nous signaler d'autres sites GenAI, ou si votre site aurait été identifié à tort, cliquez sur le bouton de l'extension.<br>",
    infoUrl: 'https://next.ink/153613/enquete-plus-de-1-000-medias-en-francais-generes-par-ia-polluent-le-web-et-google/',
    updateUrl: 'http://gavois.fr/bloom-filter.json'
  },
  'redflag': {
    type: 'plain',
    filename: 'test.txt',
    message: "Attention : ce site est dans la base de données de Red Flag Domains, une initiative qui référence des noms de domaine potentiellement malveillants.",
    infoUrl: 'https://red.flag.domains/',
    updateUrl: 'https://dl.red.flag.domains/red.flag.domains.txt'
  },
  'amf': {
    type: 'plain',
    filename: 'test2.txt',
    message: "Attention : ce site est dans la la liste noire  des sociétés et sites non autorisés par l'Autorité des marchés financiers.",
    infoUrl: 'https://www.amf-france.org/fr/espace-epargnants/proteger-son-epargne/listes-noires-et-mises-en-garde',
    updateUrl: 'https://next.ink/wp-content/uploads/2025/02/test2.txt'
  }
};

const exceptions = new Set([
  'web.archive.org',
  'wlp-acs.com',
  'matoo.net',
  'accountscenter.facebook.com',
  'univ-fcomte.fr',
  'iut-bm.univ-fcomte.fr',
  'atlassian.com',
  'atlassian.fr',
  'eligibilite-thd.fr',
  'la-pleiade.fr',
  'univ-lyon1.fr',
  'ccijp.net',
  'techouvot.com',
  'st.com',
  'mobilizon.org',
  'aisafety.dance',
  'esver.free.fr',
  'foundation.mozilla.org',
  'akeeba.com',
  'toobi.fr',
  'winehq.org/',
  'cedeo.fr',
  'streetpress.com',
  'centaure-marketing-ia.fr',
  'cloud.familleboisteau.fr',
  'blog.erreur503.xyz',
  'veepee.fr',
  'les-sans-hulotte.net',
  'grr.ensta-bretagne.fr',
  'rennes.maville.com'
]);

class BloomFilter {
  constructor(size, numHashes, bitArray) {
    this.size = size;
    this.numHashes = numHashes;
    this.bitArray = new Uint8Array(bitArray);
  }

  static fnv1a(string, seed = 0) {
    let hash = 2166136261 ^ seed;
    for (let i = 0; i < string.length; i++) {
      hash ^= string.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return hash >>> 0;
  }

  getHashValues(string) {
    const hashes = new Array(this.numHashes);
    for (let i = 0; i < this.numHashes; i++) {
      hashes[i] = BloomFilter.fnv1a(string, i) % this.size;
    }
    return hashes;
  }

  mightContain(string) {
    const hashes = this.getHashValues(string);
    for (let i = 0; i < hashes.length; i++) {
      if (this.bitArray[hashes[i]] === 0) return false;
    }
    return true;
  }

  static fromJSON(jsonData) {
    return new BloomFilter(jsonData.size, jsonData.numHashes, jsonData.bitArray);
  }
}

async function initializeExtension() {
  if (initializationPromise) return initializationPromise;
  
  initializationPromise = (async () => {
    
    // Charger d'abord depuis le storage
    await loadListsFromStorage();

    // Vérifier quand était la dernière mise à jour
    const { lastListUpdate } = await browser.storage.local.get('lastListUpdate');
    const now = Date.now();
    const needsUpdate = !lastListUpdate || (now - lastListUpdate > 12 * 60 * 60 * 1000); // 12h

    if (needsUpdate) {
      await updateAllLists();
    }
    
    isInitialized = true;
  })();
  
  return initializationPromise;
}

function getListCount(type) {
  if (LIST_CONFIGS[type].type === 'bloom') {
    if (bloomFilter) {
      try {
        const jsonString = JSON.stringify(bloomFilter);
        const fileSizeInBytes = new Blob([jsonString]).size;
        const fileSizeInKo = (fileSizeInBytes / 1024).toFixed(2);
        return { count: `${fileSizeInKo} ko` };
      } catch (error) {
        return { count: 'Erreur de calcul' };
      }
    }
    return { count: 'Non chargé' };
  } else {
    return { count: plainLists[type] ? plainLists[type].size : 0 };
  }
}

async function checkAndUpdateLists() {
  const lastUpdateKey = 'lastListUpdate';
  const now = Date.now();
  
  try {
    const { [lastUpdateKey]: lastUpdate } = await browser.storage.local.get(lastUpdateKey);
    
    if (!lastUpdate || (now - lastUpdate > 24 * 60 * 60 * 1000)) {
      await updateAllLists();
      await browser.storage.local.set({ [lastUpdateKey]: now });
    }
  } catch (error) {
  }
}

async function updateList(type) {
  try {
    const listConfig = LIST_CONFIGS[type];
    const response = await fetch(listConfig.updateUrl);

    if (!response.ok) {
      throw new Error(`Erreur HTTP ${response.status} lors du téléchargement de ${listConfig.updateUrl}`);
    }
    
    // Timestamp actuel pour cette liste
    const currentTimestamp = Date.now();

    if (listConfig.type === 'bloom') {
      const filterData = await response.json();
      bloomFilter = BloomFilter.fromJSON(filterData);
      await browser.storage.local.set({ 
        bloomFilter,
        bloomFilterTimestamp: currentTimestamp  // Ajouter le timestamp
      });
    } else {
      const text = await response.text();
      const urls = text.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
      plainLists[type] = new Set(urls);
      
      await browser.storage.local.set({ 
        [`plainList_${type}`]: Array.from(plainLists[type]),
        [`plainList_${type}_timestamp`]: currentTimestamp  // Ajouter le timestamp
      });
    }

    await browser.runtime.sendMessage({
      action: 'updateListCount',
      type: type,
      count: plainLists[type] ? plainLists[type].size : 0,
      timestamp: currentTimestamp
    });

  } catch (error) {
  }
}

async function updateAllLists() {
  try {
    const updatePromises = Object.keys(LIST_CONFIGS).map(type => updateList(type));
    await Promise.allSettled(updatePromises);
    
    const updateTime = new Date().toLocaleString();
    await browser.storage.local.set({ 
      lastListUpdate: Date.now(),
      lastListUpdateFormatted: updateTime 
    });
  } catch (error) {
  }
}

async function loadListsFromStorage() {
  try {
    const res = await browser.storage.local.get(null);

    if (!res.enabledLists) {
      const defaultLists = {
        'genai': true,
        'redflag': true,
        'amf': true
      };
      await browser.storage.local.set({ enabledLists: defaultLists });
      enabledLists = defaultLists;
    } else {
      enabledLists = res.enabledLists;
    }

    if (res.bloomFilter) {
      bloomFilter = BloomFilter.fromJSON(res.bloomFilter);
    }

    for (const key in res) {
      if (key.startsWith('plainList_') && !key.includes('timestamp')) {
        const listName = key.slice('plainList_'.length);
        plainLists[listName] = new Set(res[key]);
      }
    }

    isInitialized = true;

  } catch (error) {
  }
}

function cleanUrl(url) {
  try {
    if (!url) return null;

    let cleaned = url.toLowerCase()
      .replace(/^(https?:\/\/)?(www\.)?/, '')
      .replace(/\/$/, '')
      .split(/[/?#]/)[0];

    if (exceptions.has(cleaned)) {
      return null;
    }

    return cleaned;

  } catch (error) {
    return null;
  }
}

// Modification de checkUrl pour ajouter un délai et une vérification de l'état du tab
async function checkUrl(tabId, url, retry = 0) {
  await initializeExtension();

  const cleanedUrl = cleanUrl(url);

  // Vérifier si l'onglet existe et est prêt
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.status !== 'complete') {
      // Réessayer après un court délai si l'onglet n'est pas prêt
      if (retry < 3) {
        setTimeout(() => checkUrl(tabId, url, retry + 1), 500);
        return;
      }
    }
  } catch (error) {
    return;
  }

  const listsHaveData = Object.values(plainLists).some(list => list && list.size > 0);
  if (!listsHaveData) {
    await updateAllLists();
  }

  const config = await browser.storage.local.get('enabledLists');
  const enabledLists = config.enabledLists || {
    genai: true,
    redflag: true,
    amf: true
  };

  let matches = [];

  for (const [type, listConfig] of Object.entries(LIST_CONFIGS)) {
    if (listConfig.type === 'plain' && enabledLists[type] !== false) {
      if (plainLists[type] && plainLists[type].has(cleanedUrl)) {
        matches.push({ category: type, config: listConfig });
      }
    }
  }

  for (const [type, listConfig] of Object.entries(LIST_CONFIGS)) {
    if (listConfig.type === 'bloom' && bloomFilter && enabledLists[type] !== false) {
      if (bloomFilter.mightContain(cleanedUrl)) {
        matches.push({ category: type, config: listConfig });
      }
    }
  }

  if (matches.length > 0) {
    try {
      await browser.tabs.sendMessage(tabId, {
        action: "showNotification",
        matches: matches
      }).catch(error => {
        // Réessayer après un court délai
        setTimeout(async () => {
          try {
            await browser.tabs.sendMessage(tabId, {
              action: "showNotification",
              matches: matches
            });
          } catch (retryError) {
          }
        }, 1000);
      });
    } catch (error) {
    }
  }
}

async function ensureContentScriptLoaded(tabId, retry = 0) {
  if (retry >= 5) {
    return false;
  }

  try {
    const response = await browser.tabs.sendMessage(tabId, { action: "checkReady" });
    if (response && response.status === "ready") {
      return true;
    }
  } catch (error) {
    // Content script probablement pas encore chargé
    await new Promise(resolve => setTimeout(resolve, 200));
    return ensureContentScriptLoaded(tabId, retry + 1);
  }
  
  return false;
}

browser.runtime.onMessage.addListener(async (message, sender) => {
  await initializeExtension();

  if (message.action === 'getListCount') {
    const count = getListCount(message.type);
    return Promise.resolve({ count });
  }
  else if (message.action === 'toggleList') {
    try {
      const config = await browser.storage.local.get('enabledLists');
      const enabledLists = config.enabledLists || {
        genai: true,
        redflag: true,
        amf: true
      };
      
      enabledLists[message.type] = message.enabled;
      await browser.storage.local.set({ enabledLists });
      
      return Promise.resolve({ success: true });
    } catch (error) {
      return Promise.resolve({ success: false, error: error.message });
    }
  }
  else if (message.action === 'updateAllLists') {
    await updateAllLists();
  }
  else if (message.action === "contentScriptReady" && sender.tab) {
    // Vérifiez immédiatement l'URL
    checkUrl(sender.tab.id, sender.tab.url);
  }
  else if (message.action === "pageRevisited" && sender.tab) {
    // Vérifier l'URL à nouveau
    checkUrl(sender.tab.id, sender.tab.url);
  } else if (message.action === 'checkURL' && message.url) {
    console.log('Vérification de l\'URL:', message.url);
    getCategoryOfUrl(message.url).then((x) => {
      sendResponse(x);
    }, () => {
      console.log('Erreur lors de la catégorisation de l\'URL. Fallback.', message.url);
      sendResponse(categories['normal']);
    })
  }
  
  return Promise.resolve(undefined);
});

// Ajouter un écouteur pour les nouveaux onglets créés
browser.tabs.onCreated.addListener(async (tab) => {
  if (tab.url && !tab.url.startsWith('about:') && !tab.url.startsWith('moz-extension://')) {
    // Attendre un peu pour laisser le temps au content script de se charger
    setTimeout(() => checkUrl(tab.id, tab.url), 500);
  }
});

// Conserver l'écouteur existant pour les mises à jour d'onglets
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    checkUrl(tabId, tab.url);
  }
});

browser.runtime.onStartup.addListener(initializeExtension);
browser.runtime.onInstalled.addListener(async (details) => {
  await initializeExtension();
  
  await browser.alarms.create('listUpdateAlarm', {
    periodInMinutes: 60
  });
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'listUpdateAlarm') {
    await checkAndUpdateLists();
  }
});

browser.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await browser.tabs.get(activeInfo.tabId);
    
    // Si l'onglet a une URL valide, vérifier le domaine
    if (tab.url && !tab.url.startsWith('about:') && !tab.url.startsWith('moz-extension://')) {
      // Vérifier d'abord si le content script est réactif
      try {
        await browser.tabs.sendMessage(activeInfo.tabId, { action: "checkReady" });
        checkUrl(activeInfo.tabId, tab.url);
      } catch (error) {
        // Le content script n'est pas disponible, il faut attendre que Firefox réinjecte le content script
        // Une solution pour forcer le rechargement du content script serait d'utiliser tabs.executeScript 
        // mais cela nécessiterait des permissions supplémentaires
        
        // Attendons un peu et réessayons
        setTimeout(() => {
          browser.tabs.sendMessage(activeInfo.tabId, { action: "checkReady" })
            .then(() => checkUrl(activeInfo.tabId, tab.url))
            .catch(err => {});
        }, 500);
      }
    }
  } catch (error) {
  }
});

const categories = {
  "genai": {
    name: "genai",
    longLabel: "Site GenAI",
    shortLabel: "GenAI"
  },
  "amf": {
    name: "amf",
    longLabel: "Site sur la liste noire de l\'AMF",
    shortLabel: "AMF"
  },
  "redflag": {
    name: "redflag",
    longLabel: "Red Flag Domain",
    shortLabel: "Red Flag"
  }
}

async function getCategoryOfUrl(url) {
  try {
    await initializeExtension();

    const cleanedUrl = cleanUrl(url);
    if (!cleanedUrl) {
      return null;
    }

    const config = await storageGet('enabledLists');
    const enabledLists = config.enabledLists || {
      genai: true,
      redflag: true,
      amf: true
    };

    for (const [type, listConfig] of Object.entries(LIST_CONFIGS)) {
      if (listConfig.type === 'plain' && enabledLists[type] !== false) {
        if (plainLists[type] && plainLists[type].has(cleanedUrl)) {
          return categories[type];
        }
      }

      if (listConfig.type === 'bloom' && bloomFilter && enabledLists[type] !== false) {
        if (bloomFilter.mightContain(cleanedUrl)) {
          return categories[type];
        }
      }
    }   

  } catch (error) {
    console.error('Erreur critique lors de la vérification URL:', error);
  }  
  
  return null;
}

// Appeler initializeExtension au démarrage
initializeExtension();

