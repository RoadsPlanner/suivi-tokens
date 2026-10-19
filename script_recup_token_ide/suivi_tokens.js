#!/usr/bin/env node
/*
 * Récupère les tokens consommés dans Antigravity (Gemini) et dans Claude Code
 * à partir des conversations enregistrées sur ce PC, puis les affiche par jour,
 * semaine, mois, outil, projet, modèle ou conversation.
 *
 * Chaque lancement complète un historique local (historique-tokens.json) :
 * l'utilisation reste comptée même quand l'outil efface ses anciennes
 * conversations (Claude Code les supprime par défaut au bout de 30 jours).
 *
 * Aucune dépendance : il faut seulement Node.js 22.5 ou plus récent
 * (module node:sqlite). Les bases d'Antigravity sont lues sur une copie
 * temporaire, les originaux ne sont jamais modifiés.
 *
 * Aide : node suivi_tokens.js --aide
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

process.removeAllListeners('warning'); // masque l'avertissement « SQLite is experimental »
const { DatabaseSync } = require('node:sqlite');

const ICI = __dirname;
const AIDE = `
Utilisation : node suivi_tokens.js [vue] [options]

Vues :
  tableau-de-bord tableau de bord visuel dans le navigateur   [par défaut]
  jour            tokens par jour
  semaine         tokens par semaine (du lundi au dimanche)
  mois            tokens par mois
  outil           tokens par outil (Antigravity, Claude Code)
  projet          tokens par projet (dossier de travail)
  modele          tokens par modèle (Gemini 3.1 Pro, claude-opus-5-5...)
  conversation    tokens par conversation
  detail          une ligne par réponse de l'IA
  equipe          lignes « semaine,membre,tokens » à coller dans donnees/consommation.csv

Options :
  --depuis AAAA-MM-JJ      ne garde que l'utilisation à partir de cette date
  --jusqua AAAA-MM-JJ      ne garde que l'utilisation jusqu'à cette date
  --projet TEXTE           ne garde que les projets dont le nom contient TEXTE (ex. SAE, Trek)
  --outil antigravity|claude ne garde qu'un outil
  --colonnes projet|modele|outil  une colonne par projet, modèle ou outil (avec jour, semaine ou mois)
  --sans-cache             ne compte pas les tokens lus depuis le cache
  --csv FICHIER            enregistre le résultat en CSV (s'ouvre dans Excel)
  --json FICHIER           enregistre le résultat en JSON
  --sans-ouvrir            (tableau-de-bord) génère la page sans l'ouvrir
  --aide                   affiche cette aide

Exemples :
  node suivi_tokens.js
  node suivi_tokens.js semaine --projet SAE
  node suivi_tokens.js semaine --projet SAE --colonnes projet
  node suivi_tokens.js semaine --colonnes outil
  node suivi_tokens.js mois --csv mois.csv
  node suivi_tokens.js equipe --projet SAE --sans-cache
`;

// ---------------------------------------------------------------- options

function lireOptions(argv) {
  const o = { vue: 'tableau-de-bord' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const valeur = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Il manque une valeur après ${a}.`);
      return v;
    };
    if (a === '--aide' || a === '-h' || a === '--help') o.aide = true;
    else if (a === '--depuis') o.depuis = date(valeur(), a);
    else if (a === '--jusqua') o.jusqua = date(valeur(), a);
    else if (a === '--projet') o.projet = valeur().toLowerCase();
    else if (a === '--colonnes') o.colonnes = valeur();
    else if (a === '--outil') o.outil = valeur().toLowerCase();
    else if (a === '--sans-cache') o.sansCache = true;
    else if (a === '--sans-ouvrir') o.sansOuvrir = true;
    else if (a === '--csv') o.csv = valeur();
    else if (a === '--json') o.json = valeur();
    else if (!a.startsWith('-')) o.vue = a;
    else throw new Error(`Option inconnue : ${a}`);
  }
  const vues = ['tableau-de-bord', 'jour', 'semaine', 'mois', 'outil', 'projet', 'modele', 'conversation', 'detail', 'equipe'];
  if (!vues.includes(o.vue)) throw new Error(`Vue inconnue : ${o.vue} (choix : ${vues.join(', ')}).`);
  if (o.colonnes && !['projet', 'modele', 'outil'].includes(o.colonnes)) throw new Error('--colonnes accepte projet, modele ou outil.');
  if (o.outil && !['antigravity', 'claude'].includes(o.outil)) throw new Error('--outil accepte antigravity ou claude.');
  return o;
}

function date(v, option) {
  const texte = v.trim();
  // Supporte AAAA-MM-JJ ou JJ/MM/AAAA
  if (/^\d{4}-\d{2}-\d{2}$/.test(texte)) return texte;
  const matchFr = texte.match(/^(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{4})$/);
  if (matchFr) {
    const j = matchFr[1].padStart(2, '0');
    const m = matchFr[2].padStart(2, '0');
    const a = matchFr[3];
    return `${a}-${m}-${j}`;
  }
  throw new Error(`${option} attend une date valide (ex. AAAA-MM-JJ ou JJ/MM/AAAA, reçu : ${v}).`);
}

function lireConfig() {
  const fichier = path.join(ICI, 'config.json');
  const c = JSON.parse(fs.readFileSync(fichier, 'utf8'));
  const maison = d => d.replace(/^~/, os.homedir());
  c.dossiersConversations = (c.dossiersConversations || []).map(maison);
  c.dossiersClaude = (c.dossiersClaude || ['~/.claude/projects']).map(maison);
  c.fichierHistorique = path.resolve(ICI, c.fichierHistorique || 'historique-tokens.json');
  c.dossierExportClaudeAi = path.resolve(ICI, maison(c.dossierExportClaudeAi || 'exports-claude-ai'));
  return c;
}

// --------------------------------------------- lecture protobuf sans schéma
// Antigravity enregistre ses données en protobuf. On décode la structure
// brute (numéros de champs) sans connaître le schéma.

function varint(b, i) {
  let r = 0n, s = 0n;
  for (;;) {
    if (i >= b.length) throw new Error('fin');
    const x = b[i++];
    r |= BigInt(x & 127) << s;
    s += 7n;
    if (!(x & 128)) return [r, i];
  }
}

function decoder(b, profondeur = 0) {
  const champs = [];
  let i = 0;
  try {
    while (i < b.length) {
      let cle;
      [cle, i] = varint(b, i);
      const num = Number(cle >> 3n), type = Number(cle & 7n);
      if (num === 0) return null;
      if (type === 0) { let v; [v, i] = varint(b, i); champs.push([num, v]); }
      else if (type === 1) { i += 8; }
      else if (type === 5) { i += 4; }
      else if (type === 2) {
        let l; [l, i] = varint(b, i); l = Number(l);
        if (i + l > b.length) return null;
        const sous = b.subarray(i, i + l); i += l;
        champs.push([num, sous, profondeur < 10 ? decoder(sous, profondeur + 1) : null]);
      } else return null;
    }
  } catch { return null; }
  return champs;
}

// Suit un chemin de numéros de champs : champ(arbre, 1, 9, 4, 1)
function champ(arbre, ...chemin) {
  let noeud = arbre, brut;
  for (const n of chemin) {
    const c = noeud && noeud.find(x => x[0] === n);
    if (!c) return undefined;
    brut = c[1];
    noeud = c[2];
  }
  return { brut, noeud };
}
const entier = c => (c && typeof c.brut === 'bigint' ? Number(c.brut) : 0);
const texte = c => (c && Buffer.isBuffer(c.brut) ? c.brut.toString('utf8') : undefined);

// ------------------------------------------------ extraction des réponses

// Copie la base (avec ses fichiers -wal et -shm) pour ne jamais toucher l'original.
function copier(fichierDb, dossierTemp) {
  const cible = path.join(dossierTemp, path.basename(fichierDb));
  for (const suffixe of ['', '-wal', '-shm']) {
    if (fs.existsSync(fichierDb + suffixe)) fs.copyFileSync(fichierDb + suffixe, cible + suffixe);
  }
  return cible;
}

// Chemin de travail lisible : « BUT3/SAE » plutôt que « C:/Users/.../Documents/BUT3/SAE ».
function nomDossier(chemin) {
  if (!chemin) return '(sans dossier)';
  const p = chemin.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/\/scratch-workspaces\//i.test(p)) return '(session sans dossier)';
  const docs = p.search(/\/Documents\//i);
  if (docs >= 0) return p.slice(docs + '/Documents/'.length);
  const maison = p.match(/^(?:[a-z]:\/Users\/[^/]+|\/home\/[^/]+|\/Users\/[^/]+)\/(.+)$/i);
  return maison ? maison[1] : p;
}

function dossierProjet(db) {
  const ligne = db.prepare('select data from trajectory_metadata_blob').get();
  if (!ligne) return '(sans dossier)';
  const m = Buffer.from(ligne.data).toString('latin1').match(/file:\/\/\/[^\x00-\x1f"]+/);
  if (!m) return '(sans dossier)';
  let p;
  try { p = decodeURIComponent(m[0]); } catch { p = m[0]; }
  return nomDossier(p.replace(/^file:\/\/\//, ''));
}

// Pour un dossier partagé par plusieurs sous-projets (ex. BUT3/SAE), on regarde
// de quoi parle la conversation : le sous-projet dont les mots-clés reviennent
// le plus souvent l'emporte. Le contenu n'est lu que si une règle concerne ce dossier.
function sousProjet(lireContenu, dossier, regles) {
  const candidates = regles.filter(r => r.dossiers.some(d => d.toLowerCase() === dossier.toLowerCase()));
  if (!candidates.length) return dossier;
  const contenu = lireContenu();
  let meilleur = null, max = 0;
  for (const r of candidates) {
    const n = r.motsCles.reduce((s, mot) => s + (contenu.match(new RegExp(mot, 'gi')) || []).length, 0);
    if (n > max) { max = n; meilleur = r.nom; }
  }
  return meilleur || dossier;
}

function jourLocal(ms) {
  return new Date(ms).toLocaleDateString('sv-SE'); // AAAA-MM-JJ, fuseau du PC
}

// Antigravity : une base SQLite par conversation, une ligne gen_metadata par réponse.
function extraireAntigravity(config) {
  const dossierTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokens-antigravity-'));
  const reponses = [];
  try {
    for (const dossier of config.dossiersConversations) {
      if (!fs.existsSync(dossier)) continue;
      for (const nom of fs.readdirSync(dossier).filter(f => f.endsWith('.db'))) {
        let db;
        try {
          db = new DatabaseSync(copier(path.join(dossier, nom), dossierTemp));
          const tables = db.prepare("select name from sqlite_master where type='table'").all().map(t => t.name);
          if (!tables.includes('gen_metadata') || !tables.includes('trajectory_metadata_blob')) continue;
          const dossierP = dossierProjet(db);
          const projet = sousProjet(() => {
            let contenu = '';
            for (const table of ['steps', 'gen_metadata', 'executor_metadata']) {
              for (const ligne of db.prepare(`select * from ${table}`).all()) {
                for (const v of Object.values(ligne)) if (v instanceof Uint8Array) contenu += Buffer.from(v).toString('utf8') + ' ';
              }
            }
            return contenu;
          }, dossierP, config.sousProjets || []);
          const conversation = nom.replace(/\.db$/, '');
          for (const ligne of db.prepare('select idx, data from gen_metadata').all()) {
            const arbre = decoder(Buffer.from(ligne.data));
            const gen = arbre && champ(arbre, 1);
            if (!gen || !gen.noeud) continue;
            const secondes = entier(champ(gen.noeud, 9, 4, 1));
            if (!secondes) continue;
            const u = champ(gen.noeud, 4);
            const n = k => entier(u && champ(u.noeud, k));
            reponses.push({
              cle: `ag:${conversation}:${ligne.idx}`,
              outil: 'Antigravity',
              date: jourLocal(secondes * 1000),
              heure: new Date(secondes * 1000).toLocaleTimeString('fr-FR'),
              modele: texte(champ(gen.noeud, 21)) || texte(champ(gen.noeud, 19)) || 'inconnu',
              projet,
              dossier: dossierP,
              conversation,
              entree: n(2),
              sortie: n(3),
              cache: n(5),
              reflexion: n(9),
            });
          }
        } catch (e) {
          console.error(`Conversation Antigravity ignorée (${nom}) : ${e.message}`);
        } finally {
          if (db) db.close();
        }
      }
    }
  } finally {
    fs.rmSync(dossierTemp, { recursive: true, force: true });
  }
  return reponses;
}

// Claude Code : un fichier .jsonl par session ; chaque réponse de l'API porte son « usage ».
// Une même réponse peut être écrite sur plusieurs lignes : on la compte une seule fois.
function extraireClaude(config) {
  const reponses = [];
  const vues = new Set();
  const fichiers = [];
  const parcourir = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) parcourir(p);
      else if (e.name.endsWith('.jsonl')) fichiers.push(p);
    }
  };
  for (const dossier of config.dossiersClaude) {
    try { if (fs.existsSync(dossier)) parcourir(dossier); } catch (e) { console.error(`Dossier Claude illisible (${dossier}) : ${e.message}`); }
  }
  for (const fichier of fichiers) {
    let lignes;
    try { lignes = fs.readFileSync(fichier, 'utf8').split('\n'); } catch (e) { console.error(`Session Claude ignorée (${fichier}) : ${e.message}`); continue; }
    const contenu = () => lignes.join(' ');
    const projets = new Map(); // dossier -> projet, calculé une fois par session
    // Un « cd » dans un sous-dossier pendant la session reste rattaché au dossier de départ.
    const racines = [];
    const dossierDe = cwd => {
      if (!cwd) return nomDossier(cwd);
      const p = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
      const racine = racines.find(r => p.toLowerCase() === r.toLowerCase() || p.toLowerCase().startsWith(r.toLowerCase() + '/'));
      if (!racine) racines.push(p);
      return nomDossier(racine || p);
    };
    for (const ligne of lignes) {
      if (!ligne.includes('"usage"')) continue;
      let o;
      try { o = JSON.parse(ligne); } catch { continue; }
      const m = o.message, u = m && m.usage;
      if (!u || !o.timestamp || m.model === '<synthetic>') continue;
      const id = `${m.id || ''}:${o.requestId || ''}`;
      if (id !== ':' && vues.has(id)) continue;
      vues.add(id);
      const quand = new Date(o.timestamp);
      const dossier = dossierDe(o.cwd);
      if (!projets.has(dossier)) projets.set(dossier, sousProjet(contenu, dossier, config.sousProjets || []));
      const reflexion = (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
      reponses.push({
        cle: `cc:${id !== ':' ? id : o.uuid}`,
        outil: 'Claude Code',
        date: jourLocal(quand.getTime()),
        heure: quand.toLocaleTimeString('fr-FR'),
        modele: m.model || 'inconnu',
        projet: projets.get(dossier),
        dossier,
        conversation: o.sessionId || path.basename(fichier, '.jsonl'),
        // L'écriture dans le cache est facturée comme de l'entrée : on la compte avec l'entrée.
        entree: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        sortie: Math.max(0, (u.output_tokens || 0) - reflexion),
        cache: u.cache_read_input_tokens || 0,
        reflexion,
      });
    }
  }
  return reponses;
}

// --------------------------------------------- claude.ai (export des données)
// L'export de claude.ai (Paramètres › Confidentialité › Exporter les données) donne
// le texte des conversations, pas les tokens. On les estime à partir du nombre de
// caractères : c'est un ordre de grandeur, pas une mesure.

// Lecteur ZIP minimal (méthodes « stocké » et « deflate »), pour lire l'export sans le décompresser.
function lireZip(fichier) {
  const zlib = require('zlib');
  const b = fs.readFileSync(fichier);
  let fin = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { fin = i; break; }
  }
  if (fin < 0) throw new Error("ce n'est pas une archive ZIP lisible");
  const nb = b.readUInt16LE(fin + 10);
  let p = b.readUInt32LE(fin + 16);
  const entrees = new Map();
  for (let k = 0; k < nb; k++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('archive ZIP abîmée');
    const methode = b.readUInt16LE(p + 10), taille = b.readUInt32LE(p + 20);
    const ln = b.readUInt16LE(p + 28), le = b.readUInt16LE(p + 30), lc = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const nom = b.toString('utf8', p + 46, p + 46 + ln);
    entrees.set(nom, () => {
      const debut = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
      const donnees = b.subarray(debut, debut + taille);
      if (methode === 0) return donnees;
      if (methode === 8) return zlib.inflateRawSync(donnees);
      throw new Error(`compression ${methode} non gérée`);
    });
    p += 46 + ln + le + lc;
  }
  return entrees;
}

// Renvoie le contenu de chaque conversations.json trouvé (dans un dossier, un .zip ou directement).
function exportsClaudeAi(dossier) {
  const textes = [];
  if (!fs.existsSync(dossier)) return textes;
  const parcourir = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) parcourir(p);
      else if (e.name.toLowerCase() === 'conversations.json') textes.push([p, fs.readFileSync(p, 'utf8')]);
      else if (e.name.toLowerCase().endsWith('.zip')) {
        try {
          for (const [nom, lire] of lireZip(p)) {
            if (path.basename(nom).toLowerCase() === 'conversations.json') textes.push([`${p} › ${nom}`, lire().toString('utf8')]);
          }
        } catch (err) { console.error(`Export ignoré (${p}) : ${err.message}`); }
      }
    }
  };
  parcourir(dossier);
  return textes;
}

function extraireClaudeAi(config) {
  const ratio = config.caracteresParToken || 3.5;
  const estimer = n => Math.round(n / ratio);
  const reponses = [];
  for (const [source, texteJson] of exportsClaudeAi(config.dossierExportClaudeAi)) {
    let conversations;
    try { conversations = JSON.parse(texteJson); } catch (e) { console.error(`Export illisible (${source}) : ${e.message}`); continue; }
    if (!Array.isArray(conversations)) continue;
    for (const conv of conversations) {
      const messages = [...(conv.chat_messages || [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      // Les règles de sousProjets dont les dossiers contiennent « claude.ai » rangent la conversation selon ses mots-clés.
      const projet = sousProjet(() => (conv.name || '') + ' ' + JSON.stringify(messages), 'claude.ai', config.sousProjets || []);
      let contexte = 0;   // caractères déjà échangés : relus par le modèle à chaque réponse
      let enAttente = 0;  // caractères envoyés depuis la dernière réponse
      for (const m of messages) {
        let texte = 0, reflexion = 0;
        const blocs = Array.isArray(m.content) && m.content.length ? m.content : [{ type: 'text', text: m.text || '' }];
        for (const c of blocs) {
          if (c.type === 'thinking') reflexion += String(c.thinking || '').length;
          else if (c.type === 'tool_use') texte += JSON.stringify(c.input || {}).length;
          else if (c.type === 'tool_result') texte += JSON.stringify(c.content || '').length;
          else texte += String(c.text || '').length;
        }
        for (const pj of m.attachments || []) texte += String(pj.extracted_content || '').length;
        if (m.sender !== 'assistant') { enAttente += texte; continue; }
        const quand = new Date(m.created_at);
        if (isNaN(quand)) continue;
        reponses.push({
          cle: `ai:${m.uuid || conv.uuid + ':' + m.created_at}`,
          outil: 'Claude.ai',
          date: jourLocal(quand.getTime()),
          heure: quand.toLocaleTimeString('fr-FR'),
          modele: m.model || conv.model || 'claude.ai (estimation)',
          projet,
          dossier: 'claude.ai',
          conversation: conv.name ? `${conv.name} (${String(conv.uuid).slice(0, 8)})` : String(conv.uuid),
          entree: estimer(enAttente),
          sortie: estimer(texte),
          cache: estimer(contexte),
          reflexion: estimer(reflexion),
        });
        contexte += enAttente + texte;
        enAttente = 0;
      }
    }
  }
  return reponses;
}

// --------------------------------------------- quota d'abonnement Claude
// L'appli Claude note régulièrement le pourcentage utilisé de l'abonnement :
// fenêtre de 5 heures (fh) et semaine glissante (sd). Tous les usages sont
// compris (claude.ai, appli, Claude Code), mais seulement pendant que l'appli est ouverte.
function fichiersQuota(config) {
  if (config.fichiersQuotaClaude) return config.fichiersQuotaClaude;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const candidats = [path.join(roaming, 'Claude', 'plan-usage-history.json')];
  for (const base of [path.join(local, 'Claude-Data'), path.join(local, 'Packages')]) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base)) {
      candidats.push(path.join(base, d, 'plan-usage-history.json'));
      candidats.push(path.join(base, d, 'LocalCache', 'Roaming', 'Claude', 'plan-usage-history.json'));
    }
  }
  return candidats.filter(f => fs.existsSync(f));
}

function lireQuota(config) {
  const releves = [];
  for (const f of fichiersQuota(config)) {
    try {
      const h = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const s of h.samples || []) {
        if (s && s.t && s.u) releves.push({ t: s.t, cinqHeures: Number(s.u.fh) || 0, semaine: Number(s.u.sd) || 0 });
      }
    } catch (e) { console.error(`Quota illisible (${f}) : ${e.message}`); }
  }
  return releves;
}

// ------------------------------------------------------------- historique
// L'historique garde chaque réponse et chaque relevé de quota déjà vus. Les lectures
// du jour les mettent à jour, et ce que les outils ont effacé depuis reste compté.
const CHAMPS = ['cle', 'outil', 'date', 'heure', 'modele', 'projet', 'dossier', 'conversation', 'entree', 'sortie', 'cache', 'reflexion'];

function fusionnerHistorique(fichier, nouvelles, releves) {
  const tout = new Map();
  const quota = new Map();
  if (fs.existsSync(fichier)) {
    try {
      const h = JSON.parse(fs.readFileSync(fichier, 'utf8'));
      for (const l of h.lignes || []) tout.set(l[0], Object.fromEntries(CHAMPS.map((c, i) => [c, l[i]])));
      for (const q of h.quota || []) quota.set(q[0], { t: q[0], cinqHeures: q[1], semaine: q[2] });
    } catch (e) {
      console.error(`Historique illisible (${fichier}) : ${e.message}. Il sera recréé.`);
    }
  }
  const avant = tout.size;
  for (const r of nouvelles) tout.set(r.cle, r);
  for (const q of releves) quota.set(q.t, q);
  const lignes = [...tout.values()].sort((a, b) => (a.date + a.heure).localeCompare(b.date + b.heure));
  const releveTries = [...quota.values()].sort((a, b) => a.t - b.t);
  const temp = fichier + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({
    version: 2,
    misAJour: new Date().toISOString(),
    lignes: lignes.map(r => CHAMPS.map(c => r[c])),
    quota: releveTries.map(q => [q.t, q.cinqHeures, q.semaine]),
  }));
  fs.renameSync(temp, fichier);
  return { reponses: lignes, quota: releveTries, ajoutees: tout.size - avant };
}

function extraire(config) {
  const nouvelles = [...extraireAntigravity(config), ...extraireClaude(config), ...extraireClaudeAi(config)];
  const { reponses, quota, ajoutees } = fusionnerHistorique(config.fichierHistorique, nouvelles, lireQuota(config));
  const conversations = new Set(reponses.map(r => r.outil + r.conversation));
  return { reponses, quota, nbConversations: conversations.size, ajoutees };
}

// ------------------------------------------------------------ regroupements

function lundi(jour) {
  const d = new Date(jour + 'T12:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return jourLocal(d.getTime());
}

const fr = jour => jour.split('-').reverse().join('/');
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

const CLES = {
  jour: r => r.date,
  semaine: r => lundi(r.date),
  mois: r => r.date.slice(0, 7),
  outil: r => r.outil,
  projet: r => r.projet,
  modele: r => r.modele,
  conversation: r => r.outil + ' · ' + r.conversation,
};

function libelle(vue, cle) {
  if (vue === 'jour') return fr(cle);
  if (vue === 'semaine') return 'Sem. du ' + fr(cle);
  if (vue === 'mois') { const [a, m] = cle.split('-'); return `${MOIS[Number(m) - 1]} ${a}`; }
  return cle;
}

const total = (r, sansCache) => r.entree + r.sortie + r.reflexion + (sansCache ? 0 : r.cache);

function regrouper(reponses, vue, o) {
  const groupes = new Map();
  for (const r of reponses) {
    const k = CLES[vue](r);
    const g = groupes.get(k) || { cle: k, entree: 0, sortie: 0, cache: 0, reflexion: 0, reponses: 0, projets: new Set(), debut: r.date, fin: r.date };
    g.entree += r.entree; g.sortie += r.sortie; g.cache += r.cache; g.reflexion += r.reflexion; g.reponses++;
    g.projets.add(r.projet);
    if (r.date < g.debut) g.debut = r.date;
    if (r.date > g.fin) g.fin = r.date;
    groupes.set(k, g);
  }
  const liste = [...groupes.values()];
  if (['jour', 'semaine', 'mois'].includes(vue)) liste.sort((a, b) => a.cle.localeCompare(b.cle));
  else liste.sort((a, b) => total(b, o.sansCache) - total(a, o.sansCache));
  return liste;
}

// ------------------------------------------------------------------ affichage

const nombre = n => Math.round(n).toLocaleString('fr-FR').replace(/[  ]/g, ' ');

function tableau(entetes, lignes, alignDroite, avecTotal) {
  const toutes = [entetes, ...lignes];
  const larg = entetes.map((_, i) => Math.max(...toutes.map(l => String(l[i]).length)));
  const ligne = l => l.map((c, i) => (alignDroite(i) ? String(c).padStart(larg[i]) : String(c).padEnd(larg[i]))).join('  ');
  const sep = larg.map(w => '─'.repeat(w)).join('  ');
  const corps = lignes.map(ligne);
  if (avecTotal && corps.length > 1) corps.splice(corps.length - 1, 0, sep); // trait avant la ligne TOTAL
  return [ligne(entetes), sep, ...corps].join('\n');
}

function vueSimple(reponses, vue, o) {
  const groupes = regrouper(reponses, vue, o);
  const premiere = { jour: 'Jour', semaine: 'Semaine', mois: 'Mois', outil: 'Outil', projet: 'Projet', modele: 'Modèle', conversation: 'Conversation' }[vue];
  const entetes = [premiere, 'Entrée', 'Sortie', ...(o.sansCache ? [] : ['Cache']), 'Réflexion', 'Total', 'Réponses'];
  if (vue === 'conversation') entetes.splice(1, 0, 'Projet', 'Du', 'Au');
  const lignes = groupes.map(g => {
    const l = [libelle(vue, g.cle), g.entree, g.sortie, ...(o.sansCache ? [] : [g.cache]), g.reflexion, total(g, o.sansCache), g.reponses];
    if (vue === 'conversation') l.splice(1, 0, [...g.projets].join(', '), fr(g.debut), fr(g.fin));
    return l;
  });
  const somme = k => groupes.reduce((s, g) => s + g[k], 0);
  const t = { entree: somme('entree'), sortie: somme('sortie'), cache: somme('cache'), reflexion: somme('reflexion') };
  const ligneTotal = ['TOTAL', t.entree, t.sortie, ...(o.sansCache ? [] : [t.cache]), t.reflexion, total(t, o.sansCache), somme('reponses')];
  if (vue === 'conversation') ligneTotal.splice(1, 0, '', '', '');
  return { entetes, lignes: [...lignes, ligneTotal] };
}

function vueCroisee(reponses, vue, o) {
  const champCol = o.colonnes;
  const colonnes = [...new Set(reponses.map(r => r[champCol]))].sort();
  const lignesMap = new Map();
  for (const r of reponses) {
    const k = CLES[vue](r);
    const l = lignesMap.get(k) || Object.fromEntries(colonnes.map(c => [c, 0]));
    l[r[champCol]] += total(r, o.sansCache);
    lignesMap.set(k, l);
  }
  const cles = [...lignesMap.keys()].sort();
  const entetes = [{ jour: 'Jour', semaine: 'Semaine', mois: 'Mois' }[vue], ...colonnes, 'Total'];
  const lignes = cles.map(k => {
    const v = colonnes.map(c => lignesMap.get(k)[c]);
    return [libelle(vue, k), ...v, v.reduce((a, b) => a + b, 0)];
  });
  const tot = colonnes.map((_, i) => lignes.reduce((s, l) => s + l[i + 1], 0));
  lignes.push(['TOTAL', ...tot, tot.reduce((a, b) => a + b, 0)]);
  return { entetes, lignes };
}

function vueDetail(reponses, o) {
  const entetes = ['Date', 'Heure', 'Outil', 'Projet', 'Modèle', 'Entrée', 'Sortie', 'Cache', 'Réflexion', 'Total', 'Conversation'];
  const tri = [...reponses].sort((a, b) => (a.date + a.heure).localeCompare(b.date + b.heure));
  const lignes = tri.map(r => [fr(r.date), r.heure, r.outil, r.projet, r.modele, r.entree, r.sortie, r.cache, r.reflexion, total(r, o.sansCache), r.conversation]);
  return { entetes, lignes, sansTotal: true };
}

// Lignes au format de donnees/consommation.csv du dépôt suivi-tokens.
function vueEquipe(reponses, o, config) {
  const debut = new Date(lundi(config.debutSemaine1) + 'T12:00:00');
  const parSemaine = new Map();
  for (const r of reponses) {
    const n = Math.floor((new Date(lundi(r.date) + 'T12:00:00') - debut) / (7 * 86400000)) + 1;
    if (n < 1) continue;
    parSemaine.set(n, (parSemaine.get(n) || 0) + total(r, o.sansCache));
  }
  const entetes = ['semaine', 'membre', 'tokens'];
  const lignes = [...parSemaine.keys()].sort((a, b) => a - b).map(n => [n, config.membre, parSemaine.get(n)]);
  return { entetes, lignes, sansTotal: true, brut: true };
}

// --------------------------------------------------------------- export

function versCsv(entetes, lignes, separateur) {
  const cellule = c => {
    const s = String(c);
    return /[;",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [entetes, ...lignes].map(l => l.map(cellule).join(separateur)).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- principal

async function main() {
  const o = lireOptions(process.argv.slice(2));
  if (o.aide) { console.log(AIDE); return; }
  const config = lireConfig();

  const donnees = extraire(config);
  if (!donnees.reponses.length) {
    console.log('Aucune conversation trouvée dans :\n  ' + [...config.dossiersConversations, ...config.dossiersClaude].join('\n  '));
    return;
  }
  if (o.vue === 'tableau-de-bord') tableauDeBord(o, config, donnees);
  else afficher(o, config, donnees);
}

// Page HTML autonome (données intégrées) : s'ouvre sans connexion internet.
function tableauDeBord(o, config, { reponses, quota }) {
  const modele = fs.readFileSync(path.join(ICI, 'modele_tableau_de_bord.html'), 'utf8');
  const donnees = {
    genere: new Date().toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }),
    raccourcis: config.raccourcis || [],
    filtreParDefaut: config.filtreParDefaut || '',
    quota: (quota || []).map(q => [q.t, q.cinqHeures, q.semaine]),
    lignes: reponses.map(r => [r.date, r.projet, r.modele, r.conversation, r.entree, r.sortie, r.cache, r.reflexion, r.outil]),
  };
  const json = JSON.stringify(donnees).replace(/</g, '\\u003c');
  const sortie = path.join(ICI, 'tableau-de-bord-tokens.html');
  fs.writeFileSync(sortie, modele.replace("/*__DONNEES__*/ { genere: '', lignes: [], colonnes: [] }", json));
  console.log(`
Tableau de bord enregistré : ${sortie}`);
  if (!o.sansOuvrir) {
    const { spawn } = require('child_process');
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', sortie]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [sortie]];
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
    console.log('Ouverture dans le navigateur...');
  }
}

function afficher(o, config, { reponses: toutes, nbConversations }) {
  const reponses = toutes.filter(r =>
    (!o.depuis || r.date >= o.depuis) &&
    (!o.jusqua || r.date <= o.jusqua) &&
    (!o.projet || r.projet.toLowerCase().includes(o.projet) || r.dossier.toLowerCase().includes(o.projet)) &&
    (!o.outil || r.outil.toLowerCase().startsWith(o.outil)));

  let res;
  if (o.vue === 'detail') res = vueDetail(reponses, o);
  else if (o.vue === 'equipe') res = vueEquipe(reponses, o, config);
  else if (o.colonnes && ['jour', 'semaine', 'mois'].includes(o.vue)) res = vueCroisee(reponses, o.vue, o);
  else res = vueSimple(reponses, o.vue, o);

  const dates = toutes.map(r => r.date).sort();
  const parOutil = ['Antigravity', 'Claude Code'].map(t => `${t} ${new Set(toutes.filter(r => r.outil === t).map(r => r.conversation)).size}`).join(', ');
  console.log(`\nTokens IA — ${nbConversations} conversations (${parOutil}), données du ${fr(dates[0])} au ${fr(dates[dates.length - 1])}`);
  const filtres = [o.outil && `outil : ${o.outil}`, o.projet && `projet contient « ${o.projet} »`, o.depuis && `depuis le ${fr(o.depuis)}`, o.jusqua && `jusqu'au ${fr(o.jusqua)}`, o.sansCache && 'sans le cache'].filter(Boolean);
  if (filtres.length) console.log('Filtres : ' + filtres.join(', '));
  console.log('');

  if (!reponses.length) { console.log('Aucune utilisation ne correspond à ces filtres.'); return; }

  if (res.brut) {
    console.log(res.entetes.join(','));
    for (const l of res.lignes) console.log(l.join(','));
    console.log(`\n(à coller à la fin de donnees/consommation.csv ; semaine 1 = semaine du ${fr(lundi(config.debutSemaine1))})`);
  } else {
    const affiche = res.lignes.map(l => l.map(c => (typeof c === 'number' ? nombre(c) : c)));
    const premiereTexte = o.vue === 'conversation' ? 4 : o.vue === 'detail' ? 5 : 1;
    console.log(tableau(res.entetes, affiche, i => i >= premiereTexte && !(o.vue === 'detail' && i === res.entetes.length - 1), !res.sansTotal));
  }

  if (o.csv) {
    const sep = o.vue === 'equipe' ? ',' : ';';
    fs.writeFileSync(o.csv, (o.vue === 'equipe' ? '' : '﻿') + versCsv(res.entetes, res.lignes, sep));
    console.log(`\nCSV enregistré : ${path.resolve(o.csv)}`);
  }
  if (o.json) {
    const objets = res.lignes.map(l => Object.fromEntries(res.entetes.map((e, i) => [e, l[i]])));
    fs.writeFileSync(o.json, JSON.stringify(objets, null, 2));
    console.log(`\nJSON enregistré : ${path.resolve(o.json)}`);
  }
}

main().catch(e => {
  console.error('Erreur : ' + e.message);
  process.exitCode = 1;
});
