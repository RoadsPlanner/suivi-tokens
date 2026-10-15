#!/usr/bin/env python3
"""Génère le tableau de bord (README.md) à partir des CSV.

Sources de vérité :
  donnees/membres.csv       -> liste des membres (colonne « membre »)
  donnees/consommation.csv  -> une ligne par saisie : semaine,membre,tokens

Lancé automatiquement par GitHub Actions à chaque modification de donnees/.
En local : python3 scripts/generer_tableau.py
"""
import csv
import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
FICHIER_MEMBRES = RACINE / "donnees" / "membres.csv"
FICHIER_CONSO = RACINE / "donnees" / "consommation.csv"
FICHIER_README = RACINE / "README.md"

DEPOT = "RoadsPlanner/suivi-tokens"
BRANCHE = "main"
SEMAINES_MIN = 12  # le tableau affiche toujours au moins 12 semaines


def nombre(n):
    """12345.6 -> '12 346' (séparateur de milliers français)."""
    return f"{round(n):,}".replace(",", " ")


def lire_membres():
    with FICHIER_MEMBRES.open(encoding="utf-8-sig", newline="") as f:
        membres = [l["membre"].strip() for l in csv.DictReader(f) if l.get("membre", "").strip()]
    if len(set(m.lower() for m in membres)) != len(membres):
        raise ValueError("donnees/membres.csv contient un membre en double.")
    return membres


def lire_conso(membres):
    erreurs = []
    conso = {}  # (membre, semaine) -> tokens
    par_nom = {m.lower(): m for m in membres}
    with FICHIER_CONSO.open(encoding="utf-8-sig", newline="") as f:
        lecteur = csv.DictReader(f)
        attendu = {"semaine", "membre", "tokens"}
        if not lecteur.fieldnames or set(c.strip() for c in lecteur.fieldnames) != attendu:
            raise ValueError("La première ligne de donnees/consommation.csv doit être : semaine,membre,tokens")
        for num, ligne in enumerate(lecteur, start=2):
            ligne = {k.strip(): (v or "").strip() for k, v in ligne.items() if k}
            if not any(ligne.values()):
                continue  # ligne vide tolérée
            s, m, t = ligne["semaine"], ligne["membre"], ligne["tokens"]
            s = s.lower().removeprefix("semaine").strip()
            if not s.isdigit() or int(s) < 1:
                erreurs.append(f"ligne {num} : semaine « {ligne['semaine']} » invalide (attendu un nombre ≥ 1)")
                continue
            if m.lower() not in par_nom:
                erreurs.append(f"ligne {num} : membre « {m} » absent de donnees/membres.csv")
                continue
            t_net = t.replace(" ", "").replace(" ", "").replace(" ", "")
            if not t_net.isdigit():
                erreurs.append(f"ligne {num} : tokens « {t} » invalide (attendu un nombre entier positif)")
                continue
            cle = (par_nom[m.lower()], int(s))
            conso[cle] = conso.get(cle, 0) + int(t_net)  # plusieurs saisies = additionnées
    if erreurs:
        raise ValueError("Erreurs dans donnees/consommation.csv :\n  - " + "\n  - ".join(erreurs))
    return conso


def calculer(membres, conso):
    nb_sem = max([SEMAINES_MIN] + [s for _, s in conso])
    semaines = list(range(1, nb_sem + 1))
    lignes = []
    for m in membres:
        vals = [conso.get((m, s), 0) for s in semaines]
        positifs = [v for v in vals if v > 0]
        lignes.append((m, vals, sum(vals), sum(positifs) / len(positifs) if positifs else 0))
    tot_sem = [sum(l[1][i] for l in lignes) for i in range(nb_sem)]
    pos = [v for v in tot_sem if v > 0]
    total = sum(tot_sem)
    return {
        "semaines": semaines,
        "lignes": lignes,
        "tot_sem": tot_sem,
        "total": total,
        "moy_equipe_sem": sum(pos) / len(pos) if pos else 0,
        "moy_membre": total / len(membres) if membres else 0,
        "actifs": sum(1 for l in lignes if l[2] > 0),
    }


def ecrire_readme(membres, r):
    lien_saisie = f"https://github.com/{DEPOT}/edit/{BRANCHE}/donnees/consommation.csv"
    lien_membres = f"https://github.com/{DEPOT}/edit/{BRANCHE}/donnees/membres.csv"
    entete = ["Membre"] + [f"S{s}" for s in r["semaines"]] + ["**Total**", "Moy. / sem."]
    tableau = ["| " + " | ".join(entete) + " |", "|" + "|".join([":---"] + ["---:"] * (len(entete) - 1)) + "|"]
    for m, vals, tot, moy in r["lignes"]:
        cells = [m] + [nombre(v) if v else "·" for v in vals] + [f"**{nombre(tot)}**", nombre(moy)]
        tableau.append("| " + " | ".join(cells) + " |")
    tableau.append("| " + " | ".join(
        ["**TOTAL ÉQUIPE**"] + [f"**{nombre(v)}**" if v else "·" for v in r["tot_sem"]]
        + [f"**{nombre(r['total'])}**", f"**{nombre(r['moy_equipe_sem'])}**"]) + " |")

    contenu = f"""# 📊 Suivi de consommation des tokens

<!-- Ce fichier est généré automatiquement : ne pas le modifier à la main.
     Modifier donnees/consommation.csv (ou donnees/membres.csv) à la place. -->

| Total global consommé | Moyenne par membre | Membres actifs |
|:---:|:---:|:---:|
| **{nombre(r['total'])}** | **{nombre(r['moy_membre'])}** | **{r['actifs']} / {len(membres)}** |

{chr(10).join(tableau)}

*« · » = rien saisi. La moyenne par semaine ne compte que les semaines où il y a eu de la consommation.*

## ✏️ Ajouter une consommation (directement sur GitHub)

1. Ouvrir **[donnees/consommation.csv en édition]({lien_saisie})** (icône crayon ✏️).
2. Ajouter une ligne à la fin, au format `semaine,membre,tokens`, par exemple :
   ```
   3,Ahmed,15000
   ```
3. Cliquer sur **Commit changes**.

Le tableau ci-dessus se met à jour tout seul en moins d'une minute (onglet **Actions**).

- Plusieurs lignes pour le même membre et la même semaine sont **additionnées**.
- Pour corriger une valeur, modifier ou supprimer la ligne concernée.
- Pour ajouter / retirer un membre : **[donnees/membres.csv]({lien_membres})**.
- Le fichier CSV s'ouvre aussi dans Excel si besoin.
- Si une ligne est mal écrite, l'action GitHub échoue (croix rouge ❌) et indique la ligne à corriger ; le tableau garde alors sa version précédente.
"""
    FICHIER_README.write_text(contenu, encoding="utf-8")


def main():
    try:
        membres = lire_membres()
        conso = lire_conso(membres)
    except ValueError as e:
        print(f"❌ {e}", file=sys.stderr)
        sys.exit(1)
    r = calculer(membres, conso)
    ecrire_readme(membres, r)
    print(f"✅ Tableau généré : {nombre(r['total'])} tokens, {len(conso)} saisies.")


if __name__ == "__main__":
    main()
